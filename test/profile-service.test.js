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
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mo-profile-"));

const cds = require("@sap/cds");

const { POST } = cds.test(
    "serve",
    "srv/migration-service.cds",
    "srv/framework-service.cds",
    "--in-memory"
).in(path.join(__dirname, ".."));

const SYSTEM = "M3_PR";
const profile = (data) => POST("/migration/profileExtraction", data);

describe("Profiling of an extraction (service action)", () => {

    let extractionId;

    before(async () => {
        const systemId = cds.utils.uuid();

        await INSERT.into("migration.orchestrator.SourceSystem").entries({ ID: systemId, systemId: SYSTEM, systemName: "M3 profile test", systemType: "M3", active: true });
        await INSERT.into("migration.orchestrator.SourceConnection").entries({
            connectionId: "M3_PR_CONN", connectionName: "M3 mock", interfaceType: "M3_MI",
            adapterType: "M3", authenticationType: "MOCK", status: "CONNECTED", sourceSystem_ID: systemId
        });

        const confirmed = (sourceObject) => ({
            sourceSystemId: SYSTEM, sourceObject, businessObject: "Business Partner", component: "Master Data",
            confidence: 90, status: "COMPLETED", metadataVersion: "1.0", reviewStatus: "CONFIRMED"
        });

        await INSERT.into("migration.orchestrator.MigrationAssessment").entries([
            confirmed("CRS610MI.LstByNumber"),
            confirmed("OIS002MI.LstAddress")
        ]);

        const { data } = await POST("/migration/extractToObjectStore", { sourceSystemId: SYSTEM, businessObject: "Business Partner" });
        extractionId = data.extractionId;
    });

    it("profiles the latest extraction by business object name", async () => {
        const { data } = await profile({ businessObject: "business partner" });

        assert.equal(data.extractionId, extractionId);
        assert.equal(data.apiCount, 2);
        assert.equal(data.totalRecords, 8);
        assert.match(data.message, /^Business Partner, extraction EX-/);
        assert.match(data.message, /CRS610MI\.LstByNumber: 5 records/);
        assert.match(data.message, /OIS002MI\.LstAddress: 3 records/);
        assert.match(data.message, /Indicative quality score \d+ \/ 100/);

        const objects = JSON.parse(data.objects);

        assert.deepEqual(objects.map(o => o.objectName), ["CRS610MI.LstByNumber", "OIS002MI.LstAddress"]);
        assert.ok(objects[0].fields.length > 0);
        assert.ok(objects[0].score.value >= 0);
    });

    it("profiles one API when asked", async () => {
        const { data } = await profile({ businessObject: "Business Partner", objectName: "OIS002MI.LstAddress" });

        assert.equal(data.apiCount, 1);
        assert.equal(data.totalRecords, 3);
    });

    it("works with an extraction ID as well", async () => {
        const { data } = await profile({ extractionId });

        assert.equal(data.extractionId, extractionId);
    });

    it("explains what is possible when it cannot decide", async () => {
        await assert.rejects(profile({ businessObject: "Material" }), /404.*Business objects with an extraction: Business Partner/);
        await assert.rejects(profile({}), /400/);
        await assert.rejects(profile({ extractionId: "EX-NOPE" }), /404/);
        await assert.rejects(profile({ businessObject: "Business Partner", objectName: "NOPE" }), /404/);
    });
});
