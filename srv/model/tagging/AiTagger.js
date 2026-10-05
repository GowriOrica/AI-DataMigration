"use strict";

/**
 * ============================================================
 * AI SEMANTIC TAGGER
 * ============================================================
 *
 * Asks the configured AI provider (srv/lib/ai, AI_PROVIDER) to tag
 * fields with semantic tags from the controlled vocabulary.
 *
 * - Sends METADATA ONLY (field names, descriptions, types, structure
 *   names). No record values are sent.
 * - Every answer is validated: unknown field IDs and tags outside the
 *   vocabulary are discarded - AI output never enters the model unchecked.
 * - Provider failures are reported as failures. There is no invented
 *   fallback result; the caller decides whether to use the rule engine.
 */

const BATCH_SIZE = 50;
const PROMPT_VERSION = "tagging-v1";

function buildPrompt(fields, tags) {
    const vocabulary = tags
        .map(tag => `- ${tag.code}: ${tag.description} [${tag.dataClass}]`)
        .join("\n");

    const fieldLines = fields
        .map(field => JSON.stringify({
            id: field.ID,
            structure: field.structureName,
            name: field.name,
            description: field.description || null,
            dataType: field.dataType || null,
            length: field.length || null,
            isKey: field.isKey === true
        }))
        .join("\n");

    return `You classify fields of enterprise data structures (ERP business objects) with semantic tags.

Use ONLY tags from this vocabulary:
${vocabulary}

Rules:
- Choose the single best tag per field, or null if no tag fits (technical fields, sequence numbers, timestamps, references to other objects).
- Identifier tags (*.id, *.legacyId, *.accountId) apply only to key fields.
- Use the structure name as context (e.g. payment terms in a sales structure -> sales.paymentTerms).
- confidence is 0-100. Use below 85 when unsure or when two tags are plausible.
- reason: one short sentence.

Fields (one JSON object per line):
${fieldLines}

Return ONLY JSON in this form:
{"results":[{"id":"<field id>","tag":"<tag code or null>","confidence":<0-100>,"reason":"<text>"}]}`;
}

/**
 * Providers differ in their return shape:
 *   GeminiProvider.generateJSON      -> parsed object
 *   OpenRouterProvider.generateJSON  -> { data, usage }
 */
function unwrap(response) {
    if (response && typeof response === "object" && "data" in response && "usage" in response) {
        return { payload: response.data, usage: response.usage || {} };
    }

    return { payload: response, usage: {} };
}

function validate(payload, fields, tagCodes) {
    const fieldIds = new Set(fields.map(field => field.ID));
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const accepted = new Map();
    let discarded = 0;

    for (const result of results) {
        if (!result || !fieldIds.has(result.id)) {
            discarded++;
            continue;
        }

        const tag = result.tag === null || result.tag === "null" ? null : result.tag;

        if (tag !== null && !tagCodes.has(tag)) {
            discarded++;
            continue;
        }

        const confidence = Math.max(0, Math.min(100, Math.round(Number(result.confidence) || 0)));

        accepted.set(result.id, {
            fieldId: result.id,
            tag,
            confidence: tag ? confidence : 0,
            origin: "AI",
            reason: String(result.reason || "").slice(0, 1000) || null
        });
    }

    return { accepted, discarded };
}

/**
 * @param {Object[]} fields  { ID, name, description, dataType, length, isKey, structureName }
 * @param {Object[]} tags    { code, description, dataClass }
 * @param {Object}   provider  object with generateJSON(prompt, options)
 * @returns {{ results: Object[], discarded: number, usage: Object, promptVersion: string }}
 */
async function tagFieldsWithAi(fields, tags, provider) {
    if (!provider || typeof provider.generateJSON !== "function") {
        throw new Error("An AI provider with generateJSON() is required");
    }

    const tagCodes = new Set(tags.map(tag => tag.code));
    const results = [];
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let discarded = 0;

    for (let offset = 0; offset < fields.length; offset += BATCH_SIZE) {
        const batch = fields.slice(offset, offset + BATCH_SIZE);
        const response = await provider.generateJSON(buildPrompt(batch, tags), { temperature: 0.1 });
        const { payload, usage: batchUsage } = unwrap(response);
        const validated = validate(payload, batch, tagCodes);

        results.push(...validated.accepted.values());
        discarded += validated.discarded;

        usage.inputTokens += batchUsage.prompt_tokens || 0;
        usage.outputTokens += batchUsage.completion_tokens || 0;
        usage.totalTokens += batchUsage.total_tokens || 0;
    }

    return { results, discarded, usage, promptVersion: PROMPT_VERSION };
}

module.exports = {
    tagFieldsWithAi,
    buildPrompt,
    PROMPT_VERSION
};
