"use strict";

/**
 * ============================================================
 * ANSWER KEY SCORING
 * ============================================================
 *
 * Compares the AI's business object per API with an answer key.
 * Pure function - used by the evaluation script and by tests.
 *
 * Outcome per API:
 *   CORRECT   the answer matches one of the accepted names
 *   UNCLEAR   the AI said "Unclear" (an honest "don't know": not counted as wrong)
 *   WRONG     anything else
 *   MISSING   the AI gave no answer for the API (reported as noAnswer, e.g. a failed request)
 *
 * Extra metric: falseBusinessPartner = APIs that are NOT business partner
 * APIs but were classified as "Business Partner" (the typical weak-model error).
 */

const normalize = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function scoreAssessments(entries, answers) {
    const byApi = new Map((answers || []).map(answer => [answer.sourceObject, answer]));
    const rows = [];

    for (const entry of entries) {
        const answer = byApi.get(entry.api);
        const given = answer ? answer.businessObject : null;

        let outcome;

        if (!answer) {
            outcome = "MISSING";
        } else if (normalize(given) === "unclear") {
            outcome = "UNCLEAR";
        } else if ((entry.accept || []).some(name => normalize(name) === normalize(given))) {
            outcome = "CORRECT";
        } else {
            outcome = "WRONG";
        }

        rows.push({
            api: entry.api,
            expected: (entry.accept || []).join(" | "),
            given,
            confidence: answer ? Number(answer.confidence) : null,
            outcome,
            falseBusinessPartner:
                entry.notBusinessPartner === true && normalize(given) === "businesspartner"
        });
    }

    const count = (outcome) => rows.filter(row => row.outcome === outcome).length;
    const total = rows.length;
    const answered = total - count("UNCLEAR") - count("MISSING");

    return {
        rows,
        summary: {
            total,
            correct: count("CORRECT"),
            wrong: count("WRONG"),
            noAnswer: count("MISSING"),   // e.g. the AI request failed - not the same as a wrong answer
            unclear: count("UNCLEAR"),
            correctPercent: total === 0 ? 0 : Math.round((count("CORRECT") / total) * 100),
            // of the answers the AI was willing to give: how many were right
            precisionPercent: answered === 0 ? 0 : Math.round((count("CORRECT") / answered) * 100),
            falseBusinessPartner: rows.filter(row => row.falseBusinessPartner).length,
            notBusinessPartnerTotal: entries.filter(entry => entry.notBusinessPartner).length
        }
    };
}

module.exports = {
    scoreAssessments,
    normalize
};
