"use strict";

const { applyRule, clean } = require("./FieldRules");

/**
 * ============================================================
 * TRANSFORMATION ENGINE
 * ============================================================
 *
 * Executes an APPROVED mapping set on one business object instance.
 * Deterministic - no AI in the data path. Generic - no object,
 * system or field names in the logic.
 *
 * Instance (input):
 *   { key, rootStructure, rootRecords: [row, ...], children: { structureName: [row, ...] } }
 *   rootRecords > 1 when source records are grouped (e.g. one customer in two companies);
 *   the first record is the "survivor" for single values.
 *
 * Document (output): nested JSON of the target model
 *   { <root fields>, <childStructure>: [ { <fields> }, ... ] }
 *
 * Patterns: ONE_TO_ONE, EXPLODE, PICK, FILTER, DERIVE.
 * Issues:   MANDATORY_MISSING, LENGTH_EXCEEDED, VALUE_MAPPING_MISSING, UNKNOWN_RULE.
 */

const APPROVED = new Set(["APPROVED", "MODIFIED"]);

function same(left, right) {
    return String(clean(left) ?? "") === String(clean(right) ?? "");
}

function matches(row, where) {
    if (!where) {
        return true;
    }

    return String(row?.[where.field]) === String(where.equals);
}

/**
 * ------------------------------------------------------------
 * Compile: keep approved mappings only, attach target field
 * definitions. Input mappings use structure / field names.
 * ------------------------------------------------------------
 *
 * @param {Object} toView           ModelView of the target model
 * @param {Array}  structureMappings [{ toStructure, fromStructures, pattern, patternConfig, status,
 *                                      fieldMappings: [{ toField, fromFields, rule, status }] }]
 */
function compileMappingSet(toView, structureMappings, hop) {
    const structures = toView.structures
        .filter(structure => structure.depth <= 1)
        .map(structure => ({
            name: structure.name,
            isRoot: structure.isRoot,
            single: structure.single,
            fields: structure.fields.map(field => ({
                name: field.name,
                dataType: field.dataType,
                length: field.length,
                mandatory: field.mandatory,
                isKey: field.isKey
            })),
            mappings: structureMappings
                .filter(mapping => mapping.toStructure === structure.name && APPROVED.has(mapping.status))
                .map(mapping => ({
                    pattern: mapping.pattern,
                    fromStructures: mapping.fromStructures,
                    config: mapping.patternConfig || {},
                    fieldMappings: (mapping.fieldMappings || []).filter(fm => APPROVED.has(fm.status))
                }))
        }));

    return {
        hop,
        root: structures.find(structure => structure.isRoot),
        children: structures.filter(structure => !structure.isRoot)
    };
}

/**
 * ------------------------------------------------------------
 * Transform one instance
 * ------------------------------------------------------------
 *
 * @param {Object} instance
 * @param {Object} compiled   result of compileMappingSet
 * @param {Object} options    { sourceSystem, lookupValue(domain, value) -> { found, value } }
 * @returns {{ document, issues }}
 */
