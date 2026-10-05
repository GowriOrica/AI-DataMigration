"use strict";

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.CDS_PLUGIN_UI5_ACTIVE = "false";
process.env.AI_PROVIDER = "OPENROUTER";
process.env.OPENROUTER_API_KEY = "fake-key-for-tests";
process.env.OPENROUTER_MODEL = "fake/model";
process.env.GEMINI_API_KEY = "fake-key-for-tests";

const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mo-jobs-"));
process.env.STORAGE_DIR = STORAGE_DIR;

const cds = require("@sap/cds");

const { POST } = cds.test(
    "serve",
    "srv/migration-service.cds",
    "srv/extraction-job-service.cds",
    "srv/framework-service.cds",
    "--in-memory"
).in(path.join(__dirname, ".."));

const jobs = require("../srv/extraction-job-handlers");

const SYSTEM = "SRC_JOBS";
const call = (action, data = {}) => POST(`/migration/${action}`, data);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const waitFor = async (check, what, ms = 8000) => {
    const end = Date.now() + ms;

    for (;;) {
        const value = await check();

        if (value) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);

        await sleep(25);
    }
};

const statusOf = async (extractionId) => (await call("getExtractionStatus", { extractionId })).data;
const waitForStatus = (extractionId, wanted) =>
    waitFor(async () => { const s = await statusOf(extractionId); return wanted.includes(s.status) ? s : null; }, `${extractionId} to be ${wanted}`);

const manifestOf = (extractionId) =>
    JSON.parse(fs.readFileSync(path.join(STORAGE_DIR, "extractions", extractionId, "manifest.json"), "utf8"));

/**
 * A source that behaves as the test says: how many records per API, which call fails, and a gate that holds
 * every page until the test opens it (so a test can look at a running job).
 */
const fakeSource = (data, { count = true } = {}) => {
    const source = {
        data, calls: [], failures: {}, gate: null, pages: {},
        async extract(objectName, { top, skip }) {
            source.calls.push(`${objectName}@${skip}`);
            source.pages[objectName] = (source.pages[objectName] || 0) + 1;

            if (source.gate) await source.gate;

            const failure = source.failures[objectName];

            if (failure && failure.times > 0) {
                failure.times--;
                throw new Error(failure.message);
            }

            const all = source.data[objectName] || 0;
            const records = [];

            for (let i = skip; i < Math.min(all, skip + top); i++) records.push({ ID: `${objectName}-${i}`, Name: ` name ${i} ` });

            return { records, metadata: { recordCount: records.length } };
        }
    };

    if (count) {
        source.countEntitySets = async (objectName, { rootOnly, only, includeRoot } = {}) => {
            const sets = [{ entitySet: `${objectName}_Root`, isRoot: true, count: source.data[objectName] }];

            if (!rootOnly) {
                const child = source.data[`${objectName}/${objectName}_Child`];

                sets.push({ entitySet: `${objectName}_Child`, isRoot: false, count: child === undefined ? 7 : child }, { entitySet: `${objectName}_Odd`, isRoot: false, count: null, error: "HTTP 403" });
            }

            return only ? sets.filter(s => only.includes(s.entitySet) || (includeRoot && s.isRoot)) : sets;
        };
    }

    return source;
};

const useSource = (source) => { jobs._deps.createSourceAdapter = () => source; };

