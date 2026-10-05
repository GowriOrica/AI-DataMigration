"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    AllRecordsMalformedError,
    FIELD_COMPLETENESS_THRESHOLDS,
    QUALITY_SCORE_WEIGHTS,
    profileRecords
} = require("../srv/profiling/ProfileDataProfiler");

const context = {
    runId: "RUN-1",
    batchId: "BATCH-1",
    sourceObject: "OBJECT_A"
};

const fields = [
    {
        fieldName: "ID",
        dataType: "Edm.String",
        nullable: false
    },
    {
        fieldName: "Amount",
        dataType: "Edm.Decimal",
        nullable: false
    },
    {
        fieldName: "EmailAddress",
        dataType: "Edm.String",
        nullable: true
    }
];

const profile = (rawRecords, sourceFields = fields, overrides = {}) =>
    profileRecords({
        ...context,
        ...overrides,
        rawRecords,
        sourceFields
    });

const raw = (sourceKey, payload) => ({
    sourceKey,
    payload: typeof payload === "string"
        ? payload
        : JSON.stringify(payload)
});

const byField = (result, fieldName) =>
    result.fieldResults.find(
        (field) => field.fieldName === fieldName
    );

test("uses the required quality weights and field thresholds", () => {
    assert.deepEqual(QUALITY_SCORE_WEIGHTS, {
        completeness: 0.60,
        uniqueness: 0.20,
        validity: 0.20
    });
    assert.deepEqual(FIELD_COMPLETENESS_THRESHOLDS, {
        ok: 95,
        warning: 80
    });
});

test("returns a safe, backward-compatible result for an empty batch", () => {
    const result = profile([]);

    assert.equal(result.totalRecords, 0);
    assert.equal(result.completeRecords, 0);
    assert.equal(result.incompleteRecords, 0);
    assert.equal(result.completenessPercentage, 0);
    assert.equal(result.requiredFieldCount, 0);
    assert.equal(result.duplicateRecordCount, 0);
    assert.equal(result.duplicateSourceKeys, 0);
    assert.equal(result.qualityScore, 0);
    assert.equal(result.qualityStatus, "NO_DATA");
    assert.equal(result.status, "NO_DATA");
    assert.deepEqual(result.fieldResults, []);
});

test("profiles complete records using mandatory metadata fields", () => {
    const result = profile([
        raw("1", {
            ID: "A",
            Amount: 10,
            EmailAddress: "a@example.com"
        }),
        raw("2", {
            ID: "B",
            Amount: "20.50",
            EmailAddress: "b@example.com"
        })
    ]);

    assert.equal(result.totalRecords, 2);
    assert.equal(result.completeRecords, 2);
    assert.equal(result.incompleteRecords, 0);
    assert.equal(result.completenessPercentage, 100);
    assert.equal(result.requiredFieldCount, 2);
    assert.equal(result.qualityScore, 100);
    assert.equal(result.qualityStatus, "GOOD_QUALITY");
});

test("treats null, empty, and whitespace-only mandatory values as missing", () => {
    const result = profile([
        raw("1", { ID: null, Amount: 1 }),
        raw("2", { ID: "", Amount: 2 }),
        raw("3", { ID: "   ", Amount: 3 })
    ]);
    const id = byField(result, "ID");

    assert.equal(result.completeRecords, 0);
    assert.equal(result.incompleteRecords, 3);
    assert.equal(result.missingFieldCount, 3);
    assert.equal(id.populatedCount, 0);
    assert.equal(id.missingCount, 3);
    assert.equal(id.completenessPercentage, 0);
    assert.equal(id.status, "CRITICAL");
});

test("calculates field populated, missing, distinct, and repeated-value counts", () => {
    const result = profile([
        raw("1", { ID: "A", Amount: 1 }),
        raw("2", { ID: "A", Amount: 2 }),
        raw("3", { ID: "B", Amount: 3, EmailAddress: "b@example.com" })
    ]);
    const id = byField(result, "ID");
    const email = byField(result, "EmailAddress");

    assert.equal(id.populatedCount, 3);
    assert.equal(id.missingCount, 0);
    assert.equal(id.distinctCount, 2);
    assert.equal(id.duplicateValueCount, 1);
    assert.equal(email.populatedCount, 1);
    assert.equal(email.missingCount, 2);
    assert.equal(email.completenessPercentage, 33.33);
    assert.equal(email.status, "CRITICAL");
});

test("reports invalid numeric and email values without marking populated records incomplete", () => {
    const result = profile([
        raw("1", {
            ID: "A",
            Amount: "not-a-number",
            EmailAddress: "invalid-email"
        })
    ]);
    const amount = byField(result, "Amount");
    const email = byField(result, "EmailAddress");

    assert.equal(result.completeRecords, 1);
    assert.equal(amount.invalidCount, 1);
    assert.equal(amount.status, "CRITICAL");
    assert.equal(email.invalidCount, 1);
    assert.equal(email.status, "WARNING");
    assert.equal(result.invalidEmailCount, 1);
    assert.equal(result.qualityScore, 80);
});

