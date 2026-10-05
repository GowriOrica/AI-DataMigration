"use strict";

const crypto = require("crypto");
const zlib = require("zlib");

/**
 * ============================================================
 * EXTRACTION RUNNER (source -> Object Store)
 * ============================================================
 *
 * Reads objects (APIs / programs) of a source system page by page through
 * the source adapter and stores every page as a compressed file:
 *
 *   extractions/<id>/<object>/page-00001.ndjson.gz     (one JSON record per line)
 *   extractions/<id>/manifest.json                      (what was extracted + SHA-256 per file)
 *
 * The full data goes to the storage; nothing is kept in the database.
 * The manifest allows verifying later that the files are unchanged.
 *
 * Works with any adapter that implements extract(objectName, { top, pageSize, skip }).
 */

const MAX_PAGE_SIZE = 1000;
const MAX_RECORDS_LIMIT = 2000000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Temporary problems of the source (server errors, timeouts, throttling, network) are worth another try. */
const isTemporary = (error) =>
    /\b(5\d\d|429)\b|timeout|timed out|ETIMEDOUT|ECONN|EAI_AGAIN|ENOTFOUND|socket hang up|network/i.test(String(error && error.message));

/** A run that was stopped on purpose. Not an error of the source. */
class ExtractionCancelled extends Error {
    constructor() {
        super("The extraction was cancelled");
        this.name = "ExtractionCancelled";
    }
}

const clamp = (value, fallback, min, max) => {
    const number = Number(value);

    return Number.isFinite(number) && number >= min ? Math.min(Math.floor(number), max) : fallback;
};

const safeName = (name) => String(name).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "object";

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const manifestKey = (extractionId) => `extractions/${extractionId}/manifest.json`;

/**
 * Reads all pages of one object (until an empty page, the adapter's
 * "no more pages" marker, or the record limit).
 */
async function* readPages(adapter, objectName, { pageSize, maxRecords, pauseMs = 0, retries = 0, retryWaitMs = 1000, shouldCancel }) {
    let skip = 0;
    let total = 0;

    while (total < maxRecords) {
        if (shouldCancel && await shouldCancel()) {
            throw new ExtractionCancelled();
        }

        if (pauseMs && skip > 0) {
            await sleep(pauseMs);                       // be gentle with the live source system
        }

        const wanted = Math.min(pageSize, maxRecords - total);
        let result;

        for (let attempt = 0; ; attempt++) {
            try {
                result = await adapter.extract(objectName, { top: wanted, pageSize: wanted, skip });
                break;
            } catch (error) {
                if (attempt >= retries || !isTemporary(error)) {
                    throw error;
                }

                await sleep(retryWaitMs * Math.pow(3, attempt));
            }
        }

        let records = Array.isArray(result?.records) ? result.records : [];

        if (records.length === 0) {
            return;
        }

        if (records.length > wanted) {
            records = records.slice(0, wanted);
        }

        total += records.length;
        skip += records.length;

        const noMore = result && "nextPageToken" in result && result.nextPageToken === null;

        yield { records, noMore, limitReached: total >= maxRecords };

        if (noMore) {
            return;
        }
    }
}

/**
 * @param {Object}   args
 * @param {Object}   args.adapter
 * @param {Object}   args.storage          getStorage() instance (put/get/list)
 * @param {string}   args.extractionId
 * @param {string[]} args.objectNames
 * @param {Object}   args.context          free-form facts written to the manifest
 *                                         (sourceSystem, adapterType, businessObject ...)
 * @param {number}   [args.pageSize]
 * @param {number}   [args.maxRecordsPerObject]
 * @returns {Promise<Object>} the manifest
 */
