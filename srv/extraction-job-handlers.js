"use strict";

const cds = require("@sap/cds");
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

const { runExtraction, manifestKey } = require("./lib/extraction/ExtractionRunner");
const { getStorage } = require("./lib/storage");
const { createSourceAdapter } = require("./adapters/SourceAdapterFactory");

/**
 * Handlers of the background extraction (see srv/extraction-job-service.cds).
 * Registered by migration-service.js when the table is part of the model.
 *
 * The job runs inside the application (no extra service needed). A running job reports a heartbeat; a job
 * that stops reporting (the application restarted or crashed) is shown as INTERRUPTED and can be resumed.
 */

const ACTIVE = ["QUEUED", "RUNNING"];
const RESUMABLE = ["INTERRUPTED", "CANCELLED", "PARTIAL", "FAILED"];

// a job reads everything unless told otherwise (the old 1,000 would cut off roles: 1,125 in the test system)
const DEFAULT_MAX_RECORDS = 100000;
const HEARTBEAT_MS = 15 * 1000;
const STALE_MS = 90 * 1000;

// replaced by the tests (a fake source, a short wait)
const deps = {
    createSourceAdapter,
    getStorage,
    settings: { pauseMs: 200, retries: 3, retryWaitMs: 1000, countTimeoutMs: 30 * 1000, progressEveryMs: 2000 }
};

const fail = (status, message) => {
    const error = new Error(message);
    error.status = status;
    throw error;
};

const norm = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const str = (value) => (value === undefined || value === null ? "" : String(value).trim());
const iso = (value) => (value ? new Date(value).toISOString() : null);

const positive = (value, name) => {
    if (value === undefined || value === null || value === "") return undefined;

    const number = Number(value);

    if (!Number.isInteger(number) || number < 1) fail(400, `${name} must be a whole number of at least 1`);

    return number;
};

const withTimeout = (promise, ms, text) => {
    let timer;

    return Promise.race([
        promise,
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(text)), ms); })
    ]).finally(() => clearTimeout(timer));
};

