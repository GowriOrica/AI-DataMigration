"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const M3SourceAdapter = require("../srv/adapters/M3SourceAdapter");
const { proposeKeyJoins } = require("../srv/model/KeyJoinProposer");
const { buildSourceModel } = require("../srv/model/SourceModelBuilder");

const connection = {
    systemId: "M3_TEST",
    systemName: "M3 Test",
    systemType: "M3",
    adapterType: "M3"
};

describe("M3SourceAdapter (MOCK)", () => {

    let previousMode;

    beforeEach(() => {
        previousMode = process.env.M3_MODE;
        delete process.env.M3_MODE;
    });

    afterEach(() => {
        if (previousMode === undefined) {
            delete process.env.M3_MODE;
        } else {
            process.env.M3_MODE = previousMode;
        }
    });

    it("discovers MI transactions as source objects", async () => {
        const objects = await new M3SourceAdapter(connection).discoverObjects();
        const names = objects.map(object => object.objectName);

        assert.ok(names.includes("CRS610MI.LstByNumber"));
        assert.ok(names.includes("OIS002MI.LstAddress"));
        assert.equal(objects.find(o => o.objectName === "CRS610MI.GetFinancial").objectType, "M3_MI_GET");
    });

    it("returns field schema with keys and M3 descriptions", async () => {
        const schema = await new M3SourceAdapter(connection).getSchema("OIS002MI.LstAddress");
        const byName = Object.fromEntries(schema.fields.map(field => [field.fieldName, field]));

        assert.equal(byName.TOWN.description, "City");
        assert.equal(byName.TOWN.dataType, "String");
        assert.ok(byName.ADID.isKey);
        assert.ok(!byName.TOWN.isKey);
    });

    it("extracts records in pages with a composite source key", async () => {
        const adapter = new M3SourceAdapter(connection);

        const first = await adapter.extract("CRS610MI.LstByNumber", { pageSize: 2 });

        assert.equal(first.totalCount, 5);
        assert.equal(first.records.length, 2);
        assert.equal(first.records[0].sourceKey, "100|C1001");
        assert.equal(first.nextPageToken, "2");

        const last = await adapter.extract("CRS610MI.LstByNumber", { pageSize: 2, pageToken: "4" });

        assert.equal(last.records.length, 1);
        assert.equal(last.nextPageToken, null);

        const filtered = await adapter.extract("OIS002MI.LstAddress", { filter: { CUNO: "C1001" } });

        assert.equal(filtered.totalCount, 2);
    });

    it("declares no relationships (M3 metadata does not describe them)", async () => {
        const graph = await new M3SourceAdapter(connection).getRelationships("CRS610MI", ["OIS002MI"]);

        assert.equal(graph.relationshipsDeclared, false);
        assert.deepEqual(
            Object.keys(graph.entityTypes).sort(),
            ["CRS610MI.GetFinancial", "CRS610MI.LstByNumber", "OIS002MI.LstAddress"]
        );
        assert.ok(Object.values(graph.entityTypes).every(entity => entity.navigations.length === 0));
    });

});

describe("KeyJoinProposer + SourceModelBuilder (M3 customer)", () => {

    const build = async () => {
        const raw = await new M3SourceAdapter(connection).getRelationships("CRS610MI", ["OIS002MI"]);
        const { graph, proposals } = proposeKeyJoins(raw);

        return { graph, proposals };
    };

    it("proposes financial as 1:1 extension and addresses as child collection", async () => {
        const { proposals } = await build();

        const byChild = Object.fromEntries(proposals.map(p => [p.child, p]));

        assert.equal(byChild["CRS610MI.GetFinancial"].parent, "CRS610MI.LstByNumber");
        assert.equal(byChild["CRS610MI.GetFinancial"].cardinality, "0..1");

        assert.equal(byChild["OIS002MI.LstAddress"].parent, "CRS610MI.LstByNumber");
        assert.equal(byChild["OIS002MI.LstAddress"].cardinality, "0..N");
        assert.deepEqual(byChild["OIS002MI.LstAddress"].joinKeys, [
            { parent: "CONO", child: "CONO" },
            { parent: "CUNO", child: "CUNO" }
        ]);
        assert.ok(proposals.every(p => p.joinKeySource === "PROPOSED_BY_KEY_OVERLAP"));
    });

    it("builds the M3 customer tree with M3 access paths", async () => {
        const { graph } = await build();

        const built = buildSourceModel(graph, {
            businessObjectType: "BUSINESS_PARTNER",
            systemId: "M3_TEST",
            modelName: "M3 Business Partner",
            version: "1"
        });

        assert.equal(built.stats.rootEntitySet, "CRS610MI.LstByNumber");
        assert.equal(built.structures.length, 3);
        assert.equal(built.relationships.length, 2);
        assert.equal(built.stats.proposedJoins, 2);
        assert.ok(built.relationships.every(r => r.kind === "KEY_JOIN"));

        const address = built.structures.find(s => s.name === "OIS002MI.LstAddress");
        const accessPath = JSON.parse(address.accessPath);

        assert.equal(accessPath.kind, "M3_MI");
        assert.equal(accessPath.program, "OIS002MI");
        assert.equal(accessPath.pathFromRoot, "OIS002MI.LstAddress");
    });

    it("does not link unrelated objects (supplier, item)", async () => {
        const raw = await new M3SourceAdapter(connection).getRelationships("CRS610MI", ["CRS620MI", "MMS200MI"]);
        const { proposals } = proposeKeyJoins(raw);

        assert.ok(
            proposals.every(p => !["CRS620MI.LstBySupplier", "MMS200MI.LstItmByItm"].includes(p.child))
        );
    });
});

