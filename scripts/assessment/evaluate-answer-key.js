"use strict";

/**
 * ============================================================
 * EVALUATE THE AI ASSESSMENT AGAINST THE ANSWER KEY
 * ============================================================
 *
 * Sends the APIs of test/fixtures/assessment-answer-key.json to the
 * configured AI provider (AI_PROVIDER in .env) and scores the answers.
 *
 * - Reads the already discovered metadata (SourceObject / SourceField).
 * - Sends API names, descriptions and field metadata only - no records.
 * - Writes NOTHING to the database (answers are only scored and printed).
 *
 * Usage (project folder, CF CLI logged in to the account of the HANA/HDI,
 *        HANA Cloud running):
 *
 *   node scripts/assessment/evaluate-answer-key.js                  new prompt (catalog + "Unclear")
 *   node scripts/assessment/evaluate-answer-key.js --legacy         previous prompt, for comparison
 *   node scripts/assessment/evaluate-answer-key.js --system S4SOURCE01
 *
 * Run it whenever the AI model or the prompt changes (e.g. once when production
 * switches to Claude Sonnet) and compare the numbers.
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

if (args.includes("--legacy")) {
    process.env.ASSESSMENT_PROMPT = "legacy";
}

process.env.CDS_ENV = process.env.CDS_ENV || "hybrid";
process.chdir(path.join(__dirname, "..", ".."));

const cds = require("@sap/cds");

const systemId = option("--system", "S4SOURCE01");
const keyFile = path.join(process.cwd(), "test", "fixtures", "assessment-answer-key.json");

async function main() {
    const { entries } = JSON.parse(fs.readFileSync(keyFile, "utf8"));

    // database access with this project's CAP instance
    cds.model = cds.compile.for.nodejs(await cds.load("*"));
    await cds.connect.to("db");

    const { SELECT } = cds.ql;     // (the CAP globals SELECT/INSERT/... are available too)

    const service = require("../../srv/lib/ai/BusinessObjectAssessmentService");
    const { scoreAssessments } = require("../../srv/lib/assessment/AnswerKey");
    const { SourceSystem, SourceObject } = cds.entities("migration.orchestrator");

    const db = cds.db;
    const sourceSystem = await db.run(SELECT.one.from(SourceSystem).where({ systemId }));

    if (!sourceSystem) {
        throw new Error(`Source system '${systemId}' was not found`);
    }

    let known = [];

    try {
        const { BusinessObjectType } = cds.entities("migration.framework");
        known = (await db.run(SELECT.from(BusinessObjectType).columns("name"))).map(type => type.name);
    } catch (error) {
        // no catalog deployed
    }

    const legacy = process.env.ASSESSMENT_PROMPT === "legacy";

    console.log(`Answer key: ${entries.length} APIs | system ${systemId} | prompt: ${legacy ? "legacy" : "catalog + Unclear"} | provider ${process.env.AI_PROVIDER || "?"}`);
    console.log(`Known business objects given to the AI: ${legacy ? "(legacy prompt: none)" : known.join(", ") || "(none)"}\n`);

    // contexts from the discovered metadata
    const contexts = [];
    const skipped = [];

    for (const entry of entries) {
        const sourceObject = await db.run(
            SELECT.one.from(SourceObject).where({ sourceSystem_ID: sourceSystem.ID, objectName: entry.api })
        );

        if (!sourceObject) {
            skipped.push(`${entry.api} (not discovered)`);
            continue;
        }

        try {
            contexts.push(await service.prepareObjectContext(sourceSystem, sourceObject, { run: (query) => db.run(query) }));
        } catch (error) {
            skipped.push(`${entry.api} (${error.message})`);
        }
    }

    if (skipped.length > 0) {
        console.log(`Skipped: ${skipped.join("; ")}\n`);
    }

    // ask the AI, batch by batch (nothing is saved)
    const answers = [];
    const usage = { prompt: 0, completion: 0, total: 0 };

    for (const batch of service.buildAssessmentBatches(contexts)) {
        try {
            const result = await service.assessBatch(batch, null, legacy ? [] : known);

            answers.push(...result.assessments);
            usage.prompt += result.usage?.prompt_tokens || 0;
            usage.completion += result.usage?.completion_tokens || 0;
            usage.total += result.usage?.total_tokens || 0;
        } catch (error) {
            console.error(`Batch failed: ${error.message}`);
        }
    }

    const scored = scoreAssessments(
        entries.filter(entry => contexts.some(context => context.sourceObject.objectName === entry.api)),
        answers
    );

    const pad = (text, width) => String(text ?? "").padEnd(width).slice(0, width);

    console.log(pad("API", 34) + pad("EXPECTED", 38) + pad("AI SAID", 34) + pad("CONF", 6) + "RESULT");

    for (const row of scored.rows) {
        console.log(
            pad(row.api, 34) + pad(row.expected, 38) + pad(row.given, 34) + pad(row.confidence, 6) +
            row.outcome + (row.falseBusinessPartner ? "  (false Business Partner)" : "")
        );
    }

    const s = scored.summary;

    console.log(`
SUMMARY (${legacy ? "legacy prompt" : "catalog + Unclear prompt"})
  correct   : ${s.correct}/${s.total}  (${s.correctPercent}%)
  wrong     : ${s.wrong}
  no answer : ${s.noAnswer}   (AI request failed - repeat the run before comparing)
  unclear   : ${s.unclear}   (honest "don't know")
  of the answers given, correct: ${s.precisionPercent}%
  false "Business Partner" (APIs that are not BP): ${s.falseBusinessPartner} of ${s.notBusinessPartnerTotal}
  tokens    : ${usage.total} (in ${usage.prompt}, out ${usage.completion})`);
}

main().then(() => process.exit(0)).catch(error => {
    console.error(`\nEvaluation failed: ${error.message}`);
    process.exit(1);
});
