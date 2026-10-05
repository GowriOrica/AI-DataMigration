"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

process.env.CDS_PLUGIN_UI5_ACTIVE = "false";
process.env.S4_DISCOVERY_MODE = "MOCK";
process.env.AI_PROVIDER = "OPENROUTER";
process.env.OPENROUTER_API_KEY = "fake-key-for-tests";
process.env.OPENROUTER_MODEL = "fake/model";
process.env.GEMINI_API_KEY = "fake-key-for-tests";
delete process.env.M3_MODE;

const cds = require("@sap/cds");

const { POST } = cds.test(
    "serve",
    "srv/migration-service.cds",
    "srv/extraction-job-service.cds",
    "srv/framework-service.cds",
    "--in-memory"
).in(path.join(__dirname, ".."));

const M3SourceAdapter = require("../srv/adapters/M3SourceAdapter");

/**
 * The discovery of a source system, for every kind of source: S/4 (OData services with fields), M3 (programs or
 * transactions) and a source with thousands of objects. Run twice: the second run must change nothing.
 */
describe("Discovery of a source system", () => {

    const db = (entity) => `migration.orchestrator.${entity}`;
    const makeSystem = async (systemId, systemType, adapterType, extra = {}) => {
        const ID = cds.utils.uuid();

        await INSERT.into(db("SourceSystem")).entries({ ID, systemId, systemName: systemId, systemType, active: true });
        await INSERT.into(db("SourceConnection")).entries({
            connectionId: `${systemId}_CONN`, connectionName: systemId, interfaceType: adapterType === "M3" ? "M3_MI" : "ODATA",
            adapterType, authenticationType: "TEST", status: "CONNECTED", sourceSystem_ID: ID, ...extra
        });

        return ID;
    };
    const counts = async (systemUUID) => {
        const objects = await cds.db.run(SELECT.from(db("SourceObject")).where({ sourceSystem_ID: systemUUID }));
        const metadata = await cds.db.run(SELECT.from(db("SourceMetadata")).where({ sourceObject_ID: { in: objects.map(o => o.ID).concat(["-"]) } }));
        const fields = await cds.db.run(SELECT.from(db("SourceField")).where({ metadata_ID: { in: metadata.map(m => m.ID).concat(["-"]) } }));

        return { objects: objects.length, metadata: metadata.length, fields: fields.length };
    };
    const discover = async (sourceSystemId) => (await POST("/migration/discoverSourceMetadata", { sourceSystemId })).data;

    it("S/4: stores the services with their fields, and a second run changes nothing", async () => {
        const uuid = await makeSystem("S4_DISC", "S4HANA", "S4");
        const first = await discover("S4_DISC");
        const afterFirst = await counts(uuid);

        assert.equal(first.status, "DISCOVERED");
        assert.ok(first.objectsDiscovered >= 1);
        assert.ok(first.fieldsDiscovered > 0, "an S/4 service has fields");
        // the catalog may list a name twice: one row per distinct name is stored (as before)
        assert.ok(afterFirst.objects > 0 && afterFirst.objects <= first.objectsDiscovered);
        assert.ok(afterFirst.metadata >= 1 && afterFirst.fields > 0);

        await discover("S4_DISC");

        assert.deepEqual(await counts(uuid), afterFirst);
    });

    it("M3 (local catalog): stores the transactions with their fields, and a second run changes nothing", async () => {
        const uuid = await makeSystem("M3_DISC", "M3", "M3");
        const first = await discover("M3_DISC");
        const afterFirst = await counts(uuid);

        assert.ok(first.objectsDiscovered >= 1);
        assert.ok(first.fieldsDiscovered > 0);
        assert.ok(afterFirst.fields > 0);

        await discover("M3_DISC");

        assert.deepEqual(await counts(uuid), afterFirst);
    });

    describe("M3 from the UI: Preview Scope, Assess with AI, Add transactions, Extract (programs are grouped by the AI)", () => {

        const original = M3SourceAdapter.deps;
        const OpenRouterProvider = require("../srv/lib/ai/OpenRouterProvider");
        const originalAI = OpenRouterProvider.prototype.generateJSON;
        const aiSaw = [];

        before(() => {
            const programs = [
                { MINM: "CRS610MI", OBNM: "Customer", MIDS: "Customer interface" },
                { MINM: "CRS620MI", OBNM: "Supplier", MIDS: "Supplier interface" },
                { MINM: "MMS200MI", OBNM: "Item", MIDS: "Item master" },
                { MINM: "EXTABCMI", OBNM: "Custom", MIDS: "Company made" }
            ];
            const transactions = {
                CRS610MI: ["Add", "LstByNumber", "LstAddresses", "GetBasicData"],
                CRS620MI: ["Add", "LstSuppliers"],
                MMS200MI: ["LstItems"],
                EXTABCMI: ["LstCustom"]
            };
            const inputs = { "CRS610MI.LstByNumber": [["CONO", "0"], ["CUNO", "0"]], "CRS610MI.LstAddresses": [["CUNO", "1"]] };

            M3SourceAdapter.deps = {
                getDestination: async () => ({ name: "M3_ION_API" }),
                executeHttpRequest: async (destination, request) => {
                    const url = new URL("http://x" + request.url);
                    const [, , , , , program, transaction] = url.pathname.split("/");
                    const q = Object.fromEntries(url.searchParams);
                    let records = [];

                    if (transaction === "LstPrograms") records = programs;
                    else if (transaction === "LstTransactions") records = (transactions[q.MINM] || []).map(name => ({ TRNM: name, TRDS: name }));
                    else if (transaction === "LstFields") {
                        const key = q.MINM + "." + q.TRNM;

                        records = q.TRTP === "I"
                            ? (inputs[key] || []).map(([FLNM, MAND]) => ({ FLNM, MAND }))
                            : [{ FLNM: "CUNO", FLDS: "Customer", TYPE: "A", LENG: "10", MAND: "0" }];
                    }

                    return { data: { results: [{ transaction, records }] } };
                }
            };

            // the AI answers by program name: what is Customer, Supplier or Item
            OpenRouterProvider.prototype.generateJSON = async function (prompt) {
                const names = [...new Set([...prompt.matchAll(/"name": "([A-Z]{3}\d{3}MI)"/g)].map(m => m[1]))];
                const group = { CRS610MI: "Customer", CRS620MI: "Supplier", MMS200MI: "Item" };

                aiSaw.push(names);

                return {
                    data: { assessments: names.map(n => ({ sourceObject: n, businessObject: group[n] || "Unclear", component: "Master Data", confidence: 90, evidenceFields: [], reason: "by name" })) },
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
                };
            };
        });

        after(() => { M3SourceAdapter.deps = original; OpenRouterProvider.prototype.generateJSON = originalAI; });

        const call = async (action, data) => (await POST("/migration/" + action, { sourceSystemId: "M3_SCOPE", ...data })).data;

        it("Preview Scope shows the funnel of all programs with no area typed (no error), or of the chosen area", async () => {
            await makeSystem("M3_SCOPE", "M3", "M3", { endpointReference: "M3_ION_API" });

            const all = await call("previewAssessmentScope", {});

            assert.deepEqual(JSON.parse(all.candidates).map(c => c.name), ["CRS610MI", "CRS620MI", "MMS200MI"]);
            assert.match(JSON.parse(all.steps)[0].label, /3 programs/);
            assert.match(all.message, /Nothing was sent to the AI/);
            assert.deepEqual(JSON.parse((await call("previewAssessmentScope", { scopePrefixes: ["CRS"] })).candidates).map(c => c.name), ["CRS610MI", "CRS620MI"]);
            assert.equal((await call("previewAssessmentScope", { scopePrefixes: ["EXT"], includeCustom: true })).toAssess, 1);
        });

        it("Assess with AI groups the programs by name and description; a second press has nothing left to do", async () => {
            const result = await call("assessScope", {});

            assert.equal(result.objectsAssessed, 3);
            assert.equal(result.status, "COMPLETED");
            assert.deepEqual(aiSaw.flat().sort(), ["CRS610MI", "CRS620MI", "MMS200MI"]);

            const rows = await cds.db.run(SELECT.from(db("MigrationAssessment")).where({ sourceSystemId: "M3_SCOPE" }));

            assert.deepEqual(rows.map(r => [r.sourceObject, r.businessObject, r.reviewStatus]).sort(), [
                ["CRS610MI", "Customer", "SUGGESTED"], ["CRS620MI", "Supplier", "SUGGESTED"], ["MMS200MI", "Item", "SUGGESTED"]
            ]);

            const again = await call("assessScope", {});

            assert.equal(again.objectsAssessed, 0);
            assert.match(again.message, /already assessed/);
        });

        it("a business object with only programs cannot be extracted yet: the message says what to press", async () => {
            await call("reviewAssessment", { sourceObject: "CRS610MI", decision: "CONFIRM" });
            await assert.rejects(
                call("startExtraction", { businessObject: "Customer" }),
                e => e.response.status === 409 && /programs, not transactions.*Add entity sets \/ transactions/.test(e.response.data.error.message)
            );
        });

        it("Add entity sets / transactions puts the lists that can be read as a whole into the business object", async () => {
            const added = await call("addEntitySets", { businessObject: "Customer" });
            const items = JSON.parse(added.items);

            assert.equal(added.added, 1);
            assert.equal(added.skipped, 1);
            assert.deepEqual(items.filter(i => i.result === "ADDED").map(i => i.sourceObject), ["CRS610MI.LstByNumber"]);
            assert.match(added.message, /1 transaction\(s\) added to 'Customer' and confirmed: CRS610MI.LstByNumber/);
            assert.match(added.message, /1 list\(s\) need a value \(for example a customer number\) in every call.*CRS610MI.LstAddresses/);

            const repeat = await call("addEntitySets", { businessObject: "Customer" });

            assert.equal(repeat.added, 0);
            assert.equal(repeat.kept, 1);
        });

        it("refuses to add transactions to a business object that has no confirmed program", async () => {
            await assert.rejects(call("addEntitySets", { businessObject: "Supplier" }), e => e.response.status === 409 && /No confirmed programs/.test(e.response.data.error.message));
        });
    });

    describe("a source with thousands of objects and no fields per object (M3 programs)", () => {

        const original = M3SourceAdapter.deps;

        before(() => {
            const programs = Array.from({ length: 450 }, (_, i) => ({ MINM: `PRG${String(i).padStart(3, "0")}MI`, OBNM: `Program ${i}`, MIDS: `Does thing ${i}` }));

            M3SourceAdapter.deps = {
                getDestination: async () => ({ name: "M3_ION_API" }),
                executeHttpRequest: async () => ({ data: { results: [{ transaction: "LstPrograms", records: programs }] } })
            };
        });

        after(() => { M3SourceAdapter.deps = original; });

        it("saves all of them in bulk (more than one chunk), without metadata rows, and a second run changes nothing", async () => {
            const uuid = await makeSystem("M3_LIVE_DISC", "M3", "M3", { endpointReference: "M3_ION_API" });
            const first = await discover("M3_LIVE_DISC");
            const afterFirst = await counts(uuid);

            assert.equal(first.objectsDiscovered, 450);
            assert.equal(first.fieldsDiscovered, 0);
            assert.deepEqual(afterFirst, { objects: 450, metadata: 0, fields: 0 });

            const sample = await cds.db.run(SELECT.one.from(db("SourceObject")).where({ sourceSystem_ID: uuid, objectName: "PRG007MI" }));

            assert.equal(sample.objectType, "M3_MI_PROGRAM");
            assert.equal(sample.description, "Program 7 - Does thing 7");

            await discover("M3_LIVE_DISC");

            assert.deepEqual(await counts(uuid), afterFirst);
        });
    });
});
