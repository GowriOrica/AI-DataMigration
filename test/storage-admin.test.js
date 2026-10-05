"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

process.env.CDS_PLUGIN_UI5_ACTIVE = "false";
process.env.AI_PROVIDER = "OPENROUTER";
process.env.OPENROUTER_API_KEY = "fake-key-for-tests";
process.env.OPENROUTER_MODEL = "fake/model";
process.env.GEMINI_API_KEY = "fake-key-for-tests";

const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mo-storage-admin-"));
process.env.STORAGE_DIR = STORAGE_DIR;

const cds = require("@sap/cds");

const { POST } = cds.test(
    "serve",
    "srv/migration-service.cds",
    "srv/storage-admin-service.cds",
    "srv/framework-service.cds",
    "--in-memory"
).in(path.join(__dirname, ".."));

const SYSTEM = "M3_SA";
const call = (action, data = {}) => POST(`/migration/${action}`, data);
const put = (key, content) => {
    const file = path.join(STORAGE_DIR, ...key.split("/"));

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
};

describe("Object Store administration", () => {

    let extractionId;

    before(async () => {
        const systemId = cds.utils.uuid();

        await INSERT.into("migration.orchestrator.SourceSystem").entries({ ID: systemId, systemId: SYSTEM, systemName: "M3 storage test", systemType: "M3", active: true });
        await INSERT.into("migration.orchestrator.SourceConnection").entries({
            connectionId: "M3_SA_CONN", connectionName: "M3 mock", interfaceType: "M3_MI",
            adapterType: "M3", authenticationType: "MOCK", status: "CONNECTED", sourceSystem_ID: systemId
        });
        await INSERT.into("migration.orchestrator.MigrationAssessment").entries([
            { sourceSystemId: SYSTEM, sourceObject: "CRS610MI.LstByNumber", businessObject: "Business Partner", component: "Master Data", confidence: 90, status: "COMPLETED", metadataVersion: "1.0", reviewStatus: "CONFIRMED" },
            { sourceSystemId: SYSTEM, sourceObject: "OIS002MI.LstAddress", businessObject: "Business Partner", component: "Master Data", confidence: 90, status: "COMPLETED", metadataVersion: "1.0", reviewStatus: "CONFIRMED" }
        ]);

        const { data } = await call("extractToObjectStore", { sourceSystemId: SYSTEM, businessObject: "Business Partner", pageSize: 2 });
        extractionId = data.extractionId;

        await call("exportExtractionToExcel", { extractionId });

        // a preview run, and an extraction that was interrupted (files but no manifest)
        put("preview-runs/RUN-1/summary.json", JSON.stringify({ ok: true }));
        put("extractions/EX-INTERRUPTED/API_X/page-00001.ndjson.gz", zlib.gzipSync(Buffer.from('{"A":1}')));
    });

    it("summarises files, size, extractions and exports", async () => {
        const { data } = await call("getObjectStoreOverview");

        assert.equal(data.storageKind, "LOCAL");
        assert.ok(data.totalFiles >= 9);
        assert.ok(data.totalBytes > 0);
        assert.match(data.sizeText, /(B|KB|MB)$/);
        assert.equal(data.extractionCount, 2);                  // the real one and the interrupted one
        assert.equal(data.exportCount, 1);

        const areas = JSON.parse(data.areas);

        assert.deepEqual(areas.map(a => a.area).sort(), ["exports", "extractions", "preview-runs"]);
        assert.equal(areas.find(a => a.area === "extractions").items, 2);
        assert.equal(areas.find(a => a.area === "preview-runs").label, "Mapping preview runs");
    });

    it("has one row per extraction with what it contains", async () => {
        const { data } = await call("getObjectStoreOverview");
        const row = JSON.parse(data.extractions).find(e => e.extractionId === extractionId);

        assert.equal(row.businessObject, "Business Partner");
        assert.equal(row.sourceSystem, SYSTEM);
        assert.equal(row.status, "COMPLETED");
        assert.equal(row.apis, 2);
        assert.equal(row.records, 8);
        assert.equal(row.files, 6);                             // 5 data pages + the manifest
        assert.equal(row.exportFiles, 1);
        assert.ok(row.bytes > 0);
    });

    it("reports an extraction without a manifest, and a file that is missing from a manifest", async () => {
        const first = JSON.parse((await call("getObjectStoreOverview")).data.problems);

        assert.ok(first.some(p => p.type === "NO_MANIFEST" && /EX-INTERRUPTED/.test(p.key)));

        // remove a data file that the manifest lists
        const dir = path.join(STORAGE_DIR, "extractions", extractionId, "CRS610MI.LstByNumber");
        fs.rmSync(path.join(dir, fs.readdirSync(dir)[0]));

        const second = JSON.parse((await call("getObjectStoreOverview")).data.problems);

        assert.ok(second.some(p => p.type === "MISSING_FILES" && p.message.includes("1 file(s) listed in the manifest are missing")));
    });

    it("opens folders like an explorer: top level, a folder, and the way back", async () => {
        const top = (await call("browseObjectStore", { prefix: "" })).data;

        assert.deepEqual(JSON.parse(top.folders).map(f => f.name).sort(), ["exports", "extractions", "preview-runs"]);
        assert.deepEqual(JSON.parse(top.crumbs), [{ name: "Object Store", prefix: "" }]);
        assert.equal(top.parent, null);

        const folder = (await call("browseObjectStore", { prefix: "extractions/" })).data;
        const rows = JSON.parse(folder.folders);

        assert.equal(rows.length, 2);
        assert.match(rows.find(r => r.name === extractionId).description, /^Business Partner · M3_SA · .* · 8 records · /);
        assert.match(rows.find(r => r.name === "EX-INTERRUPTED").description, /no manifest/);
        assert.equal(folder.parent, "");
        assert.deepEqual(JSON.parse(folder.crumbs).map(c => c.name), ["Object Store", "extractions"]);

        const inner = (await call("browseObjectStore", { prefix: `extractions/${extractionId}/` })).data;

        assert.deepEqual(JSON.parse(inner.files).map(f => f.name), ["manifest.json"]);
        assert.equal(JSON.parse(inner.files)[0].type, "MANIFEST");
        assert.deepEqual(JSON.parse(inner.folders).map(f => f.name), ["CRS610MI.LstByNumber", "OIS002MI.LstAddress"]);
        assert.equal(inner.parent, "extractions/");
    });

    it("shows what is inside a manifest and a data file", async () => {
        const manifest = (await call("previewObjectStoreFile", { fileKey: `extractions/${extractionId}/manifest.json` })).data;

        assert.equal(manifest.type, "MANIFEST");
        assert.match(manifest.text, /"businessObject": "Business Partner"/);

        const dir = path.join(STORAGE_DIR, "extractions", extractionId, "OIS002MI.LstAddress");
        const page = fs.readdirSync(dir)[0];
        const data = (await call("previewObjectStoreFile", { fileKey: `extractions/${extractionId}/OIS002MI.LstAddress/${page}` })).data;

        assert.match(data.type, /^DATA/);
        assert.ok(data.records >= 1);
        assert.match(data.text, /^First \d+ of \d+ records in this file/);
    });

    it("says that a local folder has no download link", async () => {
        const { data } = await call("getObjectStoreFileLink", { fileKey: `extractions/${extractionId}/manifest.json` });

        assert.equal(data.url, null);
        assert.match(data.message, /local folder/);
    });

    it("refuses paths that leave the storage, unknown files and empty folders", async () => {
        await assert.rejects(call("browseObjectStore", { prefix: "../" }), /400/);
        await assert.rejects(call("previewObjectStoreFile", { fileKey: "extractions/../../secret.txt" }), /400/);
        await assert.rejects(call("getObjectStoreFileLink", { fileKey: "extractions/" }), /400/);
        await assert.rejects(call("previewObjectStoreFile", { fileKey: "extractions/nope.json" }), /404/);
        await assert.rejects(call("browseObjectStore", { prefix: "nothing-here/" }), /404/);
    });
});
