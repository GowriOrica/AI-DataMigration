"use strict";

/**
 * ============================================================
 * FIELD RULES
 * ============================================================
 *
 * Building blocks for field mappings. A rule is JSON stored on a
 * FieldMapping and entered/approved by the functional team:
 *
 *   { "type": "DIRECT" }
 *   { "type": "CONSTANT",    "value": "CUST" }          "$sourceSystem" = source system ID
 *   { "type": "DEFAULT",     "value": "EN" }            value when the source is empty
 *   { "type": "SPLIT",       "maxLength": 40, "part": 1 }   word-boundary split
 *   { "type": "CONCAT",      "separator": " " }
 *   { "type": "VALUE_MAP",   "domain": "finance.paymentTerms" }
 *   { "type": "FLAG",        "falseValues": ["0", ""] } code -> true/false
 *   { "type": "CONDITIONAL", "when": [{ "equals": "90", "then": true }], "else": false }
 *
 * Source values are the values of the mapping's fromFields, in order.
 * Rules never execute code from configuration.
 */

const conventions = require("./mapping-conventions.json");

function clean(value) {
    if (value === undefined || value === null) {
        return null;
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed === "" ? null : trimmed;
    }

    return value;
}

/**
 * Word-boundary split into chunks of maxLength.
 * "Southern Cross Civil Construction" (max 20) -> ["Southern Cross Civil", "Construction"]
 */
function splitText(text, maxLength) {
    const parts = [];
    let rest = String(text);

    while (rest.length > maxLength) {
        let cut = rest.lastIndexOf(" ", maxLength);

        if (cut <= 0) {
            cut = maxLength;
        }

        parts.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }

    parts.push(rest);

    return parts;
}

/**
 * @param {Object}   rule
 * @param {Array}    sourceValues  values of the fromFields
 * @param {Object}   context       { sourceSystem, lookupValue(domain, value) -> { found, value } }
 * @returns {{ value, issue? }}    issue = { code, message }
 */
function applyRule(rule, sourceValues, context) {
    const values = (sourceValues || []).map(clean);
    const first = values[0] ?? null;

    switch (rule?.type) {
        case "DIRECT":
            return { value: first };

        case "CONSTANT":
            return {
                value: rule.value === "$sourceSystem" ? context.sourceSystem : rule.value
            };

        case "DEFAULT":
            return { value: first ?? rule.value };

        case "SPLIT": {
            if (first === null) {
                return { value: null };
            }

            const parts = splitText(first, Number(rule.maxLength) || 40);

            return { value: parts[(Number(rule.part) || 1) - 1] ?? null };
        }

        case "CONCAT": {
            const present = values.filter(value => value !== null);

            return { value: present.length > 0 ? present.join(rule.separator ?? " ") : null };
        }

        case "VALUE_MAP": {
            if (first === null) {
                return { value: null };
            }

            const mapped = context.lookupValue(rule.domain, String(first));

            if (!mapped.found) {
                return {
                    value: null,
                    issue: {
                        code: "VALUE_MAPPING_MISSING",
                        message: `No approved value mapping for '${first}' in domain '${rule.domain}'`
                    }
                };
            }

            return { value: mapped.value };
        }

        case "FLAG": {
            const falseValues = rule.falseValues || conventions.flagFalseValues;

            return { value: !falseValues.includes(first === null ? "" : String(first)) };
        }

        case "CONDITIONAL": {
            const match = (rule.when || []).find(
                condition => String(first ?? "") === String(condition.equals ?? "")
            );

            return { value: match ? match.then : (rule.else ?? null) };
        }

        default:
            return {
                value: null,
                issue: {
                    code: "UNKNOWN_RULE",
                    message: `Unknown rule type '${rule?.type}'`
                }
            };
    }
}

module.exports = {
    applyRule,
    splitText,
    clean
};
