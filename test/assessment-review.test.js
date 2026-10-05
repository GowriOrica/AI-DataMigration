"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

process.env.CDS_PLUGIN_UI5_ACTIVE = "false";

// The services create their AI clients when loaded; fake keys mean no real call is ever made
process.env.AI_PROVIDER = "OPENROUTER";
process.env.OPENROUTER_API_KEY = "fake-key-for-tests";
process.env.OPENROUTER_MODEL = "fake/model";
process.env.GEMINI_API_KEY = "fake-key-for-tests";

const cds = require("@sap/cds");

const { GET, POST } = cds.test(
    "serve",
    "srv/migration-service.cds",
    "srv/framework-service.cds",
    "--in-memory"
).in(path.join(__dirname, ".."));

const SYSTEM = "T1";

const grouped = async () => {
    const { data } = await GET(
        `/migration/MigrationAssessments?groupByBusinessObject=true&$filter=${encodeURIComponent(`sourceSystemId eq '${SYSTEM}'`)}`
    );

    return data.value[0];
};

const group = (result, name) => result.groups.find(g => g.businessObject === name);

const review = (sourceObject, decision, businessObject, comment) =>
    POST("/migration/reviewAssessment", { sourceSystemId: SYSTEM, sourceObject, decision, businessObject, comment });

describe("Review of AI proposals (confirm / reject / change)", () => {

    before(async () => {
        const row = (sourceObject, businessObject, confidence) => ({
            sourceSystemId: SYSTEM,
            sourceObject,
            businessObject,
            component: "Master Data",
            confidence,
            status: "COMPLETED",
            metadataVersion: "1.0",
            reason: `AI reason for ${sourceObject}`
        });

        await INSERT.into("migration.orchestrator.MigrationAssessment").entries([
            row("API_BUSINESS_PARTNER", "Business Partner", 98),
            row("API_CUSTOMER_SRV", "Business Partner", 85),
            row("API_COSTCENTER", "Business Partner", 85),   // a wrong AI answer
            row("API_PRODUCT_SRV", "Material", 90)
        ]);
    });

    it("starts with every proposal as SUGGESTED and matches the catalog", async () => {
        const result = await grouped();
        const partner = group(result, "Business Partner");

        assert.equal(partner.apiCount, 3);
        assert.equal(partner.openCount, 3);
        assert.equal(partner.confirmedCount, 0);
        assert.equal(partner.catalogCode, "BUSINESS_PARTNER");           // matched to the catalog seed
        assert.equal(group(result, "Material").catalogCode, null);       // not in the catalog yet
        assert.ok(partner.apis.every(api => api.reviewStatus === "SUGGESTED"));
    });

    it("confirms and rejects proposals, with counters per business object", async () => {
        await review("API_BUSINESS_PARTNER", "CONFIRM");
        await review("API_COSTCENTER", "REJECT", undefined, "cost centers are not partners");

        const partner = group(await grouped(), "Business Partner");

        assert.equal(partner.confirmedCount, 1);
        assert.equal(partner.rejectedCount, 1);
        assert.equal(partner.openCount, 1);

        const rejected = partner.apis.find(api => api.sourceObject === "API_COSTCENTER");

        assert.equal(rejected.reviewStatus, "REJECTED");
        assert.equal(rejected.reviewComment, "cost centers are not partners");
    });

    it("moves an API to another business object and keeps what the AI said", async () => {
        const { data } = await review("API_COSTCENTER", "CHANGE", "Cost Center");

        assert.match(data.value, /confirmed as 'Cost Center'/);

        const result = await grouped();
        const moved = group(result, "Cost Center").apis[0];

        assert.equal(moved.sourceObject, "API_COSTCENTER");
        assert.equal(moved.reviewStatus, "CONFIRMED");
        assert.equal(moved.originalBusinessObject, "Business Partner");
        assert.equal(group(result, "Business Partner").apiCount, 2);
    });

    it("validates the request", async () => {
        await assert.rejects(review("API_PRODUCT_SRV", "MAYBE"), /400/);
        await assert.rejects(review("API_PRODUCT_SRV", "CHANGE"), /400/);
        await assert.rejects(review("API_DOES_NOT_EXIST", "CONFIRM"), /404/);
    });

    it("adds by hand an API the AI never assessed, with the reason", async () => {
        const systemId = cds.utils.uuid();

        await INSERT.into("migration.orchestrator.SourceSystem").entries({ ID: systemId, systemId: SYSTEM, systemName: "Test", active: true });
        await INSERT.into("migration.orchestrator.SourceObject").entries({
            objectId: "T1_API_BP_BANKDETAIL", objectName: "API_BP_BANKDETAIL", description: "Bank details of business partners", sourceSystem_ID: systemId
        });

        const { data } = await review("API_BP_BANKDETAIL", "ADD", "Business Partner", "client confirmed on 3 Oct");

        assert.match(data.value, /added to 'Business Partner' and confirmed/);

        const added = group(await grouped(), "Business Partner").apis.find(api => api.sourceObject === "API_BP_BANKDETAIL");

        assert.equal(added.origin, "MANUAL");
        assert.equal(added.reviewStatus, "CONFIRMED");
        assert.equal(added.reviewComment, "client confirmed on 3 Oct");
    });

    it("ADD moves an API the AI put elsewhere; it never sits in two business objects", async () => {
        await review("API_PRODUCT_SRV", "ADD", "Business Partner", "test");

        const result = await grouped();
        const moved = group(result, "Business Partner").apis.find(api => api.sourceObject === "API_PRODUCT_SRV");

        assert.equal(moved.origin, "AI");
        assert.equal(moved.originalBusinessObject, "Material");
        assert.equal(group(result, "Material"), undefined);
    });

    it("does not add an API that was not discovered", async () => {
        await assert.rejects(review("API_INVENTED", "ADD", "Business Partner"), /404/);
    });
});

