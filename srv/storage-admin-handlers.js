"use strict";

const zlib = require("zlib");
const cds = require("@sap/cds");

const { getStorage } = require("./lib/storage");

/**
 * Handlers of the Object Store administration (see srv/storage-admin-service.cds).
 * Everything is computed from the files in the storage: nothing is kept in the database.
 */

const AREAS = {
    extractions: "Extractions (source data)",
    exports: "Excel exports",
    "preview-runs": "Mapping preview runs",
    rules: "Cleansing rule files"
};

const PREVIEW_LIMIT = 100 * 1024;       // characters shown of a file
const PREVIEW_RECORDS = 5;

const fail = (status, message) => {
    const error = new Error(message);
    error.status = status;
    throw error;
};

const sizeText = (bytes) => {
    const n = Number(bytes) || 0;

    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;

    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const iso = (value) => (value ? new Date(value).toISOString() : null);
const latest = (a, b) => (!a ? b : !b ? a : new Date(a) > new Date(b) ? a : b);

const fileType = (name) =>
    /\.ndjson\.gz$/i.test(name) ? "DATA (records, compressed)" :
    /manifest\.json$/i.test(name) ? "MANIFEST" :
    /\.json$/i.test(name) ? "JSON" :
    /\.xlsx$/i.test(name) ? "EXCEL" :
    /\.(txt|csv|md)$/i.test(name) ? "TEXT" : "OTHER";

/** A folder name that is safe to use as a prefix: no '..', ends with '/'. */
const cleanPrefix = (prefix) => {
    const p = String(prefix || "").trim().replace(/^\/+/, "");

    if (p.split("/").includes("..") || p.includes("\\")) fail(400, "Invalid folder");

    return p === "" || p.endsWith("/") ? p : p + "/";
};

const cleanKey = (key) => {
    const k = String(key || "").trim().replace(/^\/+/, "");

    if (!k || k.endsWith("/") || k.split("/").includes("..") || k.includes("\\")) fail(400, "Invalid file");

    return k;
};

/** Runs async work with a small number of calls at the same time. */
async function inBatches(items, size, work) {
    const results = [];

    for (let i = 0; i < items.length; i += size) {
        results.push(...await Promise.all(items.slice(i, i + size).map(work)));
    }

    return results;
}

async function readManifest(storage, id) {
    try {
        return JSON.parse((await storage.get(`extractions/${id}/manifest.json`)).toString("utf8"));
    } catch (error) {
        return null;
    }
}

module.exports = function registerStorageAdminHandlers(srv) {

    const on = (event, handler) => srv.on(event, async (req) => {
        try {
            return await handler(req.data, req);
        } catch (error) {
            const status = error.status || 500;

            if (status >= 500) console.error(`[${event}] FAILED:`, error);

            return req.reject(status, error.message || `${event} failed`);
        }
    });

    // ------------------------------------------------------------------ overview

    on("getObjectStoreOverview", async () => {
        const storage = getStorage();
        const all = await storage.list("");
        const { kind, location, region } = storage.describe();

        let totalBytes = 0;
        let lastWrite = null;

        const areas = new Map();
        const extractionFolders = new Map();
        const exportFolders = new Map();

        for (const file of all) {
            const parts = file.key.split("/");
            const area = parts.length > 1 ? parts[0] : "(top level)";
            const entry = areas.get(area) || { area, files: 0, bytes: 0, ids: new Set() };

            entry.files++;
            entry.bytes += file.size;
            totalBytes += file.size;
            lastWrite = latest(lastWrite, file.lastModified);

            if (parts.length > 2) entry.ids.add(parts[1]);

            areas.set(area, entry);

            if (area === "extractions" && parts.length > 2) {
                const f = extractionFolders.get(parts[1]) || { files: 0, bytes: 0, lastWrite: null, keys: new Set() };
                f.files++; f.bytes += file.size; f.lastWrite = latest(f.lastWrite, file.lastModified); f.keys.add(file.key);
                extractionFolders.set(parts[1], f);
            }

            if (area === "exports" && parts.length > 2) {
                const f = exportFolders.get(parts[1]) || { files: 0, bytes: 0, lastWrite: null };
                f.files++; f.bytes += file.size; f.lastWrite = latest(f.lastWrite, file.lastModified);
                exportFolders.set(parts[1], f);
            }
        }

        // one row per extraction, from its manifest
        const ids = [...extractionFolders.keys()];
        const manifests = await inBatches(ids, 8, id => readManifest(storage, id));
        const problems = [];

        const extractions = ids.map((id, index) => {
            const folder = extractionFolders.get(id);
            const manifest = manifests[index];
            const exp = exportFolders.get(id);

            if (!manifest) {
                problems.push({ type: "NO_MANIFEST", key: `extractions/${id}/`, message: `Extraction ${id} has ${folder.files} file(s) but no manifest. It was interrupted or is still running; the files are not usable.` });
            } else {
                if (manifest.status === "FAILED" || manifest.status === "PARTIAL") {
                    problems.push({ type: manifest.status, key: `extractions/${id}/manifest.json`, message: `Extraction ${id} ${manifest.status === "FAILED" ? "failed" : "is partial"}: ${manifest.totals?.failedObjects || 0} API(s) failed.` });
                }

                const missing = manifest.objects.flatMap(o => (o.files || []).map(f => f.key)).filter(key => !folder.keys.has(key));

                if (missing.length) {
                    problems.push({ type: "MISSING_FILES", key: `extractions/${id}/`, message: `Extraction ${id}: ${missing.length} file(s) listed in the manifest are missing from the Object Store.` });
                }
            }

            return {
                extractionId: id,
                businessObject: manifest?.businessObject || null,
                sourceSystem: manifest?.sourceSystem || null,
                startedAt: manifest?.startedAt || iso(folder.lastWrite),
                status: manifest ? manifest.status : "NO MANIFEST",
                apis: manifest ? manifest.totals?.objects : null,
                records: manifest ? manifest.totals?.records : null,
                truncatedApis: manifest ? manifest.totals?.truncatedObjects : null,
                files: folder.files,
                bytes: folder.bytes,
                sizeText: sizeText(folder.bytes),
                exportFiles: exp ? exp.files : 0,
                exportBytes: exp ? exp.bytes : 0
            };
        }).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

        const areaRows = [...areas.values()].sort((a, b) => b.bytes - a.bytes).map(a => ({
            area: a.area, label: AREAS[a.area] || a.area, files: a.files, bytes: a.bytes, sizeText: sizeText(a.bytes), items: a.ids.size
        }));

        return {
            storageKind: kind, location, region: region || null,
            totalFiles: all.length, totalBytes, sizeText: sizeText(totalBytes), lastWrite: iso(lastWrite),
            extractionCount: extractions.length,
            exportCount: [...exportFolders.values()].reduce((n, f) => n + f.files, 0),
            problemCount: problems.length,
            areas: JSON.stringify(areaRows),
            extractions: JSON.stringify(extractions),
            problems: JSON.stringify(problems),
            message:
                `${kind === "OBJECT_STORE" ? "Object Store" : "Local storage"} ${location}: ${all.length} file(s), ${sizeText(totalBytes)}, ` +
                `${extractions.length} extraction(s), ${problems.length} problem(s).`
        };
    });

    // ------------------------------------------------------------------ explorer

    on("browseObjectStore", async ({ prefix }) => {
        const storage = getStorage();
        const base = cleanPrefix(prefix);
        const found = await storage.list(base);
        const folders = new Map();
        const files = [];

        for (const file of found) {
            const rest = file.key.slice(base.length);
            const slash = rest.indexOf("/");

            if (slash < 0) {
                files.push({ name: rest, key: file.key, bytes: file.size, sizeText: sizeText(file.size), lastModified: iso(file.lastModified), type: fileType(rest) });
            } else {
                const name = rest.slice(0, slash);
                const f = folders.get(name) || { name, prefix: `${base}${name}/`, files: 0, bytes: 0, lastModified: null };

                f.files++; f.bytes += file.size; f.lastModified = latest(f.lastModified, file.lastModified);
                folders.set(name, f);
            }
        }

        if (found.length === 0 && base !== "") fail(404, `The folder '${base}' does not exist or is empty`);

        // what an extraction folder is, in words
        const folderRows = [...folders.values()];

        if (base === "") {
            folderRows.forEach(f => { f.description = AREAS[f.name] || ""; });
        }

        if (base === "extractions/") {
            const manifests = await inBatches(folderRows, 8, f => readManifest(storage, f.name));

            folderRows.forEach((f, i) => {
                const m = manifests[i];
                f.description = m
                    ? `${m.businessObject || "?"} · ${m.sourceSystem || "?"} · ${String(m.startedAt || "").slice(0, 16).replace("T", " ")} · ${m.totals?.records ?? 0} records · ${m.status}`
                    : "no manifest (interrupted or running)";
            });
        }

        const newestFirst = base === "extractions/" || base === "exports/" || base === "preview-runs/";

        folderRows.sort((a, b) => newestFirst ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name));
        files.sort((a, b) => a.name.localeCompare(b.name));

        const parts = base.split("/").filter(Boolean);
        const crumbs = [{ name: "Object Store", prefix: "" }, ...parts.map((name, i) => ({ name, prefix: parts.slice(0, i + 1).join("/") + "/" }))];
        const total = found.reduce((n, f) => n + f.size, 0);

        return {
            prefix: base,
            parent: parts.length ? (parts.slice(0, -1).join("/") + (parts.length > 1 ? "/" : "")) : null,
            crumbs: JSON.stringify(crumbs),
            folders: JSON.stringify(folderRows.map(f => ({ ...f, sizeText: sizeText(f.bytes), lastModified: iso(f.lastModified) }))),
            files: JSON.stringify(files),
            fileCount: found.length,
            totalBytes: total,
            sizeText: sizeText(total)
        };
    });

    // ------------------------------------------------------------------ one file

    const checkExists = async (storage, key) => {
        const hits = await storage.list(key);
        const hit = hits.find(f => f.key === key);

        return hit || fail(404, `The file '${key}' was not found`);
    };

    on("previewObjectStoreFile", async ({ fileKey }) => {
        const storage = getStorage();
        const k = cleanKey(fileKey);
        const file = await checkExists(storage, k);
        const name = k.split("/").pop();
        const type = fileType(name);
        const result = { fileKey: k, fileName: name, type, bytes: file.size, records: null, text: "", truncated: false };

        if (type === "MANIFEST" || type === "JSON") {
            const raw = (await storage.get(k)).toString("utf8");

            try {
                result.text = JSON.stringify(JSON.parse(raw), null, 2);
            } catch (error) {
                result.text = raw;
            }
        } else if (type.startsWith("DATA")) {
            const lines = zlib.gunzipSync(await storage.get(k)).toString("utf8").split("\n").filter(Boolean);

            result.records = lines.length;
            result.text = lines.slice(0, PREVIEW_RECORDS).map(line => {
                const record = JSON.parse(line);

                // OData bookkeeping is not data
                Object.keys(record).filter(f => f.startsWith("__")).forEach(f => delete record[f]);

                return JSON.stringify(record, null, 2);
            }).join("\n");
            result.truncated = lines.length > PREVIEW_RECORDS;
            result.text = `First ${Math.min(PREVIEW_RECORDS, lines.length)} of ${lines.length} records in this file:\n\n` + result.text;
        } else if (type === "TEXT") {
            result.text = (await storage.get(k)).toString("utf8").slice(0, PREVIEW_LIMIT);
            result.truncated = file.size > PREVIEW_LIMIT;
        } else {
            result.text = type === "EXCEL"
                ? "Excel file. Use Download to open it in Excel."
                : "This file type cannot be shown here. Use Download.";
        }

        if (result.text.length > PREVIEW_LIMIT) {
            result.text = result.text.slice(0, PREVIEW_LIMIT);
            result.truncated = true;
        }

        return result;
    });

    on("getObjectStoreFileLink", async ({ fileKey }) => {
        const storage = getStorage();
        const k = cleanKey(fileKey);

        await checkExists(storage, k);

        const fileName = k.split("/").pop();
        const url = await storage.signedDownloadUrl(k, { expiresInSeconds: 900, fileName });

        return url
            ? { fileKey: k, fileName, url, expiresInMinutes: 15, message: `Download link for ${fileName}, valid for 15 minutes.` }
            : { fileKey: k, fileName, url: null, expiresInMinutes: null, message: "This storage is a local folder, so there is no download link. The file is in the local storage folder." };
    });
};
