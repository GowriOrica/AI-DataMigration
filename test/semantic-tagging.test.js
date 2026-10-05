"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { tagField, nameTokens } = require("../srv/model/tagging/RuleBasedTagger");
const { tagFieldsWithAi } = require("../srv/model/tagging/AiTagger");

const TAGS = fs
    .readFileSync(path.join(__dirname, "..", "db", "data", "migration.framework-SemanticTag.csv"), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map(line => {
        const [code, , description, dataClass] = line.split(";");
        return { code, description, dataClass };
    });

const tag = (field) => tagField({ isKey: false, ...field }, TAGS);

describe("RuleBasedTagger", () => {

    it("splits technical names into words", () => {
        assert.equal(nameTokens("OrganizationBPName1"), "organization bp name 1");
        assert.equal(nameTokens("CRS610MI.GetFinancial"), "crs 610 mi get financial");
    });

    it("tags the same meaning in S/4 and M3 identically", () => {
        const s4 = tag({ name: "CityName", description: "City", dataType: "Edm.String", structureName: "A_BusinessPartnerAddress" });
        const m3 = tag({ name: "TOWN", description: "City", dataType: "String", structureName: "OIS002MI.LstAddress" });

        assert.equal(s4.tag, "address.city");
        assert.equal(m3.tag, "address.city");
        assert.ok(s4.confidence >= 85 && m3.confidence >= 85);
        assert.equal(s4.origin, "HEURISTIC");
        assert.match(s4.reason, /City/);
    });

    it("uses structure context to separate sales and finance meanings", () => {
        const sales = tag({ name: "CustomerPaymentTerms", description: "Customer Payment Terms", dataType: "Edm.String", structureName: "A_CustomerSalesArea" });
        const finance = tag({ name: "PaymentTerms", description: "Terms of Payment Key", dataType: "Edm.String", structureName: "A_CustomerCompany" });

        assert.equal(sales.tag, "sales.paymentTerms");
        assert.equal(finance.tag, "finance.paymentTerms");
    });

    it("flags ambiguous fields for review instead of guessing confidently", () => {
        const result = tag({ name: "TEPY", description: "Payment terms", dataType: "String", structureName: "CRS610MI.LstByNumber" });

        assert.ok(result.tag === "finance.paymentTerms" || result.tag === "sales.paymentTerms");
        assert.ok(result.confidence <= 70);
        assert.match(result.reason, /ambiguous/);
    });

    it("keeps generic phrases below high confidence (M3 'Company')", () => {
        const result = tag({ name: "CONO", description: "Company", dataType: "Integer", isKey: true, structureName: "CRS610MI.LstByNumber" });

        assert.equal(result.tag, "org.companyCode");
        assert.ok(result.confidence < 85);
    });

    it("applies identifier tags only to key fields", () => {
        const reference = tag({ name: "Customer", description: "Customer Number", dataType: "Edm.String", isKey: false, structureName: "A_BusinessPartner" });
        const key = tag({ name: "Customer", description: "Customer Number", dataType: "Edm.String", isKey: true, structureName: "A_Customer" });

        assert.equal(reference.tag, null);
        assert.equal(key.tag, "party.legacyId");
    });

    it("does not mistake a supplier reference for a bank account", () => {
        const result = tag({ name: "Supplier", description: "Account Number of Supplier", dataType: "Edm.String", structureName: "A_BusinessPartner" });

        assert.notEqual(result.tag, "bank.account");
    });

    it("rejects tags whose data class does not fit", () => {
        const result = tag({ name: "BlockText", description: "Central Block", dataType: "Edm.String", length: 60, structureName: "X" });

        assert.ok(result.tag === null || result.confidence < 85);
    });

    it("leaves technical fields untagged", () => {
        assert.equal(tag({ name: "OrdinalNumber", description: "Sequence Number", dataType: "Edm.String", structureName: "X" }).tag, null);
    });
});

describe("AiTagger (fake provider - no external calls)", () => {

    const fields = [
        { ID: "f1", name: "TOWN", description: "City", dataType: "String", structureName: "OIS002MI.LstAddress" },
        { ID: "f2", name: "VRNO", description: "VAT registration number", dataType: "String", structureName: "CRS610MI.LstByNumber" },
        { ID: "f3", name: "RGDT", description: "Entry date", dataType: "Date", structureName: "CRS610MI.LstByNumber" }
    ];

    const fakeProvider = (payload, calls = []) => ({
        async generateJSON(prompt) {
            calls.push(prompt);
            return payload;
        }
    });

    it("accepts valid answers and discards invented tags and unknown fields", async () => {
        const provider = fakeProvider({
            results: [
                { id: "f1", tag: "address.city", confidence: 97, reason: "City" },
                { id: "f2", tag: "tax.vatMagic", confidence: 90, reason: "invented tag" },
                { id: "f3", tag: null, confidence: 0, reason: "technical date" },
                { id: "zz", tag: "address.city", confidence: 99, reason: "unknown field" }
            ]
        });

        const { results, discarded } = await tagFieldsWithAi(fields, TAGS, provider);
        const byId = Object.fromEntries(results.map(r => [r.fieldId, r]));

        assert.equal(byId.f1.tag, "address.city");
        assert.equal(byId.f1.origin, "AI");
        assert.equal(byId.f2, undefined);
        assert.equal(byId.f3.tag, null);
        assert.equal(discarded, 2);
    });

    it("sends metadata only - no record values", async () => {
        const calls = [];

        await tagFieldsWithAi(fields, TAGS, fakeProvider({ results: [] }, calls));

        assert.equal(calls.length, 1);
        assert.match(calls[0], /"name":"TOWN"/);
        assert.doesNotMatch(calls[0], /Mackay|C1001/);
    });

    it("supports the { data, usage } provider shape", async () => {
        const provider = fakeProvider({
            data: { results: [{ id: "f1", tag: "address.city", confidence: 95, reason: "City" }] },
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        });

        const { results, usage } = await tagFieldsWithAi(fields, TAGS, provider);

        assert.equal(results[0].tag, "address.city");
        assert.equal(usage.totalTokens, 15);
    });

    it("reports provider failures instead of inventing results", async () => {
        const failing = { async generateJSON() { throw new Error("quota exceeded"); } };

        await assert.rejects(tagFieldsWithAi(fields, TAGS, failing), /quota exceeded/);
    });
});
