"use strict";

const DEFAULT_KNOWLEDGE = require("./tag-synonyms.json");

/**
 * ============================================================
 * RULE-BASED SEMANTIC TAGGER
 * ============================================================
 *
 * Deterministic, explainable tagging of fields with semantic tags,
 * based on field descriptions, field names, key flags, data types and
 * structure context. Always available (no AI required).
 *
 * Scoring (0..1, reported as 0..100):
 *   description equals phrase               0.95
 *   description contains phrase             0.88 (multi-word) / 0.80 (single word)
 *   field name equals phrase                0.90
 *   field name contains phrase              0.82 (multi-word) / 0.75 (single word)
 *   x phrase weight (generic phrases < 1)
 *   x 0.6  keyOnly tag on a non-key field
 *   x 0.6  data class mismatch (e.g. FLAG tag on a text field)
 *   + 0.05 structure context matches (e.g. "sales" structure for sales.paymentTerms)
 *
 * Result bands:
 *   >= 85        high confidence
 *   60 .. 85     needs review
 *   < 60         untagged
 * Two different tags within 0.03 of each other -> ambiguous, capped at 70.
 */

const HIGH_CONFIDENCE = 85;
const MIN_CONFIDENCE = 0.6;
const AMBIGUITY_MARGIN = 0.03;
const CONTEXT_BONUS = 0.05;

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * "OrganizationBPName1" -> "organization bp name 1"
 * "A_CustomerSalesArea" -> "a customer sales area"
 * "CRS610MI.GetFinancial" -> "crs 610 mi get financial"
 */
function nameTokens(name) {
    return normalize(
        String(name || "")
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
            .replace(/([A-Za-z])([0-9])/g, "$1 $2")
            .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    );
}

function contains(text, phrase) {
    return ` ${text} `.includes(` ${phrase} `);
}

function wordCount(phrase) {
    return phrase.split(" ").length;
}

function baseType(dataType) {
    return String(dataType || "").replace(/^Edm\./, "");
}

function dataClassFits(dataClass, field) {
    const type = baseType(field.dataType);

    switch (dataClass) {
        case "FLAG":
            return type === "Boolean" || field.length === 1;
        case "AMOUNT":
            return ["Decimal", "Double", "Single"].includes(type);
        case "DATE":
            return ["Date", "DateTime", "DateTimeOffset"].includes(type);
        case "ID":
        case "TEXT":
        case "CODE":
            return type !== "Boolean";
        default:
            return true;
    }
}

function scorePhrase(field, phrase, weight) {
    const description = normalize(field.description);
    const name = nameTokens(field.name);
    const multiWord = wordCount(phrase) > 1;

    let score = 0;
    let evidence = null;

    if (description && description === phrase) {
        score = 0.95;
        evidence = `description "${field.description}" equals "${phrase}"`;
    } else if (description && contains(description, phrase)) {
        score = multiWord ? 0.88 : 0.80;
        evidence = `description "${field.description}" contains "${phrase}"`;
    } else if (name === phrase) {
        score = 0.90;
        evidence = `field name "${field.name}" equals "${phrase}"`;
    } else if (contains(name, phrase)) {
        score = multiWord ? 0.82 : 0.75;
        evidence = `field name "${field.name}" contains "${phrase}"`;
    }

    if (score === 0) {
        return null;
    }

    // Longer (more specific) phrases win ties
    return {
        score: score * weight + 0.005 * wordCount(phrase),
        evidence
    };
}

/**
 * @param {Object} field      { name, description, dataType, length, isKey, structureName }
 * @param {Object} tagInfo    { code, dataClass }
 * @param {Object} rule       knowledge entry for the tag
 */
function scoreTag(field, tagInfo, rule) {
    const description = normalize(field.description);
    const name = nameTokens(field.name);

    const excluded = (rule.exclude || []).find(
        phrase => contains(description, phrase) || contains(name, phrase)
    );

    if (excluded) {
        return null;
    }

    let best = null;

    for (const entry of rule.phrases || []) {
        const [phrase, weight] = Array.isArray(entry) ? entry : [entry, 1];
        const result = scorePhrase(field, normalize(phrase), weight);

        if (result && (!best || result.score > best.score)) {
            best = result;
        }
    }

    if (!best) {
        return null;
    }

    const notes = [best.evidence];
    let score = best.score;

    if (rule.keyOnly && !field.isKey) {
        score *= 0.6;
        notes.push("identifier tag on a non-key field");
    }

    if (!dataClassFits(tagInfo.dataClass, field)) {
        score *= 0.6;
        notes.push(`data type ${baseType(field.dataType) || "unknown"} does not fit ${tagInfo.dataClass}`);
    }

    const structureWords = nameTokens(field.structureName);
    const contextWord = (rule.context || []).find(word => contains(structureWords, word));

    if (contextWord) {
        score += CONTEXT_BONUS;
        notes.push(`structure "${field.structureName}" indicates "${contextWord}"`);
    }

    return {
        tag: tagInfo.code,
        score: Math.min(score, 0.99),
        notes
    };
}

/**
 * Tag one field.
 *
 * @returns {{ tag, confidence, reason, origin, alternatives }}
 *          tag = null when no tag reaches the minimum confidence
 */
function tagField(field, tags, knowledge = DEFAULT_KNOWLEDGE) {
    const candidates = tags
        .map(tagInfo => knowledge[tagInfo.code] && scoreTag(field, tagInfo, knowledge[tagInfo.code]))
        .filter(Boolean)
        .sort((left, right) => right.score - left.score);

    const [best, second] = candidates;

    if (!best || best.score < MIN_CONFIDENCE) {
        return {
            tag: null,
            confidence: 0,
            origin: "HEURISTIC",
            reason: best
                ? `Best candidate '${best.tag}' too weak (${Math.round(best.score * 100)}): ${best.notes.join("; ")}`
                : "No semantic tag matches the field name or description",
            alternatives: candidates.slice(0, 3).map(c => c.tag)
        };
    }

    let confidence = best.score;
    const reasons = [...best.notes];

    if (second && second.tag !== best.tag && best.score - second.score <= AMBIGUITY_MARGIN) {
        confidence = Math.min(confidence, 0.70);
        reasons.push(`ambiguous - also matches '${second.tag}'`);
    }

    return {
        tag: best.tag,
        confidence: Math.round(confidence * 100),
        origin: "HEURISTIC",
        reason: reasons.join("; "),
        alternatives: candidates.slice(1, 3).map(c => c.tag)
    };
}

function tagFields(fields, tags, knowledge = DEFAULT_KNOWLEDGE) {
    return fields.map(field => ({
        fieldId: field.ID,
        ...tagField(field, tags, knowledge)
    }));
}

module.exports = {
    tagField,
    tagFields,
    nameTokens,
    HIGH_CONFIDENCE
};
