"use strict";

const ExcelJS = require("exceljs");
const { GROUPS, LEVELS, RULE_TYPES, ON_FAILURE, STATUSES, RULE_COLUMNS, CONDITION_HELP } = require("./RuleCatalog");

/**
 * ============================================================
 * CLEANSING RULES TEMPLATE (Excel)
 * ============================================================
 *
 * The file the functional team fills with the cleansing rules of a business object.
 * Sheets: Read me, Rules, ValueMap, Rule types.
 * The example rows are marked as examples and are meant to be replaced.
 */

const EXAMPLE_REASON = "EXAMPLE - replace. ";

const S4 = { sourceSystem: "S4SOURCE01", entity: "API_BUSINESS_PARTNER / A_BusinessPartner", level: "Source" };
const M3 = { sourceSystem: "M3", entity: "CRS610MI.LstByNumber", level: "Source" };

/**
 * Example rows. The S/4 rows come from what the profiling of the real Business Partner extraction found,
 * the M3 rows from the M3 sample records. They show the different source systems side by side.
 */
const BUSINESS_PARTNER_EXAMPLES = [
    { ...S4, ruleId: "BP-001", field: "BusinessPartnerFullName", group: "Standardise", rule: "TRIM", order: 1, reason: "Profiling: values with leading or trailing spaces" },
    { ...S4, ruleId: "BP-002", field: "CreationDate", group: "Standardise", rule: "DATE_TO_ISO", parameter: "ODATA", order: 1, reason: "Profiling: S/4 delivers dates as /Date(...)/" },
    { ...S4, ruleId: "BP-003", field: "BusinessPartnerName", group: "Standardise", rule: "TITLE", order: 2, reason: "Profiling: spelling variants of the same name" },
    { ...S4, ruleId: "BP-004", field: "", group: "Select", rule: "INCLUDE_IF", condition: "BusinessPartnerIsBlocked = 'false'", order: 1, reason: "Blocked partners are not migrated" },
    { ...S4, ruleId: "BP-005", field: "BusinessPartnerCategory", group: "Validate", rule: "ALLOWED_VALUES", parameter: "1,2", order: 1, onFailure: "ERROR", reason: "Only person (1) or organisation (2)" },
    { ...S4, ruleId: "BP-006", field: "BusinessPartnerFullName", group: "Validate", rule: "REQUIRED", order: 2, onFailure: "ERROR", reason: "A partner without a name cannot be loaded" },
    { ...S4, ruleId: "BP-007", field: "BusinessPartnerGrouping", group: "Convert", rule: "VALUE_MAP", parameter: "BPGrouping", order: 1, reason: "Legacy grouping to the agreed target grouping" },
    { ...M3, ruleId: "BP-101", field: "RGDT", group: "Standardise", rule: "DATE_TO_ISO", parameter: "YYYYMMDD", order: 1, reason: "M3 delivers dates as 20190312" },
    { ...M3, ruleId: "BP-102", field: "CUNM", group: "Standardise", rule: "TRIM", order: 1, reason: "M3 values can be padded with spaces" },
    { ...M3, ruleId: "BP-103", field: "", group: "Select", rule: "INCLUDE_IF", condition: "CONO = '100'", order: 1, reason: "Only company 100 is migrated" },
    { sourceSystem: "*", entity: "*", level: "Source", ruleId: "ALL-001", field: "*", group: "Standardise", rule: "TRIM", order: 1, reason: "Every text field of every source: remove leading and trailing spaces" }
];

const VALUE_MAP_EXAMPLES = [
    ["BPGrouping", "BP01", "(target value)", "EXAMPLE - replace with the agreed target values"],
    ["BPGrouping", "BP02", "(target value)", "EXAMPLE - replace with the agreed target values"],
    ["BPGrouping", "BP03", "(target value)", "EXAMPLE - replace with the agreed target values"]
];

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0A6ED1" } };
const HEADER_FONT = { bold: true, color: { argb: "FFFFFFFF" } };
const EXAMPLE_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7E0" } };

function styleHeader(row) {
    row.font = HEADER_FONT;
    row.fill = HEADER_FILL;
    row.alignment = { vertical: "middle", wrapText: true };
    row.height = 22;
}

/**
 * @param {Object}  [options]
 * @param {string}  [options.businessObject]   written into the example rows (default "Business Partner")
 * @param {string}  [options.source]           default source of the example rows
 * @param {boolean} [options.examples]         include the example rows (default true)
 * @returns {Promise<Buffer>}
 */
