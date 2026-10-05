"use strict";

const defaultConventions = require("./mapping-conventions.json");

/**
 * ============================================================
 * MAPPING SUGGESTER
 * ============================================================
 *
 * Proposes how one business object model becomes another
 * (source -> canonical, canonical -> target), using semantic tags.
 * Generic: no business object, system or field names in the logic.
 *
 * Structure mappings (which source structures feed a target structure):
 *   - matched by shared meanings on NON-KEY source fields
 *     (keys such as company or customer number appear everywhere)
 *   - pattern from cardinality:
 *       single -> single   ONE_TO_ONE (+ join of single source children)
 *       single -> many     EXPLODE    (one entry per root record or per group)
 *       many   -> many     ONE_TO_ONE (FILTER if the same source is PICKed elsewhere)
 *       many   -> single   PICK       (only for meanings no single source provides)
 *
 * Field mappings: same meaning -> field pair, with a rule:
 *   DIRECT, VALUE_MAP (codes, source -> canonical), FLAG (code -> boolean),
 *   SPLIT (text longer than target + continuation field), CONSTANT $sourceSystem.
 *
 * Everything is a SUGGESTION: the functional team completes and approves.
 * Scope of this version: target / source structures up to depth 1.
 */

function isIdentifierTag(tag, tagClass) {
    return !tag || tagClass.get(tag) === "ID" || tag.startsWith("meta.");
}

function meaningsOf(structure, tagClass, { nonKeyOnly }) {
    return new Set(
        structure.fields
            .filter(field => field.tag && !(nonKeyOnly && field.isKey) && !isIdentifierTag(field.tag, tagClass))
            .map(field => field.tag)
    );
}

function intersect(left, right) {
    return new Set([...left].filter(value => right.has(value)));
}

function pickCondition(structure, conventions) {
    const flag = structure.fields.find(
        field => field.tag && conventions.pickFlagSuffixes.some(suffix => field.tag.endsWith(suffix))
    );

    return flag ? { field: flag.name, equals: true } : null;
}

function baseType(dataType) {
    return String(dataType || "").replace(/^Edm\./, "");
}

/**
 * ------------------------------------------------------------
 * Field mappings for one structure mapping
 * ------------------------------------------------------------
 */