function registerExtractionJobHandlers(srv, { resolveSourceContext }) {

    const { ExtractionJob } = cds.entities("migration.framework");
    const { MigrationAssessment } = cds.entities("migration.orchestrator");

    const on = (event, handler) => srv.on(event, async (req) => {
        try {
            return await handler(req.data, req);
        } catch (error) {
            const status = error.status || 500;

            if (status >= 500) console.error(`[${event}] FAILED:`, error);

            return req.reject(status, error.message || `${event} failed`);
        }
    });

    // jobs started by this application instance, to stop their heartbeat when they end
    const running = new Map();

    // ------------------------------------------------------------------ helpers

    const sourceOf = async (tx, sourceSystemId) => {
        try {
            return await resolveSourceContext(tx, sourceSystemId);
        } catch (error) {
            if (/was not found/.test(error.message)) fail(404, error.message);
            if (/connected source connection/.test(error.message)) fail(409, error.message);

            throw error;
        }
    };

    /**
     * The source system to work with: the given one, or the only system that has confirmed APIs for the business
     * object (a caller such as Joule says 'Business Partner', not the system ID).
     */
    const systemFor = async (tx, sourceSystemId, businessObject) => {
        if (str(sourceSystemId)) return str(sourceSystemId);

        if (!str(businessObject)) fail(400, "Give a sourceSystemId, or a business object (its source system is found from its confirmed APIs)");

        const rows = await tx.run(SELECT.from(MigrationAssessment).columns("sourceSystemId", "businessObject").where({ reviewStatus: "CONFIRMED" }));
        const systems = [...new Set(rows.filter(row => norm(row.businessObject) === norm(businessObject)).map(row => row.sourceSystemId))];

        if (systems.length === 0) fail(409, `No confirmed APIs for business object '${businessObject}' in any source system. Confirm its APIs first.`);
        if (systems.length > 1) fail(409, `'${businessObject}' has confirmed APIs in several source systems: ${systems.join(", ")}. Which one do you mean?`);

        return systems[0];
    };

    /** The APIs to extract: the given list, or the CONFIRMED APIs of the business object. */
    const namesOf = async (tx, { sourceSystem, businessObject, objectNames }) => {
        const given = (objectNames || []).map(str).filter(Boolean);

        if (given.length > 0) return { names: [...new Set(given)], businessObject: str(businessObject) || null };

        if (!businessObject) fail(400, "Give a business object (its confirmed APIs are extracted) or objectNames");

        // "business  partner" and "Business Partner" are the same business object
        const all = await tx.run(
            SELECT.from(MigrationAssessment).columns("sourceObject", "businessObject")
                .where({ sourceSystemId: sourceSystem.systemId, reviewStatus: "CONFIRMED" })
        );
        const rows = all.filter(row => norm(row.businessObject) === norm(businessObject));

        if (rows.length === 0) {
            const known = [...new Set(all.map(row => row.businessObject))];

            fail(409, `No confirmed APIs for business object '${businessObject}'.` +
                (known.length ? ` Business objects with confirmed APIs: ${known.join(", ")}.` : "") + " Review and confirm the APIs first.");
        }

        // the APIs first, then their entity sets (API/EntitySet), each in alphabetical order
        const sorted = [...new Set(rows.map(row => row.sourceObject))].sort((a, b) =>
            (a.includes("/") - b.includes("/")) || a.localeCompare(b));

        return { names: sorted, businessObject: rows[0].businessObject };
    };

    const newId = () => `EX-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;

    /** A RUNNING job that stopped reporting is INTERRUPTED. Done here, so every question gets the true answer. */
    const refresh = async (job) => {
        if (job && ACTIVE.includes(job.status)) {
            const last = job.heartbeatAt ? new Date(job.heartbeatAt).getTime() : new Date(job.modifiedAt || job.createdAt).getTime();

            if (!running.has(job.extractionId) && Date.now() - last > STALE_MS) {
                const message = "The application stopped while this extraction was running. Nothing stored so far is lost; resume it to continue.";

                await cds.db.run(UPDATE(ExtractionJob).set({ status: "INTERRUPTED", message, finishedAt: new Date().toISOString() }).where({ extractionId: job.extractionId }));

                return { ...job, status: "INTERRUPTED", message };
            }
        }

        return job;
    };

    const findJob = async (tx, { extractionId, businessObject, sourceSystemId }) => {
        let job;

        if (extractionId) {
            job = await tx.run(SELECT.one.from(ExtractionJob).where({ extractionId }));

            if (!job) fail(404, `No extraction job '${extractionId}'.`);
        } else {
            if (!businessObject) fail(400, "Give an extractionId or a business object (its latest job is used)");

            const where = sourceSystemId ? { sourceSystemId } : {};
            const all = await tx.run(SELECT.from(ExtractionJob).where(where).orderBy("createdAt desc"));
            const mine = all.filter(row => norm(row.businessObject) === norm(businessObject));

            if (mine.length === 0) {
                const names = [...new Set(all.map(row => row.businessObject))];

                fail(404, `No extraction job for '${businessObject}'.` + (names.length ? ` Business objects with a job: ${names.join(", ")}.` : " No job was started yet."));
            }

            const systems = [...new Set(mine.map(row => row.sourceSystemId))];

            if (!sourceSystemId && systems.length > 1) {
                fail(409, `'${mine[0].businessObject}' has jobs for several source systems: ${systems.join(", ")}. Which one do you mean?`);
            }

            job = mine[0];
        }

        return refresh(job);
    };

    const activeJobOf = async (tx, sourceSystemId, businessObject, exceptId) => {
        const rows = await tx.run(SELECT.from(ExtractionJob).where({ sourceSystemId, status: { in: ACTIVE } }).orderBy("createdAt asc", "extractionId asc"));
        const fresh = [];

        for (const row of rows) {
            const job = await refresh(row);

            if (ACTIVE.includes(job.status) && job.extractionId !== exceptId && norm(job.businessObject) === norm(businessObject)) fresh.push(job);
        }

        return fresh;
    };

    // ------------------------------------------------------------------ the answer

    const parseProgress = (job) => {
        try { return JSON.parse(job.progress || "[]"); } catch (error) { return []; }
    };

    const percentOf = (job, objects) => {
        const known = objects.filter(o => o.target !== null && o.target !== undefined);

        if (known.length === 0) return null;

        const target = known.reduce((sum, o) => sum + o.target, 0);
        const done = known.reduce((sum, o) => sum + Math.min(o.records, o.target), 0);

        if (target === 0) return job.status === "COMPLETED" ? 100 : 0;

        const percent = Math.floor((100 * done) / target);

        return job.status === "COMPLETED" ? 100 : Math.min(percent, 99);
    };

    const info = (job) => {
        const objects = parseProgress(job);
        const percent = percentOf(job, objects);
        const records = Number(job.totalRecords) || 0;
        const where = `Extraction ${job.extractionId} of ${job.businessObject} from ${job.sourceSystemId}`;
        let message;

        switch (job.status) {
            case "QUEUED":
                message = `${where} is queued and starts in a moment.`;
                break;
            case "RUNNING":
                message = `${where} is running: ${records} record(s) so far` +
                    (percent !== null ? ` (about ${percent} %)` : "") +
                    (job.currentObject ? `, now reading ${job.currentObject}` : "") + ". Ask again for the status; you can keep working meanwhile.";
                break;
            case "COMPLETED":
                message = `${where} is complete: ${records} record(s) from ${objects.length} API(s). The data is in the Object Store.`;
                break;
            case "PARTIAL":
                message = `${where} finished partly: ${records} record(s). ${job.message || ""} The APIs that worked are stored; resume to read the others again.`;
                break;
            case "FAILED":
                message = `${where} failed. ${job.message || ""}`;
                break;
            case "CANCELLED":
                message = `${where} was cancelled after ${records} record(s). What was stored stays in the Object Store; resume to continue.`;
                break;
            case "INTERRUPTED":
                message = `${where} was interrupted after ${records} record(s). ${job.message || ""}`;
                break;
            default:
                message = job.message || where;
        }

        if (job.status === "RUNNING" && job.cancelRequested) {
            message += " A cancel was requested; it stops after the current page.";
        }

        return {
            extractionId: job.extractionId,
            status: job.status,
            businessObject: job.businessObject,
            sourceSystemId: job.sourceSystemId,
            startedAt: iso(job.startedAt),
            finishedAt: iso(job.finishedAt),
            totalRecords: records,
            expectedRecords: job.expectedRecords === null || job.expectedRecords === undefined ? null : Number(job.expectedRecords),
            percent,
            currentObject: job.currentObject || null,
            resumable: RESUMABLE.includes(job.status),
            objects: JSON.stringify(objects),
            message
        };
    };

    // ------------------------------------------------------------------ the background run

    const progressOf = (names, manifest, current, expected, maxRecords) =>
        names.map(objectName => {
            const entry = manifest.objects.find(o => o.objectName === objectName) || (current && current.objectName === objectName ? current : null);
            const wanted = expected[objectName];
            const target = wanted === undefined || wanted === null ? null : Math.min(wanted, maxRecords);
            let state = "PENDING";

            if (entry) {
                state = entry.error ? "FAILED" : entry.cancelled ? "CANCELLED" : entry.complete ? (entry.truncated ? "STOPPED_AT_LIMIT" : "DONE") : "RUNNING";
            }

            return {
                objectName, state, records: entry ? entry.records : 0, pages: entry ? entry.pages : 0,
                expected: wanted === undefined ? null : wanted, target, error: entry && entry.error ? entry.error : undefined
            };
        });

    async function runJob(extractionId) {
        const db = cds.db;
        let heartbeat;

        try {
            const job = await db.run(SELECT.one.from(ExtractionJob).where({ extractionId }));

            if (!job) return;

            const names = JSON.parse(job.objectNames || "[]");
            const { sourceSystem, connection } = await sourceOf(db, job.sourceSystemId);
            const adapter = deps.createSourceAdapter({
                ...connection, systemId: sourceSystem.systemId, systemName: sourceSystem.systemName, systemType: sourceSystem.systemType
            });
            const storage = deps.getStorage();
            const settings = deps.settings;
            const maxRecords = job.maxRecordsPerObject || DEFAULT_MAX_RECORDS;

            await db.run(UPDATE(ExtractionJob).set({ status: "RUNNING", startedAt: job.startedAt || new Date().toISOString(), heartbeatAt: new Date().toISOString(), finishedAt: null }).where({ extractionId }));

            heartbeat = setInterval(() => {
                db.run(UPDATE(ExtractionJob).set({ heartbeatAt: new Date().toISOString() }).where({ extractionId })).catch(() => {});
            }, HEARTBEAT_MS);
            heartbeat.unref();
            running.set(extractionId, true);

            // how many records the source holds, when it can tell (a source that cannot count is simply without a percentage)
            const expected = {};

            if (typeof adapter.countEntitySets === "function") {
                // one count per API: the API itself (its root entity set) and the entity sets of this run
                const apis = [...new Set(names.map(name => name.split("/")[0]))];

                for (const api of apis) {
                    const sets = names.filter(name => name.startsWith(api + "/")).map(name => name.slice(api.length + 1));

                    try {
                        const rows = await withTimeout(adapter.countEntitySets(api, { only: sets, includeRoot: true }), settings.countTimeoutMs, "count timed out");

                        for (const row of rows) {
                            if (!Number.isInteger(row.count)) continue;

                            if (row.isRoot && names.includes(api)) expected[api] = row.count;
                            if (sets.includes(row.entitySet)) expected[api + "/" + row.entitySet] = row.count;
                        }
                    } catch (error) {
                        // no count for this API: its progress has no percentage
                    }
                }

                const sum = Object.values(expected).reduce((a, b) => a + b, 0);

                await db.run(UPDATE(ExtractionJob).set({ expectedRecords: Object.keys(expected).length ? sum : null }).where({ extractionId }));
            }

            let previous = null;

            if (job.resumeCount > 0) {
                try { previous = JSON.parse((await storage.get(manifestKey(extractionId))).toString("utf8")); } catch (error) { previous = null; }
            }

            let lastWrite = 0;

            const manifest = await runExtraction({
                adapter, storage, extractionId, objectNames: names, previous,
                context: { sourceSystem: sourceSystem.systemId, adapterType: connection.adapterType, businessObject: job.businessObject, requestedBy: job.requestedBy || null },
                pageSize: job.pageSize, maxRecordsPerObject: job.maxRecordsPerObject,
                hooks: {
                    expected, pauseMs: settings.pauseMs, retries: settings.retries, retryWaitMs: settings.retryWaitMs,

                    shouldCancel: async () => {
                        const row = await db.run(SELECT.one.from(ExtractionJob).columns("cancelRequested").where({ extractionId }));

                        return !!(row && row.cancelRequested);
                    },

                    onProgress: async ({ objectName, entry, manifest: live, objectFinished }) => {
                        if (!objectFinished && Date.now() - lastWrite < settings.progressEveryMs) return;

                        lastWrite = Date.now();

                        const done = live.objects.reduce((sum, o) => sum + o.records, 0) + (objectFinished ? 0 : entry.records);
                        const pages = live.objects.reduce((sum, o) => sum + o.pages, 0) + (objectFinished ? 0 : entry.pages);

                        await db.run(UPDATE(ExtractionJob).set({
                            totalRecords: done, totalPages: pages, currentObject: objectFinished ? null : objectName, heartbeatAt: new Date().toISOString(),
                            progress: JSON.stringify(progressOf(names, live, objectFinished ? null : entry, expected, maxRecords))
                        }).where({ extractionId }));
                    }
                }
            });

            const failed = manifest.objects.filter(o => o.error);
            const message =
                manifest.status === "COMPLETED" ? (manifest.totals.truncatedObjects ? `${manifest.totals.truncatedObjects} API(s) stopped at the limit of ${maxRecords} records.` : null) :
                manifest.status === "CANCELLED" ? "Stopped on request." :
                failed.map(o => `${o.objectName}: ${o.error}`).join(" | ").slice(0, 1900) || null;

            await db.run(UPDATE(ExtractionJob).set({
                status: manifest.status, finishedAt: new Date().toISOString(), currentObject: null, message,
                totalRecords: manifest.totals.records, totalPages: manifest.totals.pages,
                progress: JSON.stringify(progressOf(names, manifest, null, expected, maxRecords))
            }).where({ extractionId }));
        } catch (error) {
            console.error(`[extraction ${extractionId}] FAILED:`, error);

            await cds.db.run(UPDATE(ExtractionJob).set({
                status: "FAILED", finishedAt: new Date().toISOString(), currentObject: null,
                message: String(error.message || error).slice(0, 1900)
            }).where({ extractionId })).catch(() => {});
        } finally {
            if (heartbeat) clearInterval(heartbeat);

            running.delete(extractionId);
        }
    }

    const launch = (extractionId) => setImmediate(() => { runJob(extractionId); });

    // ------------------------------------------------------------------ actions

    on("startExtraction", async ({ sourceSystemId, businessObject, objectNames, pageSize, maxRecordsPerObject }, req) => {
        const size = positive(pageSize, "pageSize");
        const limit = positive(maxRecordsPerObject, "maxRecordsPerObject");
        const tx = cds.tx(req);
        const { sourceSystem, connection } = await sourceOf(tx, await systemFor(tx, sourceSystemId, businessObject));
        const { names: wantedNames, businessObject: proper } = await namesOf(tx, { sourceSystem, businessObject, objectNames });
        const label = proper || "(selected APIs)";

        // an item that cannot be read as it is (an M3 program on its own) is left out, with a clear message
        const checker = deps.createSourceAdapter({
            ...connection, systemId: sourceSystem.systemId, systemName: sourceSystem.systemName, systemType: sourceSystem.systemType
        });
        const names = wantedNames.filter(name => typeof checker.isExtractable !== "function" || checker.isExtractable(name));

        if (names.length === 0) {
            fail(409, `None of the items of '${label}' can be extracted as they are: they are programs, not transactions. ` +
                `Open the business object on step 2 and press 'Add entity sets / transactions' first.`);
        }

        const busy = await activeJobOf(tx, sourceSystem.systemId, label);

        if (busy.length) {
            fail(409, `An extraction of '${label}' is already running (${busy[0].extractionId}, ${Number(busy[0].totalRecords) || 0} records so far). Ask for its status, or cancel it first.`);
        }

        const extractionId = newId();

        await cds.db.run(INSERT.into(ExtractionJob).entries({
            extractionId, businessObject: label, sourceSystemId: sourceSystem.systemId, status: "QUEUED",
            objectNames: JSON.stringify(names), pageSize: size, maxRecordsPerObject: limit || DEFAULT_MAX_RECORDS,
            requestedBy: req.user && req.user.id, heartbeatAt: new Date().toISOString(), totalRecords: 0, totalPages: 0,
            progress: JSON.stringify(names.map(objectName => ({ objectName, state: "PENDING", records: 0, pages: 0, expected: null, target: null })))
        }));

        // two starts at the same moment: only the first one stays
        const first = (await activeJobOf(cds.db, sourceSystem.systemId, label))[0];

        if (first && first.extractionId !== extractionId) {
            await cds.db.run(DELETE.from(ExtractionJob).where({ extractionId }));

            fail(409, `An extraction of '${label}' is already running (${first.extractionId}). Ask for its status, or cancel it first.`);
        }

        launch(extractionId);

        return info(await cds.db.run(SELECT.one.from(ExtractionJob).where({ extractionId })));
    });

    on("getExtractionStatus", async (data, req) => info(await findJob(cds.tx(req), data)));

    on("cancelExtraction", async (data, req) => {
        const job = await findJob(cds.tx(req), data);

        if (!ACTIVE.includes(job.status)) {
            fail(409, `Extraction ${job.extractionId} is not running (it is ${job.status}), so there is nothing to cancel.`);
        }

        await cds.db.run(UPDATE(ExtractionJob).set({ cancelRequested: true }).where({ extractionId: job.extractionId }));

        return info({ ...job, cancelRequested: true });
    });

    on("resumeExtraction", async (data, req) => {
        const tx = cds.tx(req);
        const job = await findJob(tx, data);

        if (ACTIVE.includes(job.status)) fail(409, `Extraction ${job.extractionId} is still running, so it cannot be resumed.`);
        if (!RESUMABLE.includes(job.status)) fail(409, `Extraction ${job.extractionId} is ${job.status}: there is nothing to resume.`);

        const busy = await activeJobOf(tx, job.sourceSystemId, job.businessObject, job.extractionId);

        if (busy.length) fail(409, `Another extraction of '${job.businessObject}' is running (${busy[0].extractionId}). Wait for it or cancel it first.`);

        await cds.db.run(UPDATE(ExtractionJob).set({
            status: "QUEUED", cancelRequested: false, resumeCount: (job.resumeCount || 0) + 1, finishedAt: null, message: null,
            heartbeatAt: new Date().toISOString()
        }).where({ extractionId: job.extractionId }));

        launch(job.extractionId);

        return info(await cds.db.run(SELECT.one.from(ExtractionJob).where({ extractionId: job.extractionId })));
    });

    /**
     * M3: puts the list transactions of the confirmed programs of a business object into it, so that they are extracted
     * (the same idea as the entity sets of an S/4 API). A list that needs a value in every call is named, not added.
     */
    const addTransactions = async ({ tx, req, adapter, sourceSystem, businessObject, apiName, confirm }) => {
        const confirmed = await tx.run(
            SELECT.from(MigrationAssessment).where({ sourceSystemId: sourceSystem.systemId, reviewStatus: "CONFIRMED" })
        );
        const ofObject = confirmed.filter(row => norm(row.businessObject) === norm(businessObject));
        const proper = ofObject.length ? ofObject[0].businessObject : null;
        const programs = ofObject.map(row => row.sourceObject).filter(name => !name.includes("."));

        if (!proper || programs.length === 0) {
            fail(409, `No confirmed programs for business object '${businessObject}'. Confirm its programs first, then add their transactions.`);
        }

        if (str(apiName) && !programs.includes(str(apiName))) {
            fail(409, `'${str(apiName)}' is not a confirmed program of '${proper}'. Its confirmed programs: ${programs.join(", ")}.`);
        }

        const chosen = str(apiName) ? [str(apiName)] : programs;
        const decide = confirm !== false;
        const now = new Date().toISOString();
        const items = [];
        const failures = [];

        for (const program of chosen) {
            let found;

            try {
                found = await adapter.listExtractableObjects(program);
            } catch (error) {
                failures.push(`${program}: ${String(error.message || error).slice(0, 200)}`);
                continue;
            }

            for (const item of found.items || []) {
                const base = { apiName: program, entitySet: item.objectName, sourceObject: item.objectName, records: null };
                const existing = await tx.run(SELECT.one.from(MigrationAssessment).where({ sourceSystemId: sourceSystem.systemId, sourceObject: item.objectName }));

                if (existing) {
                    items.push({ ...base, result: "KEPT", reviewStatus: existing.reviewStatus });
                    continue;
                }

                await tx.run(INSERT.into(MigrationAssessment).entries({
                    sourceSystemId: sourceSystem.systemId,
                    sourceObject: item.objectName,
                    businessObject: proper,
                    component: "Transaction",
                    confidence: 100,
                    reason: `List transaction of ${program}: ${item.description || item.objectName}`,
                    modelName: "ENTITY_SET",
                    status: "COMPLETED",
                    assessedAt: now,
                    reviewStatus: decide ? "CONFIRMED" : "SUGGESTED",
                    reviewedBy: decide ? (req.user && req.user.id) || null : null,
                    reviewedAt: decide ? now : null,
                    reviewComment: decide ? "Added from the transactions of the program" : null
                }));
                items.push({ ...base, result: "ADDED", reviewStatus: decide ? "CONFIRMED" : "SUGGESTED" });
            }

            for (const skip of found.skipped || []) {
                items.push({ apiName: program, entitySet: skip.objectName, sourceObject: skip.objectName, records: null, result: "NEEDS_KEY", note: skip.reason });
            }
        }

        const by = (result) => items.filter(i => i.result === result);
        const names = (rows) => rows.slice(0, 12).map(i => i.entitySet).join(", ") + (rows.length > 12 ? ", ..." : "");
        const parts = [];

        if (by("ADDED").length) parts.push(`${by("ADDED").length} transaction(s) added to '${proper}' and ${decide ? "confirmed" : "waiting for the review"}: ${names(by("ADDED"))}.`);
        if (by("KEPT").length) parts.push(`${by("KEPT").length} were already there and are unchanged.`);
        if (by("NEEDS_KEY").length) parts.push(`${by("NEEDS_KEY").length} list(s) need a value (for example a customer number) in every call and are read per record, later: ${names(by("NEEDS_KEY"))}.`);
        if (failures.length) parts.push(`Not readable: ${failures.join(" | ")}.`);
        if (!parts.length) parts.push("Nothing to add.");

        return {
            sourceSystemId: sourceSystem.systemId,
            businessObject: proper,
            added: by("ADDED").length,
            kept: by("KEPT").length,
            skipped: by("NEEDS_KEY").length,
            items: JSON.stringify(items),
            message: parts.join(" ")
        };
    };

    on("addEntitySets", async ({ sourceSystemId, businessObject, apiName, entitySets, onlyWithData, confirm }, req) => {
        if (!str(businessObject)) fail(400, "businessObject is required: the entity sets are put into this business object");

        const tx = cds.tx(req);
        const { sourceSystem, connection } = await sourceOf(tx, await systemFor(tx, sourceSystemId, businessObject));
        const adapter = deps.createSourceAdapter({
            ...connection, systemId: sourceSystem.systemId, systemName: sourceSystem.systemName, systemType: sourceSystem.systemType
        });

        if (typeof adapter.countEntitySets !== "function" && typeof adapter.listExtractableObjects === "function") {
            return addTransactions({ tx, req, adapter, sourceSystem, businessObject, apiName, confirm });
        }

        if (typeof adapter.countEntitySets !== "function") {
            fail(400, `The ${connection.adapterType || sourceSystem.systemType} source has no entity sets: its APIs are extracted as they are.`);
        }

        // the confirmed APIs of the business object (not the entity sets)
        const confirmed = await tx.run(
            SELECT.from(MigrationAssessment).where({ sourceSystemId: sourceSystem.systemId, reviewStatus: "CONFIRMED" })
        );
        const ofObject = confirmed.filter(row => norm(row.businessObject) === norm(businessObject));
        const proper = ofObject.length ? ofObject[0].businessObject : null;
        const roots = ofObject.map(row => row.sourceObject).filter(name => !name.includes("/"));

        if (!proper || roots.length === 0) {
            fail(409, `No confirmed APIs for business object '${businessObject}'. Confirm the API first, then add its entity sets.`);
        }

        const apis = str(apiName) ? [str(apiName)] : roots;

        if (str(apiName) && !roots.includes(str(apiName))) {
            fail(409, `'${str(apiName)}' is not a confirmed API of '${proper}'. Its confirmed APIs: ${roots.join(", ")}.`);
        }

        const wanted = (entitySets || []).map(str).filter(Boolean);
        const only = onlyWithData !== false;
        const items = [];
        const failures = [];

        // read everything first, so that a wrong request writes nothing
        const counted = [];

        for (const api of apis) {
            try {
                counted.push({ api, sets: await adapter.countEntitySets(api) });
            } catch (error) {
                failures.push(`${api}: ${String(error.message || error).slice(0, 200)}`);
            }
        }

        if (counted.length === 0) fail(502, `The entity sets could not be read from the source. ${failures.join(" | ")}`);

        if (wanted.length) {
            const known = new Set(counted.flatMap(c => c.sets.map(s => s.entitySet)));
            const unknown = wanted.filter(name => !known.has(name));

            if (unknown.length) fail(400, `Unknown entity set(s): ${unknown.join(", ")}. Use countSourceRecords to list the entity sets of the API.`);
        }

        const decide = confirm !== false;
        const now = new Date().toISOString();

        for (const { api, sets } of counted) {
            for (const set of sets.filter(s => !s.isRoot && (!wanted.length || wanted.includes(s.entitySet)))) {
                const sourceObject = `${api}/${set.entitySet}`;
                const item = { apiName: api, entitySet: set.entitySet, sourceObject, records: set.count };

                if (!wanted.length && only && set.count === null) {
                    items.push({ ...item, result: "NOT_COUNTABLE", note: set.error || "the source could not count it" });
                    continue;
                }

                if (!wanted.length && only && set.count === 0) {
                    items.push({ ...item, result: "EMPTY" });
                    continue;
                }

                const existing = await tx.run(SELECT.one.from(MigrationAssessment).where({ sourceSystemId: sourceSystem.systemId, sourceObject }));

                if (existing) {
                    items.push({ ...item, result: "KEPT", reviewStatus: existing.reviewStatus });
                    continue;
                }

                await tx.run(INSERT.into(MigrationAssessment).entries({
                    sourceSystemId: sourceSystem.systemId,
                    sourceObject,
                    businessObject: proper,
                    component: "Entity set",
                    confidence: 100,
                    reason: `Entity set of ${api}` + (set.count === null ? "." : `: ${set.count} record(s) in the source.`),
                    modelName: "ENTITY_SET",            // origin: added from the entity sets of an API
                    status: "COMPLETED",
                    assessedAt: now,
                    reviewStatus: decide ? "CONFIRMED" : "SUGGESTED",
                    reviewedBy: decide ? (req.user && req.user.id) || null : null,
                    reviewedAt: decide ? now : null,
                    reviewComment: decide ? "Added from the entity sets of the API" : null
                }));

                items.push({ ...item, result: "ADDED", reviewStatus: decide ? "CONFIRMED" : "SUGGESTED" });
            }
        }

        const by = (result) => items.filter(i => i.result === result);
        const list = (rows) => rows.slice(0, 15).map(i => `${i.entitySet} ${i.records === null ? "?" : i.records}`).join(", ") + (rows.length > 15 ? ", ..." : "");
        const parts = [];

        if (by("ADDED").length) parts.push(`${by("ADDED").length} entity set(s) added to '${proper}' and ${decide ? "confirmed" : "waiting for the review"}: ${list(by("ADDED"))}.`);
        if (by("KEPT").length) parts.push(`${by("KEPT").length} were already there and are unchanged.`);
        if (by("EMPTY").length) parts.push(`${by("EMPTY").length} empty entity set(s) skipped.`);
        if (by("NOT_COUNTABLE").length) parts.push(`${by("NOT_COUNTABLE").length} could not be counted and were skipped.`);
        if (failures.length) parts.push(`Not readable: ${failures.join(" | ")}.`);
        if (!parts.length) parts.push("Nothing to add.");

        return {
            sourceSystemId: sourceSystem.systemId,
            businessObject: proper,
            added: by("ADDED").length,
            kept: by("KEPT").length,
            skipped: by("EMPTY").length + by("NOT_COUNTABLE").length,
            items: JSON.stringify(items),
            message: parts.join(" ")
        };
    });

    on("describeSourceObject", async ({ sourceSystemId, objectName }, req) => {
        if (!sourceSystemId) fail(400, "sourceSystemId is required");
        if (!str(objectName)) fail(400, "objectName is required");

        const tx = cds.tx(req);
        const { sourceSystem, connection } = await sourceOf(tx, sourceSystemId);
        const adapter = deps.createSourceAdapter({
            ...connection, systemId: sourceSystem.systemId, systemName: sourceSystem.systemName, systemType: sourceSystem.systemType
        });

        if (typeof adapter.describeObject !== "function") {
            return { objectName: str(objectName), title: str(objectName), description: "", itemLabel: "", items: "[]", hiddenCount: 0, note: "This source cannot describe its objects." };
        }

        let result;

        try {
            result = await adapter.describeObject(str(objectName));
        } catch (error) {
            fail(/does not exist|was not found|not in the/i.test(error.message) ? 404 : 502, String(error.message || error).slice(0, 400));
        }

        return {
            objectName: str(objectName),
            title: result.title || str(objectName),
            description: String(result.description || "").slice(0, 1000),
            itemLabel: result.itemLabel || "",
            items: JSON.stringify(result.items || []),
            hiddenCount: result.hiddenCount || 0,
            note: result.note || ""
        };
    });

    on("countSourceRecords", async ({ sourceSystemId, businessObject, objectNames }, req) => {
        const tx = cds.tx(req);
        const { sourceSystem, connection } = await sourceOf(tx, await systemFor(tx, sourceSystemId, businessObject));
        const { names, businessObject: proper } = await namesOf(tx, { sourceSystem, businessObject, objectNames });
        const adapter = deps.createSourceAdapter({
            ...connection, systemId: sourceSystem.systemId, systemName: sourceSystem.systemName, systemType: sourceSystem.systemType
        });

        if (typeof adapter.countEntitySets !== "function") {
            fail(400, `The ${connection.adapterType || sourceSystem.systemType} source cannot tell how many records it holds.`);
        }

        const objects = [];
        let rootRecords = 0;

        for (const objectName of names) {
            try {
                const entitySets = await adapter.countEntitySets(objectName);

                entitySets.filter(s => s.isRoot && Number.isInteger(s.count)).forEach(s => { rootRecords += s.count; });
                objects.push({ objectName, entitySets });
            } catch (error) {
                objects.push({ objectName, entitySets: [], error: String(error.message || error).slice(0, 300) });
            }
        }

        const lines = objects.map(o => {
            if (o.error) return `${o.objectName}: could not be counted (${o.error})`;

            const filled = o.entitySets.filter(s => s.count > 0).sort((a, b) => b.count - a.count);
            const unknown = o.entitySets.filter(s => s.count === null).length;

            return `${o.objectName}: ${filled.length} of ${o.entitySets.length} entity sets hold data` +
                (filled.length ? ` - ${filled.slice(0, 12).map(s => `${s.entitySet} ${s.count}`).join(", ")}` : "") +
                (unknown ? `; ${unknown} could not be counted` : "") + ".";
        });

        return {
            sourceSystemId: sourceSystem.systemId,
            businessObject: proper || null,
            rootRecords,
            objects: JSON.stringify(objects),
            message: lines.join("\n")
        };
    });

    // ------------------------------------------------------------------ after a restart

    /** Jobs that were running when the application stopped are shown as INTERRUPTED (see refresh()). */
    // (not awaited: the server must not wait for the database before it listens)
    cds.once("served", () => {
        (async () => {
            const rows = await cds.db.run(SELECT.from(ExtractionJob).where({ status: { in: ACTIVE } }));

            for (const row of rows) await refresh(row);
        })().catch(error => console.warn("[extraction jobs] restart check skipped:", error.message));
    });
}

module.exports = registerExtractionJobHandlers;
module.exports._deps = deps;
