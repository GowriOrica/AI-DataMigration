"use strict";

const cds = require("@sap/cds");
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

const { validateRule } = require("./lib/cleansing/RuleEngine");
const { previewRules } = require("./lib/cleansing/CleansingPreview");
const { resolveExtractionId, readExtractionRecords, listExtractions } = require("./lib/extraction/ExtractionRunner");
const { getStorage } = require("./lib/storage");

/**
 * Handlers of the cleansing rule library (see srv/cleansing-service.cds).
 * Registered by migration-service.js when the cleansing tables are part of the model.
 */

const MAX_RULES = 2000;

const fail = (status, message) => {
    const error = new Error(message);
    error.status = status;
    throw error;
};

const str = (value) => (value === undefined || value === null ? "" : String(value).trim());

/** A rule as the engine and the template know it  <->  a row of the table. */
const toRule = (row) => ({
    ruleId: row.ruleId, sourceSystem: row.sourceSystem, entity: row.sourceEntity, field: row.field, level: row.level,
    group: row.ruleGroup, rule: row.ruleType, parameter: row.parameter, condition: row.condition,
    order: row.sortOrder, onFailure: row.onFailure, reason: row.reason, owner: row.owner, status: row.status
});

const toRow = (rule) => ({
    ruleId: str(rule.ruleId), sourceSystem: str(rule.sourceSystem) || "*", sourceEntity: str(rule.entity) || "*", field: str(rule.field),
    level: str(rule.level) || "Source", ruleGroup: str(rule.group), ruleType: str(rule.rule).toUpperCase(),
    parameter: str(rule.parameter), condition: str(rule.condition), sortOrder: Number(rule.order) || 1,
    onFailure: str(rule.onFailure), reason: str(rule.reason), owner: str(rule.owner), status: str(rule.status) || "Draft"
});

const parseJson = (text, what) => {
    try {
        return JSON.parse(text);
    } catch (error) {
        return fail(400, `${what} is not valid JSON: ${error.message}`);
    }
};

const norm = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