const { scoreAssessments } = require("../srv/lib/assessment/AnswerKey");

describe("Answer key scoring", () => {

    const entries = [
        { api: "API_BUSINESS_PARTNER", accept: ["Business Partner"] },
        { api: "API_CNSLDTNCOSTCENTER", accept: ["Cost Center"], notBusinessPartner: true },
        { api: "API_BANK", accept: ["Bank"], notBusinessPartner: true },
        { api: "API_CASHREGISTER_REMOTE", accept: ["Cash Register"], notBusinessPartner: true },
        { api: "API_MISSING", accept: ["X"] }
    ];

    const answers = [
        { sourceObject: "API_BUSINESS_PARTNER", businessObject: "business-partner", confidence: 98 },
        { sourceObject: "API_CNSLDTNCOSTCENTER", businessObject: "Business Partner", confidence: 85 },   // typical weak-model error
        { sourceObject: "API_BANK", businessObject: "Unclear", confidence: 20 },
        { sourceObject: "API_CASHREGISTER_REMOTE", businessObject: "Cash Register", confidence: 90 }
    ];

    it("counts correct, wrong, unclear and missing answers", () => {
        const { rows, summary } = scoreAssessments(entries, answers);
        const outcome = Object.fromEntries(rows.map(row => [row.api, row.outcome]));

        assert.deepEqual(outcome, {
            API_BUSINESS_PARTNER: "CORRECT",
            API_CNSLDTNCOSTCENTER: "WRONG",
            API_BANK: "UNCLEAR",
            API_CASHREGISTER_REMOTE: "CORRECT",
            API_MISSING: "MISSING"
        });
        assert.equal(summary.correct, 2);
        assert.equal(summary.wrong, 1);
        assert.equal(summary.noAnswer, 1);       // missing is not the same as wrong
        assert.equal(summary.unclear, 1);
        assert.equal(summary.correctPercent, 40);
        assert.equal(summary.precisionPercent, 67);   // 2 correct of 3 answers given
    });

    it("reports false Business Partner answers separately", () => {
        const { summary } = scoreAssessments(entries, answers);

        assert.equal(summary.falseBusinessPartner, 1);
        assert.equal(summary.notBusinessPartnerTotal, 3);
    });
});

describe("Assessment prompt", () => {

    const input = [{ sourceObject: { name: "API_X" }, fields: [{ name: "Field1" }] }];

    it("gives the AI the catalog names and an honest 'Unclear' option", () => {
        const service = require("../srv/lib/ai/BusinessObjectAssessmentService");
        const prompt = service.buildBatchPrompt(input, null, ["Business Partner", "Material"]);

        assert.match(prompt, /KNOWN BUSINESS OBJECTS AND "UNCLEAR"/);
        assert.match(prompt, /- Business Partner\n- Material/);
        assert.match(prompt, /"businessObject": "Unclear"/);
        assert.match(prompt, /Never use a known business object as a default/);
    });

    it("still offers 'Unclear' when no catalog is available", () => {
        const service = require("../srv/lib/ai/BusinessObjectAssessmentService");
        const prompt = service.buildBatchPrompt(input, null, []);

        assert.doesNotMatch(prompt, /Known migration business objects/);
        assert.match(prompt, /"businessObject": "Unclear"/);
    });

    it("can be switched back to the legacy prompt for comparisons", () => {
        const service = require("../srv/lib/ai/BusinessObjectAssessmentService");

        process.env.ASSESSMENT_PROMPT = "legacy";

        try {
            assert.doesNotMatch(service.buildBatchPrompt(input, null, ["Business Partner"]), /KNOWN BUSINESS OBJECTS/);
        } finally {
            delete process.env.ASSESSMENT_PROMPT;
        }
    });
});