function suggestFieldMappings({ target, sources, fallbackRoot, from, tagClass, hop, conventions }) {
    const fieldMappings = [];
    const assigned = new Map(); // target field name -> { source, field }

    const tagged = target.fields.filter(field => field.tag);
    const byTag = new Map();

    for (const field of tagged) {
        if (!byTag.has(field.tag)) {
            byTag.set(field.tag, []);
        }

        byTag.get(field.tag).push(field);
    }

    for (const [tag, targetFields] of byTag) {
        const candidates = [];

        for (const source of sources) {
            for (const field of source.fields.filter(f => f.tag === tag)) {
                candidates.push({ structure: source, field });
            }
        }

        const keyCandidates = fallbackRoot && !sources.includes(fallbackRoot)
            ? fallbackRoot.fields.filter(f => f.tag === tag).map(field => ({ structure: fallbackRoot, field }))
            : [];

        let next = 0;
        let nextKey = 0;

        for (const targetField of targetFields) {
            let candidate = candidates[next];

            if (candidate) {
                next++;
            } else if (targetField.isKey && keyCandidates[nextKey]) {
                candidate = keyCandidates[nextKey++];
            }

            if (candidate) {
                assigned.set(targetField.name, candidate);
            }
        }
    }

    const splitSecondParts = new Map(); // continuation target field -> source candidate

    for (const targetField of tagged) {
        const candidate = assigned.get(targetField.name);

        if (!candidate) {
            continue;
        }

        const sourceField = candidate.field;
        const dataClass = tagClass.get(targetField.tag);
        let rule = { type: "DIRECT" };
        let note = "same value";

        // Split only where the overflow can continue in another field (name -> additional name);
        // otherwise keep DIRECT and let validation report values that are too long
        const continuationTag = conventions.continuationTags[targetField.tag];
        const tooLong =
            continuationTag &&
            dataClass === "TEXT" &&
            sourceField.length && targetField.length &&
            sourceField.length > targetField.length;

        if (tooLong) {
            rule = { type: "SPLIT", maxLength: targetField.length, part: 1 };
            note = `source length ${sourceField.length} > target length ${targetField.length} - split`;

            const continuation = continuationTag && tagged.find(
                field => field.tag === continuationTag && !assigned.has(field.name) && !splitSecondParts.has(field.name)
            );

            if (continuation) {
                splitSecondParts.set(continuation.name, { candidate, maxLength: targetField.length });
            }
        } else if (dataClass === "FLAG" && baseType(sourceField.dataType) !== "Boolean" && baseType(targetField.dataType) === "Boolean") {
            rule = { type: "FLAG", falseValues: conventions.flagFalseValues };
            note = "code converted to true/false - please confirm which values mean false";
        } else if (
            dataClass === "CODE" &&
            hop === "SOURCE_TO_CANONICAL" &&
            !conventions.isoCodeTags.includes(targetField.tag)
        ) {
            rule = { type: "VALUE_MAP", domain: targetField.tag };
            note = `source codes must be mapped to canonical codes (value mapping '${targetField.tag}')`;
        }

        const sourceConfidence = sourceField.tagConfidence ?? 100;
        const targetConfidence = targetField.tagConfidence ?? 100;

        fieldMappings.push({
            toField: targetField.name,
            toFieldId: targetField.ID,
            fromFields: [{ structure: candidate.structure.name, field: sourceField.name }],
            rule,
            confidence: Math.round(Math.min(sourceConfidence, targetConfidence) * (rule.type === "DIRECT" ? 1 : 0.95)),
            reason:
                `Same meaning '${targetField.tag}': ${candidate.structure.name}.${sourceField.name}` +
                `${sourceField.description ? ` ("${sourceField.description}")` : ""} -> ${target.name}.${targetField.name}; ${note}`
        });
    }

    for (const [targetFieldName, { candidate, maxLength }] of splitSecondParts) {
        const targetField = target.fields.find(field => field.name === targetFieldName);

        fieldMappings.push({
            toField: targetField.name,
            toFieldId: targetField.ID,
            fromFields: [{ structure: candidate.structure.name, field: candidate.field.name }],
            rule: { type: "SPLIT", maxLength, part: 2 },
            confidence: Math.round(Math.min(candidate.field.tagConfidence ?? 100, targetField.tagConfidence ?? 100) * 0.9),
            reason: `Overflow of ${candidate.structure.name}.${candidate.field.name} (longer than ${maxLength}) continues in ${target.name}.${targetField.name}`
        });

        assigned.set(targetFieldName, candidate);
    }

    // Identifier of the source system when the source has no such field
    for (const targetField of tagged) {
        if (!assigned.has(targetField.name) && targetField.tag.startsWith("meta.") && hop === "SOURCE_TO_CANONICAL") {
            fieldMappings.push({
                toField: targetField.name,
                toFieldId: targetField.ID,
                fromFields: [],
                rule: { type: "CONSTANT", value: "$sourceSystem" },
                confidence: 100,
                reason: `'${targetField.tag}' is filled with the source system ID`
            });

            assigned.set(targetField.name, null);
        }
    }

    return { fieldMappings, assigned, from };
}

/**
 * ============================================================
 * SUGGEST
 * ============================================================
 *
 * @param {Object} args
 * @param {Object} args.from   ModelView of the source model
 * @param {Object} args.to     ModelView of the target model
 * @param {Array}  args.tags   SemanticTag rows ({ code, dataClass })
 * @param {string} args.hop    SOURCE_TO_CANONICAL | CANONICAL_TO_TARGET
 */
