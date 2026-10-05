"use strict";

const zlib = require("zlib");
const ExcelJS = require("exceljs");
const { manifestKey } = require("./ExtractionRunner");

/**
 * ============================================================
 * EXCEL EXPORT OF AN EXTRACTION
 * ============================================================
 *
 * Builds one workbook from the files of an extraction in the storage:
 *
 *   Info                  the extraction report (what, from where, how many, complete or not)
 *   <one sheet per API>   all extracted records, one column per field
 *   Fields                field metadata per API (name, type, length, description)
 *
 * The records are read from the storage (Object Store), not from the database.
 */

const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_ROWS_PER_SHEET = 1048575;   // Excel limit (1,048,576 rows including the header)

/** Excel sheet names: max 31 characters, no []:*?/\ and unique within the workbook. */
function sheetName(name, used) {
    const base = String(name).replace(/[\[\]:*?/\\]/g, "_").slice(0, 31) || "Sheet";
    let candidate = base;
    let n = 2;

    while (used.has(candidate.toLowerCase())) {
        const suffix = ` (${n++})`;
        candidate = base.slice(0, 31 - suffix.length) + suffix;
    }

    used.add(candidate.toLowerCase());
    return candidate;
}

/** Keeps the source fields; drops OData bookkeeping (__metadata, deferred navigation links). */
function cellValue(value) {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === "object") {
        return JSON.stringify(value);
    }

    return value;
}

const isBookkeeping = (key, value) =>
    key.startsWith("__") ||
    (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(k => k === "__deferred"));

async function readAllRecords(storage, entry) {
    const records = [];

    for (const file of entry.files || []) {
        const lines = zlib.gunzipSync(await storage.get(file.key)).toString("utf8").split("\n");

        for (const line of lines) {
            if (line) {
                records.push(JSON.parse(line));
            }
        }
    }

    return records;
}

const safeFilePart = (text) => String(text || "").replace(/[^A-Za-z0-9._-]+/g, "");

/**
 * @param {Object}   args
 * @param {Object}   args.storage            getStorage() instance
 * @param {string}   args.extractionId
 * @param {string}   [args.objectName]       only this API; all APIs when empty
 * @param {Object}   [args.fieldsByObject]   { objectName: [{ fieldName, dataType, length, nullable, description }] }
 * @param {Object}   [args.verification]     result of verifyExtraction (ok, filesChecked, mismatches)
 * @param {string}   [args.exportedBy]
 * @param {Date}     [args.exportedAt]
 * @returns {Promise<{ buffer, fileName, mediaType, sheets, totalRows, manifest }>}
 */
