"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ExcelJS = require("exceljs");

process.env.CDS_PLUGIN_UI5_ACTIVE = "false";
process.env.AI_PROVIDER = "OPENROUTER";
process.env.OPENROUTER_API_KEY = "fake-key-for-tests";
process.env.OPENROUTER_MODEL = "fake/model";
process.env.GEMINI_API_KEY = "fake-key-for-tests";

const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mo-excel-"));
process.env.STORAGE_DIR = STORAGE_DIR;

const cds = require("@sap/cds");

const { GET, POST } = cds.test(
    "serve",
    "srv/migration-service.cds",
    "srv/framework-service.cds",
    "--in-memory"
).in(path.join(__dirname, ".."));

const SYSTEM = "M3_XL";

const readWorkbook = async (key) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(STORAGE_DIR, ...key.split("/")));
    return workbook;
};

describe("Excel export of an extraction", () => {

    let extractionId;
    let exported;

    before(async () => {
        const systemId = cds.utils.uuid();

        await INSERT.into("migration.orchestrator.SourceSystem").entries({
            ID: systemId, systemId: SYSTEM, systemName: "M3 Excel test", systemType: "M3", active: true
        });
        await INSERT.into("migration.orchestrator.SourceConnection").entries({
            connectionId: "M3_XL_CONN", connectionName: "M3 mock", interfaceType: "M3_MI",
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

        await INSERT.into("migration.orchestrator.SourceField").entries([
            { fieldName: "CUNO", objectName: "CRS610MI.LstByNumber", dataType: "Edm.String", length: 10, nullable: false, description: "Customer number" },
            { fieldName: "CUNM", objectName: "CRS610MI.LstByNumber", dataType: "Edm.String", length: 36, nullable: true, description: "Customer name" }
        ]);

        const { data } = await POST("/migration/extractToObjectStore", { sourceSystemId: SYSTEM, businessObject: "Business Partner", pageSize: 2 });
        extractionId = data.extractionId;
    });

    it("exports the whole business object: Info, one sheet per API, Fields", async () => {
        const { data } = await POST("/migration/exportExtractionToExcel", { extractionId });
        exported = data;

        assert.equal(data.checksums, "OK");
        assert.equal(data.totalRows, 8);                          // 5 customers + 3 addresses
        assert.match(data.fileName, new RegExp(`^BusinessPartner_\\d{4}-\\d{2}-\\d{2}_${extractionId}\\.xlsx$`));
        assert.equal(data.exportKey, `exports/${extractionId}/${data.fileName}`);
        assert.match(data.message, /^Excel created: .* 8 records in 2 API sheet\(s\)/);

        const workbook = await readWorkbook(data.exportKey);

        assert.deepEqual(workbook.worksheets.map(s => s.name), ["Info", "CRS610MI.LstByNumber", "OIS002MI.LstAddress", "Fields"]);

        const customers = workbook.getWorksheet("CRS610MI.LstByNumber");
        assert.equal(customers.rowCount, 1 + 5);                  // header + all records, not only one page
        assert.ok(customers.getRow(1).values.includes("CUNO"));

        const info = workbook.getWorksheet("Info");
        const infoText = info.getSheetValues().flat().join(" ");
        assert.match(infoText, /Business Partner/);
        assert.match(infoText, /OK - all 5 file\(s\) match their checksums/);

        const fields = workbook.getWorksheet("Fields");
        assert.equal(fields.rowCount, 1 + 2);
        assert.equal(fields.getRow(2).getCell(6).value, "Customer number");
    });

    it("exports only one API when asked", async () => {
        const { data } = await POST("/migration/exportExtractionToExcel", { extractionId, objectName: "OIS002MI.LstAddress" });

        assert.equal(data.totalRows, 3);
        assert.match(data.fileName, /_OIS002MI\.LstAddress\.xlsx$/);

        const workbook = await readWorkbook(data.exportKey);
        assert.deepEqual(workbook.worksheets.map(s => s.name), ["Info", "OIS002MI.LstAddress", "Fields"]);
    });

    it("downloads the stored file", async () => {
        const response = await GET(`/migration/downloadExport(exportKey='${encodeURIComponent(exported.exportKey)}')`, { responseType: "arraybuffer" });

        assert.equal(response.status, 200);
        assert.match(response.headers["content-type"], /spreadsheetml/);
        assert.match(response.headers["content-disposition"] || "", /attachment/);
        assert.equal(Buffer.from(response.data).length, exported.sizeBytes);
    });

    it("exports the latest extraction by business object name - no ID needed", async () => {
        const { data } = await POST("/migration/exportExtractionToExcel", { businessObject: "business  partner" });

        assert.equal(data.extractionId, extractionId);
        assert.equal(data.totalRows, 8);

        // a second, newer extraction becomes the one that is exported
        const { data: newer } = await POST("/migration/extractToObjectStore", { sourceSystemId: SYSTEM, objectNames: ["CRS610MI.LstByNumber"], businessObject: "Business Partner" });
        const { data: second } = await POST("/migration/exportExtractionToExcel", { businessObject: "Business Partner", sourceSystemId: SYSTEM });

        assert.equal(second.extractionId, newer.extractionId);
        assert.equal(second.totalRows, 5);
    });

    it("explains what is possible when the name does not lead to one extraction", async () => {
        await assert.rejects(POST("/migration/exportExtractionToExcel", { businessObject: "Material" }), /404.*Business objects with an extraction: Business Partner/);
        await assert.rejects(POST("/migration/exportExtractionToExcel", { businessObject: "Business Partner", sourceSystemId: "OTHER" }), /404/);
    });

    it("refuses unknown extractions, unknown APIs and other files", async () => {
        await assert.rejects(POST("/migration/exportExtractionToExcel", { extractionId: "EX-NOPE" }), /404/);
        await assert.rejects(POST("/migration/exportExtractionToExcel", { extractionId, objectName: "NOPE" }), /404/);
        await assert.rejects(POST("/migration/exportExtractionToExcel", {}), /400/);
        await assert.rejects(GET(`/migration/downloadExport(exportKey='${encodeURIComponent(`extractions/${extractionId}/manifest.json`)}')`), /400/);
        await assert.rejects(GET(`/migration/downloadExport(exportKey='${encodeURIComponent("exports/x/../../secret.xlsx")}')`), /400/);
    });
});
