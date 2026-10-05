"use strict";

const zlib = require("zlib");
const { manifestKey } = require("../extraction/ExtractionRunner");
const { FIELD_COMPLETENESS_THRESHOLDS, QUALITY_SCORE_WEIGHTS } = require("../../profiling/ProfileDataProfiler");

/**
 * ============================================================
 * PROFILING OF AN EXTRACTION (Object Store files)
 * ============================================================
 *
 * Reads the pages of an extraction one by one and keeps only counters in memory, so large
 * extractions work as well. Per API / program it answers:
 *
 *   - how complete is every field (fill rate), which fields are always empty
 *   - how many different values, which values are the most frequent
 *   - mixed formats (e.g. OData dates next to ISO dates), spelling variants (DE / de),
 *     values with leading or trailing spaces
 *   - duplicate keys, and PROBABLE duplicates (same name)
 *   - one indicative quality score
 *
 * The mandatory fields of the target are not known here, so this measures what is IN the data,
 * not whether the target will accept it.
 */

const MAX_DISTINCT = 5000;          // distinct values tracked per field
const MAX_DUPLICATE_KEYS = 1000000; // keys / names tracked for duplicates
const TOP_VALUES = 5;

const ODATA_DATE = /^\/Date\((-?\d+)([+-]\d+)?\)\/$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// fields that can hold a person's or company's name, best first
const NAME_FIELD_ORDER = [/FullName$/i, /^Name$/i, /Name1$/i, /Name$/i];
const NOT_A_NAME = /(prefix|suffix|title|middle|first|last|search|short|group|type|user|file|schema|formatted)/i;
const CITY_FIELD = /^(city|cityname|town|ort)$/i;

const isEmpty = (value) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");

function classify(value) {
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "number";

    const text = String(value);

    if (ODATA_DATE.test(text)) return "odata-date";
    if (ISO_DATE.test(text)) return "iso-date";
    if (NUMERIC_TEXT.test(text)) return "numeric-text";

    return "text";
}

const isDateClass = (cls) => cls === "odata-date" || cls === "iso-date";

/** Collects the counters of ONE API / program. */
class RecordProfiler {

    /**
     * @param {Object}   [options]
     * @param {string[]} [options.keyFields]        fields that form the key (duplicate keys are counted for them)
     * @param {string[]} [options.duplicateFields]  fields compared for PROBABLE duplicates (default: the best name field)
     */
    constructor(options = {}) {
        this.options = options;
        this.records = 0;
        this.fieldOrder = [];
        this.fields = new Map();
        this.keyCounts = new Map();
        this.keyOverflow = false;
        this.nameCounts = new Map();     // field -> Map(normalised value -> count)
        this.comboCounts = new Map();    // "nameField|cityField" -> Map(normalised name + city -> count)
    }

