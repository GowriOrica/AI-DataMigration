"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");

const { applyRules, validateRule, parseCondition, toIsoDate } = require("../srv/lib/cleansing/RuleEngine");
const { previewRules } = require("../srv/lib/cleansing/CleansingPreview");

const rule = (overrides) => ({ ruleId: "R1", sourceSystem: "*", entity: "*", level: "Source", order: 1, status: "Approved", ...overrides });
const run = (records, rules, options) => applyRules({ records, rules, ...options });
const stat = (result, ruleId) => result.rules.find(r => r.ruleId === ruleId);

describe("Conditions", () => {

    const test = (condition, record) => parseCondition(condition).test(record);

    it("understands =, !=, in, is empty and is not empty", () => {
        assert.equal(test("STAT = '20'", { STAT: "20" }), true);
        assert.equal(test("STAT = '20'", { STAT: " 20 " }), true);          // values are compared without spaces
        assert.equal(test("STAT != '20'", { STAT: "10" }), true);
        assert.equal(test("CUCL in ('MIN','OIL')", { CUCL: "OIL" }), true);
        assert.equal(test("CUCL in ('MIN','OIL')", { CUCL: "GAS" }), false);
        assert.equal(test("TFNO is empty", { TFNO: "" }), true);
        assert.equal(test("TFNO is empty", {}), true);
        assert.equal(test("VRNO is not empty", { VRNO: "1" }), true);
    });

    it("evaluates AND before OR", () => {
        const condition = "A = '1' OR B = '1' AND C = '1'";

        assert.equal(test(condition, { A: "1", B: "0", C: "0" }), true);    // A alone is enough
        assert.equal(test(condition, { A: "0", B: "1", C: "1" }), true);    // B and C
        assert.equal(test(condition, { A: "0", B: "1", C: "0" }), false);
    });

    it("keeps AND / OR that are inside quotes", () => {
        assert.equal(test("NAME = 'Smith AND Sons'", { NAME: "Smith AND Sons" }), true);
    });

    it("says what is wrong", () => {
        assert.throws(() => parseCondition("STAT == 20"), /not understood/);
        assert.throws(() => parseCondition("STAT = '20"), /quote is not closed/);
    });
});

describe("Dates", () => {

    it("converts OData dates, M3 dates and common formats", () => {
        assert.deepEqual(toIsoDate("/Date(1755907200000)/", "ODATA"), { value: "2025-08-23" });
        assert.deepEqual(toIsoDate("/Date(1755907261000)/", "ODATA"), { value: "2025-08-23T00:01:01Z" });
        assert.deepEqual(toIsoDate("20190312", "YYYYMMDD"), { value: "2019-03-12" });
        assert.deepEqual(toIsoDate(20190312, "YYYYMMDD"), { value: "2019-03-12" });
        assert.deepEqual(toIsoDate("23.08.2025", "DD.MM.YYYY"), { value: "2025-08-23" });
        assert.deepEqual(toIsoDate("08/23/2025", "MM/DD/YYYY"), { value: "2025-08-23" });
        assert.deepEqual(toIsoDate("2025-08-23T10:00:00", "YYYY-MM-DD"), { value: "2025-08-23" });
    });

    it("turns an empty or zero date into an empty value, and reports a bad date", () => {
        assert.deepEqual(toIsoDate("00000000", "YYYYMMDD"), { value: "" });
        assert.deepEqual(toIsoDate(0, "YYYYMMDD"), { value: "" });
        assert.match(toIsoDate("20251341", "YYYYMMDD").warn, /not a real date/);
        assert.match(toIsoDate("hello", "ODATA").warn, /not an OData date/);
    });
});