async function buildExtractionWorkbook({ storage, extractionId, objectName, fieldsByObject = {}, verification, exportedBy, exportedAt = new Date() }) {
    let manifest;

    try {
        manifest = JSON.parse((await storage.get(manifestKey(extractionId))).toString("utf8"));
    } catch (error) {
        const notFound = new Error(`Extraction '${extractionId}' was not found in the storage`);
        notFound.status = 404;
        throw notFound;
    }

    const entries = objectName
        ? manifest.objects.filter(o => o.objectName === objectName)
        : manifest.objects;

    if (entries.length === 0) {
        const notFound = new Error(`'${objectName}' is not part of extraction '${extractionId}'`);
        notFound.status = 404;
        throw notFound;
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "AI Migration Cockpit";
    workbook.created = exportedAt;

    const used = new Set();
    const bold = { bold: true };

    // ---------------------------------------------------------------- Info
    const info = workbook.addWorksheet(sheetName("Info", used));
    info.columns = [{ width: 28 }, { width: 90 }];

    const checksumText = !verification
        ? "not checked"
        : verification.ok
            ? `OK - all ${verification.filesChecked} file(s) match their checksums`
            : `${(verification.mismatches || []).length} of ${verification.filesChecked} file(s) differ from the manifest`;

    [
        ["Business object", manifest.businessObject || ""],
        ["Source system", manifest.sourceSystem || ""],
        ["Extraction", manifest.extractionId],
        ["Extracted at", manifest.startedAt || ""],
        ["Status", manifest.status || ""],
        ["Records in this file", entries.reduce((n, e) => n + (e.records || 0), 0)],
        ["Checksums at export", checksumText],
        ["Exported at", exportedAt.toISOString()],
        ["Exported by", exportedBy || ""],
        ["Note", "Only the main entity of each API is extracted. Child data such as addresses or roles is not included yet."]
    ].forEach(row => info.addRow(row));

    info.getColumn(1).font = bold;
    info.addRow([]);

    const apiHeader = info.addRow(["API", "Records · result"]);
    apiHeader.font = bold;

    for (const entry of manifest.objects) {
        const result = entry.error
            ? `failed: ${entry.error}`
            : `${entry.records} records, ${entry.truncated ? "stopped at the record limit - the source has more" : "complete"}`;

        info.addRow([entry.objectName, result + (entries.includes(entry) ? "" : " (not in this file)")]);
    }

    // ---------------------------------------------------------------- one sheet per API
    const sheets = [];
    let totalRows = 0;

    for (const entry of entries) {
        const records = await readAllRecords(storage, entry);

        if (records.length > MAX_ROWS_PER_SHEET) {
            const tooBig = new Error(`${entry.objectName} has ${records.length} records - more than one Excel sheet can hold (${MAX_ROWS_PER_SHEET})`);
            tooBig.status = 413;
            throw tooBig;
        }

        const columns = [];

        for (const record of records) {
            for (const [key, value] of Object.entries(record)) {
                if (!isBookkeeping(key, value) && !columns.includes(key)) {
                    columns.push(key);
                }
            }
        }

        // "API_BUSINESS_PARTNER/A_BusinessPartnerAddress" gets the sheet name "A_BusinessPartnerAddress"
        const sheet = workbook.addWorksheet(sheetName(String(entry.objectName).split("/").pop(), used));
        sheet.columns = columns.map(key => ({ header: key, key, width: Math.min(Math.max(key.length + 2, 12), 40) }));
        sheet.getRow(1).font = bold;
        sheet.views = [{ state: "frozen", ySplit: 1 }];

        if (columns.length > 0) {
            sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
        }

        for (const record of records) {
            sheet.addRow(columns.map(key => cellValue(record[key])));
        }

        sheets.push({ name: sheet.name, objectName: entry.objectName, rows: records.length, columns: columns.length });
        totalRows += records.length;
    }

    // ---------------------------------------------------------------- Fields
    const fields = workbook.addWorksheet(sheetName("Fields", used));
    fields.columns = [
        { header: "API", key: "api", width: 32 },
        { header: "Field", key: "field", width: 36 },
        { header: "Type", key: "type", width: 16 },
        { header: "Length", key: "length", width: 8 },
        { header: "Optional", key: "optional", width: 10 },
        { header: "Description", key: "description", width: 50 }
    ];
    fields.getRow(1).font = bold;
    fields.views = [{ state: "frozen", ySplit: 1 }];

    for (const entry of entries) {
        for (const field of fieldsByObject[entry.objectName] || []) {
            fields.addRow({
                api: entry.objectName,
                field: field.fieldName,
                type: field.dataType || "",
                length: field.length ?? null,
                optional: field.nullable === false ? "no" : "yes",
                description: field.description || ""
            });
        }
    }

    const day = String(manifest.startedAt || exportedAt.toISOString()).slice(0, 10);
    const fileName =
        [safeFilePart(manifest.businessObject) || "Extraction", day, safeFilePart(extractionId), objectName ? safeFilePart(objectName) : null]
            .filter(Boolean).join("_") + ".xlsx";

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    return { buffer, fileName, mediaType: XLSX_MEDIA_TYPE, sheets, totalRows, manifest };
}

module.exports = {
    buildExtractionWorkbook,
    XLSX_MEDIA_TYPE
};
