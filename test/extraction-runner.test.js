"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const M3SourceAdapter = require("../srv/adapters/M3SourceAdapter");
const LocalStorage = require("../srv/lib/storage/LocalStorage");
const { runExtraction, verifyExtraction, manifestKey } = require("../srv/lib/extraction/ExtractionRunner");

describe("ExtractionRunner (M3 mock source -> local storage)", () => {

    let storage;
    let root;
    let manifest;

    const adapter = new M3SourceAdapter({ systemId: "M3_TEST" });

    before(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-extraction-"));
        storage = new LocalStorage(root);

        manifest = await runExtraction({
            adapter,
            storage,
            extractionId: "EX-1",
            objectNames: ["CRS610MI.LstByNumber", "OIS002MI.LstAddress"],
            context: { sourceSystem: "M3_TEST", businessObject: "Business Partner" },
            pageSize: 2
        });
    });

    it("reads every page and stores it as a compressed NDJSON file", async () => {
        const header = manifest.objects.find(o => o.objectName === "CRS610MI.LstByNumber");

        assert.equal(header.records, 5);
        assert.equal(header.pages, 3);                       // 2 + 2 + 1
        assert.deepEqual(header.files.map(f => f.records), [2, 2, 1]);
        assert.equal(header.files[0].key, "extractions/EX-1/CRS610MI.LstByNumber/page-00001.ndjson.gz");

        const lines = zlib.gunzipSync(await storage.get(header.files[0].key)).toString("utf8").split("\n").map(JSON.parse);

        assert.equal(lines.length, 2);
        assert.equal(lines[0].CUNO, "C1001");
    });

    it("writes a manifest with totals and a checksum per file", async () => {
        const stored = JSON.parse((await storage.get(manifestKey("EX-1"))).toString("utf8"));

        assert.equal(stored.status, "COMPLETED");
        assert.equal(stored.businessObject, "Business Partner");
        assert.equal(stored.totals.records, 8);              // 5 headers + 3 addresses
        assert.equal(stored.totals.objects, 2);
        assert.ok(stored.objects.every(o => o.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256))));
    });

    it("verifies untouched files, and detects a changed one", async () => {
        const ok = await verifyExtraction({ storage, extractionId: "EX-1" });

        assert.equal(ok.ok, true);
        assert.equal(ok.filesChecked, 5);                    // 3 header pages + 2 address pages (3 records, page size 2)

        const victim = manifest.objects[0].files[1].key;

        await storage.put(victim, zlib.gzipSync(Buffer.from('{"CUNO":"TAMPERED"}', "utf8")));

        const broken = await verifyExtraction({ storage, extractionId: "EX-1" });

        assert.equal(broken.ok, false);
        assert.equal(broken.mismatches.length, 1);
        assert.equal(broken.mismatches[0].key, victim);
    });

    it("reports an unknown extraction", async () => {
        assert.equal((await verifyExtraction({ storage, extractionId: "NOPE" })).found, false);
    });

    it("stops at the record limit and marks the object as truncated", async () => {
        const limited = await runExtraction({
            adapter, storage, extractionId: "EX-2", objectNames: ["CRS610MI.LstByNumber"], pageSize: 2, maxRecordsPerObject: 3
        });

        assert.equal(limited.objects[0].records, 3);
        assert.equal(limited.objects[0].truncated, true);
        assert.equal(limited.totals.truncatedObjects, 1);
    });

    it("keeps going when one object fails and reports PARTIAL", async () => {
        const partial = await runExtraction({
            adapter, storage, extractionId: "EX-3", objectNames: ["CRS610MI.LstByNumber", "UNKNOWN.Transaction"]
        });

        assert.equal(partial.status, "PARTIAL");
        assert.equal(partial.totals.failedObjects, 1);
        assert.match(partial.objects[1].error, /not found/);
        assert.equal(partial.objects[0].records, 5);
    });
});
