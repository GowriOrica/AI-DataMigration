"use strict";

const zlib = require("zlib");
const { manifestKey } = require("../extraction/ExtractionRunner");
const { RuleRunner } = require("./RuleEngine");

/**
 * ============================================================
 * PREVIEW OF CLEANSING RULES ON AN EXTRACTION
 * ============================================================
 *
 * Runs rules over the extracted files (page by page, nothing is kept in memory) and answers,
 * per API and per rule: how many values would change, how many records are left out, how many
 * issues, with before / after examples. Nothing is written: not to the extraction, not to the source.
 * Rules may be drafts: a preview is how a person decides whether to approve them.
 */

async function previewRules({ storage, extractionId, objectName, rules, valueMaps = {}, examples = 3 }) {
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
        const runner = new RuleRunner({ rules, sourceSystem: manifest.sourceSystem, entity: entry.objectName, valueMaps, keepRecords: false, examples });

        for (const file of entry.files || []) {
            const lines = zlib.gunzipSync(await storage.get(file.key)).toString("utf8").split("\n");

            for (const line of lines) {
                if (line) {
                    runner.process(JSON.parse(line));
                }
            }
        }

        const { records, ...result } = runner.result();

        objects.push({ objectName: entry.objectName, truncated: !!entry.truncated, ...result });
    }

    return {
        extractionId,
        businessObject: manifest.businessObject || null,
        sourceSystem: manifest.sourceSystem || null,
        objects
    };
}

module.exports = { previewRules };
