"use strict";

/**
 * ============================================================
 * CLEANSING RULE CATALOGUE
 * ============================================================
 *
 * The rule types the functional team can choose from. One place for:
 *   - the template that is handed to the functional team,
 *   - the check of a rule (rule exists, group matches, parameter is valid),
 *   - the engine that applies the rules.
 *
 * The rules do not depend on a source system: they work on records (field name and value), which look
 * the same for S/4, Infor M3 or Oracle. What differs between systems is the data (for example the
 * date format), and that is a parameter of the rule, not a different rule.
 *
 * A rule never changes the source or the extraction: it is applied to a copy when the data is read.
 */

const GROUPS = ["Standardise", "Convert", "Default", "Derive", "Select", "Validate"];

/** SOURCE: technical fixes of one source system. CANONICAL: business rules for any source (run after mapping). */
const LEVELS = ["Source", "Canonical"];

/** Input formats of DATE_TO_ISO. */
const DATE_FORMATS = ["ODATA", "YYYYMMDD", "DD.MM.YYYY", "DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];

/**
 * @property {string}  name        the name used in the template
 * @property {string}  group       one of GROUPS
 * @property {string}  does        what it does, in plain words
 * @property {string}  parameter   what goes into the Parameter column ("-" = nothing)
 * @property {boolean} needsParameter
 * @property {boolean} usesCondition  the Condition column is the point of the rule (Select rules)
 * @property {boolean} recordRule     works on the whole record, the Field column stays empty (Select rules)
 * @property {string}  example     a short example
 */
const RULE_TYPES = [
    { name: "TRIM", group: "Standardise", does: "Removes spaces at the start and the end of the value.", parameter: "-", needsParameter: false, example: "' Berlin ' becomes 'Berlin'" },
    { name: "UPPER", group: "Standardise", does: "Writes the value in capital letters.", parameter: "-", needsParameter: false, example: "'de' becomes 'DE'" },
    { name: "LOWER", group: "Standardise", does: "Writes the value in small letters.", parameter: "-", needsParameter: false, example: "'INFO@ACME.COM' becomes 'info@acme.com'" },
    { name: "TITLE", group: "Standardise", does: "Writes every word with a capital first letter.", parameter: "-", needsParameter: false, example: "'jit COMPANY' becomes 'Jit Company'" },
    { name: "DATE_TO_ISO", group: "Standardise", does: "Converts a date into a real date (YYYY-MM-DD). The parameter says in which format the source delivers it. An empty or zero date (0, 00000000) becomes empty.", parameter: `input format: ${DATE_FORMATS.join(", ")}`, needsParameter: true, example: "ODATA: '/Date(1755907200000)/' becomes '2025-08-23'; YYYYMMDD: '20190312' becomes '2019-03-12'" },
    { name: "REPLACE", group: "Standardise", does: "Replaces a text by another text.", parameter: "from=>to", needsParameter: true, example: "parameter 'N/A=>' removes the text N/A" },
    { name: "VALUE_MAP", group: "Convert", does: "Converts a value into the agreed value, using the ValueMap sheet.", parameter: "name of the domain in the ValueMap sheet", needsParameter: true, example: "domain 'Country': 'Germany' becomes 'DE'" },
    { name: "DEFAULT", group: "Default", does: "Fills the field with a fixed value when it is empty.", parameter: "the value", needsParameter: true, example: "parameter 'EN' fills an empty language with EN" },
    { name: "CONCAT", group: "Derive", does: "Builds the value of the Field from other fields.", parameter: "fields=Field1,Field2;separator=text", needsParameter: true, example: "fields=FirstName,LastName;separator=' ' gives 'Anna Muller'" },
    { name: "INCLUDE_IF", group: "Select", does: "Only records that meet the condition are migrated. The Field column stays empty.", parameter: "-", needsParameter: false, usesCondition: true, recordRule: true, example: "condition STAT = '20'" },
    { name: "EXCLUDE_IF", group: "Select", does: "Records that meet the condition are not migrated. The Field column stays empty.", parameter: "-", needsParameter: false, usesCondition: true, recordRule: true, example: "condition CUCL = 'TEST'" },
    { name: "REQUIRED", group: "Validate", does: "The field must be filled. Otherwise an issue is reported; nothing is changed.", parameter: "-", needsParameter: false, example: "a partner without a name cannot be loaded" },
    { name: "MATCHES", group: "Validate", does: "The value must fit a pattern (regular expression). Otherwise an issue is reported.", parameter: "pattern", needsParameter: true, example: "pattern ^[A-Z]{2}$ for a country code" },
    { name: "MAX_LENGTH", group: "Validate", does: "The value must not be longer than a number of characters.", parameter: "number", needsParameter: true, example: "40 for a name field of the target" },
    { name: "ALLOWED_VALUES", group: "Validate", does: "Only the listed values are allowed. Otherwise an issue is reported.", parameter: "list separated by comma", needsParameter: true, example: "1,2 for person or organisation" }
];

const ON_FAILURE = ["ERROR", "WARNING"];
const STATUSES = ["Draft", "Approved"];

/** The columns of the Rules sheet, in order. */
const RULE_COLUMNS = [
    { key: "ruleId", header: "RuleID", width: 11, note: "Unique number, e.g. BP-001" },
    { key: "businessObject", header: "Business object", width: 18, note: "e.g. Business Partner" },
    { key: "sourceSystem", header: "Source system", width: 15, note: "e.g. S4SOURCE01 or M3. * = every source system" },
    { key: "entity", header: "Entity", width: 30, note: "S/4: API / entity set. M3: program.transaction. * = every entity" },
    { key: "field", header: "Field", width: 24, note: "Technical field name. * = every text field. Empty for Select rules." },
    { key: "level", header: "Level", width: 11, note: "Source = technical fix of one source system. Canonical = business rule for any source (applied after the mapping)" },
    { key: "group", header: "Group", width: 13, note: "Standardise, Convert, Default, Derive, Select or Validate" },
    { key: "rule", header: "Rule", width: 20, note: "Pick from the list. See the sheet Rule types." },
    { key: "parameter", header: "Parameter", width: 26, note: "What the rule needs. See the sheet Rule types." },
    { key: "condition", header: "Condition", width: 30, note: "Optional. The rule only applies when the condition is true." },
    { key: "order", header: "Order", width: 8, note: "Order of the rules on the same field (1, 2, 3 ...)" },
    { key: "onFailure", header: "On failure", width: 12, note: "Validate rules only: ERROR (stops the record) or WARNING" },
    { key: "reason", header: "Reason / source", width: 40, note: "Why this rule, who agreed it, when" },
    { key: "owner", header: "Owner", width: 16, note: "Who maintains the rule" },
    { key: "status", header: "Status", width: 11, note: "Draft or Approved. Only approved rules are applied." }
];

const CONDITION_HELP = [
    ["Field = 'value'", "the field equals the value", "STAT = '20'"],
    ["Field != 'value'", "the field does not equal the value", "CONO != '200'"],
    ["Field in ('a','b')", "the field is one of the values", "CUCL in ('MIN','OIL')"],
    ["Field is empty", "the field has no value", "TFNO is empty"],
    ["Field is not empty", "the field has a value", "VRNO is not empty"],
    ["... AND ...  /  ... OR ...", "combine two or more conditions (AND is evaluated before OR)", "CONO = '100' AND VRNO is empty"]
];

const byName = new Map(RULE_TYPES.map(rule => [rule.name, rule]));

module.exports = {
    GROUPS, LEVELS, DATE_FORMATS, RULE_TYPES, ON_FAILURE, STATUSES, RULE_COLUMNS, CONDITION_HELP,
    ruleType: (name) => byName.get(String(name || "").toUpperCase())
};