function suggestMappings({ from, to, tags, hop, conventions = defaultConventions }) {
    const tagClass = new Map(tags.map(tag => [tag.code, tag.dataClass]));
    const minOverlap = conventions.minStructureOverlap;

    const sourceRoot = from.root;
    const sourceChildren = from.structures.filter(structure => structure.depth === 1);
    const structureMappings = [];
    const coverage = { unmappedStructures: [], unmappedFields: [], unsupportedStructures: [] };
    const picks = new Map(); // source structure name -> pick condition

    let rootGroupBy = null;

    const add = (target, pattern, sources, patternConfig, confidence, reason, fallbackRoot) => {
        const { fieldMappings, assigned } = suggestFieldMappings({
            target, sources, fallbackRoot, from, tagClass, hop, conventions
        });

        const mapping = {
            toStructure: target.name,
            toStructureId: target.ID,
            fromStructures: sources.map(source => source.name),
            pattern,
            patternConfig,
            confidence,
            reason,
            fieldMappings,
            assigned
        };

        structureMappings.push(mapping);

        return mapping;
    };

    const joinsFor = (targetMeanings) => sourceChildren
        .filter(child => child.single && intersect(meaningsOf(child, tagClass, { nonKeyOnly: true }), targetMeanings).size > 0)
        .map(child => ({ structure: child, on: child.joinKeys }));

    for (const target of to.structures) {

        if (target.depth > 1) {
            coverage.unsupportedStructures.push({
                structure: target.name,
                reason: "Nested structures (depth > 1) are not supported in this version"
            });
            continue;
        }

        const targetMeanings = meaningsOf(target, tagClass, { nonKeyOnly: false });

        /*
         * ---------- Target root ----------
         */
        if (target.isRoot) {
            const joins = joinsFor(targetMeanings);
            const covered = intersect(
                new Set([
                    ...meaningsOf(sourceRoot, tagClass, { nonKeyOnly: true }),
                    ...joins.flatMap(join => [...meaningsOf(join.structure, tagClass, { nonKeyOnly: true })])
                ]),
                targetMeanings
            );

            const rootMapping = add(
                target,
                "ONE_TO_ONE",
                [sourceRoot, ...joins.map(join => join.structure)],
                {
                    join: joins.map(join => ({ structure: join.structure.name, on: join.on }))
                },
                targetMeanings.size > 0 ? Math.round((covered.size / targetMeanings.size) * 100) : 100,
                `Root '${sourceRoot.name}' is the root of '${target.name}'` +
                (joins.length > 0 ? `; joined with ${joins.map(join => join.structure.name).join(", ")} (1:1 data)` : ""),
                null
            );

            // Group source root records when the target root key uses only part of the source key
            const sourceKeyFields = sourceRoot.fields.filter(field => field.isKey).map(field => field.name);
            const mappedKeys = target.fields
                .filter(field => field.isKey)
                .map(field => rootMapping.assigned.get(field.name))
                .filter(candidate => candidate && candidate.structure === sourceRoot && candidate.field.isKey)
                .map(candidate => candidate.field.name);

            if (mappedKeys.length > 0 && mappedKeys.length < sourceKeyFields.length) {
                rootGroupBy = mappedKeys;
                rootMapping.patternConfig.groupBy = mappedKeys;
                rootMapping.reason +=
                    `; source records grouped by ${mappedKeys.join(", ")} (target key does not include ` +
                    `${sourceKeyFields.filter(key => !mappedKeys.includes(key)).join(", ")})`;
            }

            for (const child of sourceChildren.filter(structure => !structure.single)) {
                const uncovered = [...intersect(meaningsOf(child, tagClass, { nonKeyOnly: true }), targetMeanings)]
                    .filter(meaning => !covered.has(meaning));

                if (uncovered.length === 0) {
                    continue;
                }

                const where = pickCondition(child, conventions);

                picks.set(child.name, where);
                uncovered.forEach(meaning => covered.add(meaning));

                const pick = add(
                    target,
                    "PICK",
                    [child],
                    { where },
                    Math.round((uncovered.length / targetMeanings.size) * 100),
                    `One entry of '${child.name}' provides ${uncovered.join(", ")}` +
                    (where ? ` - the entry where ${where.field} = ${where.equals}` : " - the first entry"),
                    null
                );

                // The picked entry only fills meanings no other source provides
                const tagOf = new Map(target.fields.map(field => [field.name, field.tag]));

                pick.fieldMappings = pick.fieldMappings.filter(
                    fieldMapping => uncovered.includes(tagOf.get(fieldMapping.toField))
                );

                for (const fieldName of [...pick.assigned.keys()]) {
                    if (!uncovered.includes(tagOf.get(fieldName))) {
                        pick.assigned.delete(fieldName);
                    }
                }
            }

            continue;
        }

        /*
         * ---------- Target child (depth 1) ----------
         */
        if (targetMeanings.size === 0) {
            continue;
        }

        const score = (structure) =>
            intersect(meaningsOf(structure, tagClass, { nonKeyOnly: true }), targetMeanings).size / targetMeanings.size;

        const rootScore = score(sourceRoot);

        if (rootScore >= minOverlap) {
            const joins = joinsFor(targetMeanings);

            const mapping = add(
                target,
                "EXPLODE",
                [sourceRoot, ...joins.map(join => join.structure)],
                {
                    rows: "survivor",
                    join: joins.map(join => ({ structure: join.structure.name, on: join.on }))
                },
                Math.round(rootScore * 100),
                `Fields of '${sourceRoot.name}' form entries of '${target.name}' (${Math.round(rootScore * 100)}% of its meanings)`,
                sourceRoot
            );

            // One entry per source root record when a target key comes from a source key
            // that is not used for grouping (e.g. company within the customer)
            const inheritedKeyTags = new Set(to.root.fields.filter(field => field.isKey).map(field => field.tag));
            const perRecordKey = target.fields
                .filter(field => field.isKey && !inheritedKeyTags.has(field.tag))
                .map(field => mapping.assigned.get(field.name))
                .find(candidate =>
                    candidate &&
                    candidate.structure === sourceRoot &&
                    candidate.field.isKey &&
                    !(rootGroupBy || []).includes(candidate.field.name)
                );

            if (perRecordKey) {
                mapping.patternConfig.rows = "all";
                mapping.reason += `; one entry per '${sourceRoot.name}' record (key ${perRecordKey.field.name})`;
            }
        }

        for (const child of sourceChildren.filter(structure => !structure.single)) {
            const childScore = score(child);

            if (childScore < minOverlap) {
                continue;
            }

            const picked = picks.get(child.name);

            if (picks.has(child.name)) {
                add(
                    target,
                    "FILTER",
                    [child],
                    { where: picked, negate: true },
                    Math.round(childScore * 100),
                    `Entries of '${child.name}' not picked for the root` +
                    (picked ? ` (${picked.field} <> ${picked.equals})` : ""),
                    sourceRoot
                );
            } else {
                add(
                    target,
                    "ONE_TO_ONE",
                    [child],
                    {},
                    Math.round(childScore * 100),
                    `Each entry of '${child.name}' becomes an entry of '${target.name}' (${Math.round(childScore * 100)}% of its meanings)`,
                    sourceRoot
                );
            }
        }
    }

    /*
     * ---------- Coverage ----------
     */
    for (const target of to.structures.filter(structure => structure.depth <= 1)) {
        const mappings = structureMappings.filter(mapping => mapping.toStructure === target.name);

        if (mappings.length === 0) {
            coverage.unmappedStructures.push({
                structure: target.name,
                mandatoryFields: target.fields.filter(field => field.mandatory).map(field => field.name)
            });
            continue;
        }

        // A single target (e.g. root) is one entry filled by all its mappings together;
        // a collection gets entries from each mapping separately
        const groups = target.single
            ? [{
                fromStructures: [...new Set(mappings.flatMap(mapping => mapping.fromStructures))],
                pattern: mappings.map(mapping => mapping.pattern).join("+"),
                assigned: new Map(mappings.flatMap(mapping => [...mapping.assigned]))
            }]
            : mappings;

        for (const mapping of groups) {
            for (const field of target.fields) {
                if (!mapping.assigned.has(field.name)) {
                    coverage.unmappedFields.push({
                        structure: target.name,
                        via: mapping.fromStructures,
                        pattern: mapping.pattern,
                        field: field.name,
                        mandatory: field.mandatory,
                        isKey: field.isKey
                    });
                }
            }
        }
    }

    return {
        hop,
        structureMappings: structureMappings.map(({ assigned, ...mapping }) => mapping),
        coverage
    };
}

module.exports = {
    suggestMappings
};