    _count(store, mapKey, key) {
        let counts = store.get(mapKey);

        if (!counts) {
            counts = new Map();
            store.set(mapKey, counts);
        }

        if (counts.has(key) || counts.size < MAX_DUPLICATE_KEYS) {
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }

    _field(name) {
        let field = this.fields.get(name);

        if (!field) {
            field = { name, filled: 0, distinct: new Map(), capped: false, classes: {}, spaces: 0, invalidEmails: 0, isEmailField: /e-?mail/i.test(name) };
            this.fields.set(name, field);
            this.fieldOrder.push(name);
        }

        return field;
    }

    _keyFields(record) {
        if (this.options.keyFields && this.options.keyFields.length) {
            return this.options.keyFields;
        }

        // automatic: the first field of the record, used only if it turns out to look like a key
        return [this.fieldOrder[0]];
    }

    add(record) {
        this.records++;

        for (const [name, value] of Object.entries(record)) {
            if (name.startsWith("__") || (value && typeof value === "object")) {
                continue;            // OData bookkeeping and navigation links are not data
            }

            const field = this._field(name);

            if (isEmpty(value)) {
                continue;
            }

            field.filled++;

            const text = String(value);
            const cls = classify(value);

            field.classes[cls] = (field.classes[cls] || 0) + 1;

            if (typeof value === "string" && value !== value.trim()) {
                field.spaces++;
            }

            if (field.isEmailField && !EMAIL.test(text.trim())) {
                field.invalidEmails++;
            }

            if (field.distinct.has(text)) {
                field.distinct.set(text, field.distinct.get(text) + 1);
            } else if (field.distinct.size < MAX_DISTINCT) {
                field.distinct.set(text, 1);
            } else {
                field.capped = true;
            }

            // names: tracked completely (not capped at 5,000) to find probable duplicates
            if (this._isNameCandidate(name)) {
                const normalised = text.trim().toLowerCase().replace(/\s+/g, " ");

                this._count(this.nameCounts, name, normalised);

                // the same name in different cities is usually a different business partner / bank branch
                for (const [other, otherValue] of Object.entries(record)) {
                    if (CITY_FIELD.test(other) && !isEmpty(otherValue)) {
                        this._count(this.comboCounts, name + "|" + other, normalised + "\u0001" + String(otherValue).trim().toLowerCase());
                    }
                }
            }
        }

        // key duplicates
        const keyFields = this._keyFields(record);
        const parts = keyFields.map(f => record[f]);

        if (parts.every(p => !isEmpty(p))) {
            const key = parts.join("\u0001");

            if (this.keyCounts.has(key) || this.keyCounts.size < MAX_DUPLICATE_KEYS) {
                this.keyCounts.set(key, (this.keyCounts.get(key) || 0) + 1);
            } else {
                this.keyOverflow = true;
            }
        }
    }

    _isNameCandidate(name) {
        if (this.options.duplicateFields) {
            return this.options.duplicateFields.includes(name);
        }

        return /name/i.test(name) && !NOT_A_NAME.test(name);
    }

    finish({ truncated = false } = {}) {
        const n = this.records;
        const pct = (part, whole) => (whole ? Math.round((1000 * part) / whole) / 10 : 0);

        const fields = this.fieldOrder.map(name => {
            const f = this.fields.get(name);
            const fillPct = pct(f.filled, n);
            const classes = Object.keys(f.classes);

            // lower-case spelling variants: "DE" / "de" / "De"
            const spellings = new Map();
            for (const value of f.distinct.keys()) {
                const norm = value.trim().toLowerCase();
                spellings.set(norm, (spellings.get(norm) || 0) + 1);
            }

            const top = [...f.distinct.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_VALUES)
                .map(([value, count]) => ({ value, count }));

            return {
                name,
                filled: f.filled,
                fillPct,
                kind: f.filled === 0 ? "EMPTY" : fillPct === 100 ? "FULL" : "PARTIAL",
                distinct: f.distinct.size,
                distinctCapped: f.capped,
                top,
                types: f.classes,
                mixedDateFormats: classes.some(isDateClass) && classes.length > 1,
                spellingVariants: [...spellings.values()].filter(count => count > 1).length,
                valuesWithSpaces: f.spaces,
                invalidEmails: f.invalidEmails
            };
        });

        const alwaysEmpty = fields.filter(f => f.kind === "EMPTY").map(f => f.name);
        const used = fields.filter(f => f.kind !== "EMPTY");

        // ---- duplicate keys
        const keyFields = (this.options.keyFields && this.options.keyFields.length) ? this.options.keyFields : [this.fieldOrder[0]];
        const first = this.fields.get(keyFields[0]);
        const looksLikeKey = !!first && (this.options.keyFields || (first.filled === n && first.distinct.size >= 0.9 * n));
        let duplicateKeys = null;

        if (looksLikeKey && !this.keyOverflow) {
            let extra = 0;
            for (const count of this.keyCounts.values()) if (count > 1) extra += count - 1;
            duplicateKeys = { fields: keyFields, duplicateRecords: extra };
        }

        // ---- probable duplicates (same name)
        let probable = null;
        let nameField = null;

        if (this.options.duplicateFields && this.options.duplicateFields.length) {
            nameField = this.options.duplicateFields[0];
        } else {
            for (const pattern of NAME_FIELD_ORDER) {
                const candidate = fields.find(f => pattern.test(f.name) && !NOT_A_NAME.test(f.name) && f.fillPct >= 50);
                if (candidate) { nameField = candidate.name; break; }
            }
        }

        if (nameField && this.nameCounts.get(nameField)) {
            // name + city when the API has a city that is filled in at least half of the records
            const cityField = fields.find(c => CITY_FIELD.test(c.name) && c.fillPct >= 50);
            const combo = cityField && this.comboCounts.get(nameField + "|" + cityField.name);
            const counted = combo || this.nameCounts.get(nameField);
            const groups = [...counted.entries()].filter(([, count]) => count > 1)
                .map(([value, count]) => [value.replace("\u0001", " / "), count]);
            probable = {
                field: combo ? nameField + " + " + cityField.name : nameField,
                groups: groups.length,
                records: groups.reduce((sum, [, count]) => sum + count, 0),
                extraRecords: groups.reduce((sum, [, count]) => sum + count - 1, 0),
                examples: groups.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count }))
            };
        }

        // ---- indicative quality score (weights and thresholds as in the old profiler)
        // optional fields that are rarely filled are normal and do not lower the score
        const core = fields.filter(f => f.fillPct >= 50);
        const completeness = core.length ? core.reduce((sum, f) => sum + f.fillPct, 0) / core.length : 0;
        const dupShare = probable && n ? Math.min(1, probable.extraRecords / n) : 0;
        const keyShare = duplicateKeys && n ? Math.min(1, duplicateKeys.duplicateRecords / n) : 0;
        const uniqueness = 100 * (1 - Math.max(dupShare, keyShare));

        const invalidValues = fields.reduce((sum, f) => sum + f.invalidEmails + (f.mixedDateFormats ? minorityOfDates(this.fields.get(f.name)) : 0), 0);
        const checkedValues = fields.reduce((sum, f) => sum + f.filled, 0);
        const validity = checkedValues ? 100 * (1 - invalidValues / checkedValues) : 100;

        const score = Math.round(
            QUALITY_SCORE_WEIGHTS.completeness * completeness +
            QUALITY_SCORE_WEIGHTS.uniqueness * uniqueness +
            QUALITY_SCORE_WEIGHTS.validity * validity
        );

        const status = score >= FIELD_COMPLETENESS_THRESHOLDS.ok ? "OK" : score >= FIELD_COMPLETENESS_THRESHOLDS.warning ? "WARNING" : "CRITICAL";

        const result = {
            records: n,
            truncated,
            fieldCount: fields.length,
            fields,
            alwaysEmpty,
            fullyFilled: fields.filter(f => f.kind === "FULL").length,
            partlyFilled: fields.filter(f => f.kind === "PARTIAL").length,
            duplicateKeys,
            probableDuplicates: probable,
            mixedDateFields: fields.filter(f => f.mixedDateFormats).map(f => f.name),
            odataDateFields: fields.filter(f => f.types["odata-date"]).map(f => f.name),
            spellingVariantFields: fields.filter(f => f.spellingVariants > 0).map(f => f.name),
            fieldsWithSpaces: fields.filter(f => f.valuesWithSpaces > 0).map(f => f.name),
            score: { value: score, status, completeness: Math.round(completeness), uniqueness: Math.round(uniqueness), validity: Math.round(validity), indicative: true }
        };

        result.findings = findings(result);

        return result;
    }
}

