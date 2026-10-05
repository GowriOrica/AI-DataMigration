"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.CDS_PLUGIN_UI5_ACTIVE = "false";
process.env.AI_PROVIDER = "OPENROUTER";
process.env.OPENROUTER_API_KEY = "fake-key-for-tests";
process.env.OPENROUTER_MODEL = "fake/model";
process.env.GEMINI_API_KEY = "fake-key-for-tests";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mo-cleansing-"));

const cds = require("@sap/cds");

const { GET, POST } = cds.test(
    "serve",
    "srv/migration-service.cds",
    "srv/cleansing-service.cds",
    "srv/framework-service.cds",
    "--in-memory"
).in(path.join(__dirname, ".."));

const SYSTEM = "M3_CL";
const BO = "Business Partner";
const call = (action, data) => POST(`/migration/${action}`, data);

const rule = (overrides) => ({
    ruleId: "R1", sourceSystem: "*", entity: "CRS610MI.LstByNumber", field: "CUNM", level: "Source", group: "Standardise",
    rule: "TRIM", order: 1, status: "Draft", ...overrides
});

const good = [
    rule({ ruleId: "BP-001", field: "RGDT", rule: "DATE_TO_ISO", parameter: "YYYYMMDD" }),
    rule({ ruleId: "BP-002", field: "TOWN", rule: "UPPER" }),
    rule({ ruleId: "BP-003", field: "", group: "Select", rule: "INCLUDE_IF", condition: "CONO = '100'" })
];

