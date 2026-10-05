"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const { buildCleansingTemplate, BUSINESS_PARTNER_EXAMPLES } = require("../srv/lib/cleansing/CleansingTemplate");
const { RULE_TYPES, GROUPS, RULE_COLUMNS, ruleType } = require("../srv/lib/cleansing/RuleCatalog");

const read = async (buffer) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    return workbook;
};

describe("Rule catalogue", () => {

    it("has unique rule names, and every rule belongs to a known group", () => {
        const names = RULE_TYPES.map(r => r.name);

        assert.equal(new Set(names).size, names.length);
        assert.ok(RULE_TYPES.every(r => GROUPS.includes(r.group)));
    });

    it("finds a rule by name, ignoring case", () => {
        assert.equal(ruleType("trim").group, "Standardise");
        assert.equal(ruleType("NOPE"), undefined);
    });

    it("says which rules need a parameter", () => {
        assert.equal(ruleType("TRIM").needsParameter, false);
        assert.equal(ruleType("VALUE_MAP").needsParameter, true);
        assert.equal(ruleType("INCLUDE_IF").usesCondition, true);
    });

    it("uses only rules that exist in the examples, with the right group", () => {
        for (const example of BUSINESS_PARTNER_EXAMPLES) {
            assert.equal(ruleType(example.rule)?.group, example.group, example.ruleId);
        }
    });
});

const { validateRule } = require("../srv/lib/cleansing/RuleEngine");

describe("Cleansing rules template", () => {

    it("only contains example rules that the engine accepts", () => {
        for (const example of BUSINESS_PARTNER_EXAMPLES) {
            assert.deepEqual(validateRule(example), [], example.ruleId);
        }
    });


    it("has the sheets Read me, Rules, ValueMap and Rule types", async () => {
        const workbook = await read(await buildCleansingTemplate());

        assert.deepEqual(workbook.worksheets.map(s => s.name), ["Read me", "Rules", "ValueMap", "Rule types"]);
    });

    it("has the agreed columns on the Rules sheet", async () => {
        const workbook = await read(await buildCleansingTemplate());
        const headers = workbook.getWorksheet("Rules").getRow(1).values.slice(1);

        assert.deepEqual(headers, RULE_COLUMNS.map(c => c.header));
        assert.deepEqual(headers.slice(0, 8), ["RuleID", "Business object", "Source system", "Entity", "Field", "Level", "Group", "Rule"]);
    });

    it("lists every rule type with what it does and its parameter", async () => {
        const sheet = (await read(await buildCleansingTemplate())).getWorksheet("Rule types");

        assert.equal(sheet.rowCount, 1 + RULE_TYPES.length);
        assert.deepEqual(sheet.getColumn(1).values.slice(2), RULE_TYPES.map(r => r.name));
    });

    it("contains the marked example rows, and no examples when asked", async () => {
        const withExamples = (await read(await buildCleansingTemplate())).getWorksheet("Rules");

        const filledRows = (sheet) => sheet.getColumn(1).values.slice(2).filter(v => v !== undefined && v !== null && v !== "").length;

        assert.equal(filledRows(withExamples), BUSINESS_PARTNER_EXAMPLES.length);
        const col = (key) => RULE_COLUMNS.findIndex(c => c.key === key) + 1;

        assert.match(String(withExamples.getRow(2).getCell(col("reason")).value), /^EXAMPLE - replace/);
        assert.equal(withExamples.getRow(2).getCell(col("status")).value, "Draft");

        const empty = (await read(await buildCleansingTemplate({ examples: false }))).getWorksheet("Rules");

        assert.equal(filledRows(empty), 0);
    });

    it("offers lists for Group, Rule, On failure and Status", async () => {
        const sheet = (await read(await buildCleansingTemplate())).getWorksheet("Rules");
        const col = (key) => RULE_COLUMNS.findIndex(c => c.key === key) + 1;
        const validation = (key) => sheet.getCell(2, col(key)).dataValidation;

        assert.match(validation("level").formulae[0], /Source,Canonical/);
        assert.match(validation("group").formulae[0], /Standardise,Convert,Default,Derive,Select,Validate/);
        assert.equal(validation("rule").formulae[0], `'Rule types'!$A$2:$A$${RULE_TYPES.length + 1}`);
        assert.match(validation("onFailure").formulae[0], /ERROR,WARNING/);
        assert.match(validation("status").formulae[0], /Draft,Approved/);
    });

    it("writes the business object into the examples", async () => {
        const sheet = (await read(await buildCleansingTemplate({ businessObject: "Supplier" }))).getWorksheet("Rules");

        assert.equal(sheet.getRow(2).getCell(2).value, "Supplier");
    });
});