describe("Check of a rule", () => {

    it("accepts a good rule", () => {
        assert.deepEqual(validateRule(rule({ field: "CityName", group: "Standardise", rule: "TRIM" })), []);
    });

    it("says what is wrong, in plain words", () => {
        assert.match(validateRule(rule({ field: "X", rule: "PAD_LEFT" }))[0], /rule 'PAD_LEFT' does not exist. Available rules: TRIM/);
        assert.match(validateRule(rule({ field: "X", group: "Validate", rule: "TRIM" }))[0], /belongs to the group Standardise/);
        assert.match(validateRule(rule({ field: "X", rule: "VALUE_MAP" }))[0], /needs a Parameter/);
        assert.match(validateRule(rule({ field: "X", rule: "DATE_TO_ISO", parameter: "DDMMYY" }))[0], /date format 'DDMMYY' is not known/);
        assert.match(validateRule(rule({ field: "X", rule: "MAX_LENGTH", parameter: "abc" }))[0], /positive number/);
        assert.match(validateRule(rule({ field: "X", rule: "MATCHES", parameter: "([" }))[0], /pattern is not valid/);
        assert.match(validateRule(rule({ field: "", rule: "TRIM" }))[0], /Field is missing/);
        assert.match(validateRule(rule({ field: "*", rule: "REQUIRED" }))[0], /only allowed for Standardise/);
        assert.match(validateRule(rule({ field: "", rule: "INCLUDE_IF" }))[0], /needs a Condition/);
        assert.match(validateRule(rule({ field: "X", rule: "INCLUDE_IF", condition: "A = '1'" }))[0], /leave Field empty/);
        assert.match(validateRule(rule({ field: "X", rule: "TRIM", condition: "A ~ 1" }))[0], /not understood/);
    });

    it("hints at a typo in the field name", () => {
        const errors = validateRule(rule({ field: "CityNam", rule: "TRIM" }), { knownFields: ["CityName", "Region"] });

        assert.match(errors[0], /field 'CityNam' does not exist in this entity, did you mean 'CityName'\?/);
    });
});

