"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { applyRule, splitText } = require("../srv/engine/FieldRules");
const { buildModelView } = require("../srv/engine/ModelView");
const { compileMappingSet, transformInstance, toStructureRows } = require("../srv/engine/TransformationEngine");
const { assembleInstances } = require("../srv/engine/InstanceAssembler");

/*
 * A deliberately NON-Business-Partner example (sales order): the engine
 * has no object-specific logic.
 */
const targetView = buildModelView({
    structures: [
        { ID: "o", name: "Order", isRoot: true, sortOrder: 1 },
        { ID: "i", name: "Item", isRoot: false, sortOrder: 2 },
        { ID: "n", name: "Note", isRoot: false, sortOrder: 3 }
    ],
    relationships: [
        { parent_ID: "o", child_ID: "i", cardinality: "0..N" },
        { parent_ID: "o", child_ID: "n", cardinality: "0..N" }
    ],
    fields: [
        { ID: "o1", structure_ID: "o", name: "orderId", isKey: true, mandatory: true, length: 10 },
        { ID: "o2", structure_ID: "o", name: "customer", mandatory: true, length: 10 },
        { ID: "o3", structure_ID: "o", name: "shipCity", length: 20 },
        { ID: "o4", structure_ID: "o", name: "system", length: 10 },
        { ID: "i1", structure_ID: "i", name: "orderId", isKey: true, mandatory: true },
        { ID: "i2", structure_ID: "i", name: "itemNo", isKey: true, mandatory: true },
        { ID: "i3", structure_ID: "i", name: "material", mandatory: true, length: 5 },
        { ID: "n1", structure_ID: "n", name: "orderId", isKey: true },
        { ID: "n2", structure_ID: "n", name: "text", length: 40 }
    ]
});

const approved = (mapping) => ({
    status: "APPROVED",
    patternConfig: {},
    ...mapping,
    fieldMappings: mapping.fieldMappings.map(fm => ({ status: "APPROVED", fromFields: [], ...fm }))
});

const f = (structure, field) => ({ structure, field });

const instance = {
    key: "A1",
    rootStructure: "HDR",
    rootRecords: [
        { ORDNO: "A1", CUST: "X1 ", NOTE: "urgent", CO: "10" },
        { ORDNO: "A1", CUST: "X1", NOTE: "", CO: "20" }
    ],
    children: {
        LINES: [
            { ORDNO: "A1", POS: "10", MAT: "M1" },
            { ORDNO: "A1", POS: "20", MAT: "" },
            { ORDNO: "A1", POS: "30", MAT: "TOO-LONG-MAT" }
        ],
        SHIP: [
            { ORDNO: "A1", TYPE: "B", CITY: "Perth" },
            { ORDNO: "A1", TYPE: "S", CITY: "Darwin" }
        ]
    }
};

describe("FieldRules", () => {

    const context = {
        sourceSystem: "SRC",
        lookupValue: (domain, value) => (value === "30" ? { found: true, value: "0001" } : { found: false })
    };

    it("splits text at word boundaries", () => {
        assert.deepEqual(splitText("Southern Cross Civil Construction", 20), ["Southern Cross Civil", "Construction"]);
        assert.equal(applyRule({ type: "SPLIT", maxLength: 20, part: 2 }, ["Southern Cross Civil Construction"], context).value, "Construction");
    });

    it("maps values and reports missing value mappings", () => {
        assert.equal(applyRule({ type: "VALUE_MAP", domain: "d" }, ["30"], context).value, "0001");

        const missing = applyRule({ type: "VALUE_MAP", domain: "d" }, ["60"], context);

        assert.equal(missing.value, null);
        assert.equal(missing.issue.code, "VALUE_MAPPING_MISSING");
    });

    it("converts codes to flags, constants, defaults and conditions", () => {
        assert.equal(applyRule({ type: "FLAG" }, ["9"], context).value, true);
        assert.equal(applyRule({ type: "FLAG" }, ["0"], context).value, false);
        assert.equal(applyRule({ type: "CONSTANT", value: "$sourceSystem" }, [], context).value, "SRC");
        assert.equal(applyRule({ type: "DEFAULT", value: "EN" }, ["  "], context).value, "EN");
        assert.equal(applyRule({ type: "CONCAT", separator: "-" }, ["A", null, "B"], context).value, "A-B");
        assert.equal(
            applyRule({ type: "CONDITIONAL", when: [{ equals: "90", then: "BLOCKED" }], else: "OK" }, ["90"], context).value,
            "BLOCKED"
        );
    });

    it("rejects unknown rule types instead of guessing", () => {
        assert.equal(applyRule({ type: "SCRIPT" }, ["x"], context).issue.code, "UNKNOWN_RULE");
    });
});