describe("Cleansing rule library", () => {

    before(async () => {
        const systemId = cds.utils.uuid();

        await INSERT.into("migration.orchestrator.SourceSystem").entries({ ID: systemId, systemId: SYSTEM, systemName: "M3 cleansing test", systemType: "M3", active: true });
        await INSERT.into("migration.orchestrator.SourceConnection").entries({
            connectionId: "M3_CL_CONN", connectionName: "M3 mock", interfaceType: "M3_MI",
            adapterType: "M3", authenticationType: "MOCK", status: "CONNECTED", sourceSystem_ID: systemId
        });
        await INSERT.into("migration.orchestrator.MigrationAssessment").entries([{
            sourceSystemId: SYSTEM, sourceObject: "CRS610MI.LstByNumber", businessObject: BO, component: "Master Data",
            confidence: 90, status: "COMPLETED", metadataVersion: "1.0", reviewStatus: "CONFIRMED"
        }]);

        await call("extractToObjectStore", { sourceSystemId: SYSTEM, businessObject: BO });
    });

    it("stores nothing when a row is wrong, and says which row and why", async () => {
        const { data } = await call("importCleansingRules", {
            businessObject: BO,
            rules: JSON.stringify([good[0], rule({ ruleId: "BAD-1", rule: "PAD_LEFT" }), rule({ ruleId: "BAD-2", field: "TOWNN", rule: "TRIM" })])
        });

        assert.equal(data.status, "REJECTED");
        assert.equal(data.accepted, 0);

        const errors = JSON.parse(data.errors);

        assert.deepEqual(errors.map(e => e.row), [3, 4]);                                 // row 1 of the Excel is the header
        assert.match(errors[0].messages[0], /rule 'PAD_LEFT' does not exist/);
        assert.match(errors[1].messages[0], /field 'TOWNN' does not exist in this entity, did you mean 'TOWN'\?/);   // from the real extraction

        const { data: sets } = await GET("/migration/CleansingRuleSets");

        assert.equal(sets.value.length, 0);
    });

    it("finds duplicate RuleIDs and two rules in the same place and order", async () => {
        const { data } = await call("importCleansingRules", {
            businessObject: BO,
            rules: JSON.stringify([good[0], good[0], rule({ ruleId: "X1" }), rule({ ruleId: "X2", rule: "UPPER" })])
        });
        const text = JSON.parse(data.errors).flatMap(e => e.messages).join(" | ");

        assert.match(text, /RuleID is used twice/);
        assert.match(text, /already uses the same field, group and Order/);
    });

    it("stores good rules as draft version 1", async () => {
        const { data } = await call("importCleansingRules", { businessObject: "business partner", rules: JSON.stringify(good), origin: "EXCEL", note: "first upload" });

        assert.equal(data.status, "CREATED");
        assert.equal(data.version, 1);
        assert.equal(data.accepted, 3);

        const { data: sets } = await GET("/migration/CleansingRuleSets");

        assert.equal(sets.value[0].status, "DRAFT");
        assert.equal(sets.value[0].origin, "EXCEL");
        assert.equal(sets.value[0].ruleCount, 3);

        const { data: rules } = await GET("/migration/CleansingRules");

        assert.equal(rules.value.length, 3);
        assert.equal(rules.value.find(r => r.ruleId === "BP-003").ruleType, "INCLUDE_IF");
    });

    it("previews the draft on the extracted data, in plain words", async () => {
        const { data } = await call("previewCleansingRules", { businessObject: BO });

        assert.match(data.message, /Rule set version 1 \(DRAFT\)\. Nothing was changed\./);
        assert.match(data.message, /CRS610MI\.LstByNumber: 5 records, 4 kept, 1 left out/);
        assert.match(data.message, /BP-001 DATE_TO_ISO on RGDT: 4 of 4 values would change \(e\.g\. '\d{8}' -> '\d{4}-\d{2}-\d{2}'\)/);
        assert.match(data.message, /BP-003 INCLUDE_IF: leaves out 1 of 5 records/);

        const objects = JSON.parse(data.objects);

        assert.equal(objects[0].rules.find(r => r.ruleId === "BP-002").rule, "UPPER");
    });

    it("previews a rule that is not saved yet", async () => {
        const { data } = await call("previewCleansingRules", { businessObject: BO, rules: JSON.stringify([rule({ ruleId: "NEW", field: "TOWN", rule: "TITLE" })]) });

        assert.match(data.message, /Rules that are not saved yet/);
        assert.match(data.message, /NEW TITLE on TOWN/);
        assert.equal(data.ruleSetId, null);
    });

    it("warns in the preview when a rule leaves out every record", async () => {
        const { data } = await call("previewCleansingRules", { businessObject: BO, rules: JSON.stringify([rule({ ruleId: "ALL", field: "", group: "Select", rule: "INCLUDE_IF", condition: "CONO = '999'" })]) });

        assert.match(data.message, /WARNING: Rule ALL leaves out every record/);
    });

    it("uses the approved value mappings for VALUE_MAP", async () => {
        await INSERT.into("migration.framework.ValueMapping").entries([
            { domain: "Currency", fromSystem: SYSTEM, toSystem: "CLEANSED", fromValue: "AUD", toValue: "AUD-X", status: "APPROVED" },
            { domain: "Currency", fromSystem: SYSTEM, toSystem: "CLEANSED", fromValue: "USD", toValue: "USD-X", status: "SUGGESTED" }
        ]);

        const { data } = await call("previewCleansingRules", {
            businessObject: BO,
            rules: JSON.stringify([rule({ ruleId: "VM", field: "CUCD", group: "Convert", rule: "VALUE_MAP", parameter: "Currency" })])
        });

        assert.match(data.message, /VM VALUE_MAP on CUCD: \d+ value\(s\) converted, \d+ without an approved mapping/);

        const o = JSON.parse(data.objects)[0].rules[0];

        assert.ok(o.changed > 0);                          // AUD is approved
        assert.ok(o.issues >= 0);
    });

    it("approves a version, and a newer approval supersedes it", async () => {
        const { data: sets } = await GET("/migration/CleansingRuleSets?$filter=version eq 1");
        const { data: approved } = await call("approveCleansingRules", { ruleSetId: sets.value[0].ID });

        assert.equal(approved.status, "APPROVED");
        assert.match(approved.message, /Version 1 of 'Business Partner' is approved \(3 rules\)/);

        const { data: after } = await GET("/migration/CleansingRuleSets?$filter=version eq 1");

        assert.ok(after.value[0].approvedAt);
        assert.ok(after.value[0].approvedBy);

        const { data: rules } = await GET(`/migration/CleansingRules?$filter=ruleSet_ID eq ${sets.value[0].ID}`);

        assert.ok(rules.value.every(r => r.status === "Approved"));
        await assert.rejects(call("approveCleansingRules", { ruleSetId: sets.value[0].ID }), /already approved/);
    });

    it("does not let an approved version be changed; a new version is a copy", async () => {
        const { data: sets } = await GET("/migration/CleansingRuleSets?$filter=version eq 1");
        const id = sets.value[0].ID;

        await assert.rejects(call("upsertCleansingRule", { ruleSetId: id, rule: JSON.stringify(rule({ ruleId: "BP-009" })) }), /409.*Only a draft can be changed/);
        await assert.rejects(call("deleteCleansingRule", { ruleSetId: id, ruleId: "BP-001" }), /409/);

        const { data: copy } = await call("newCleansingRulesVersion", { businessObject: BO });

        assert.equal(copy.version, 2);
        assert.equal(copy.status, "DRAFT");
        assert.equal(copy.ruleCount, 3);
        await assert.rejects(call("newCleansingRulesVersion", { businessObject: BO }), /already a draft/);
    });

    it("edits a draft rule by rule, and approving version 2 supersedes version 1", async () => {
        const { data: sets } = await GET("/migration/CleansingRuleSets?$filter=version eq 2");
        const id = sets.value[0].ID;

        const { data: added } = await call("upsertCleansingRule", { ruleSetId: id, rule: JSON.stringify(rule({ ruleId: "BP-004", field: "CUNM", rule: "TRIM" })) });

        assert.equal(added.ruleCount, 4);

        const { data: changed } = await call("upsertCleansingRule", { ruleSetId: id, rule: JSON.stringify(rule({ ruleId: "BP-004", field: "CUNM", rule: "TITLE", order: 2 })) });

        assert.equal(changed.ruleCount, 4);                                               // updated, not added

        await assert.rejects(call("upsertCleansingRule", { ruleSetId: id, rule: JSON.stringify(rule({ ruleId: "BP-005", rule: "NOPE" })) }), /400.*does not exist/);

        const { data: removed } = await call("deleteCleansingRule", { ruleSetId: id, ruleId: "BP-004" });

        assert.equal(removed.ruleCount, 3);

        await call("approveCleansingRules", { ruleSetId: id });

        const { data: all } = await GET("/migration/CleansingRuleSets?$orderby=version");

        assert.deepEqual(all.value.map(s => `${s.version}:${s.status}`), ["1:SUPERSEDED", "2:APPROVED"]);
    });

    it("explains when there are no rules or no extraction", async () => {
        await assert.rejects(call("previewCleansingRules", { businessObject: "Material" }), /404.*no rules yet/);
        await assert.rejects(call("previewCleansingRules", {}), /400/);
        await assert.rejects(call("importCleansingRules", { businessObject: BO, rules: "[]" }), /400/);
        await assert.rejects(call("importCleansingRules", { businessObject: BO, rules: "not json" }), /not valid JSON/);
    });
});