module.exports = function registerCleansingHandlers(srv) {

    const { CleansingRuleSet, CleansingRule, ValueMapping } = cds.entities("migration.framework");

    /** Registers a handler that turns errors with a status into a clean answer. */
    const on = (event, handler) => srv.on(event, async (req) => {
        try {
            return await handler(req.data, req);
        } catch (error) {
            const status = error.status || 500;

            if (status >= 500) console.error(`[${event}] FAILED:`, error);

            return req.reject(status, error.message || `${event} failed`);
        }
    });

    // ------------------------------------------------------------------ helpers

    const loadSet = async (tx, ruleSetId) => {
        const set = await tx.run(SELECT.one.from(CleansingRuleSet).where({ ID: ruleSetId }));

        return set || fail(404, `Rule set '${ruleSetId}' was not found`);
    };

    const loadRules = async (tx, ruleSetId) =>
        (await tx.run(SELECT.from(CleansingRule).where({ ruleSet_ID: ruleSetId }))).map(toRule);

    const info = (set, message) => ({
        ruleSetId: set.ID, businessObject: set.businessObject, version: set.version, status: set.status, ruleCount: set.ruleCount, message
    });

    const latestSet = async (tx, businessObject, statuses) => {
        const rows = await tx.run(SELECT.from(CleansingRuleSet).where({ businessObject }).orderBy("version desc"));

        return rows.find(r => !statuses || statuses.includes(r.status));
    };

    /** The business object as it is written in the rule sets or in the extractions: found by name. */
    const resolveBusinessObject = async (tx, name) => {
        const sources = [
            async () => (await tx.run(SELECT.from(CleansingRuleSet).columns("businessObject"))).map(r => r.businessObject),
            async () => (await tx.run(SELECT.from("migration.orchestrator.MigrationAssessment").columns("businessObject"))).map(r => r.businessObject),
            async () => (await listExtractions({ storage: getStorage() })).map(m => m.businessObject)
        ];

        for (const source of sources) {
            try {
                const found = (await source()).find(n => n && norm(n) === norm(name));

                if (found) return found;
            } catch (error) {
                // this source is not available (for example no Object Store): try the next one
            }
        }

        return str(name);
    };

    /** Fields per entity from the first records of the latest extraction: lets the check say "did you mean ...?". */
    const knownFieldsByEntity = async (businessObject) => {
        const storage = getStorage();

        try {
            const extractionId = await resolveExtractionId({ storage, businessObject });
            const manifest = JSON.parse((await storage.get(`extractions/${extractionId}/manifest.json`)).toString("utf8"));
            const result = {};

            for (const entry of manifest.objects) {
                const page = await readExtractionRecords({ storage, extractionId, objectName: entry.objectName, skip: 0, top: 200 });
                const fields = new Set();

                (page.records || []).forEach(record => Object.keys(record).forEach(key => { if (!key.startsWith("__")) fields.add(key); }));
                result[entry.objectName] = [...fields];
            }

            return result;
        } catch (error) {
            return {};      // no extraction yet: rules are checked without the field names
        }
    };

    /** Fields of the entity a rule points to (undefined when unknown, so no typo check is made). */
    const fieldsFor = (known, entity) => {
        const wanted = str(entity).split("/")[0].trim();

        return wanted && wanted !== "*" ? known[wanted] : undefined;
    };

    /** Checks all rows: returns the messages per row. Also: duplicate RuleIDs and two rules in the same place and order. */
    const checkRows = (rows, known) => {
        const errors = [];
        const seenIds = new Map();
        const seenSlots = new Map();

        rows.forEach((rule, index) => {
            const messages = validateRule(rule, { knownFields: fieldsFor(known, rule.entity) });
            const id = str(rule.ruleId);

            if (id) {
                if (seenIds.has(id.toLowerCase())) messages.push(`${id}: RuleID is used twice (rows ${seenIds.get(id.toLowerCase())} and ${index + 2})`);
                else seenIds.set(id.toLowerCase(), index + 2);
            }

            const group = str(rule.group);

            if (!["Select", "Validate"].includes(group) && str(rule.field)) {
                const slot = [rule.sourceSystem || "*", rule.entity || "*", rule.field, rule.level || "Source", group, rule.order || 1].join("|").toLowerCase();

                if (seenSlots.has(slot)) messages.push(`${id}: the rule ${seenSlots.get(slot)} already uses the same field, group and Order. Give them different Orders`);
                else seenSlots.set(slot, id);
            }

            if (messages.length) errors.push({ row: index + 2, ruleId: id, messages });      // row 1 of the Excel is the header
        });

        return errors;
    };

    const writeRules = async (tx, set, rows) => {
        if (rows.length) {
            await tx.run(INSERT.into(CleansingRule).entries(rows.map(row => ({ ...toRow(row), ruleSet_ID: set.ID }))));
        }

        await tx.run(UPDATE(CleansingRuleSet).set({ ruleCount: rows.length }).where({ ID: set.ID }));
    };

    const supersedeDrafts = (tx, businessObject, exceptId) =>
        tx.run(UPDATE(CleansingRuleSet).set({ status: "SUPERSEDED" }).where({ businessObject, status: "DRAFT", ID: { "!=": exceptId || "" } }));

    const nextVersion = async (tx, businessObject) => {
        const latest = await latestSet(tx, businessObject);

        return (latest ? latest.version : 0) + 1;
    };

    const createSet = async (tx, req, { businessObject, origin, note, fileKey }) => {
        const set = {
            ID: cds.utils.uuid(), businessObject, version: await nextVersion(tx, businessObject),
            status: "DRAFT", origin, note: note || null, fileKey: fileKey || null, ruleCount: 0
        };

        await tx.run(INSERT.into(CleansingRuleSet).entries(set));
        await supersedeDrafts(tx, businessObject, set.ID);

        return set;
    };

    const requireDraft = (set) => {
        if (set.status !== "DRAFT") fail(409, `Version ${set.version} of '${set.businessObject}' is ${set.status}. Only a draft can be changed. Create a new version first.`);
    };

    // ------------------------------------------------------------------ actions

    on("importCleansingRules", async ({ businessObject, rules, origin, note, fileKey }, req) => {
        const tx = cds.tx(req);

        if (!str(businessObject)) fail(400, "businessObject is required");

        const rows = parseJson(rules || "[]", "rules");

        if (!Array.isArray(rows) || rows.length === 0) fail(400, "rules must be a JSON array with at least one rule");
        if (rows.length > MAX_RULES) fail(413, `A rule set can have at most ${MAX_RULES} rules`);

        const name = await resolveBusinessObject(tx, businessObject);

        // a row that names another business object is a mistake in the file
        const wrongObject = rows.findIndex(r => str(r.businessObject) && norm(r.businessObject) !== norm(name));
        const errors = checkRows(rows, await knownFieldsByEntity(name));

        if (wrongObject >= 0) {
            errors.unshift({ row: wrongObject + 2, ruleId: str(rows[wrongObject].ruleId), messages: [`the row is for the business object '${rows[wrongObject].businessObject}', but the file is imported for '${name}'`] });
        }

        if (errors.length) {
            return {
                status: "REJECTED", ruleSetId: null, version: null, accepted: 0, errors: JSON.stringify(errors),
                message: `Nothing was stored. ${errors.length} of ${rows.length} rule(s) have a problem: ` +
                    errors.slice(0, 5).map(e => `row ${e.row}: ${e.messages.join("; ")}`).join(" | ") + (errors.length > 5 ? ` | and ${errors.length - 5} more` : "")
            };
        }

        const set = await createSet(tx, req, { businessObject: name, origin: str(origin) || "SCREEN", note, fileKey });

        await writeRules(tx, set, rows);

        return {
            status: "CREATED", ruleSetId: set.ID, version: set.version, accepted: rows.length, errors: "[]",
            message: `${rows.length} rule(s) stored as draft version ${set.version} of '${name}'. Check the effect with a preview, then approve.`
        };
    });

    on("upsertCleansingRule", async ({ ruleSetId, rule }, req) => {
        const tx = cds.tx(req);
        const set = await loadSet(tx, ruleSetId);

        requireDraft(set);

        const row = parseJson(rule, "rule");
        const existing = await loadRules(tx, set.ID);
        const known = await knownFieldsByEntity(set.businessObject);
        const others = existing.filter(r => r.ruleId !== str(row.ruleId));
        const errors = checkRows([...others, row], known).filter(e => e.ruleId === str(row.ruleId) || e.messages.some(m => m.includes(str(row.ruleId))));

        if (errors.length) fail(400, errors.flatMap(e => e.messages).join("; "));

        if (existing.some(r => r.ruleId === str(row.ruleId))) {
            await tx.run(UPDATE(CleansingRule).set(toRow(row)).where({ ruleSet_ID: set.ID, ruleId: str(row.ruleId) }));
        } else {
            await tx.run(INSERT.into(CleansingRule).entries({ ...toRow(row), ruleSet_ID: set.ID }));
        }

        const count = (await loadRules(tx, set.ID)).length;

        await tx.run(UPDATE(CleansingRuleSet).set({ ruleCount: count }).where({ ID: set.ID }));

        return info({ ...set, ruleCount: count }, `Rule ${str(row.ruleId)} saved in draft version ${set.version} (${count} rules).`);
    });

    on("deleteCleansingRule", async ({ ruleSetId, ruleId }, req) => {
        const tx = cds.tx(req);
        const set = await loadSet(tx, ruleSetId);

        requireDraft(set);

        const removed = await tx.run(DELETE.from(CleansingRule).where({ ruleSet_ID: set.ID, ruleId }));

        if (!removed) fail(404, `Rule '${ruleId}' is not in version ${set.version}`);

        const count = (await loadRules(tx, set.ID)).length;

        await tx.run(UPDATE(CleansingRuleSet).set({ ruleCount: count }).where({ ID: set.ID }));

        return info({ ...set, ruleCount: count }, `Rule ${ruleId} removed from draft version ${set.version} (${count} rules).`);
    });

    on("approveCleansingRules", async ({ ruleSetId }, req) => {
        const tx = cds.tx(req);
        const set = await loadSet(tx, ruleSetId);

        if (set.status === "APPROVED") fail(409, `Version ${set.version} of '${set.businessObject}' is already approved.`);
        if (set.status === "SUPERSEDED") fail(409, `Version ${set.version} of '${set.businessObject}' was replaced by a newer version and cannot be approved.`);

        const rules = await loadRules(tx, set.ID);

        if (rules.length === 0) fail(409, "A rule set without rules cannot be approved.");

        // the rules are checked again: a draft may have been edited since the upload
        const errors = checkRows(rules, await knownFieldsByEntity(set.businessObject));

        if (errors.length) fail(409, `Not approved. ${errors.length} rule(s) have a problem: ${errors.slice(0, 3).map(e => e.messages.join("; ")).join(" | ")}`);

        await tx.run(UPDATE(CleansingRuleSet).set({ status: "SUPERSEDED" }).where({ businessObject: set.businessObject, status: "APPROVED" }));
        await tx.run(UPDATE(CleansingRuleSet).set({ status: "APPROVED", approvedBy: req.user?.id || null, approvedAt: new Date().toISOString() }).where({ ID: set.ID }));
        await tx.run(UPDATE(CleansingRule).set({ status: "Approved" }).where({ ruleSet_ID: set.ID }));

        return info({ ...set, status: "APPROVED" }, `Version ${set.version} of '${set.businessObject}' is approved (${rules.length} rules). Earlier approved versions are superseded.`);
    });

    on("newCleansingRulesVersion", async ({ businessObject }, req) => {
        const tx = cds.tx(req);
        const name = await resolveBusinessObject(tx, businessObject);
        const latest = await latestSet(tx, name, ["DRAFT", "APPROVED"]);

        if (!latest) fail(404, `'${businessObject}' has no rules yet. Import rules first.`);

        if (latest.status === "DRAFT") fail(409, `Version ${latest.version} of '${name}' is already a draft. Change that one.`);

        const set = await createSet(tx, req, { businessObject: name, origin: "COPY", note: `Copy of version ${latest.version}` });
        const rules = await loadRules(tx, latest.ID);

        await writeRules(tx, set, rules.map(r => ({ ...r, status: "Draft" })));

        return info({ ...set, ruleCount: rules.length }, `Draft version ${set.version} created from version ${latest.version} (${rules.length} rules).`);
    });

    /** Approved value conversions for the domains the rules use: { domain: { fromValue: toValue } }. */
    const loadValueMaps = async (tx, rules, sourceSystem) => {
        const domains = [...new Set(rules.filter(r => String(r.rule).toUpperCase() === "VALUE_MAP").map(r => str(r.parameter)).filter(Boolean))];
        const maps = {};

        if (domains.length === 0) return maps;

        const rows = await tx.run(SELECT.from(ValueMapping).where({ domain: { in: domains }, status: "APPROVED" }));

        rows.filter(r => !sourceSystem || r.fromSystem === sourceSystem || r.fromSystem === "*").forEach(r => {
            (maps[r.domain] = maps[r.domain] || {})[r.fromValue] = r.toValue;
        });

        return maps;
    };

    const sentence = (rule, total) => {
        const what = `${rule.ruleId} ${rule.rule}${rule.field && rule.field !== "(record)" ? " on " + rule.field : ""}`;
        const example = rule.examples.length ? ` (e.g. '${rule.examples[0].before}' -> '${rule.examples[0].after}')` : "";

        if (rule.group === "Select") return `${what}: leaves out ${rule.excluded} of ${total} records.`;
        if (rule.group === "Validate") return `${what}: ${rule.issues} issue(s) in ${rule.evaluated} checked values.`;
        if (rule.group === "Convert") return `${what}: ${rule.changed} value(s) converted, ${rule.issues} without an approved mapping.`;

        return `${what}: ${rule.changed} of ${rule.evaluated} values would change${example}.`;
    };

    on("previewCleansingRules", async ({ businessObject, ruleSetId, extractionId, objectName, sourceSystemId, rules }, req) => {
        const tx = cds.tx(req);
        const storage = getStorage();

        // which rules
        let set = null;
        let rows;

        if (rules) {
            rows = parseJson(rules, "rules");
            if (!Array.isArray(rows)) rows = [rows];
        } else if (ruleSetId) {
            set = await loadSet(tx, ruleSetId);
        } else if (businessObject) {
            set = await latestSet(tx, await resolveBusinessObject(tx, businessObject), ["DRAFT", "APPROVED"]);
            if (!set) fail(404, `'${businessObject}' has no rules yet. Import or create rules first.`);
        } else {
            fail(400, "Give a businessObject, a ruleSetId or rules");
        }

        if (set) rows = await loadRules(tx, set.ID);

        const id = await resolveExtractionId({ storage, extractionId, businessObject: businessObject || set?.businessObject, sourceSystem: sourceSystemId });

        // rules are applied to the source system of the extraction
        const manifest = JSON.parse((await storage.get(`extractions/${id}/manifest.json`)).toString("utf8"));
        const valueMaps = await loadValueMaps(tx, rows, manifest.sourceSystem);
        const result = await previewRules({ storage, extractionId: id, objectName, rules: rows, valueMaps });

        const lines = [
            `${result.businessObject || "Extraction"}, extraction ${id}. ` +
            (set ? `Rule set version ${set.version} (${set.status}).` : "Rules that are not saved yet.") + " Nothing was changed."
        ];

        for (const o of result.objects) {
            lines.push(`${o.objectName}: ${o.input} records, ${o.output} kept, ${o.excluded} left out, ${o.rejected} with errors.`);
            o.rules.forEach(r => lines.push("  " + sentence(r, o.input)));
            o.warnings.forEach(w => lines.push("  WARNING: " + w));
            o.invalidRules.forEach(r => lines.push(`  NOT USED: ${r.errors.join("; ")}`));
        }

        if (!result.objects.some(o => o.rules.length)) {
            lines.push("No rule applies to this extraction (check Source system and Entity of the rules).");
        }

        return {
            extractionId: id, businessObject: result.businessObject, ruleSetId: set?.ID || null,
            ruleSetVersion: set?.version || null, ruleSetStatus: set?.status || null,
            message: lines.join("\n"), objects: JSON.stringify(result.objects)
        };
    });
};