async function buildCleansingTemplate({ businessObject = "Business Partner", examples = true } = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "AI Migration Cockpit";
    workbook.created = new Date();

    // ------------------------------------------------------------ Read me
    const readMe = workbook.addWorksheet("Read me");
    readMe.columns = [{ width: 26 }, { width: 100 }];

    const lines = [
        ["Cleansing rules template", ""],
        ["", ""],
        ["What this file is", "The cleansing rules of ONE business object. One rule per row on the sheet Rules."],
        ["What a rule does", "A rule changes, checks or selects data when it is read for the migration. The source system and the extracted files are never changed."],
        ["Who fills it", "The functional team of the business object. The cockpit only executes the rules."],
        ["", ""],
        ["How to fill it", "1. Sheet Rules: one row per rule. Choose Group, Rule and Status from the lists."],
        ["", "2. Sheet Rule types: shows what each rule does and what goes into Parameter."],
        ["", "3. Code conversions (Rule VALUE_MAP): put the value pairs on the sheet ValueMap, with the domain name as Parameter."],
        ["", "4. Keep Status = Draft while the rule is being discussed. Rules become Approved in the cockpit after a review."],
        ["", "5. Upload the file in the cockpit, step 5 Cleansing. Every row is checked and the answer says what is wrong."],
        ["", ""],
        ["Rows marked EXAMPLE", "The yellow rows are examples (S/4 from the profiling of Business Partner, M3 from sample records). Replace or delete them."],
        ["Source system and Entity", "A rule belongs to a source system and an entity (S/4: API / entity set, M3: program.transaction). * means every source system, every entity or every text field (Field)."],
        ["Level", "Source = technical fix of one source system, applied to the extracted data. Canonical = business rule for any source, applied after the mapping."],
        ["", ""],
        ["Conditions", "The Condition column is optional. The rule is only applied when the condition is true. Allowed forms:"]
    ];

    lines.forEach(line => readMe.addRow(line));
    CONDITION_HELP.forEach(([form, meaning, example]) => readMe.addRow(["", `${form}    -    ${meaning}    -    e.g. ${example}`]));

    readMe.getRow(1).font = { bold: true, size: 16 };
    readMe.getColumn(1).font = { bold: true };
    readMe.getColumn(2).alignment = { wrapText: true, vertical: "top" };

    // ------------------------------------------------------------ Rules
    const rules = workbook.addWorksheet("Rules", { views: [{ state: "frozen", ySplit: 1, xSplit: 1 }] });
    rules.columns = RULE_COLUMNS.map(c => ({ header: c.header, key: c.key, width: c.width }));
    styleHeader(rules.getRow(1));

    RULE_COLUMNS.forEach((c, index) => {
        rules.getRow(1).getCell(index + 1).note = c.note;
    });

    if (examples) {
        BUSINESS_PARTNER_EXAMPLES.forEach(example => {
            const row = rules.addRow({
                businessObject,
                parameter: "",
                condition: "",
                onFailure: "",
                owner: "",
                status: "Draft",
                ...example,
                reason: EXAMPLE_REASON + (example.reason || "")
            });
            row.fill = EXAMPLE_FILL;
        });
    }

    const lastRow = 500;
    const column = (key) => RULE_COLUMNS.findIndex(c => c.key === key) + 1;
    const listValidation = (key, formula) => {
        for (let r = 2; r <= lastRow; r++) {
            rules.getCell(r, column(key)).dataValidation = { type: "list", allowBlank: true, formulae: [formula], showErrorMessage: true, errorTitle: "Not in the list", error: "Please choose a value from the list." };
        }
    };

    listValidation("level", `"${LEVELS.join(",")}"`);
    listValidation("group", `"${GROUPS.join(",")}"`);
    listValidation("rule", `'Rule types'!$A$2:$A$${RULE_TYPES.length + 1}`);
    listValidation("onFailure", `"${ON_FAILURE.join(",")}"`);
    listValidation("status", `"${STATUSES.join(",")}"`);

    rules.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: RULE_COLUMNS.length } };

    // ------------------------------------------------------------ ValueMap
    const valueMap = workbook.addWorksheet("ValueMap", { views: [{ state: "frozen", ySplit: 1 }] });
    valueMap.columns = [
        { header: "Domain", key: "domain", width: 24 },
        { header: "Source value", key: "source", width: 30 },
        { header: "Target value", key: "target", width: 30 },
        { header: "Comment", key: "comment", width: 60 }
    ];
    styleHeader(valueMap.getRow(1));
    valueMap.getRow(1).getCell(1).note = "The name used as Parameter of a VALUE_MAP rule";

    if (examples) {
        VALUE_MAP_EXAMPLES.forEach(example => { valueMap.addRow(example).fill = EXAMPLE_FILL; });
    }

    // ------------------------------------------------------------ Rule types
    const types = workbook.addWorksheet("Rule types", { views: [{ state: "frozen", ySplit: 1 }] });
    types.columns = [
        { header: "Rule", key: "name", width: 22 },
        { header: "Group", key: "group", width: 14 },
        { header: "What it does", key: "does", width: 70 },
        { header: "Parameter", key: "parameter", width: 40 },
        { header: "Example", key: "example", width: 56 }
    ];
    styleHeader(types.getRow(1));
    RULE_TYPES.forEach(rule => types.addRow(rule));
    types.getColumn("does").alignment = { wrapText: true, vertical: "top" };
    types.getColumn("example").alignment = { wrapText: true, vertical: "top" };

    return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { buildCleansingTemplate, BUSINESS_PARTNER_EXAMPLES };