test("applies OK, WARNING, and CRITICAL field-completeness thresholds", () => {
    const statusFor = (populatedCount) =>
        byField(
            profile(
                Array.from(
                    { length: 20 },
                    (_, index) => raw(
                        String(index),
                        index < populatedCount
                            ? { Value: `value-${index}` }
                            : {}
                    )
                ),
                [{
                    fieldName: "Value",
                    dataType: "Edm.String",
                    nullable: true
                }]
            ),
            "Value"
        ).status;

    assert.equal(statusFor(19), "OK");
    assert.equal(statusFor(16), "WARNING");
    assert.equal(statusFor(15), "CRITICAL");
});

test("counts one malformed payload as a quality issue without crashing the batch", () => {
    const result = profile([
        raw("1", { ID: "A", Amount: 1 }),
        raw("2", "{not-json")
    ]);
    const id = byField(result, "ID");

    assert.equal(result.totalRecords, 2);
    assert.equal(result.completeRecords, 1);
    assert.equal(result.incompleteRecords, 1);
    assert.equal(result.completenessPercentage, 50);
    assert.equal(id.populatedCount, 1);
    assert.equal(id.missingCount, 1);
    assert.match(result.message, /Malformed payloads: 1/);
});

test("fails only when every stored payload is malformed", () => {
    assert.throws(
        () => profile([
            raw("1", "{bad"),
            raw("2", "not-json")
        ]),
        AllRecordsMalformedError
    );
});

test("counts repeated source keys already present in RawRecord", () => {
    const result = profile([
        raw("DUP", { ID: "A", Amount: 1 }),
        raw("DUP", { ID: "B", Amount: 2 }),
        raw("UNIQUE", { ID: "C", Amount: 3 })
    ]);

    assert.equal(result.duplicateRecordCount, 1);
    assert.equal(result.duplicateSourceKeys, 1);
});

test("uses different metadata for different source objects", () => {
    const objectA = profile(
        [raw("1", { RequiredA: "value" })],
        [{
            fieldName: "RequiredA",
            dataType: "Edm.String",
            nullable: false
        }]
    );
    const objectB = profile(
        [raw("2", { OptionalB: "value" })],
        [{
            fieldName: "OptionalB",
            dataType: "Edm.String",
            nullable: true
        }],
        { sourceObject: "OBJECT_B" }
    );

    assert.equal(objectA.requiredFieldCount, 1);
    assert.equal(objectA.fieldResults[0].fieldName, "RequiredA");
    assert.equal(objectB.sourceObject, "OBJECT_B");
    assert.equal(objectB.requiredFieldCount, 0);
    assert.equal(objectB.fieldResults[0].fieldName, "OptionalB");
});

test("profiles a mixed-quality demo batch with missing, invalid, duplicate, and malformed data", () => {
    const demoRecords = [
        raw("CUSTOMER-1001", {
            ID: "TEST-1",
            Amount: 1250.50,
            EmailAddress: "test1@example.com"
        }),
        raw("CUSTOMER-1001", {
            ID: "DATATEST-2",
            Amount: "12O0.50",
            EmailAddress: "datatest2.example.com"
        }),
        raw(
            "CUSTOMER-1003",
            '{"ID":"DATATEST-3","Amount":300,"EmailAddress":"test3@example.com"'
        )
    ];

    const displayRecords = demoRecords.map((record) => {
        try {
            return {
                sourceKey: record.sourceKey,
                payload: JSON.parse(record.payload)
            };
        } catch (error) {
            return record;
        }
    });

    console.log(
        "\nDUMMY RAW RECORDS BEING PROFILED:\n",
        JSON.stringify(displayRecords, null, 2)
    );

    const result = profile(demoRecords);

    console.log(
        "\nPROFILE DATA SENT TO UI:\n",
        JSON.stringify(result, null, 2)
    );

    const id = byField(result, "ID");
    const amount = byField(result, "Amount");
    const email = byField(result, "EmailAddress");

    assert.equal(result.totalRecords, 3);
    assert.equal(result.completeRecords, 2);
    assert.equal(result.incompleteRecords, 1);
    assert.equal(result.completenessPercentage, 66.67);
    assert.equal(result.duplicateRecordCount, 1);
    assert.equal(result.invalidEmailCount, 1);
    assert.equal(result.missingFieldCount, 2);

    assert.equal(id.populatedCount, 2);
    assert.equal(id.missingCount, 1);

    assert.equal(amount.populatedCount, 2);
    assert.equal(amount.missingCount, 1);
    assert.equal(amount.invalidCount, 1);

    assert.equal(email.populatedCount, 2);
    assert.equal(email.missingCount, 1);
    assert.equal(email.invalidCount, 1);
    assert.match(result.message, /Malformed payloads: 1/);
});

test("retains all existing response fields", () => {
    const result = profile([
        raw("1", {
            ID: "A",
            Amount: 1,
            EmailAddress: "a@example.com"
        })
    ]);

    for (const fieldName of [
        "runId",
        "batchId",
        "sourceObject",
        "totalRecords",
        "completeRecords",
        "incompleteRecords",
        "duplicateSourceKeys",
        "invalidEmailCount",
        "missingFieldCount",
        "qualityScore",
        "status",
        "profiledAt",
        "message"
    ]) {
        assert.ok(
            Object.prototype.hasOwnProperty.call(result, fieldName),
            `missing backward-compatible field: ${fieldName}`
        );
    }
});