async function runExtraction({ adapter, storage, extractionId, objectNames, context = {}, pageSize, maxRecordsPerObject, hooks = {}, previous = null }) {
    const limits = {
        pageSize: clamp(pageSize, 200, 1, MAX_PAGE_SIZE),
        maxRecordsPerObject: clamp(maxRecordsPerObject, 1000, 1, MAX_RECORDS_LIMIT)
    };
    const { onProgress, shouldCancel, pauseMs = 0, retries = 0, retryWaitMs = 1000, expected = {} } = hooks;

    const manifest = {
        extractionId,
        ...context,
        startedAt: (previous && previous.startedAt) || new Date().toISOString(),
        finishedAt: null,
        status: "RUNNING",
        limits,
        objects: [],
        totals: { objects: 0, records: 0, pages: 0, bytes: 0, truncatedObjects: 0, failedObjects: 0 }
    };

    const total = (entry) => {
        manifest.totals.objects++;
        manifest.totals.records += entry.records;
        manifest.totals.pages += entry.pages;
        manifest.totals.bytes += entry.bytes;

        if (entry.truncated) manifest.totals.truncatedObjects++;
        if (entry.error) manifest.totals.failedObjects++;
    };

    // totals of the objects that are in the manifest so far (the running object is added by the caller)
    const recount = (running) => {
        manifest.totals = { objects: 0, records: 0, pages: 0, bytes: 0, truncatedObjects: 0, failedObjects: 0 };
        [...manifest.objects, ...(running ? [running] : [])].forEach(total);
    };

    // the manifest is written while the run is going: an interrupted run still shows what it has stored
    const writeManifest = (running) => {
        recount(running);

        return storage.put(
            manifestKey(extractionId),
            JSON.stringify({ ...manifest, objects: [...manifest.objects, ...(running ? [running] : [])] }, null, 2),
            { contentType: "application/json" }
        );
    };

    // resume: objects that were stored completely are kept, everything else is read again
    const done = new Map();

    ((previous && previous.objects) || []).forEach(entry => {
        if (!entry.error && !entry.cancelled && (entry.complete !== false)) done.set(entry.objectName, entry);
    });

    let cancelled = false;

    try {
        for (const objectName of objectNames) {
            if (done.has(objectName)) {
                manifest.objects.push(done.get(objectName));
                continue;
            }

            const entry = {
                objectName, folder: safeName(objectName), records: 0, pages: 0, bytes: 0, truncated: false, files: [], error: null,
                expected: expected[objectName] === undefined ? null : expected[objectName], complete: false
            };

            try {
                for await (const page of readPages(adapter, objectName, {
                    pageSize: limits.pageSize,
                    maxRecords: limits.maxRecordsPerObject,
                    pauseMs, retries, retryWaitMs, shouldCancel
                })) {
                    entry.pages++;

                    const body = zlib.gzipSync(Buffer.from(page.records.map(record => JSON.stringify(record)).join("\n"), "utf8"));
                    const key = `extractions/${extractionId}/${entry.folder}/page-${String(entry.pages).padStart(5, "0")}.ndjson.gz`;

                    await storage.put(key, body, { contentType: "application/gzip" });

                    entry.files.push({ key, records: page.records.length, bytes: body.length, sha256: sha256(body) });
                    entry.records += page.records.length;
                    entry.bytes += body.length;

                    // the limit stopped us while the source may still have more
                    if (page.limitReached && !page.noMore) {
                        entry.truncated = true;
                    }

                    if (onProgress) {
                        await onProgress({ objectName, entry, manifest });
                    }

                    if (entry.pages % 20 === 0) {
                        await writeManifest(entry);
                    }
                }

                entry.complete = true;
            } catch (error) {
                if (error instanceof ExtractionCancelled) {
                    entry.cancelled = true;
                    cancelled = true;
                } else {
                    entry.error = String(error.message || error).slice(0, 500);
                }
            }

            manifest.objects.push(entry);
            await writeManifest();

            if (onProgress) {
                await onProgress({ objectName, entry, manifest, objectFinished: true });
            }

            if (cancelled) {
                break;
            }
        }
    } finally {
        recount();
    }

    const failed = manifest.totals.failedObjects;

    manifest.status =
        cancelled ? "CANCELLED" :
        failed === 0 ? "COMPLETED" :
        failed === manifest.objects.length ? "FAILED" :
        "PARTIAL";
    manifest.finishedAt = new Date().toISOString();

    await storage.put(manifestKey(extractionId), JSON.stringify(manifest, null, 2), { contentType: "application/json" });

    return manifest;
}

/**
 * Re-reads every file of an extraction and compares size and SHA-256 with the manifest.
 */
async function verifyExtraction({ storage, extractionId }) {
    let manifest;

    try {
        manifest = JSON.parse((await storage.get(manifestKey(extractionId))).toString("utf8"));
    } catch (error) {
        return { found: false, ok: false, filesChecked: 0, mismatches: [{ key: manifestKey(extractionId), reason: "manifest not found" }] };
    }

    const mismatches = [];
    let filesChecked = 0;

    for (const entry of manifest.objects) {
        for (const file of entry.files) {
            filesChecked++;

            try {
                const data = await storage.get(file.key);

                if (data.length !== file.bytes) {
                    mismatches.push({ key: file.key, reason: `size ${data.length} differs from ${file.bytes}` });
                } else if (sha256(data) !== file.sha256) {
                    mismatches.push({ key: file.key, reason: "checksum differs - the file was changed or damaged" });
                }
            } catch (error) {
                mismatches.push({ key: file.key, reason: "file missing" });
            }
        }
    }

    return { found: true, ok: mismatches.length === 0, filesChecked, mismatches, manifest };
}

/**
 * Lists the extractions in the storage (newest first), optionally only those
 * of one source system and / or business object. Reads only the manifests.
 */
