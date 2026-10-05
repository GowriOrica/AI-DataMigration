const test = require("node:test");
const assert = require("node:assert");
const cds = require("@sap/cds");

// the service looks up its entities when it is loaded; the validation itself needs no database
Object.defineProperty(cds, "entities", { value: () => ({ MigrationAssessment: {} }), configurable: true });

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-only";   // the service builds its AI provider when loaded; nothing is called here
const service = require("../srv/lib/ai/BusinessObjectAssessmentService");

const answer = (extra = {}) => ({
    sourceObject: "APS200MI", businessObject: "Supplier Invoice", component: "Transaction",
    confidence: 90, evidenceFields: ["SupplierInvoice"], reason: "by name", ...extra
});

test("a program without fields is accepted even if the AI names evidence it was not given", () => {
    const result = service.validateAssessmentResult(answer(), { sourceObject: { objectName: "APS200MI" }, fields: [] });

    assert.strictEqual(result.businessObject, "Supplier Invoice");
    assert.deepStrictEqual(result.evidenceFields, []);
});

test("a program without fields is accepted when the AI gives no evidence list at all", () => {
    const result = service.validateAssessmentResult(answer({ evidenceFields: undefined }), { sourceObject: { objectName: "APS200MI" }, fields: [] });

    assert.deepStrictEqual(result.evidenceFields, []);
});

test("an object that has fields still needs evidence taken from those fields", () => {
    const context = { sourceObject: { objectName: "APS200MI" }, fields: [{ fieldName: "SUNO" }] };

    assert.throws(() => service.validateAssessmentResult(answer(), context), /was not supplied/);
    assert.strictEqual(service.validateAssessmentResult(answer({ evidenceFields: ["SUNO"] }), context).evidenceFields[0], "SUNO");
});
