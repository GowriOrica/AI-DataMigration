"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");

const { RecordProfiler, profileExtraction, classify } = require("../srv/lib/profiling/ExtractionProfiler");

/** A small data set with known answers. */
const records = [
    { __metadata: { id: "x" }, Partner: "1", Name: "Anna Muller", City: "Berlin", Country: "DE", Created: "/Date(1755907200000)/", Email: "anna@example.com", Unused: "", Nav: { __deferred: { uri: "x" } } },
    { Partner: "2", Name: "anna muller", City: "Berlin", Country: "de", Created: "/Date(1755907200000)/", Email: "not-an-email", Unused: null },
    { Partner: "3", Name: "Bob Smith ", City: "", Country: "DE", Created: "2025-08-23", Email: "bob@example.com", Unused: "" },
    { Partner: "3", Name: "Carla Diaz", City: "Madrid", Country: "Germany", Created: "/Date(1755907200000)/", Email: "", Unused: "" }
];

const profileOf = (rows, options) => {
    const profiler = new RecordProfiler(options);
    rows.forEach(r => profiler.add(r));
    return profiler.finish();
};

const field = (profile, name) => profile.fields.find(f => f.name === name);

describe("Profiling of extracted records", () => {

    it("counts records and fields and ignores OData bookkeeping", () => {
        const p = profileOf(records);

        assert.equal(p.records, 4);
        assert.deepEqual(p.fields.map(f => f.name), ["Partner", "Name", "City", "Country", "Created", "Email", "Unused"]);
    });

    it("measures the fill rate and finds the fields that are always empty", () => {
        const p = profileOf(records);

        assert.equal(field(p, "City").fillPct, 75);
        assert.equal(field(p, "City").kind, "PARTIAL");
        assert.equal(field(p, "Email").fillPct, 75);
        assert.equal(field(p, "Partner").kind, "FULL");
        assert.deepEqual(p.alwaysEmpty, ["Unused"]);
        assert.equal(p.fullyFilled, 4);   // Partner, Name, Country, Created
    });

    it("lists the most frequent values", () => {
        const p = profileOf(records);

        assert.deepEqual(field(p, "City").top, [{ value: "Berlin", count: 2 }, { value: "Madrid", count: 1 }]);
    });

    it("finds mixed date formats, spelling variants and values with spaces", () => {
        const p = profileOf(records);

        assert.deepEqual(p.mixedDateFields, ["Created"]);
        assert.deepEqual(p.spellingVariantFields, ["Name", "Country"]);   // "Anna Muller" / "anna muller", "DE" / "de"
        assert.deepEqual(p.fieldsWithSpaces, ["Name"]);                   // "Bob Smith "
        assert.equal(field(p, "Email").invalidEmails, 1);
    });

    it("recognises the date formats", () => {
        assert.equal(classify("/Date(1755907200000)/"), "odata-date");
        assert.equal(classify("2025-08-23"), "iso-date");
        assert.equal(classify("2025-08-23T10:00:00Z"), "iso-date");
        assert.equal(classify("100100"), "numeric-text");
        assert.equal(classify("DE"), "text");
    });

    it("counts duplicate keys, with the first field as the automatic key", () => {
        // 20 records, the key "7" appears twice: 19 of 20 values are different, so the first field looks like a key
        const rows = Array.from({ length: 19 }, (_, i) => ({ Partner: String(i + 1), Name: `N${i}` }));
        rows.push({ Partner: "7", Name: "again" });

        assert.deepEqual(profileOf(rows).duplicateKeys, { fields: ["Partner"], duplicateRecords: 1 });
    });

    it("counts duplicate keys for a given composite key", () => {
        const p = profileOf(records, { keyFields: ["City", "Country"] });

        assert.deepEqual(p.duplicateKeys, { fields: ["City", "Country"], duplicateRecords: 0 });
    });

    it("does not report a key when the first field is clearly not one", () => {
        const rows = [{ Country: "DE", N: 1 }, { Country: "DE", N: 2 }, { Country: "DE", N: 3 }, { Country: "FR", N: 4 }];

        assert.equal(profileOf(rows).duplicateKeys, null);
    });

    it("finds probable duplicates by name, ignoring case and spaces", () => {
        const p = profileOf(records);

        // the API has a city, so name + city are compared
        assert.equal(p.probableDuplicates.field, "Name + City");
        assert.equal(p.probableDuplicates.groups, 1);
        assert.equal(p.probableDuplicates.extraRecords, 1);
        assert.deepEqual(p.probableDuplicates.examples, [{ value: "anna muller / berlin", count: 2 }]);
    });

    it("does not call the same name in different cities a duplicate (bank branches)", () => {
        const rows = [
            { Id: "1", BankName: "Commerzbank", CityName: "Berlin" },
            { Id: "2", BankName: "Commerzbank", CityName: "Munich" },
            { Id: "3", BankName: "Commerzbank", CityName: "Hamburg" },
            { Id: "4", BankName: "Sparkasse", CityName: "Berlin" }
        ];

        assert.equal(profileOf(rows).probableDuplicates.groups, 0);

        // without a city the same name would be a candidate
        const noCity = rows.map(({ CityName, ...rest }) => rest);
        assert.equal(profileOf(noCity).probableDuplicates.groups, 1);
    });

    it("reports fields with dates in the old OData format", () => {
        const p = profileOf(records);

        assert.deepEqual(p.odataDateFields, ["Created"]);
        assert.match(p.findings.join(" "), /old OData format .*Created/);
    });

    it("does not let rarely filled optional fields pull the score down", () => {
        const rows = Array.from({ length: 20 }, (_, i) => ({ Id: String(i + 1), Name: `N${i}`, Optional: i === 0 ? "x" : "" }));

        assert.equal(profileOf(rows).score.completeness, 100);   // Optional is filled in 5 % only
    });

    it("gives an indicative score and plain sentences", () => {
        const p = profileOf(records);

        assert.ok(p.score.value >= 0 && p.score.value <= 100);
        assert.equal(p.score.indicative, true);
        assert.match(p.findings.join(" "), /4 records, 7 fields: 4 fully filled, 2 partly filled, 1 always empty/);
        assert.match(p.findings.join(" "), /probable duplicates, not proof/);
        assert.match(p.findings.join(" "), /Mixed date formats in: Created/);
    });

    it("handles an empty extraction", () => {
        const p = profileOf([]);

        assert.equal(p.records, 0);
        assert.deepEqual(p.findings, ["The extraction contains no records."]);
    });

    it("scores clean data as OK", () => {
        const clean = Array.from({ length: 50 }, (_, i) => ({ Id: String(i + 1), Name: `Name ${i + 1}`, Country: "DE" }));
        const p = profileOf(clean);

        assert.equal(p.score.value, 100);
        assert.equal(p.score.status, "OK");
    });
});