describe("Rules on records", () => {

    it("never changes the records it is given", () => {
        const records = [{ CityName: " Berlin " }];

        run(records, [rule({ field: "CityName", rule: "TRIM" })]);

        assert.equal(records[0].CityName, " Berlin ");
    });

    it("trims, changes case and replaces; counts changed values and keeps examples", () => {
        const records = [{ N: " jit COMPANY " }, { N: "Acme" }, { N: "n/a" }];
        const result = run(records, [
            rule({ ruleId: "T", field: "N", rule: "TRIM", order: 1 }),
            rule({ ruleId: "C", field: "N", rule: "TITLE", order: 2 }),
            rule({ ruleId: "R", field: "N", rule: "REPLACE", parameter: "N/A=>", order: 3 })
        ]);

        // "n/a": TITLE makes it "N/A" (a letter after / is capitalised), then REPLACE removes it
        assert.deepEqual(result.records.map(r => r.N), ["Jit Company", "Acme", ""]);
        assert.equal(stat(result, "T").changed, 1);
        assert.equal(stat(result, "T").evaluated, 3);
        assert.deepEqual(stat(result, "T").examples, [{ before: " jit COMPANY ", after: "jit COMPANY" }]);
        assert.equal(stat(result, "C").changed, 2);                       // "jit COMPANY" and "n/a"
        assert.equal(stat(result, "R").changed, 1);
    });

    it("runs the rules of one field in their Order", () => {
        const records = [{ N: "  de " }];
        const result = run(records, [
            rule({ ruleId: "U", field: "N", rule: "UPPER", order: 2 }),
            rule({ ruleId: "T", field: "N", rule: "TRIM", order: 1 })
        ]);

        assert.equal(result.records[0].N, "DE");
    });

    it("trims every text field with the field *", () => {
        const result = run([{ A: " x ", B: " y ", C: 5, __metadata: { id: 1 } }], [rule({ field: "*", rule: "TRIM" })]);

        assert.deepEqual(result.records[0].A, "x");
        assert.deepEqual(result.records[0].B, "y");
        assert.equal(result.records[0].C, 5);
    });

    it("converts dates of different source systems with the same rule", () => {
        const s4 = run([{ D: "/Date(1755907200000)/" }], [rule({ field: "D", rule: "DATE_TO_ISO", parameter: "ODATA" })]);
        const m3 = run([{ D: "20190312" }, { D: "00000000" }], [rule({ field: "D", rule: "DATE_TO_ISO", parameter: "YYYYMMDD" })]);

        assert.equal(s4.records[0].D, "2025-08-23");
        assert.deepEqual(m3.records.map(r => r.D), ["2019-03-12", ""]);
    });

    it("converts codes with the value map, and reports values without a mapping", () => {
        const result = run(
            [{ G: "BP01" }, { G: "BPXX" }, { G: "" }],
            [rule({ field: "G", rule: "VALUE_MAP", parameter: "Grouping" })],
            { valueMaps: { Grouping: { BP01: "Z001" } } }
        );

        assert.deepEqual(result.records.map(r => r.G), ["Z001", "BPXX", ""]);
        assert.equal(result.issueCount, 1);
        assert.match(result.issues[0].message, /'BPXX' has no approved mapping in the domain Grouping/);
        assert.equal(result.issues[0].severity, "WARNING");      // only Validate rules reject records
    });

    it("fills defaults only where the value is empty, also if the field is missing", () => {
        const result = run([{ L: "" }, { L: "FR" }, {}], [rule({ field: "L", rule: "DEFAULT", parameter: "EN" })]);

        assert.deepEqual(result.records.map(r => r.L), ["EN", "FR", "EN"]);
    });

    it("builds a value from other fields", () => {
        const result = run(
            [{ F: "Anna", L: "Muller" }, { F: "", L: "Smith" }],
            [rule({ field: "FULL", rule: "CONCAT", parameter: "fields=F,L;separator=' '" })]
        );

        assert.deepEqual(result.records.map(r => r.FULL), ["Anna Muller", "Smith"]);
    });

    it("leaves records out with INCLUDE_IF / EXCLUDE_IF", () => {
        const records = [{ CONO: "100", T: "a" }, { CONO: "200", T: "b" }, { CONO: "100", T: "TEST" }];
        const result = run(records, [
            rule({ ruleId: "I", field: "", rule: "INCLUDE_IF", condition: "CONO = '100'" }),
            rule({ ruleId: "E", field: "", rule: "EXCLUDE_IF", condition: "T = 'TEST'" })
        ]);

        assert.equal(result.input, 3);
        assert.equal(result.output, 1);
        assert.equal(result.excluded, 2);
        assert.equal(stat(result, "I").excluded, 1);
        assert.equal(stat(result, "E").excluded, 1);
    });

    it("validates the cleansed value, reports issues and does not change anything", () => {
        const records = [{ N: " Anna ", C: "1", CC: "DE" }, { N: "  ", C: "3", CC: "Germany" }];
        const result = run(records, [
            rule({ ruleId: "T", field: "N", rule: "TRIM", order: 1 }),
            rule({ ruleId: "REQ", field: "N", rule: "REQUIRED", onFailure: "ERROR" }),
            rule({ ruleId: "ALL", field: "C", rule: "ALLOWED_VALUES", parameter: "1,2", onFailure: "WARNING" }),
            rule({ ruleId: "PAT", field: "CC", rule: "MATCHES", parameter: "^[A-Z]{2}$", onFailure: "ERROR" }),
            rule({ ruleId: "LEN", field: "CC", rule: "MAX_LENGTH", parameter: "5", onFailure: "WARNING" })
        ]);

        assert.equal(stat(result, "REQ").issues, 1);                      // the second name is empty after trimming
        assert.equal(stat(result, "ALL").issues, 1);
        assert.equal(stat(result, "PAT").issues, 1);
        assert.equal(stat(result, "LEN").issues, 1);
        assert.equal(result.rejected, 1);                                 // only ERROR issues reject a record
        assert.equal(result.records.length, 2);                           // the record stays, it is only flagged
        assert.equal(result.records[1].CC, "Germany");
    });

    it("applies a rule only when its condition is true", () => {
        const result = run(
            [{ CO: "100", N: " a " }, { CO: "200", N: " b " }],
            [rule({ field: "N", rule: "TRIM", condition: "CO = '100'" })]
        );

        assert.deepEqual(result.records.map(r => r.N), ["a", " b "]);
    });

    it("applies only the rules of the source system and the entity", () => {
        const rules = [
            rule({ ruleId: "S4", sourceSystem: "S4SOURCE01", entity: "API_BUSINESS_PARTNER / A_BusinessPartner", field: "N", rule: "TRIM" }),
            rule({ ruleId: "M3", sourceSystem: "M3", entity: "CRS610MI.LstByNumber", field: "N", rule: "TRIM" }),
            rule({ ruleId: "ALL", sourceSystem: "*", entity: "*", field: "N", rule: "UPPER" })
        ];
        const result = run([{ N: " a " }], rules, { sourceSystem: "S4SOURCE01", entity: "API_BUSINESS_PARTNER" });

        assert.deepEqual(result.rules.map(r => r.ruleId), ["S4", "ALL"]);
        assert.equal(result.records[0].N, "A");
    });

    it("warns when a rule uses a field that no record has, or leaves out every record", () => {
        const result = run([{ CONO: "100", CityName: "x" }, { CONO: "200", CityName: "y" }], [
            rule({ ruleId: "BAD", field: "", rule: "INCLUDE_IF", condition: "IsMarkedForDeletion = 'false'" }),
            rule({ ruleId: "TYPO", field: "CityNam", rule: "TRIM" })
        ], { entity: "API_X" });

        assert.equal(result.output, 0);
        assert.deepEqual(result.warnings, [
            "Rule BAD: the field 'IsMarkedForDeletion' does not exist in any record of API_X",
            "Rule BAD leaves out every record. Check the condition.",
            "Rule TYPO: the field 'CityNam' does not exist in any record of API_X, did you mean 'CityName'?"
        ]);
    });

    it("gives no warnings for good rules, also for fields that a rule creates", () => {
        const result = run([{ F: "a", L: "b" }], [
            rule({ field: "FULL", rule: "CONCAT", parameter: "fields=F,L;separator=' '" }),
            rule({ ruleId: "D", field: "NEW", rule: "DEFAULT", parameter: "x" })
        ]);

        assert.deepEqual(result.warnings, []);
    });

    it("skips invalid rules and says why, the others still run", () => {
        const result = run([{ N: " a " }], [
            rule({ ruleId: "BAD", field: "N", rule: "PAD_LEFT" }),
            rule({ ruleId: "OK", field: "N", rule: "TRIM" })
        ]);

        assert.equal(result.invalidRules.length, 1);
        assert.equal(result.invalidRules[0].ruleId, "BAD");
        assert.equal(result.records[0].N, "a");
    });

    it("runs the canonical level separately", () => {
        const rules = [rule({ field: "N", rule: "TRIM", level: "Canonical" })];

        assert.equal(run([{ N: " a " }], rules).records[0].N, " a ");
        assert.equal(run([{ N: " a " }], rules, { level: "Canonical" }).records[0].N, "a");
    });
});