describe("TransformationEngine", () => {

    const mappings = [
        approved({
            toStructure: "Order",
            pattern: "ONE_TO_ONE",
            fromStructures: ["HDR"],
            fieldMappings: [
                { toField: "orderId", fromFields: [f("HDR", "ORDNO")], rule: { type: "DIRECT" } },
                { toField: "customer", fromFields: [f("HDR", "CUST")], rule: { type: "DIRECT" } },
                { toField: "system", rule: { type: "CONSTANT", value: "$sourceSystem" } }
            ]
        }),
        approved({
            toStructure: "Order",
            pattern: "PICK",
            fromStructures: ["SHIP"],
            patternConfig: { where: { field: "TYPE", equals: "S" } },
            fieldMappings: [{ toField: "shipCity", fromFields: [f("SHIP", "CITY")], rule: { type: "DIRECT" } }]
        }),
        approved({
            toStructure: "Item",
            pattern: "ONE_TO_ONE",
            fromStructures: ["LINES"],
            fieldMappings: [
                { toField: "orderId", fromFields: [f("HDR", "ORDNO")], rule: { type: "DIRECT" } },
                { toField: "itemNo", fromFields: [f("LINES", "POS")], rule: { type: "DIRECT" } },
                { toField: "material", fromFields: [f("LINES", "MAT")], rule: { type: "DIRECT" } }
            ]
        }),
        approved({
            toStructure: "Note",
            pattern: "EXPLODE",
            fromStructures: ["HDR"],
            patternConfig: { rows: "all" },
            fieldMappings: [
                { toField: "orderId", fromFields: [f("HDR", "ORDNO")], rule: { type: "DIRECT" } },
                { toField: "text", fromFields: [f("HDR", "NOTE")], rule: { type: "DIRECT" } }
            ]
        }),
        {
            ...approved({
                toStructure: "Note",
                pattern: "DERIVE",
                fromStructures: ["HDR"],
                fieldMappings: [{ toField: "text", rule: { type: "CONSTANT", value: "never used" } }]
            }),
            status: "SUGGESTED"
        }
    ];

    const compiled = compileMappingSet(targetView, mappings, "SOURCE_TO_CANONICAL");
    const { document, issues } = transformInstance(instance, compiled, {
        sourceSystem: "SRC",
        lookupValue: () => ({ found: false })
    });

    it("builds the root from the survivor record, picks from a collection and trims values", () => {
        assert.equal(document.orderId, "A1");
        assert.equal(document.customer, "X1");
        assert.equal(document.system, "SRC");
        assert.equal(document.shipCity, "Darwin");
    });

    it("creates one entry per source row and reports mandatory / length issues", () => {
        assert.equal(document.Item.length, 3);
        assert.deepEqual(
            issues.map(issue => `${issue.structure}[${issue.entry}].${issue.field}:${issue.code}`).sort(),
            ["Item[1].material:MANDATORY_MISSING", "Item[2].material:LENGTH_EXCEEDED"]
        );
    });

    it("explodes per root record and skips exploded entries without data", () => {
        // two root records, the second has an empty note -> only one entry
        assert.deepEqual(document.Note.map(note => note.text), ["urgent"]);
    });

    it("ignores mappings that are not approved", () => {
        assert.ok(!document.Note.some(note => note.text === "never used"));
    });

    it("flattens the document into rows per target structure", () => {
        const rows = toStructureRows(document, compiled);

        assert.equal(rows.Order.length, 1);
        assert.equal(rows.Item.length, 3);
        assert.ok(!("Item" in rows.Order[0]));
    });
});

describe("InstanceAssembler", () => {

    const sourceView = buildModelView({
        structures: [
            { ID: "h", name: "HDR", isRoot: true },
            { ID: "l", name: "LINES", isRoot: false }
        ],
        relationships: [
            { parent_ID: "h", child_ID: "l", cardinality: "0..N", joinKeys: JSON.stringify({ keys: [{ parent: "ORDNO", child: "ORDNO" }] }) }
        ],
        fields: [
            { ID: "h1", structure_ID: "h", name: "CO", isKey: true },
            { ID: "h2", structure_ID: "h", name: "ORDNO", isKey: true }
        ]
    });

    const data = {
        HDR: [{ CO: "10", ORDNO: "A1" }, { CO: "20", ORDNO: "A1" }, { CO: "10", ORDNO: "B2" }],
        LINES: [{ ORDNO: "A1", POS: "10" }, { ORDNO: "B2", POS: "10" }, { ORDNO: "B2", POS: "20" }]
    };

    const fetchPage = async (name, { pageSize, pageToken }) => {
        const offset = Number(pageToken || 0);
        const rows = data[name].slice(offset, offset + 1); // 1 row per page: exercises paging

        return { records: rows, nextPageToken: offset + 1 < data[name].length ? String(offset + 1) : null };
    };

    it("groups root records and attaches children by join keys (all pages)", async () => {
        const instances = await assembleInstances({ view: sourceView, fetchPage, groupBy: ["ORDNO"] });

        assert.deepEqual(instances.map(i => i.key), ["A1", "B2"]);
        assert.equal(instances[0].rootRecords.length, 2);
        assert.equal(instances[1].children.LINES.length, 2);
    });

    it("respects the instance limit", async () => {
        const instances = await assembleInstances({ view: sourceView, fetchPage, groupBy: ["ORDNO"], limit: 1 });

        assert.equal(instances.length, 1);
    });
});
