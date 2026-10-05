"use strict";

const { GROUPS, LEVELS, DATE_FORMATS, ON_FAILURE, ruleType } = require("./RuleCatalog");

/**
 * ============================================================
 * CLEANSING RULE ENGINE
 * ============================================================
 *
 * Applies the rules of the functional team to records. It works on plain records (field name and
 * value), so it is the same for S/4, Infor M3 or Oracle. It never changes the records it is given:
 * every record is copied first. No code from a rule is executed: rule types are fixed functions,
 * conditions are parsed by a small grammar, patterns are regular expressions.
 *
 * Order of work per record:
 *   1. Select rules (INCLUDE_IF / EXCLUDE_IF): the record is kept or left out
 *   2. Standardise, Convert, Default, Derive rules, by group, then by Order
 *   3. Validate rules on the cleansed record: issues are reported, nothing is changed
 */

const TRANSFORM_GROUPS = ["Standardise", "Convert", "Default", "Derive"];
const MAX_VALUE_FOR_PATTERN = 1000;
const MAX_PATTERN_LENGTH = 300;

const isEmpty = (value) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");
const text = (value) => (value === null || value === undefined ? "" : String(value));

// ------------------------------------------------------------------ conditions

/**
 * Field = 'v' | Field != 'v' | Field in ('a','b') | Field is empty | Field is not empty,
 * joined with AND / OR (AND is evaluated before OR). Throws an error that says what is wrong.
 */
function parseCondition(source) {
    const input = String(source || "").trim();

    if (!input) {
        return { test: () => true, fields: [] };
    }

    // split on AND / OR outside of quotes
    const parts = [];
    const operators = [];
    let current = "";
    let quoted = false;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (ch === "'") quoted = !quoted;

        if (!quoted && /\s/.test(ch)) {
            const rest = input.slice(i);
            const m = /^\s+(AND|OR)\s+/i.exec(rest);

            if (m) {
                parts.push(current);
                operators.push(m[1].toUpperCase());
                current = "";
                i += m[0].length - 1;
                continue;
            }
        }

        current += ch;
    }

    if (quoted) {
        throw new Error(`Condition '${input}': a quote is not closed`);
    }

    parts.push(current);

    const unquote = (value) => value.slice(1, -1).replace(/''/g, "'");
    const fields = [];

    const clauses = parts.map(part => {
        const clause = part.trim();
        let m;

        if ((m = /^([A-Za-z_][\w.]*)\s+is\s+not\s+empty$/i.exec(clause))) {
            fields.push(m[1]);
            return (record) => !isEmpty(record[m[1]]);
        }

        if ((m = /^([A-Za-z_][\w.]*)\s+is\s+empty$/i.exec(clause))) {
            fields.push(m[1]);
            return (record) => isEmpty(record[m[1]]);
        }

        if ((m = /^([A-Za-z_][\w.]*)\s*(=|!=)\s*('(?:[^']|'')*')$/.exec(clause))) {
            const [, field, op, quotedValue] = m;
            const expected = unquote(quotedValue);

            fields.push(field);
            return (record) => (text(record[field]).trim() === expected) === (op === "=");
        }

        if ((m = /^([A-Za-z_][\w.]*)\s+in\s*\(\s*((?:'(?:[^']|'')*')(?:\s*,\s*'(?:[^']|'')*')*)\s*\)$/i.exec(clause))) {
            const field = m[1];
            const values = (m[2].match(/'(?:[^']|'')*'/g) || []).map(unquote);

            fields.push(field);
            return (record) => values.includes(text(record[field]).trim());
        }

        throw new Error(`Condition '${clause}' is not understood. Use: Field = 'value', Field != 'value', Field in ('a','b'), Field is empty, Field is not empty`);
    });

    // AND binds stronger than OR
    const test = (record) => {
        let result = false;
        let group = clauses[0](record);

        operators.forEach((op, i) => {
            const next = clauses[i + 1](record);

            if (op === "AND") {
                group = group && next;
            } else {
                result = result || group;
                group = next;
            }
        });

        return result || group;
    };

    return { test, fields };
}

// ------------------------------------------------------------------ dates