describe("Background extraction", () => {

    before(async () => {
        const systemId = cds.utils.uuid();

        await INSERT.into("migration.orchestrator.SourceSystem").entries({ ID: systemId, systemId: SYSTEM, systemName: "Jobs test", systemType: "S4HANA", active: true });
        await INSERT.into("migration.orchestrator.SourceConnection").entries({
            connectionId: "SRC_JOBS_CONN", connectionName: "fake", interfaceType: "ODATA",
            adapterType: "S4HANA", authenticationType: "MOCK", status: "CONNECTED", sourceSystem_ID: systemId
        });
        await INSERT.into("migration.orchestrator.MigrationAssessment").entries(["API_ONE", "API_TWO"].map(sourceObject => ({
            sourceSystemId: SYSTEM, sourceObject, businessObject: "Business Partner", component: "Master Data",
            confidence: 90, status: "COMPLETED", metadataVersion: "1.0", reviewStatus: "CONFIRMED"
        })));

        jobs._deps.settings = { pauseMs: 0, retries: 2, retryWaitMs: 1, countTimeoutMs: 2000, progressEveryMs: 0 };
    });

    beforeEach(async () => {
        // every test starts without a running job
        await cds.db.run(UPDATE("migration.framework.ExtractionJob").set({ status: "CANCELLED" }).where({ status: { in: ["QUEUED", "RUNNING"] } }));
    });

    describe("a normal run", () => {

        it("answers at once, runs in the background and ends COMPLETED with the data in the Object Store", async () => {
            const source = fakeSource({ API_ONE: 450, API_TWO: 120 });
            let release;

            source.gate = new Promise(resolve => { release = resolve; });
            useSource(source);

            const started = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner", pageSize: 100, maxRecordsPerObject: 1000 })).data;

            assert.match(started.extractionId, /^EX-/);
            assert.ok(["QUEUED", "RUNNING"].includes(started.status), "the answer comes before the extraction is done");
            assert.equal(started.resumable, false);

            const running = await waitForStatus(started.extractionId, ["RUNNING"]);

            assert.match(running.message, /is running/);

            release();

            const done = await waitForStatus(started.extractionId, ["COMPLETED"]);

            assert.equal(done.totalRecords, 570);
            assert.equal(done.expectedRecords, 570);
            assert.equal(done.percent, 100);
            assert.match(done.message, /is complete: 570 record\(s\) from 2 API\(s\)/);
            assert.deepEqual(JSON.parse(done.objects).map(o => [o.objectName, o.state, o.records]), [["API_ONE", "DONE", 450], ["API_TWO", "DONE", 120]]);

            const manifest = manifestOf(started.extractionId);

            assert.equal(manifest.status, "COMPLETED");
            assert.equal(manifest.totals.records, 570);
            assert.equal(manifest.businessObject, "Business Partner");
        });

        it("shows progress while it runs", async () => {
            const source = fakeSource({ API_ONE: 400, API_TWO: 0 });
            let release;

            useSource(source);

            // hold the second page of API_ONE
            const original = source.extract;

            let held = false;

            source.extract = async function (name, options) {
                if (name === "API_ONE" && options.skip >= 200 && !held) {
                    held = true;
                    await new Promise(resolve => { release = resolve; });
                }

                return original.call(source, name, options);
            };

            const started = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner", pageSize: 100 })).data;

            const mid = await waitFor(async () => {
                const s = await statusOf(started.extractionId);

                return s.status === "RUNNING" && s.totalRecords >= 200 ? s : null;
            }, "progress");

            assert.equal(mid.currentObject, "API_ONE");
            assert.ok(mid.percent >= 40 && mid.percent < 100, `percent ${mid.percent}`);
            assert.match(mid.message, /about \d+ %/);

            release();
            await waitForStatus(started.extractionId, ["COMPLETED"]);
        });

        it("says the percentage is unknown when the source cannot count", async () => {
            useSource(fakeSource({ API_ONE: 30, API_TWO: 30 }, { count: false }));

            const started = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;
            const done = await waitForStatus(started.extractionId, ["COMPLETED"]);

            assert.equal(done.percent, null);
            assert.equal(done.expectedRecords, null);
            assert.equal(done.totalRecords, 60);
        });

        it("marks an API that stopped at the record limit", async () => {
            useSource(fakeSource({ API_ONE: 500, API_TWO: 10 }));

            const started = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner", maxRecordsPerObject: 200, pageSize: 100 })).data;
            const done = await waitForStatus(started.extractionId, ["COMPLETED"]);

            assert.equal(done.totalRecords, 210);
            assert.equal(JSON.parse(done.objects)[0].state, "STOPPED_AT_LIMIT");
            assert.equal(manifestOf(started.extractionId).totals.truncatedObjects, 1);
        });

        it("extracts only the APIs that were asked for", async () => {
            const source = fakeSource({ API_ONE: 5, API_TWO: 5 });

            useSource(source);

            const started = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner", objectNames: ["API_TWO"] })).data;

            await waitForStatus(started.extractionId, ["COMPLETED"]);
            assert.ok(source.calls.every(c => c.startsWith("API_TWO")));
        });
    });

    describe("only one extraction of a business object at a time", () => {

        it("refuses a second start (any spelling of the name) and names the running job", async () => {
            const source = fakeSource({ API_ONE: 50, API_TWO: 50 });
            let release;

            source.gate = new Promise(resolve => { release = resolve; });
            useSource(source);

            const first = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;

            await assert.rejects(
                call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "business  partner" }),
                error => error.response.status === 409 && error.response.data.error.message.includes(first.extractionId)
            );

            release();
            await waitForStatus(first.extractionId, ["COMPLETED"]);

            // after it ended a new one may start
            const second = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;

            assert.notEqual(second.extractionId, first.extractionId);
            await waitForStatus(second.extractionId, ["COMPLETED"]);
        });

        it("lets only one of two simultaneous starts through", async () => {
            const source = fakeSource({ API_ONE: 20, API_TWO: 20 });
            let release;

            source.gate = new Promise(resolve => { release = resolve; });
            useSource(source);

            const results = await Promise.allSettled([
                call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" }),
                call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })
            ]);

            assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
            assert.equal(results.filter(r => r.status === "rejected" && r.reason.response.status === 409).length, 1);

            release();
            await waitForStatus(results.find(r => r.status === "fulfilled").value.data.extractionId, ["COMPLETED"]);
        });
    });

    describe("source problems", () => {

        it("tries a temporary error again and still completes", async () => {
            const source = fakeSource({ API_ONE: 10, API_TWO: 10 });

            source.failures.API_ONE = { times: 2, message: "Extraction failed for 'API_ONE': Request failed with status code 503" };
            useSource(source);

            const started = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;
            const done = await waitForStatus(started.extractionId, ["COMPLETED"]);

            assert.equal(done.totalRecords, 20);
        });

        it("does not retry a permanent error: that API fails, the others are stored (PARTIAL)", async () => {
            const source = fakeSource({ API_ONE: 10, API_TWO: 10 });

            source.failures.API_ONE = { times: 99, message: "Extraction failed for 'API_ONE': Request failed with status code 403" };
            useSource(source);

            const started = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;
            const done = await waitForStatus(started.extractionId, ["PARTIAL"]);

            assert.equal(done.totalRecords, 10);
            assert.equal(done.resumable, true);
            assert.match(done.message, /API_ONE: .*403/);
            assert.equal(source.pages.API_ONE, 1, "a permanent error is not tried again");
            assert.deepEqual(JSON.parse(done.objects).map(o => o.state), ["FAILED", "DONE"]);
        });

        it("gives up after the retries on a source that stays down (FAILED)", async () => {
            const source = fakeSource({ API_ONE: 10, API_TWO: 10 });

            source.failures.API_ONE = { times: 99, message: "connect ECONNREFUSED" };
            source.failures.API_TWO = { times: 99, message: "Request failed with status code 503" };
            useSource(source);

            const started = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;
            const done = await waitForStatus(started.extractionId, ["FAILED"]);

            assert.equal(done.totalRecords, 0);
            assert.equal(source.pages.API_ONE, 3, "first try plus two retries");
            assert.match(done.message, /ECONNREFUSED/);
        });
    });

    describe("cancel and resume", () => {

        it("cancels a running job after the current page, keeps what is stored and resumes the rest", async () => {
            const source = fakeSource({ API_ONE: 300, API_TWO: 100 });
            let release;

            source.gate = new Promise(resolve => { release = resolve; });
            useSource(source);

            const started = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner", pageSize: 100 })).data;

            await waitForStatus(started.extractionId, ["RUNNING"]);

            const asked = (await call("cancelExtraction", { businessObject: "Business Partner" })).data;

            assert.match(asked.message, /cancel was requested/);

            release();

            const cancelled = await waitForStatus(started.extractionId, ["CANCELLED"]);

            assert.equal(cancelled.resumable, true);
            assert.ok(cancelled.totalRecords < 400);
            assert.equal(manifestOf(started.extractionId).status, "CANCELLED");

            // resume with a source that works: same extraction folder, everything is there at the end
            source.gate = null;

            const resumed = (await call("resumeExtraction", { extractionId: started.extractionId })).data;

            assert.equal(resumed.extractionId, started.extractionId);

            const done = await waitForStatus(started.extractionId, ["COMPLETED"]);

            assert.equal(done.totalRecords, 400);
            assert.equal(manifestOf(started.extractionId).totals.records, 400);
        });

        it("resume keeps the APIs that were complete and reads only the others again", async () => {
            const source = fakeSource({ API_ONE: 10, API_TWO: 10 });

            source.failures.API_TWO = { times: 99, message: "Request failed with status code 403" };
            useSource(source);

            const started = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;

            await waitForStatus(started.extractionId, ["PARTIAL"]);

            const before = source.calls.filter(c => c.startsWith("API_ONE")).length;

            source.failures.API_TWO = { times: 0, message: "" };
            await call("resumeExtraction", { extractionId: started.extractionId });

            const done = await waitForStatus(started.extractionId, ["COMPLETED"]);

            assert.equal(done.totalRecords, 20);
            assert.equal(source.calls.filter(c => c.startsWith("API_ONE")).length, before, "API_ONE was not read again");
        });

        it("refuses to cancel or resume what cannot be cancelled or resumed", async () => {
            useSource(fakeSource({ API_ONE: 5, API_TWO: 5 }));

            const started = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;

            await waitForStatus(started.extractionId, ["COMPLETED"]);

            await assert.rejects(call("cancelExtraction", { extractionId: started.extractionId }), e => e.response.status === 409 && /nothing to cancel/.test(e.response.data.error.message));
            await assert.rejects(call("resumeExtraction", { extractionId: started.extractionId }), e => e.response.status === 409 && /nothing to resume/.test(e.response.data.error.message));
        });

        it("refuses to resume while the job runs", async () => {
            const source = fakeSource({ API_ONE: 5, API_TWO: 5 });
            let release;

            source.gate = new Promise(resolve => { release = resolve; });
            useSource(source);

            const started = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;

            await assert.rejects(call("resumeExtraction", { extractionId: started.extractionId }), e => e.response.status === 409 && /still running/.test(e.response.data.error.message));

            release();
            await waitForStatus(started.extractionId, ["COMPLETED"]);
        });
    });

    describe("an application restart", () => {

        it("shows a job that stopped reporting as INTERRUPTED and resumes it", async () => {
            const extractionId = "EX-STALE-0001";

            await cds.db.run(INSERT.into("migration.framework.ExtractionJob").entries({
                extractionId, businessObject: "Business Partner", sourceSystemId: SYSTEM, status: "RUNNING",
                objectNames: JSON.stringify(["API_ONE", "API_TWO"]), totalRecords: 50,
                heartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
            }));

            const status = await statusOf(extractionId);

            assert.equal(status.status, "INTERRUPTED");
            assert.equal(status.resumable, true);
            assert.match(status.message, /application stopped/);

            // a second start is allowed (the stale job does not block), and the old one can still be resumed afterwards
            useSource(fakeSource({ API_ONE: 5, API_TWO: 5 }));
            await call("resumeExtraction", { extractionId });

            const done = await waitForStatus(extractionId, ["COMPLETED"]);

            assert.equal(done.totalRecords, 10);
        });

        it("does not call a job that is still reporting interrupted", async () => {
            const extractionId = "EX-FRESH-0001";

            await cds.db.run(INSERT.into("migration.framework.ExtractionJob").entries({
                extractionId, businessObject: "Other Object", sourceSystemId: SYSTEM, status: "RUNNING",
                objectNames: "[]", heartbeatAt: new Date().toISOString()
            }));

            assert.equal((await statusOf(extractionId)).status, "RUNNING");
        });
    });

    describe("questions about jobs", () => {

        it("finds the latest job by business object name", async () => {
            useSource(fakeSource({ API_ONE: 5, API_TWO: 5 }));

            const started = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;

            await waitForStatus(started.extractionId, ["COMPLETED"]);

            const byName = (await call("getExtractionStatus", { businessObject: "business partner" })).data;

            assert.equal(byName.extractionId, started.extractionId);
        });

        it("says what is wrong when nothing is found", async () => {
            await assert.rejects(call("getExtractionStatus", { extractionId: "EX-NOPE" }), e => e.response.status === 404 && /No extraction job 'EX-NOPE'/.test(e.response.data.error.message));
            await assert.rejects(call("getExtractionStatus", { businessObject: "Material" }), e => e.response.status === 404 && /Business objects with a job: .*Business Partner/.test(e.response.data.error.message));
            await assert.rejects(call("getExtractionStatus", {}), e => e.response.status === 400);
            await assert.rejects(call("cancelExtraction", { extractionId: "EX-NOPE" }), e => e.response.status === 404);
            await assert.rejects(call("resumeExtraction", { extractionId: "EX-NOPE" }), e => e.response.status === 404);
        });
    });

    describe("wrong requests do not create a job", () => {

        const jobCount = async () => (await cds.db.run(SELECT.from("migration.framework.ExtractionJob"))).length;

        it("rejects a missing, unknown or unconnected source system", async () => {
            const before = await jobCount();

            await assert.rejects(call("startExtraction", {}), e => e.response.status === 400);
            await assert.rejects(call("startExtraction", { sourceSystemId: "NOPE", businessObject: "Business Partner" }), e => e.response.status === 404);
            assert.equal(await jobCount(), before);
        });

        it("rejects a business object without confirmed APIs, and a start without any business object or API", async () => {
            const before = await jobCount();

            await assert.rejects(call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Material" }), e => e.response.status === 409 && /No confirmed APIs/.test(e.response.data.error.message));
            await assert.rejects(call("startExtraction", { sourceSystemId: SYSTEM }), e => e.response.status === 400);
            assert.equal(await jobCount(), before);
        });

        it("rejects limits that are not whole positive numbers", async () => {
            const before = await jobCount();

            for (const bad of [{ pageSize: -5 }, { pageSize: 0 }, { maxRecordsPerObject: -1 }]) {
                await assert.rejects(call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner", ...bad }), e => e.response.status === 400);
            }

            assert.equal(await jobCount(), before);
        });
    });

    describe("the source system is found from the business object", () => {

        it("starts without a source system when only one has confirmed APIs for the business object", async () => {
            useSource(fakeSource({ API_ONE: 4, API_TWO: 4 }));

            const started = (await call("startExtraction", { businessObject: "business partner" })).data;

            assert.equal(started.sourceSystemId, SYSTEM);
            await waitForStatus(started.extractionId, ["COMPLETED"]);
        });

        it("asks which system when several have confirmed APIs, and says so when none has", async () => {
            const otherId = cds.utils.uuid();

            await INSERT.into("migration.orchestrator.SourceSystem").entries({ ID: otherId, systemId: "SRC_OTHER", systemName: "Other", systemType: "S4HANA", active: true });
            await INSERT.into("migration.orchestrator.MigrationAssessment").entries({
                sourceSystemId: "SRC_OTHER", sourceObject: "API_X", businessObject: "Business Partner", component: "Master Data",
                confidence: 90, status: "COMPLETED", metadataVersion: "1.0", reviewStatus: "CONFIRMED"
            });

            await assert.rejects(call("startExtraction", { businessObject: "Business Partner" }), e => e.response.status === 409 && /several source systems: SRC_JOBS, SRC_OTHER/.test(e.response.data.error.message));
            await assert.rejects(call("addEntitySets", { businessObject: "Business Partner" }), e => e.response.status === 409);
            await assert.rejects(call("startExtraction", { businessObject: "Material" }), e => e.response.status === 409 && /in any source system/.test(e.response.data.error.message));

            await cds.db.run(DELETE.from("migration.orchestrator.MigrationAssessment").where({ sourceSystemId: "SRC_OTHER" }));
        });
    });

    describe("what a discovered object offers (the same for every source)", () => {

        const body = { sourceSystemId: SYSTEM, objectName: "API_ONE" };

        it("answers in one shape: title, what it offers, how many items are hidden, a note", async () => {
            const source = fakeSource({ API_ONE: 1, API_TWO: 1 });

            source.describeObject = async (name) => ({
                title: name, description: "Remote API", itemLabel: "Entity sets of this API",
                items: [{ name: "A_One", description: "One", kind: "ENTITY_SET" }, { name: "A_Two", description: "", kind: "ENTITY_SET" }],
                hiddenCount: 3, note: "a note"
            });
            useSource(source);

            const result = (await call("describeSourceObject", body)).data;

            assert.equal(result.title, "API_ONE");
            assert.equal(result.itemLabel, "Entity sets of this API");
            assert.deepEqual(JSON.parse(result.items).map(i => i.name), ["A_One", "A_Two"]);
            assert.equal(result.hiddenCount, 3);
            assert.equal(result.note, "a note");
        });

        it("says so when the source cannot describe its objects", async () => {
            useSource(fakeSource({ API_ONE: 1, API_TWO: 1 }));

            const result = (await call("describeSourceObject", body)).data;

            assert.deepEqual(JSON.parse(result.items), []);
            assert.match(result.note, /cannot describe/);
        });

        it("refuses wrong requests with a clear answer", async () => {
            const source = fakeSource({ API_ONE: 1, API_TWO: 1 });

            source.describeObject = async (name) => {
                if (name === "NOPE") throw new Error("M3 program 'NOPE' does not exist in this M3 tenant");
                throw new Error("connect ECONNREFUSED");
            };
            useSource(source);

            await assert.rejects(call("describeSourceObject", { sourceSystemId: SYSTEM, objectName: "NOPE" }), e => e.response.status === 404 && /does not exist/.test(e.response.data.error.message));
            await assert.rejects(call("describeSourceObject", body), e => e.response.status === 502 && /ECONNREFUSED/.test(e.response.data.error.message));
            await assert.rejects(call("describeSourceObject", { sourceSystemId: SYSTEM }), e => e.response.status === 400);
            await assert.rejects(call("describeSourceObject", { objectName: "X" }), e => e.response.status === 400);
            await assert.rejects(call("describeSourceObject", { sourceSystemId: "NOPE", objectName: "X" }), e => e.response.status === 404);
        });
    });

    describe("source size", () => {

        it("counts the records per API and entity set before an extraction", async () => {
            useSource(fakeSource({ API_ONE: 492, API_TWO: 8 }));

            const result = (await call("countSourceRecords", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;

            assert.equal(result.rootRecords, 500);
            assert.match(result.message, /API_ONE: 2 of 3 entity sets hold data - API_ONE_Root 492, API_ONE_Child 7; 1 could not be counted/);
            assert.equal(JSON.parse(result.objects)[0].entitySets.length, 3);
        });

        it("says so when the source cannot count", async () => {
            useSource(fakeSource({ API_ONE: 1, API_TWO: 1 }, { count: false }));

            await assert.rejects(call("countSourceRecords", { sourceSystemId: SYSTEM, businessObject: "Business Partner" }), e => e.response.status === 400 && /cannot tell how many records/.test(e.response.data.error.message));
        });

        it("reports an API that cannot be counted without stopping the others", async () => {
            const source = fakeSource({ API_ONE: 4, API_TWO: 6 });
            const original = source.countEntitySets;

            source.countEntitySets = async (name, options) => {
                if (name === "API_ONE") throw new Error("API 'API_ONE' is not in the source system's API list");

                return original(name, options);
            };
            useSource(source);

            const result = (await call("countSourceRecords", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;

            assert.equal(result.rootRecords, 6);
            assert.match(result.message, /API_ONE: could not be counted/);
        });
    });

    describe("entity sets of an API", () => {

        const items = (result) => JSON.parse(result.items);
        const rowsOf = () => cds.db.run(SELECT.from("migration.orchestrator.MigrationAssessment").where({ modelName: "ENTITY_SET" }));

        beforeEach(async () => {
            await cds.db.run(DELETE.from("migration.orchestrator.MigrationAssessment").where({ modelName: "ENTITY_SET" }));
        });

        it("adds the entity sets that hold data, confirmed, and skips empty and uncountable ones", async () => {
            const source = fakeSource({ API_ONE: 5, API_TWO: 5 });
            const original = source.countEntitySets;

            // API_ONE also has an empty entity set
            source.countEntitySets = async (name, options) => {
                const sets = await original(name, options);

                return name === "API_ONE" ? [...sets, { entitySet: "API_ONE_Empty", isRoot: false, count: 0 }] : sets;
            };
            useSource(source);

            const result = (await call("addEntitySets", { sourceSystemId: SYSTEM, businessObject: "business  partner" })).data;

            assert.equal(result.businessObject, "Business Partner");
            assert.equal(result.added, 2);
            assert.equal(result.skipped, 3);                        // one empty, two that could not be counted
            assert.deepEqual(items(result).filter(i => i.result === "ADDED").map(i => i.sourceObject), ["API_ONE/API_ONE_Child", "API_TWO/API_TWO_Child"]);
            assert.match(result.message, /2 entity set\(s\) added to 'Business Partner' and confirmed: API_ONE_Child 7, API_TWO_Child 7\./);
            assert.match(result.message, /1 empty entity set\(s\) skipped/);

            const rows = await rowsOf();

            assert.equal(rows.length, 2);
            assert.ok(rows.every(r => r.reviewStatus === "CONFIRMED" && r.businessObject === "Business Partner" && r.component === "Entity set"));
        });

        it("does not add them twice and does not change a decision that was made", async () => {
            useSource(fakeSource({ API_ONE: 5, API_TWO: 5 }));
            await call("addEntitySets", { sourceSystemId: SYSTEM, businessObject: "Business Partner" });

            await cds.db.run(UPDATE("migration.orchestrator.MigrationAssessment").set({ reviewStatus: "REJECTED" }).where({ sourceObject: "API_ONE/API_ONE_Child" }));

            const again = (await call("addEntitySets", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;

            assert.equal(again.added, 0);
            assert.equal(again.kept, 2);
            assert.equal((await rowsOf()).length, 2);
            assert.equal(items(again).find(i => i.sourceObject === "API_ONE/API_ONE_Child").reviewStatus, "REJECTED");
        });

        it("adds the entity sets that are named, also an empty one, and only those", async () => {
            const source = fakeSource({ API_ONE: 5, API_TWO: 5 });
            const original = source.countEntitySets;

            source.countEntitySets = async (name, options) => [...await original(name, options), { entitySet: `${name}_Empty`, isRoot: false, count: 0 }];
            useSource(source);

            const result = (await call("addEntitySets", {
                sourceSystemId: SYSTEM, businessObject: "Business Partner", apiName: "API_ONE", entitySets: ["API_ONE_Empty"]
            })).data;

            assert.equal(result.added, 1);
            assert.deepEqual((await rowsOf()).map(r => r.sourceObject), ["API_ONE/API_ONE_Empty"]);
        });

        it("lets the review decide when confirm is false, and the extraction reads only confirmed items", async () => {
            const source = fakeSource({ API_ONE: 3, API_TWO: 3, "API_ONE/API_ONE_Child": 7, "API_TWO/API_TWO_Child": 7 });

            useSource(source);

            const result = (await call("addEntitySets", { sourceSystemId: SYSTEM, businessObject: "Business Partner", confirm: false })).data;

            assert.match(result.message, /waiting for the review/);
            assert.ok((await rowsOf()).every(r => r.reviewStatus === "SUGGESTED"));

            const first = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;

            await waitForStatus(first.extractionId, ["COMPLETED"]);
            assert.deepEqual(manifestOf(first.extractionId).objects.map(o => o.objectName), ["API_ONE", "API_TWO"]);

            // confirmed: the APIs come first, then their entity sets
            await cds.db.run(UPDATE("migration.orchestrator.MigrationAssessment").set({ reviewStatus: "CONFIRMED" }).where({ modelName: "ENTITY_SET" }));

            const second = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;
            const done = await waitForStatus(second.extractionId, ["COMPLETED"]);

            assert.deepEqual(manifestOf(second.extractionId).objects.map(o => o.objectName), ["API_ONE", "API_TWO", "API_ONE/API_ONE_Child", "API_TWO/API_TWO_Child"]);
            assert.equal(done.totalRecords, 3 + 3 + 7 + 7);
            assert.equal(done.expectedRecords, 20, "the expected number includes the entity sets");
            assert.equal(done.percent, 100);
            assert.ok(fs.existsSync(path.join(STORAGE_DIR, "extractions", second.extractionId, "API_ONE_API_ONE_Child")), "an entity set gets its own folder");
        });

        it("names the Excel sheets of entity sets after the entity set", async () => {
            useSource(fakeSource({ API_ONE: 3, API_TWO: 3, "API_ONE/API_ONE_Child": 2, "API_TWO/API_TWO_Child": 2 }));
            await call("addEntitySets", { sourceSystemId: SYSTEM, businessObject: "Business Partner" });

            const started = (await call("startExtraction", { sourceSystemId: SYSTEM, businessObject: "Business Partner" })).data;

            await waitForStatus(started.extractionId, ["COMPLETED"]);

            const exported = (await call("exportExtractionToExcel", { extractionId: started.extractionId })).data;

            assert.deepEqual(JSON.parse(exported.sheets).map(s => s.name), ["API_ONE", "API_TWO", "API_ONE_Child", "API_TWO_Child"]);
        });

        it("refuses wrong requests and writes nothing", async () => {
            useSource(fakeSource({ API_ONE: 5, API_TWO: 5 }));

            const refused = async (data, status, text) => {
                await assert.rejects(call("addEntitySets", { sourceSystemId: SYSTEM, ...data }), e => e.response.status === status && text.test(e.response.data.error.message));
                assert.equal((await rowsOf()).length, 0);
            };

            await refused({}, 400, /businessObject is required/);
            await refused({ businessObject: "Material" }, 409, /No confirmed APIs for business object 'Material'/);
            await refused({ businessObject: "Business Partner", apiName: "API_OTHER" }, 409, /not a confirmed API of 'Business Partner'/);
            await refused({ businessObject: "Business Partner", entitySets: ["API_ONE_Child", "Nope"] }, 400, /Unknown entity set\(s\): Nope/);

            await assert.rejects(call("addEntitySets", { sourceSystemId: "NOPE", businessObject: "Business Partner" }), e => e.response.status === 404);
        });

        it("says so when a source has no entity sets, or cannot be read", async () => {
            useSource(fakeSource({ API_ONE: 1, API_TWO: 1 }, { count: false }));
            await assert.rejects(call("addEntitySets", { sourceSystemId: SYSTEM, businessObject: "Business Partner" }), e => e.response.status === 400 && /has no entity sets/.test(e.response.data.error.message));

            const down = fakeSource({ API_ONE: 1, API_TWO: 1 });

            down.countEntitySets = async () => { throw new Error("connect ECONNREFUSED"); };
            useSource(down);
            await assert.rejects(call("addEntitySets", { sourceSystemId: SYSTEM, businessObject: "Business Partner" }), e => e.response.status === 502 && /ECONNREFUSED/.test(e.response.data.error.message));
            assert.equal((await rowsOf()).length, 0);
        });
    });
});