/** Dates in the minority format of a field (a rough count of the values that do not fit). */
function minorityOfDates(field) {
    const counts = Object.entries(field.classes).filter(([cls]) => isDateClass(cls) || cls === "text").map(([, c]) => c);
    const total = counts.reduce((a, b) => a + b, 0);

    return total - Math.max(...counts, 0);
}

/** The result in plain sentences (used by the screen and by Joule). */
function findings(r) {
    const out = [];

    if (r.records === 0) {
        return ["The extraction contains no records."];
    }

    out.push(`${r.records} records, ${r.fieldCount} fields: ${r.fullyFilled} fully filled, ${r.partlyFilled} partly filled, ${r.alwaysEmpty.length} always empty.`);

    if (r.alwaysEmpty.length > 0) {
        out.push(`${r.alwaysEmpty.length} fields are empty in every record, so they probably need no mapping.`);
    }

    const lowest = r.fields.filter(f => f.kind === "PARTIAL" && f.fillPct < 90).sort((a, b) => a.fillPct - b.fillPct).slice(0, 3);
    if (lowest.length) {
        out.push(`Least filled fields: ${lowest.map(f => `${f.name} ${f.fillPct} %`).join(", ")}.`);
    }

    const gaps = r.fields.filter(f => f.kind === "PARTIAL" && f.fillPct >= 90);
    if (gaps.length) {
        out.push(`Almost complete but with gaps: ${gaps.slice(0, 4).map(f => `${f.name} ${f.fillPct} %`).join(", ")}.`);
    }

    if (r.duplicateKeys) {
        out.push(r.duplicateKeys.duplicateRecords === 0
            ? `No duplicate keys (${r.duplicateKeys.fields.join(" + ")}).`
            : `${r.duplicateKeys.duplicateRecords} records repeat an existing key (${r.duplicateKeys.fields.join(" + ")}).`);
    }

    if (r.probableDuplicates && r.probableDuplicates.groups > 0) {
        const p = r.probableDuplicates;
        out.push(`${p.groups} names occur more than once in ${p.field} (${p.records} records), for example ${p.examples.slice(0, 3).map(e => `"${e.value}" x${e.count}`).join(", ")}. These are probable duplicates, not proof.`);
    }

    if (r.odataDateFields.length) {
        out.push(`Dates in the old OData format /Date(...)/, to be converted: ${r.odataDateFields.join(", ")}.`);
    }

    if (r.mixedDateFields.length) {
        out.push(`Mixed date formats in: ${r.mixedDateFields.join(", ")}.`);
    }

    if (r.spellingVariantFields.length) {
        out.push(`Spelling variants (same value with different case) in: ${r.spellingVariantFields.slice(0, 6).join(", ")}.`);
    }

    if (r.fieldsWithSpaces.length) {
        out.push(`Values with leading or trailing spaces in: ${r.fieldsWithSpaces.slice(0, 6).join(", ")}.`);
    }

    if (r.truncated) {
        out.push("The extraction stopped at the record limit, so this describes only the extracted records.");
    }

    out.push(`Indicative quality score ${r.score.value} / 100 (${r.score.status}): completeness ${r.score.completeness} (fields filled in at least half of the records), uniqueness ${r.score.uniqueness}, validity ${r.score.validity}. The mandatory fields of the target are not known yet.`);

    return out;
}