/**
 * LIVE mode, without a network: the destination and the HTTP layer are replaced by a fake M3 that answers like the
 * ION API does (results[0].records, errorMessage). What is checked: only read transactions are called, the catalog
 * comes from M3, paging by start key, and clear errors.
 */
describe("M3SourceAdapter (LIVE, fake ION API)", () => {

    const live = { ...connection, endpointReference: "M3_ION_API" };
    const original = M3SourceAdapter.deps;
    let calls;
    let customers;

    const answer = (records, error) => ({ data: { results: [error ? { errorMessage: error, errorCode: "XX", records: [] } : { transaction: "x", records }] } });

    beforeEach(() => {
        calls = [];
        customers = Array.from({ length: 7 }, (_, i) => ({ CONO: "100", CUNO: `C${String(i + 1).padStart(3, "0")}`, CUNM: `Customer ${i + 1}` }));

        M3SourceAdapter.deps = {
            getDestination: async ({ destinationName }) => (destinationName === "M3_ION_API" ? { name: destinationName } : null),
            executeHttpRequest: async (destination, request) => {
                const url = new URL("http://x" + request.url);
                const [, , , , , program, transaction] = url.pathname.split("/");
                const q = Object.fromEntries(url.searchParams);

                calls.push({ program, transaction, q });

                if (program === "MRS001MI" && transaction === "LstPrograms") {
                    return answer([{ MINM: "CRS610MI", OBNM: "Customer", MIDS: "Customer. Open" }, { MINM: "MMS200MI", OBNM: "Item", MIDS: "Item" }, { MINM: "EXTABCMI", OBNM: "Custom", MIDS: "Company made" }]);
                }

                if (program === "MRS001MI" && transaction === "LstTransactions") {
                    if (q.MINM === "MMS200MI") return answer([{ TRNM: "LstItems", TRDS: "List items" }, { TRNM: "UpdItem", TRDS: "Update" }]);
                    if (q.MINM === "EXTABCMI") return answer([{ TRNM: "LstCustom", TRDS: "List custom" }]);

                    return q.MINM === "CRS610MI"
                        ? answer([{ TRNM: "Add", TRDS: "Create" }, { TRNM: "LstByNumber", TRDS: "List customers" }, { TRNM: "LstAddresses", TRDS: "List addresses" }, { TRNM: "GetBasicData", TRDS: "Get" }])
                        : answer([], `MR00102 Program ${q.MINM} does not exist`);
                }

                if (program === "MRS001MI" && transaction === "LstFields") {
                    const fields = {
                        "LstByNumber:O": [{ FLNM: "CONO", FLDS: "Company", TYPE: "N", LENG: "3", MAND: "0" }, { FLNM: "CUNO", FLDS: "Customer", TYPE: "A", LENG: "10", MAND: "0" }, { FLNM: "CUNM", FLDS: "Name", TYPE: "A", LENG: "36", MAND: "0" }],
                        "LstByNumber:I": [{ FLNM: "CONO", MAND: "0" }, { FLNM: "CUNO", MAND: "0" }],
                        "LstAddresses:O": [{ FLNM: "CUNO", FLDS: "Customer", TYPE: "A", LENG: "10", MAND: "1" }, { FLNM: "ADID", FLDS: "Address", TYPE: "A", LENG: "6", MAND: "0" }],
                        "LstAddresses:I": [{ FLNM: "CUNO", MAND: "1" }]
                    };

                    return answer(fields[`${q.TRNM}:${q.TRTP}`] || []);
                }

                if (program === "CRS610MI" && transaction === "LstByNumber") {
                    const from = q.CUNO ? customers.findIndex(c => c.CUNO >= q.CUNO) : 0;

                    return answer(from < 0 ? [] : customers.slice(from, from + Number(q.maxrecs || 100)));
                }

                if (program === "CRS610MI" && transaction === "Add") {
                    throw new Error("a write transaction must never reach M3");
                }

                return answer([], "unknown transaction");
            }
        };
    });

    afterEach(() => {
        M3SourceAdapter.deps = original;
    });

    it("uses LIVE mode when the connection names a destination, and the mock otherwise", () => {
        assert.equal(new M3SourceAdapter(live).mode, "LIVE");
        assert.equal(new M3SourceAdapter(connection).mode, "MOCK");
    });

    it("connects through the destination and reports a missing destination clearly", async () => {
        const adapter = new M3SourceAdapter(live);

        assert.equal((await adapter.authenticate()).authenticated, true);
        assert.equal((await adapter.getStatus()).status, "CONNECTED");

        await assert.rejects(new M3SourceAdapter({ ...live, endpointReference: "NOPE" }).authenticate(), /destination 'NOPE' could not be resolved/);
    });

    it("discovers every program of the M3 catalog with one call, without reading transactions or fields", async () => {
        const objects = await new M3SourceAdapter(live).discoverObjects();

        assert.deepEqual(objects.map(o => [o.objectName, o.objectType]), [["CRS610MI", "M3_MI_PROGRAM"], ["MMS200MI", "M3_MI_PROGRAM"], ["EXTABCMI", "M3_MI_PROGRAM"]]);
        assert.equal(objects[0].description, "Customer - Customer. Open");
        assert.equal(calls.length, 1, "one call for the whole catalog");
    });

    describe("the scope step: programs (not transactions) are what the AI groups into business objects", () => {

        it("offers all API programs when no area is given (custom EXT programs only when asked)", async () => {
            const objects = await new M3SourceAdapter(live).discoverObjects({ forScope: true, scopePrefixes: [] });

            assert.deepEqual(objects.map(o => o.objectName), ["CRS610MI", "MMS200MI"]);
            assert.ok(objects.every(o => o.objectType === "M3_MI_PROGRAM"));
            assert.equal(calls.length, 1, "one call for the whole catalog; no transaction or field is read");

            const withCustom = await new M3SourceAdapter(live).discoverObjects({ forScope: true, scopePrefixes: [], includeCustom: true });

            assert.deepEqual(withCustom.map(o => o.objectName), ["CRS610MI", "MMS200MI", "EXTABCMI"]);
        });

        it("narrows to the chosen areas, several at once, prefixes in any case", async () => {
            assert.deepEqual((await new M3SourceAdapter(live).discoverObjects({ forScope: true, scopePrefixes: ["crs"] })).map(o => o.objectName), ["CRS610MI"]);
            assert.deepEqual((await new M3SourceAdapter(live).discoverObjects({ forScope: true, scopePrefixes: "crs, mms" })).map(o => o.objectName), ["CRS610MI", "MMS200MI"]);
            assert.deepEqual((await new M3SourceAdapter(live).discoverObjects({ forScope: true, scopePrefixes: ["EXT"], includeCustom: true })).map(o => o.objectName), ["EXTABCMI"]);
        });

        it("says what can be extracted: a transaction yes, a program on its own no", () => {
            const adapter = new M3SourceAdapter(live);

            assert.equal(adapter.isExtractable("CRS610MI.LstByNumber"), true);
            assert.equal(adapter.isExtractable("CRS610MI"), false);
            assert.equal(new M3SourceAdapter(connection).isExtractable("CRS610MI"), true, "the local catalog works as before");
        });

        it("offers the lists that can be read as a whole, and names the ones that need a value in every call", async () => {
            const found = await new M3SourceAdapter(live).listExtractableObjects("CRS610MI");

            assert.deepEqual(found.items.map(i => i.objectName), ["CRS610MI.LstByNumber"]);
            assert.deepEqual(found.skipped.map(s => [s.objectName, s.reason]), [["CRS610MI.LstAddresses", "needs CUNO in every call (a list per record)"]]);
        });
    });

    it("answers the schema of a program without calling M3 again", async () => {
        const adapter = new M3SourceAdapter(live);

        await adapter.discoverObjects();

        const schema = await adapter.getSchema("CRS610MI");

        assert.deepEqual(schema.fields, []);
        assert.equal(schema.metadata.level, "PROGRAM");
        assert.equal(calls.length, 1);
        await assert.rejects(adapter.getSchema("OIS002MI"), /program 'OIS002MI' does not exist in this M3 tenant/);
    });

    it("describes a program for a functional person: the transactions that read data, and how many are hidden", async () => {
        const description = await new M3SourceAdapter(live).describeObject("CRS610MI");

        assert.equal(description.title, "CRS610MI");
        assert.equal(description.description, "Customer - Customer. Open");
        assert.deepEqual(description.items.map(i => i.name), ["CRS610MI.LstByNumber", "CRS610MI.LstAddresses", "CRS610MI.GetBasicData"]);
        assert.equal(description.hiddenCount, 1, "Add is counted, not listed");
        assert.match(description.note, /never calls them/);
        await assert.rejects(new M3SourceAdapter(live).describeObject("OIS002MI"), /does not exist in this M3 tenant/);
    });

    it("lists the read-only transactions of a program and leaves out the ones that change data", async () => {
        const list = await new M3SourceAdapter(live).listTransactions("CRS610MI");

        assert.deepEqual(list.map(t => [t.objectName, t.kind]), [
            ["CRS610MI.LstByNumber", "LIST"], ["CRS610MI.LstAddresses", "LIST"], ["CRS610MI.GetBasicData", "GET"]
        ]);
        await assert.rejects(new M3SourceAdapter(live).listTransactions("OIS002MI"), /does not exist in this M3 tenant/);
    });

    it("builds the schema from the field definitions of M3", async () => {
        const schema = await new M3SourceAdapter(live).getSchema("CRS610MI.LstByNumber");

        assert.deepEqual(schema.fields.map(f => [f.fieldName, f.dataType, f.length, f.isKey]), [
            ["CONO", "Integer", 3, true], ["CUNO", "String", 10, true], ["CUNM", "String", 36, false]
        ]);
        assert.equal(schema.metadata.discoveryMode, "LIVE");
    });

    it("extracts a list page by page by the start key, without losing or repeating a record", async () => {
        const adapter = new M3SourceAdapter(live);
        const seen = [];
        let skip = 0;

        for (let page = 0; page < 10; page++) {
            const result = await adapter.extract("CRS610MI.LstByNumber", { pageSize: 3, skip });

            seen.push(...result.records.map(r => r.CUNO));
            skip += result.records.length;

            if (result.nextPageToken === null) break;
        }

        assert.deepEqual(seen, customers.map(c => c.CUNO));
        assert.equal(new Set(seen).size, 7);
    });

    it("sets sourceKey from the key fields and asks M3 for one record more on a follow-up page", async () => {
        const adapter = new M3SourceAdapter(live);
        const first = await adapter.extract("CRS610MI.LstByNumber", { pageSize: 3, skip: 0 });

        assert.equal(first.records[0].sourceKey, "100|C001");
        assert.equal(first.nextPageToken, "3");

        await adapter.extract("CRS610MI.LstByNumber", { pageSize: 3, skip: 3 });

        const second = calls.filter(c => c.transaction === "LstByNumber")[1];

        assert.equal(second.q.CUNO, "C003");
        assert.equal(second.q.maxrecs, "4");
    });

    it("stops when the page is not full, and a page out of order is refused", async () => {
        const adapter = new M3SourceAdapter(live);
        const all = await adapter.extract("CRS610MI.LstByNumber", { pageSize: 50, skip: 0 });

        assert.equal(all.records.length, 7);
        assert.equal(all.nextPageToken, null);

        const other = new M3SourceAdapter(live);

        await other.extract("CRS610MI.LstByNumber", { pageSize: 3, skip: 0 });
        await assert.rejects(other.extract("CRS610MI.LstByNumber", { pageSize: 3, skip: 5 }), /pages must be read in order/);
    });

    it("never calls a transaction that changes data", async () => {
        const adapter = new M3SourceAdapter(live);

        for (const name of ["Add", "ChgBasicData", "Delete", "Copy", "AddAddress"]) {
            await assert.rejects(adapter._ion("CRS610MI", name, {}), /is not read only/);
        }

        assert.equal(calls.length, 0, "no call reached M3");
        await assert.rejects(adapter.extract("CRS610MI.Add", {}), /not read only|was not found/);
    });

    it("says that a list with a mandatory input cannot be extracted as one list", async () => {
        await assert.rejects(new M3SourceAdapter(live).extract("CRS610MI.LstAddresses", {}), /needs a value for CUNO/);
    });

    it("reports an unknown program or transaction, a name without a transaction, and an M3 error message", async () => {
        const adapter = new M3SourceAdapter(live);

        await assert.rejects(adapter.getSchema("OIS002MI.LstByNumber"), /program 'OIS002MI' does not exist in this M3 tenant/);
        await assert.rejects(adapter.getSchema("CRS610MI.LstNope"), /'CRS610MI.LstNope' was not found/);
        await assert.rejects(adapter.extract("CRS610MI", {}), /Name the M3 transaction/);

        M3SourceAdapter.deps.executeHttpRequest = async () => { const e = new Error("bad gateway"); e.response = { status: 503 }; throw e; };
        await assert.rejects(new M3SourceAdapter(live).authenticate(), /failed with status code 503/);
    });
});
