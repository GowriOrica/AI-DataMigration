"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const M3SourceAdapter = require("../srv/adapters/M3SourceAdapter");
const { buildScope, estimateTokens } = require("../srv/lib/assessment/AssessmentScope");

const tx = (name, description = "x") => ({ objectName: name, objectType: "M3_MI_LIST", description });

describe("AssessmentScope - M3 (programs)", () => {

    const objects = [
        tx("CRS610MI.LstByNumber", "Customer. Interface - List customers"),
        tx("CRS610MI.GetFinancial", "Customer. Interface - Get financial"),
        tx("OIS002MI.LstAddress", "Customer Address. Interface - List addresses"),
        tx("CRS620MI.LstBySupplier", "Supplier. Interface - List suppliers"),
        tx("MMS200MI.LstItmByItm", "Item. Interface - List items"),
        tx("CRS999MI.AddThing", "Write only"),
        tx("CRS999MI.UpdThing", "Write only"),
        tx("EXT100MI.LstCustom", "Custom program"),
        tx("CRS610.SomeScreen", "Screen program, not an API")
    ];

    it("groups transactions into programs and filters step by step", () => {
        const scope = buildScope("M3", objects);

        assert.equal(scope.discovered, 7);                       // 7 programs in 9 transactions
        assert.deepEqual(
            scope.steps.map(step => [step.id, step.remaining]),
            [["discovered", 7], ["mi-programs", 6], ["read", 5], ["custom", 4]]
        );
        assert.deepEqual(scope.candidates.map(c => c.name).sort(), ["CRS610MI", "CRS620MI", "MMS200MI", "OIS002MI"]);
        assert.deepEqual(scope.candidates.find(c => c.name === "CRS610MI").members.sort(), ["CRS610MI.GetFinancial", "CRS610MI.LstByNumber"]);
    });

    it("explains every exclusion", () => {
        const reasons = Object.fromEntries(buildScope("M3", objects).excluded.map(e => [e.name, e.reason]));

        assert.match(reasons["CRS610"], /not an MI/);
        assert.match(reasons["CRS999MI"], /only write transactions \(AddThing, UpdThing\)/);
        assert.match(reasons["EXT100MI"], /custom program/);
    });

    it("narrows by scope prefixes (areas) and can include custom programs", () => {
        const crs = buildScope("M3", objects, { scopePrefixes: "CRS, OIS" });

        assert.deepEqual(crs.candidates.map(c => c.name).sort(), ["CRS610MI", "CRS620MI", "OIS002MI"]);
        assert.ok(crs.excluded.some(e => e.name === "MMS200MI" && /area not in the scope/.test(e.reason)));

        const withCustom = buildScope("M3", objects, { includeCustom: true });

        assert.ok(withCustom.candidates.some(c => c.name === "EXT100MI"));
    });

    it("works on the real M3 mock adapter output", async () => {
        const adapterObjects = await new M3SourceAdapter({ systemId: "M3" }).discoverObjects();
        const scope = buildScope("M3", adapterObjects);

        assert.equal(scope.discovered, 4);
        assert.equal(scope.candidates.length, 4);
    });
});

describe("AssessmentScope - S/4 (services)", () => {

    const service = (objectName, attributes = {}) => ({ objectName, objectType: "ODATA_V2", description: objectName, attributes });

    const objects = [
        service("API_BUSINESS_PARTNER", { serviceType: "WEB_API" }),
        service("API_PRODUCT_SRV", { serviceType: "WEB_API", releaseStatus: "RELEASED" }),
        service("API_OLD_SRV", { releaseStatus: "DEPRECATED" }),
        service("/IWFND/SG_MED_CATALOG_0002", { serviceType: "GW_MED" }),
        service("SOME_UI_SERVICE", {}),
        service("API_NO_ATTRIBUTES", {})
    ];

    it("keeps business APIs and uses release status when the catalog provides it", () => {
        const scope = buildScope("S4", objects);

        assert.deepEqual(scope.candidates.map(c => c.name).sort(), ["API_BUSINESS_PARTNER", "API_NO_ATTRIBUTES", "API_PRODUCT_SRV"]);

        const reasons = Object.fromEntries(scope.excluded.map(e => [e.name, e.reason]));

        assert.match(reasons["API_OLD_SRV"], /release status DEPRECATED/);
        assert.match(reasons["/IWFND/SG_MED_CATALOG_0002"], /service type GW_MED/);
        assert.match(reasons["SOME_UI_SERVICE"], /not an API_/);
    });

    it("can be switched to all services and narrowed by name prefix", () => {
        assert.equal(buildScope("S4", objects, { businessApisOnly: false }).candidates.length, 6);
        assert.deepEqual(
            buildScope("S4", objects, { scopePrefixes: ["API_BUSINESS"] }).candidates.map(c => c.name),
            ["API_BUSINESS_PARTNER"]
        );
    });
});

describe("AssessmentScope - estimate and unknown sources", () => {

    it("estimates tokens from known field counts, defaults otherwise, plus prompt overhead", () => {
        const candidates = [{ name: "A", members: ["A.Lst"] }, { name: "B", members: ["B.Lst"] }];
        const estimate = estimateTokens("M3", candidates, new Map([["A.Lst", 50]]), 11);

        // A: 50 fields x 12 = 600 ; B: default 500 ; one batch of prompt = 3000
        assert.equal(estimate.inputTokens, 600 + 500 + 3000);
        assert.equal(estimate.outputTokens, 240);
        assert.equal(estimate.batches, 1);
    });

    it("refuses sources without rule set", () => {
        assert.throws(() => buildScope("ORACLE", []), /No assessment scope rules/);
    });
});


describe("M3 scope: a program on its own is a unit (assessed by name and description)", () => {

    it("keeps programs without transactions, leaves out custom ones, and counts programs, not transactions", () => {
        const scope = buildScope("M3", [
            { objectName: "CRS610MI", objectType: "M3_MI_PROGRAM", description: "Customer - Customer interface" },
            { objectName: "CRS620MI", objectType: "M3_MI_PROGRAM", description: "Supplier - Supplier Interface" },
            { objectName: "EXTABCMI", objectType: "M3_MI_PROGRAM", description: "Custom - Company made" }
        ], { scopePrefixes: [], includeCustom: false, readOnly: true });

        assert.deepEqual(scope.candidates.map(c => c.name), ["CRS610MI", "CRS620MI"]);
        assert.deepEqual(scope.candidates[0].members, ["CRS610MI"]);
        assert.equal(scope.steps[0].label, "Discovered in the system (3 programs)");
        assert.deepEqual(scope.excluded.map(e => e.name), ["EXTABCMI"]);
    });
});