/**
 * Profiles the APIs of one extraction, reading its files from the storage page by page.
 */
async function profileExtraction({ storage, extractionId, objectName, options = {} }) {
    let manifest;

    try {
        manifest = JSON.parse((await storage.get(manifestKey(extractionId))).toString("utf8"));
    } catch (error) {
        const notFound = new Error(`Extraction '${extractionId}' was not found in the storage`);
        notFound.status = 404;
        throw notFound;
    }

    const entries = objectName ? manifest.objects.filter(o => o.objectName === objectName) : manifest.objects;

    if (entries.length === 0) {
        const notFound = new Error(`'${objectName}' is not part of extraction '${extractionId}'`);
        notFound.status = 404;
        throw notFound;
    }

    const objects = [];

    for (const entry of entries) {
        const profiler = new RecordProfiler(options[entry.objectName] || options);

        for (const file of entry.files || []) {
            const lines = zlib.gunzipSync(await storage.get(file.key)).toString("utf8").split("\n");

            for (const line of lines) {
                if (line) {
                    profiler.add(JSON.parse(line));
                }
            }
        }

        objects.push({ objectName: entry.objectName, error: entry.error || null, ...profiler.finish({ truncated: !!entry.truncated }) });
    }

    return {
        extractionId,
        businessObject: manifest.businessObject || null,
        sourceSystem: manifest.sourceSystem || null,
        startedAt: manifest.startedAt || null,
        objects
    };
}

module.exports = { RecordProfiler, profileExtraction, classify };
