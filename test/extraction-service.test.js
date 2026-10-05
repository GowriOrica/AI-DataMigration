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

const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mo-extract-service-"));
process.env.STORAGE_DIR = STORAGE_DIR;

const cds = require("@sap/cds");

const { GET, POST } = cds.test(
    "serve",
    "srv/migration-service.cds",
    "srv/framework-service.cds",
    "--in-memory"
).in(path.join(__dirname, ".."));

const SYSTEM = "M3_X";

const extract = (data) => POST("/migration/extractToObjectStore", { sourceSystemId: SYSTEM, ...data });
const review = (sourceObject, decision) => POST("/migration/reviewAssessment", { sourceSystemId: SYSTEM, sourceObject, decision });

describe("Extraction of confirmed APIs into the storage", () => {

    let extractionId;

    before(async () => {
        const systemId = cds.utils.uuid();

        await INSERT.into("migration.orchestrator.SourceSystem").entries({
            ID: systemId, systemId: SYSTEM, systemName: "M3 extraction test", systemType: "M3", active: true
        });
        await INSERT.into("migration.orchestrator.SourceConnection").entries({
            connectionId: "M3_X_CONN", connectionName: "M3 mock", interfaceType: "M3_MI",
            adapterType: "M3", authenticationType: "MOCK", status: "CONNECTED", sourceSystem_ID: systemId
        });

        const assessed = (sourceObject) => ({
            sourceSystemId: SYSTEM, sourceObject, businessObject: "Business Partner",
            component: "Master Data", confidence: 90, status: "COMPLETED", metadataVersion: "1.0"
        });

        await INSERT.into("migration.orchestrator.MigrationAssessment").entries([
            assessed("CRS610MI.LstByNumber"),
            assessed("OIS002MI.LstAddress"),
            assessed("MMS200MI.LstItmByItm")        // stays unconfirmed
        ]);
    });

    it("refuses to extract while nothing is confirmed (governance)", async () => {
        await assert.rejects(extract({ businessObject: "Business Partner" }), /409/);
    });

    it("requires a business object or an explicit list", async () => {
        await assert.rejects(extract({}), /400/);
    });

    it("extracts only the CONFIRMED APIs of the business object", async () => {
        await review("CRS610MI.LstByNumber", "CONFIRM");
        await review("OIS002MI.LstAddress", "CONFIRM");

        const { data } = await extract({ businessObject: "Business Partner", pageSize: 2 });

        extractionId = data.extractionId;

        assert.equal(data.status, "COMPLETED");
        assert.equal(data.objectCount, 2);                     // MMS200MI was not confirmed
        assert.equal(data.totalRecords, 8);                    // 5 headers + 3 addresses
        assert.equal(data.totalPages, 5);                      // page size 2
        assert.match(data.storage, /^LOCAL /);

        const runDir = path.join(STORAGE_DIR, "extractions", extractionId);

        assert.deepEqual(fs.readdirSync(runDir).sort(), ["CRS610MI.LstByNumber", "OIS002MI.LstAddress", "manifest.json"]);
        assert.equal(fs.readdirSync(path.join(runDir, "CRS610MI.LstByNumber")).length, 3);
    });

    it("verifies the files, and detects a change", async () => {
        const { data: ok } = await POST("/migration/verifyExtraction", { extractionId });

        assert.equal(ok.status, "OK");
        assert.equal(ok.filesChecked, 5);

        const file = path.join(STORAGE_DIR, "extractions", extractionId, "OIS002MI.LstAddress", "page-00001.ndjson.gz");

        fs.writeFileSync(file, Buffer.from("not the original"));

        const { data: broken } = await POST("/migration/verifyExtraction", { extractionId });

        assert.equal(broken.status, "CHANGED");
        assert.match(JSON.parse(broken.mismatches)[0].key, /OIS002MI\.LstAddress\/page-00001/);
    });

    it("lists the extractions of a business object", async () => {
        const { data } = await POST("/migration/listExtractions", { sourceSystemId: SYSTEM, businessObject: "Business Partner" });

        const found = data.value.find(e => e.extractionId === extractionId);

        assert.ok(found);
        assert.equal(found.totalRecords, 8);
        assert.deepEqual(JSON.parse(found.objects).map(o => o.objectName), ["CRS610MI.LstByNumber", "OIS002MI.LstAddress"]);

        // the way a person (or Joule) types it
        const { data: loose } = await POST("/migration/listExtractions", { sourceSystemId: SYSTEM, businessObject: "business  partner" });

        assert.ok(loose.value.some(e => e.extractionId === extractionId));

        const { data: none } = await POST("/migration/listExtractions", { sourceSystemId: SYSTEM, businessObject: "Material" });

        assert.equal(none.value.length, 0);
    });

    it("reads records back across pages (skip / top)", async () => {
        const read = (skip, top) => POST("/migration/readExtractionRecords", { extractionId, objectName: "CRS610MI.LstByNumber", skip, top });

        const { data: all } = await read(0, 50);

        assert.equal(all.totalRecords, 5);
        assert.equal(JSON.parse(all.records).length, 5);

        const { data: part } = await read(3, 2);   // pages hold 2 records: crosses page 2 -> 3
        const allRecords = JSON.parse(all.records);

        assert.deepEqual(JSON.parse(part.records), allRecords.slice(3, 5));

        await assert.rejects(POST("/migration/readExtractionRecords", { extractionId, objectName: "NOPE" }), /404/);
    });

    it("reports an unknown extraction", async () => {
        const { data } = await POST("/migration/verifyExtraction", { extractionId: "EX-DOES-NOT-EXIST" });

        assert.equal(data.status, "NOT_FOUND");
    });

    it("accepts an explicit list and a record limit, and reports truncation", async () => {
        const { data } = await extract({ objectNames: ["CRS610MI.LstByNumber"], pageSize: 2, maxRecordsPerObject: 3 });

        assert.equal(data.totalRecords, 3);
        assert.equal(data.truncatedObjects, 1);
        assert.match(data.message, /stopped at the record limit/);
    });

    it("shows extractions in the storage browser", async () => {
        const { data } = await GET("/framework/StorageFolders");

        assert.ok(data.value.some(folder => folder.description === `Extraction ${extractionId}`));
    });
});