describe("Preview on an extraction in the storage", () => {

    const store = new Map();
    const storage = { get: async (key) => { if (!store.has(key)) throw new Error("missing"); return store.get(key); } };
    const page = (rows) => zlib.gzipSync(Buffer.from(rows.map(r => JSON.stringify(r)).join("\n")));

    store.set("extractions/EX-C/CRS610MI.LstByNumber/page-00001.ndjson.gz", page([{ CONO: "100", CUNM: " North ", RGDT: "20190312" }, { CONO: "200", CUNM: "South", RGDT: "00000000" }]));
    store.set("extractions/EX-C/CRS610MI.LstByNumber/page-00002.ndjson.gz", page([{ CONO: "100", CUNM: "East ", RGDT: "20200701" }]));
    store.set("extractions/EX-C/manifest.json", Buffer.from(JSON.stringify({
        extractionId: "EX-C", businessObject: "Business Partner", sourceSystem: "M3_X",
        objects: [{
            objectName: "CRS610MI.LstByNumber", records: 3, truncated: false,
            files: [{ key: "extractions/EX-C/CRS610MI.LstByNumber/page-00001.ndjson.gz" }, { key: "extractions/EX-C/CRS610MI.LstByNumber/page-00002.ndjson.gz" }]
        }]
    })));

    it("counts what the rules would change on all pages, without keeping records", async () => {
        const result = await previewRules({
            storage, extractionId: "EX-C",
            rules: [
                rule({ ruleId: "A", sourceSystem: "M3_X", entity: "CRS610MI.LstByNumber", field: "CUNM", rule: "TRIM" }),
                rule({ ruleId: "B", sourceSystem: "M3_X", entity: "CRS610MI.LstByNumber", field: "RGDT", rule: "DATE_TO_ISO", parameter: "YYYYMMDD" }),
                rule({ ruleId: "C", sourceSystem: "M3_X", entity: "*", field: "", rule: "INCLUDE_IF", condition: "CONO = '100'" })
            ]
        });
        const o = result.objects[0];

        assert.equal(o.input, 3);
        assert.equal(o.excluded, 1);
        assert.equal(o.records, undefined);
        assert.equal(stat(o, "A").changed, 2);                           // " North " and "East "
        assert.equal(stat(o, "B").changed, 2);                           // two dates are converted; the zero date is in the excluded record
    });

    it("refuses an unknown extraction or API", async () => {
        await assert.rejects(previewRules({ storage, extractionId: "EX-NOPE", rules: [] }), /not found/);
        await assert.rejects(previewRules({ storage, extractionId: "EX-C", objectName: "X", rules: [] }), /not part of/);
    });
});