describe("Profiling of an extraction in the storage", () => {

    const store = new Map();
    const storage = { get: async (key) => { if (!store.has(key)) throw new Error("missing " + key); return store.get(key); } };

    const page = (rows) => zlib.gzipSync(Buffer.from(rows.map(r => JSON.stringify(r)).join("\n")));

    store.set("extractions/EX-P/API_A/page-00001.ndjson.gz", page(records.slice(0, 2)));
    store.set("extractions/EX-P/API_A/page-00002.ndjson.gz", page(records.slice(2)));
    store.set("extractions/EX-P/manifest.json", Buffer.from(JSON.stringify({
        extractionId: "EX-P", businessObject: "Business Partner", sourceSystem: "S1", startedAt: "2026-10-04T00:00:00Z",
        objects: [{
            objectName: "API_A", records: 4, truncated: true, error: null,
            files: [{ key: "extractions/EX-P/API_A/page-00001.ndjson.gz" }, { key: "extractions/EX-P/API_A/page-00002.ndjson.gz" }]
        }]
    })));

    it("reads all pages and reports a truncated extraction", async () => {
        const result = await profileExtraction({ storage, extractionId: "EX-P" });

        assert.equal(result.businessObject, "Business Partner");
        assert.equal(result.objects.length, 1);
        assert.equal(result.objects[0].records, 4);
        assert.equal(result.objects[0].truncated, true);
        assert.match(result.objects[0].findings.join(" "), /stopped at the record limit/);
    });

    it("refuses an unknown extraction or API", async () => {
        await assert.rejects(profileExtraction({ storage, extractionId: "EX-NOPE" }), /not found/);
        await assert.rejects(profileExtraction({ storage, extractionId: "EX-P", objectName: "API_X" }), /not part of/);
    });
});