async function listExtractions({ storage, sourceSystem, businessObject }) {
    const files = await storage.list("extractions/");
    const manifests = [];

    // "business partner", "Business  Partner" and "Business Partner" are the same name
    const norm = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

    for (const file of files.filter(f => /^extractions\/[^/]+\/manifest\.json$/.test(f.key))) {
        try {
            const manifest = JSON.parse((await storage.get(file.key)).toString("utf8"));

            if (sourceSystem && manifest.sourceSystem !== sourceSystem) continue;
            if (businessObject && norm(manifest.businessObject) !== norm(businessObject)) continue;

            manifests.push(manifest);
        } catch (error) {
            // an unreadable manifest is skipped, the others are still listed
        }
    }

    return manifests.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

/**
 * Finds the latest usable extraction of a business object by its NAME (case, spaces and
 * punctuation are ignored), so that callers such as Joule need no extraction ID.
 * Answers { extraction } or { error: 'UNKNOWN' | 'AMBIGUOUS' | 'SEVERAL_SYSTEMS' | 'NONE_USABLE', options }.
 */
async function findLatestExtraction({ storage, businessObject, sourceSystem }) {
    const norm = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const all = await listExtractions({ storage, sourceSystem });          // newest first
    const names = [...new Set(all.map(m => m.businessObject).filter(Boolean))];
    const wanted = norm(businessObject);

    const exact = names.filter(n => norm(n) === wanted);
    const matches = exact.length ? exact : names.filter(n => wanted && (norm(n).includes(wanted) || wanted.includes(norm(n))));

    if (matches.length === 0) {
        return { error: "UNKNOWN", options: names };
    }

    if (matches.length > 1) {
        return { error: "AMBIGUOUS", options: matches };
    }

    const ofObject = all.filter(m => m.businessObject === matches[0]);
    const systems = [...new Set(ofObject.map(m => m.sourceSystem).filter(Boolean))];

    if (!sourceSystem && systems.length > 1) {
        return { error: "SEVERAL_SYSTEMS", options: systems, businessObject: matches[0] };
    }

    // a failed or still running extraction has no complete files to export
    const usable = ofObject.find(m => m.status === "COMPLETED" || m.status === "PARTIAL");

    return usable ? { extraction: usable } : { error: "NONE_USABLE", businessObject: matches[0], options: [] };
}

/**
 * The extraction to work with: the given ID, or the latest one of a business object by name.
 * Throws an error with .status (400 / 404 / 409) and a message that says what is possible.
 */
async function resolveExtractionId({ storage, extractionId, businessObject, sourceSystem }) {
    if (extractionId) {
        return extractionId;
    }

    const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };

    if (!businessObject) {
        fail(400, "Give a business object (its latest extraction is used) or an extractionId");
    }

    const found = await findLatestExtraction({ storage, businessObject, sourceSystem });
    const list = (options) => (options || []).join(", ");

    if (found.error === "UNKNOWN") {
        fail(404, `No extraction exists for '${businessObject}'. Business objects with an extraction: ${list(found.options) || "none"}.`);
    }
    if (found.error === "AMBIGUOUS") {
        fail(409, `'${businessObject}' matches several business objects: ${list(found.options)}. Which one do you mean?`);
    }
    if (found.error === "SEVERAL_SYSTEMS") {
        fail(409, `'${found.businessObject}' was extracted from several source systems: ${list(found.options)}. Which one do you mean?`);
    }
    if (found.error === "NONE_USABLE") {
        fail(409, `'${found.businessObject}' has no completed extraction yet. Extract it first.`);
    }

    return found.extraction.extractionId;
}

/**
 * Reads records of one extracted object from its files: skip / top across pages.
 * Only the pages that are needed are downloaded.
 */
async function readExtractionRecords({ storage, extractionId, objectName, skip = 0, top = 50 }) {
    let manifest;

    try {
        manifest = JSON.parse((await storage.get(manifestKey(extractionId))).toString("utf8"));
    } catch (error) {
        return { found: false };
    }

    const entry = manifest.objects.find(o => o.objectName === objectName) || (!objectName && manifest.objects[0]);

    if (!entry) {
        return { found: false, manifest };
    }

    skip = clamp(skip, 0, 0, Number.MAX_SAFE_INTEGER);
    top = clamp(top, 50, 1, 500);

    const records = [];
    let offset = 0;

    for (const file of entry.files) {
        if (records.length >= top) break;

        if (offset + file.records <= skip) {
            offset += file.records;
            continue;
        }

        const lines = zlib.gunzipSync(await storage.get(file.key)).toString("utf8").split("\n").filter(Boolean);

        for (const line of lines) {
            if (offset++ < skip) continue;
            if (records.length >= top) break;
            records.push(JSON.parse(line));
        }
    }

    return { found: true, manifest, entry, totalRecords: entry.records, skip, top, records };
}

module.exports = {
    runExtraction,
    ExtractionCancelled,
    isTemporary,
    verifyExtraction,
    listExtractions,
    findLatestExtraction,
    resolveExtractionId,
    readExtractionRecords,
    manifestKey,
    safeName
};