function transformInstance(instance, compiled, options) {
    const issues = [];
    const survivor = instance.rootRecords[0] || {};
    const rootName = instance.rootStructure;
    const children = instance.children || {};

    const issueOf = (structure, field, issue, entryIndex = null) => ({
        instance: instance.key,
        hop: compiled.hop,
        structure,
        entry: entryIndex,
        field,
        code: issue.code,
        message: issue.message
    });

    const report = (...args) => issues.push(issueOf(...args));

    const baseContext = (row) => ({ [rootName]: row });

    const addJoins = (context, row, joins) => {
        for (const join of joins || []) {
            context[join.structure] = (children[join.structure] || []).find(
                candidate => (join.on || []).every(key => same(candidate[key.child], row[key.parent]))
            ) || null;
        }

        return context;
    };

    /**
     * Applies the field mappings of one structure mapping to an entry.
     * Issues go to `sink`. Returns whether the entry carries data:
     * false when it has non-key source fields and none of them
     * delivered a value (keys alone - e.g. a tax category derived
     * from the country - do not make an entry).
     */
    const applyMappings = (mapping, context, entry, structure, entryIndex, sink) => {
        const keyFields = new Set(structure.fields.filter(field => field.isKey).map(field => field.name));
        let dataFields = 0;
        let dataValues = 0;

        for (const fieldMapping of mapping.fieldMappings) {
            const values = (fieldMapping.fromFields || []).map(
                source => context[source.structure]?.[source.field]
            );

            const result = applyRule(fieldMapping.rule, values, options);

            if (result.issue) {
                sink.push(issueOf(structure.name, fieldMapping.toField, result.issue, entryIndex));
            }

            if ((fieldMapping.fromFields || []).length > 0 && !keyFields.has(fieldMapping.toField)) {
                dataFields++;

                if (result.value !== null && result.value !== undefined) {
                    dataValues++;
                }
            }

            if (result.value !== null && result.value !== undefined) {
                entry[fieldMapping.toField] = result.value;
            } else if (!(fieldMapping.toField in entry)) {
                entry[fieldMapping.toField] = null;
            }
        }

        // An exploded entry without any source data is not created (e.g. no VAT number)
        return dataFields === 0 || dataValues > 0;
    };

    const validate = (entry, structure, entryIndex, sink) => {
        for (const field of structure.fields) {
            const value = entry[field.name];

            if (!(field.name in entry)) {
                entry[field.name] = null;
            }

            if (field.mandatory && (value === null || value === undefined || value === "")) {
                sink.push(issueOf(structure.name, field.name, {
                    code: "MANDATORY_MISSING",
                    message: `Mandatory field '${field.name}' is empty`
                }, entryIndex));
            }

            if (typeof value === "string" && field.length && value.length > field.length) {
                sink.push(issueOf(structure.name, field.name, {
                    code: "LENGTH_EXCEEDED",
                    message: `'${value}' is ${value.length} characters, maximum ${field.length}`
                }, entryIndex));
            }
        }

        return entry;
    };

    /*
     * ---------- Root ----------
     */
    const document = {};
    const root = compiled.root;

    if (root) {
        const context = baseContext(survivor);

        for (const mapping of root.mappings) {
            if (mapping.pattern === "PICK") {
                const source = mapping.fromStructures[0];
                const rows = children[source] || [];

                context[source] = rows.find(row => matches(row, mapping.config.where)) || rows[0] || null;
            } else {
                addJoins(context, survivor, mapping.config.join);
            }
        }

        for (const mapping of root.mappings) {
            applyMappings(mapping, context, document, root, null, issues);
        }

        validate(document, root, null, issues);
    }

    /*
     * ---------- Child structures ----------
     */
    for (const structure of compiled.children) {
        const entries = [];

        const build = (mapping, context) => {
            const entry = {};
            const index = entries.length;
            const entryIssues = [];
            const hasData = applyMappings(mapping, context, entry, structure, index, entryIssues);

            // Only EXPLODE creates entries out of flat fields; an exploded entry without
            // data is not created, and its issues are discarded with it
            if (hasData || mapping.pattern !== "EXPLODE") {
                entries.push(validate(entry, structure, index, entryIssues));
                issues.push(...entryIssues);
            }
        };

        for (const mapping of structure.mappings) {
            const source = mapping.fromStructures[0];

            switch (mapping.pattern) {
                case "EXPLODE": {
                    const rows = mapping.config.rows === "all" ? instance.rootRecords : [survivor];

                    for (const row of rows) {
                        build(mapping, addJoins(baseContext(row), row, mapping.config.join));
                    }
                    break;
                }

                case "ONE_TO_ONE":
                case "FILTER": {
                    const rows = (children[source] || []).filter(row => {
                        if (mapping.pattern !== "FILTER") {
                            return true;
                        }

                        const hit = matches(row, mapping.config.where);
                        return mapping.config.negate ? !hit : hit;
                    });

                    for (const row of rows) {
                        build(mapping, { ...baseContext(survivor), [source]: row });
                    }
                    break;
                }

                case "PICK": {
                    const rows = children[source] || [];
                    const row = rows.find(candidate => matches(candidate, mapping.config.where)) || rows[0];

                    if (row) {
                        build(mapping, { ...baseContext(survivor), [source]: row });
                    }
                    break;
                }

                case "DERIVE":
                    build(mapping, baseContext(survivor));
                    break;

                default:
                    report(structure.name, null, {
                        code: "UNKNOWN_PATTERN",
                        message: `Unknown structure pattern '${mapping.pattern}'`
                    });
            }
        }

        document[structure.name] = entries;
    }

    return { document, issues };
}

/**
 * Canonical document -> instance for the next hop.
 */
function documentToInstance(document, key, rootStructure, childNames) {
    const rootRecord = {};
    const children = {};

    for (const [name, value] of Object.entries(document)) {
        if (childNames.includes(name)) {
            children[name] = value || [];
        } else {
            rootRecord[name] = value;
        }
    }

    return { key, rootStructure, rootRecords: [rootRecord], children };
}

/**
 * Target document -> rows per target structure (staging shape).
 */
function toStructureRows(document, compiled) {
    const rows = {};

    if (compiled.root) {
        rows[compiled.root.name] = [
            Object.fromEntries(
                Object.entries(document).filter(([name]) => !compiled.children.some(child => child.name === name))
            )
        ];
    }

    for (const child of compiled.children) {
        rows[child.name] = document[child.name] || [];
    }

    return rows;
}

module.exports = {
    compileMappingSet,
    transformInstance,
    documentToInstance,
    toStructureRows
};