const validDate = (y, m, d) => {
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

const iso = (y, m, d) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Returns { value } or { warn }. An empty or zero date becomes an empty value. */
function toIsoDate(value, format) {
    const raw = text(value).trim();

    if (raw === "" || /^0+$/.test(raw)) {
        return { value: "" };
    }

    let m;
    let y, mo, d;

    if (format === "ODATA") {
        if (!(m = /^\/Date\((-?\d+)([+-]\d+)?\)\/$/.exec(raw))) return { warn: `'${raw}' is not an OData date` };

        const date = new Date(Number(m[1]));

        if (Number.isNaN(date.getTime())) return { warn: `'${raw}' is not a valid date` };

        const full = date.toISOString();

        return { value: full.endsWith("T00:00:00.000Z") ? full.slice(0, 10) : full.slice(0, 19) + "Z" };
    }

    if (format === "YYYYMMDD") {
        if (!(m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw))) return { warn: `'${raw}' is not a date in the format YYYYMMDD` };
        [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    } else if (format === "DD.MM.YYYY" || format === "DD/MM/YYYY") {
        const sep = format === "DD.MM.YYYY" ? "\\." : "/";
        if (!(m = new RegExp(`^(\\d{1,2})${sep}(\\d{1,2})${sep}(\\d{4})$`).exec(raw))) return { warn: `'${raw}' is not a date in the format ${format}` };
        [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    } else if (format === "MM/DD/YYYY") {
        if (!(m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw))) return { warn: `'${raw}' is not a date in the format MM/DD/YYYY` };
        [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    } else if (format === "YYYY-MM-DD") {
        if (!(m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw))) return { warn: `'${raw}' is not a date in the format YYYY-MM-DD` };
        [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    } else {
        return { warn: `unknown date format '${format}'` };
    }

    return validDate(y, mo, d) ? { value: iso(y, mo, d) } : { warn: `'${raw}' is not a real date` };
}

// ------------------------------------------------------------------ parameters

function parseConcat(parameter) {
    const m = /^\s*fields\s*=\s*([^;]+?)\s*(?:;\s*separator\s*=(.*))?$/is.exec(String(parameter || ""));

    if (!m) return null;

    let separator = m[2] === undefined ? " " : m[2];

    if (/^'.*'$/s.test(separator)) separator = separator.slice(1, -1);

    return { fields: m[1].split(",").map(f => f.trim()).filter(Boolean), separator };
}

function parseReplace(parameter) {
    const at = String(parameter || "").indexOf("=>");

    if (at <= 0) return null;

    return { from: parameter.slice(0, at), to: parameter.slice(at + 2) };
}

const title = (value) => value.toLowerCase().replace(/(^|[\s\-/(])(\p{L})/gu, (match, before, letter) => before + letter.toUpperCase());

const levenshtein = (a, b) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return dp[a.length][b.length];
};

// ------------------------------------------------------------------ validation of a rule

/**
 * Checks ONE rule (a row of the template). Returns a list of messages that say what is wrong;
 * an empty list means the rule is fine. Optional: knownFields (the fields of the entity) for a typo hint.
 */
function validateRule(rule, { knownFields } = {}) {
    const errors = [];
    const id = rule.ruleId || "(no RuleID)";
    const type = ruleType(rule.rule);

    if (!rule.ruleId) errors.push("RuleID is missing");

    if (!type) {
        errors.push(`${id}: rule '${rule.rule || ""}' does not exist. Available rules: ${require("./RuleCatalog").RULE_TYPES.map(t => t.name).join(", ")}`);
        return errors;
    }

    if (rule.group && rule.group !== type.group) errors.push(`${id}: ${type.name} belongs to the group ${type.group}, not ${rule.group}`);
    if (rule.level && !LEVELS.includes(rule.level)) errors.push(`${id}: level must be ${LEVELS.join(" or ")}`);
    if (rule.onFailure && !ON_FAILURE.includes(rule.onFailure)) errors.push(`${id}: On failure must be ${ON_FAILURE.join(" or ")}`);

    const field = String(rule.field || "").trim();

    if (type.recordRule) {
        if (field) errors.push(`${id}: ${type.name} works on the whole record, leave Field empty`);
        if (!String(rule.condition || "").trim()) errors.push(`${id}: ${type.name} needs a Condition`);
    } else if (!field) {
        errors.push(`${id}: Field is missing`);
    } else if (field === "*" && type.group !== "Standardise") {
        errors.push(`${id}: Field * (every text field) is only allowed for Standardise rules`);
    } else if (field !== "*" && knownFields && !knownFields.includes(field)) {
        const close = knownFields.find(f => f.toLowerCase() === field.toLowerCase()) || knownFields.find(f => levenshtein(f.toLowerCase(), field.toLowerCase()) <= 2);
        errors.push(`${id}: field '${field}' does not exist in this entity${close ? `, did you mean '${close}'?` : ""}`);
    }

    const parameter = String(rule.parameter || "").trim();

    if (type.needsParameter && !parameter) errors.push(`${id}: ${type.name} needs a Parameter (${type.parameter})`);

    if (parameter) {
        if (type.name === "DATE_TO_ISO" && !DATE_FORMATS.includes(parameter)) errors.push(`${id}: date format '${parameter}' is not known. Use one of: ${DATE_FORMATS.join(", ")}`);
        if (type.name === "REPLACE" && !parseReplace(parameter)) errors.push(`${id}: REPLACE needs the form from=>to`);
        if (type.name === "CONCAT" && !(parseConcat(parameter)?.fields.length)) errors.push(`${id}: CONCAT needs the form fields=Field1,Field2;separator=text`);
        if (type.name === "MAX_LENGTH" && !(Number.isInteger(Number(parameter)) && Number(parameter) > 0)) errors.push(`${id}: MAX_LENGTH needs a positive number`);
        if (type.name === "ALLOWED_VALUES" && !parameter.split(",").some(v => v.trim())) errors.push(`${id}: ALLOWED_VALUES needs a list of values`);
        if (type.name === "MATCHES") {
            if (parameter.length > MAX_PATTERN_LENGTH) errors.push(`${id}: the pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
            try { new RegExp(parameter); } catch (error) { errors.push(`${id}: the pattern is not valid (${error.message})`); }
        }
    }

    if (String(rule.condition || "").trim()) {
        try {
            const { fields } = parseCondition(rule.condition);

            if (knownFields) {
                fields.filter(f => !knownFields.includes(f)).forEach(f => errors.push(`${id}: the condition uses the field '${f}', which does not exist in this entity`));
            }
        } catch (error) {
            errors.push(`${id}: ${error.message}`);
        }
    }

    return errors;
}

// ------------------------------------------------------------------ scope

const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

/** A rule's Source system: empty or * = every system. */
const systemMatches = (ruleSystem, system) => !String(ruleSystem || "").trim() || ruleSystem.trim() === "*" || same(ruleSystem, system);

/** A rule's Entity: * = every entity; "API_X / A_Y" matches the API API_X. */
const entityMatches = (ruleEntity, entity) => {
    const wanted = String(ruleEntity || "").trim();

    return !wanted || wanted === "*" || same(wanted, entity) || same(wanted.split("/")[0], entity);
};

// ------------------------------------------------------------------ the runner

/**
 * Applies the rules to records one by one (so large extractions can be streamed).
 *
 * @param {Object}   options
 * @param {Object[]} options.rules          rows of the template
 * @param {string}   [options.sourceSystem]
 * @param {string}   [options.entity]       API / program of the records
 * @param {Object}   [options.valueMaps]    { domain: { sourceValue: targetValue } }
 * @param {string}   [options.level]        "Source" (default) or "Canonical"
 * @param {boolean}  [options.keepRecords]  keep the cleansed records (default true)
 * @param {number}   [options.examples]     before / after examples kept per rule (default 3)
 * @param {number}   [options.maxIssues]    issues kept in the result (default 200)
 */
class RuleRunner {

    constructor({ rules = [], sourceSystem, entity, valueMaps = {}, level = "Source", keepRecords = true, examples = 3, maxIssues = 200 } = {}) {
        this.keepRecords = keepRecords;
        this.examples = examples;
        this.maxIssues = maxIssues;
        this.valueMaps = valueMaps;
        this.records = [];
        this.input = 0;
        this.excluded = 0;
        this.rejected = 0;
        this.issueCount = 0;
        this.issues = [];
        this.invalidRules = [];
        this.stats = new Map();
        this.entity = entity;
        this.seen = new Set();            // field names that occur in the records

        const scoped = rules.filter(r =>
            (r.level || "Source") === level && systemMatches(r.sourceSystem, sourceSystem) && entityMatches(r.entity, entity));

        this.select = [];
        this.transform = [];
        this.validate = [];

        scoped.forEach((rule, index) => {
            const errors = validateRule(rule);

            if (errors.length) {
                this.invalidRules.push({ ruleId: rule.ruleId, errors });
                return;
            }

            const type = ruleType(rule.rule);
            const compiled = {
                rule, type, index,
                order: Number(rule.order) || 0,
                condition: parseCondition(rule.condition),
                parameter: String(rule.parameter || "").trim(),
                field: String(rule.field || "").trim(),
                // only Validate rules reject a record by default; a missing value mapping is a warning
                severity: rule.onFailure || (type.group === "Validate" ? "ERROR" : "WARNING")
            };

            this.stats.set(rule.ruleId, { ruleId: rule.ruleId, rule: type.name, group: type.group, field: compiled.field || "(record)", evaluated: 0, changed: 0, excluded: 0, issues: 0, examples: [] });

            if (type.group === "Select") this.select.push(compiled);
            else if (type.group === "Validate") this.validate.push(compiled);
            else this.transform.push(compiled);
        });

        const rank = (c) => TRANSFORM_GROUPS.indexOf(c.type.group);
        this.transform.sort((a, b) => rank(a) - rank(b) || a.order - b.order || a.index - b.index);
        this.validate.sort((a, b) => a.order - b.order || a.index - b.index);
    }

    _issue(compiled, recordIndex, field, value, message) {
        const stat = this.stats.get(compiled.rule.ruleId);

        stat.issues++;
        this.issueCount++;

        if (this.issues.length < this.maxIssues) {
            this.issues.push({ ruleId: compiled.rule.ruleId, severity: compiled.severity, recordIndex, field, value: text(value), message });
        }
    }

    _example(stat, before, after) {
        if (stat.examples.length < this.examples) {
            stat.examples.push({ before: text(before), after: text(after) });
        }
    }

    _apply(compiled, record, recordIndex) {
        const stat = this.stats.get(compiled.rule.ruleId);
        const { type, parameter } = compiled;
        const fields = compiled.field === "*"
            ? Object.keys(record).filter(k => !k.startsWith("__") && typeof record[k] === "string")
            : [compiled.field];

        if (!compiled.condition.test(record)) {
            return;
        }

        for (const field of fields) {
            const before = record[field];
            let after = before;

            stat.evaluated++;

            switch (type.name) {
                case "TRIM": if (typeof before === "string") after = before.trim(); break;
                case "UPPER": if (typeof before === "string") after = before.toUpperCase(); break;
                case "LOWER": if (typeof before === "string") after = before.toLowerCase(); break;
                case "TITLE": if (typeof before === "string") after = title(before); break;
                case "REPLACE": {
                    const { from, to } = parseReplace(parameter);
                    if (typeof before === "string" && from) after = before.split(from).join(to);
                    break;
                }
                case "DATE_TO_ISO": {
                    if (isEmpty(before) && !/^0+$/.test(text(before).trim())) break;
                    const result = toIsoDate(before, parameter);
                    if (result.warn) { this._issue(compiled, recordIndex, field, before, result.warn); break; }
                    after = result.value;
                    break;
                }
                case "VALUE_MAP": {
                    if (isEmpty(before)) break;
                    const map = this.valueMaps[parameter] || {};
                    const key = text(before).trim();
                    if (Object.prototype.hasOwnProperty.call(map, key)) after = map[key];
                    else this._issue(compiled, recordIndex, field, before, `'${key}' has no approved mapping in the domain ${parameter}`);
                    break;
                }
                case "DEFAULT": if (isEmpty(before)) after = parameter; break;
                case "CONCAT": {
                    const { fields: sources, separator } = parseConcat(parameter);
                    after = sources.map(f => text(record[f]).trim()).filter(Boolean).join(separator);
                    break;
                }
                default: break;
            }

            if (text(after) !== text(before)) {
                record[field] = after;
                stat.changed++;
                this._example(stat, before, after);
            }
        }
    }

    _check(compiled, record, recordIndex) {
        const stat = this.stats.get(compiled.rule.ruleId);
        const { type, parameter, field } = compiled;
        const value = record[field];

        if (!compiled.condition.test(record)) {
            return false;
        }

        stat.evaluated++;

        const problem = (message) => { this._issue(compiled, recordIndex, field, value, message); return compiled.severity === "ERROR"; };

        switch (type.name) {
            case "REQUIRED": return isEmpty(value) ? problem(`${field} is empty`) : false;
            case "MATCHES": return !isEmpty(value) && !new RegExp(parameter).test(text(value).slice(0, MAX_VALUE_FOR_PATTERN)) ? problem(`'${text(value)}' does not match the pattern ${parameter}`) : false;
            case "MAX_LENGTH": return !isEmpty(value) && text(value).length > Number(parameter) ? problem(`'${text(value)}' is longer than ${parameter} characters`) : false;
            case "ALLOWED_VALUES": {
                const allowed = parameter.split(",").map(v => v.trim());
                return !isEmpty(value) && !allowed.includes(text(value).trim()) ? problem(`'${text(value)}' is not one of ${allowed.join(", ")}`) : false;
            }
            default: return false;
        }
    }

    /** Applies the rules to one record. Returns the cleansed record, or null if it is left out. */
    process(original) {
        const recordIndex = this.input++;
        const record = { ...original };

        if (this.seen.size < 5000) {
            Object.keys(original).forEach(key => this.seen.add(key));
        }

        // 1. select
        for (const compiled of this.select) {
            const stat = this.stats.get(compiled.rule.ruleId);
            const matches = compiled.condition.test(record);

            stat.evaluated++;

            if ((compiled.type.name === "INCLUDE_IF" && !matches) || (compiled.type.name === "EXCLUDE_IF" && matches)) {
                stat.excluded++;
                this.excluded++;
                return null;
            }
        }

        // 2. standardise / convert / default / derive
        for (const compiled of this.transform) {
            this._apply(compiled, record, recordIndex);
        }

        // 3. validate
        let rejected = false;

        for (const compiled of this.validate) {
            rejected = this._check(compiled, record, recordIndex) || rejected;
        }

        if (rejected) this.rejected++;
        if (this.keepRecords) this.records.push(record);

        return record;
    }

    /** Warnings that a person must see: wrong field names, rules that leave out every record. */
    _warnings() {
        const warnings = [];

        if (this.input === 0) return warnings;

        const seen = [...this.seen];
        const close = (name) => seen.find(f => f.toLowerCase() === name.toLowerCase()) || seen.find(f => levenshtein(f.toLowerCase(), name.toLowerCase()) <= 2);

        for (const compiled of [...this.select, ...this.transform, ...this.validate]) {
            const id = compiled.rule.ruleId;
            const referenced = new Set(compiled.condition.fields);
            const type = compiled.type.name;

            if (compiled.field && compiled.field !== "*" && type !== "DEFAULT" && type !== "CONCAT") referenced.add(compiled.field);
            if (type === "CONCAT") (parseConcat(compiled.parameter)?.fields || []).forEach(f => referenced.add(f));

            for (const field of referenced) {
                if (!this.seen.has(field)) {
                    const hint = close(field);
                    warnings.push(`Rule ${id}: the field '${field}' does not exist in any record of ${this.entity || "this entity"}${hint ? `, did you mean '${hint}'?` : ""}`);
                }
            }

            if (compiled.type.group === "Select" && this.stats.get(id).excluded === this.input) {
                warnings.push(`Rule ${id} leaves out every record. Check the condition.`);
            }
        }

        return warnings;
    }

    result() {
        return {
            warnings: this._warnings(),
            input: this.input,
            output: this.input - this.excluded,
            excluded: this.excluded,
            rejected: this.rejected,
            issueCount: this.issueCount,
            issues: this.issues,
            invalidRules: this.invalidRules,
            rules: [...this.stats.values()],
            records: this.records
        };
    }
}

/** Applies the rules to a list of records. */
function applyRules({ records, ...options }) {
    const runner = new RuleRunner(options);

    records.forEach(record => runner.process(record));

    return runner.result();
}

module.exports = { RuleRunner, applyRules, validateRule, parseCondition, toIsoDate, entityMatches, systemMatches, GROUPS };
