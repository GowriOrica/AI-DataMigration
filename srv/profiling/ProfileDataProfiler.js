"use strict";

const QUALITY_SCORE_WEIGHTS = Object.freeze({
    completeness: 0.60,
    uniqueness: 0.20,
    validity: 0.20
});

const FIELD_COMPLETENESS_THRESHOLDS = Object.freeze({
    ok: 95,
    warning: 80
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class AllRecordsMalformedError extends Error {
    constructor() {
        super("Every RawRecord payload failed JSON parsing");
        this.name = "AllRecordsMalformedError";
        this.code = "ALL_RECORDS_MALFORMED";
    }
}

const roundPercentage = (value) => Number(value.toFixed(2));

const percentage = (numerator, denominator) =>
    denominator > 0
        ? roundPercentage((numerator / denominator) * 100)
        : 0;

const isMissing = (value) =>
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "");

const isNumericField = (dataType) =>
    /(^|[._])(?:byte|sbyte|int|int16|int32|int64|integer|decimal|number|numeric|double|single|float|real)(?:$|[.(])/i
        .test(String(dataType || ""));

const isEmailField = (fieldName) =>
    /email/i.test(String(fieldName || ""));

const isNumericValue = (value) =>
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" &&
        value.trim() !== "" &&
        Number.isFinite(Number(value)));

const normalizeDistinctValue = (value, numeric) => {
    if (numeric && isNumericValue(value)) {
        const numberValue = Number(value);
        if (Number.isFinite(numberValue)) {
            return `number:${numberValue}`;
        }
    }

    if (typeof value === "string") {
        return `string:${value.trim()}`;
    }

    if (typeof value === "object") {
        try {
            return `object:${JSON.stringify(value)}`;
        } catch (error) {
            return `object:${String(value)}`;
        }
    }

    return `${typeof value}:${String(value)}`;
};

const fieldStatus = ({
    completenessPercentage,
    required,
    invalidCount
}) => {
    if (
        completenessPercentage < FIELD_COMPLETENESS_THRESHOLDS.warning ||
        (required && invalidCount > 0)
    ) {
        return "CRITICAL";
    }

    if (
        completenessPercentage < FIELD_COMPLETENESS_THRESHOLDS.ok ||
        invalidCount > 0
    ) {
        return "WARNING";
    }

    return "OK";
};

const qualityStatus = (score) => {
    if (score < 50) {
        return "LOW_QUALITY";
    }

    if (score < 80) {
        return "MEDIUM_QUALITY";
    }

    return "GOOD_QUALITY";
};

const createEmptyResult = ({ runId, batchId, sourceObject }) => ({
    runId,
    batchId,
    sourceObject,
    totalRecords: 0,
    completeRecords: 0,
    incompleteRecords: 0,
    completenessPercentage: 0,
    requiredFieldCount: 0,
    duplicateRecordCount: 0,
    qualityScore: 0,
    qualityStatus: "NO_DATA",
    fieldResults: [],
    duplicateSourceKeys: 0,
    invalidEmailCount: 0,
    missingFieldCount: 0,
    status: "NO_DATA",
    profiledAt: new Date(),
    message:
        "No RAW_RECORD entries were found for the supplied runId, batchId and sourceObject."
});

const profileRecords = ({
    runId,
    batchId,
    sourceObject,
    rawRecords,
    sourceFields
}) => {
    const records = Array.isArray(rawRecords) ? rawRecords : [];

    if (records.length === 0) {
        return createEmptyResult({ runId, batchId, sourceObject });
    }

    const uniqueFields = [];
    const seenFieldNames = new Set();

    for (const field of Array.isArray(sourceFields) ? sourceFields : []) {
        if (!field || !field.fieldName || seenFieldNames.has(field.fieldName)) {
            continue;
        }

        seenFieldNames.add(field.fieldName);
        uniqueFields.push(field);
    }

    const requiredFields = uniqueFields.filter(
        (field) => field.nullable === false
    );

    const fieldProfiles = new Map(
        uniqueFields.map((field) => [
            field.fieldName,
            {
                fieldName: field.fieldName,
                dataType: field.dataType || null,
                required: field.nullable === false,
                populatedCount: 0,
                missingCount: 0,
                distinctValues: new Set(),
                invalidCount: 0,
                numeric: isNumericField(field.dataType),
                email: isEmailField(field.fieldName)
            }
        ])
    );

    let completeRecords = 0;
    let incompleteRecords = 0;
    let missingFieldCount = 0;
    let invalidEmailCount = 0;
    let malformedRecordCount = 0;
    let validatedValueCount = 0;
    let invalidValueCount = 0;

    const sourceKeyMap = new Map();

    for (const rawRecord of records) {
        let payload;

        try {
            payload = typeof rawRecord.payload === "string"
                ? JSON.parse(rawRecord.payload)
                : rawRecord.payload;

            if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
                throw new TypeError("RawRecord payload is not a JSON object");
            }
        } catch (error) {
            malformedRecordCount++;
            incompleteRecords++;
            missingFieldCount += requiredFields.length || 1;
            validatedValueCount++;
            invalidValueCount++;

            for (const profile of fieldProfiles.values()) {
                profile.missingCount++;
            }

            continue;
        }

        const sourceKey = rawRecord.sourceKey;
        if (sourceKey) {
            const normalizedSourceKey = String(sourceKey);
            sourceKeyMap.set(
                normalizedSourceKey,
                (sourceKeyMap.get(normalizedSourceKey) || 0) + 1
            );
        }

        let recordIsComplete = true;

        for (const profile of fieldProfiles.values()) {
            const value = payload[profile.fieldName];

            if (isMissing(value)) {
                profile.missingCount++;

                if (profile.required) {
                    recordIsComplete = false;
                    missingFieldCount++;
                }

                continue;
            }

            profile.populatedCount++;
            profile.distinctValues.add(
                normalizeDistinctValue(value, profile.numeric)
            );

            let valid = true;

            if (profile.numeric) {
                validatedValueCount++;
                valid = isNumericValue(value);
            }

            if (profile.email) {
                validatedValueCount++;
                const emailIsValid = EMAIL_PATTERN.test(String(value).trim());
                valid = valid && emailIsValid;

                if (!emailIsValid) {
                    invalidEmailCount++;
                }
            }

            if (!valid) {
                profile.invalidCount++;
                invalidValueCount++;
            }
        }

        if (recordIsComplete) {
            completeRecords++;
        } else {
            incompleteRecords++;
        }
    }

    if (malformedRecordCount === records.length) {
        throw new AllRecordsMalformedError();
    }

    let duplicateRecordCount = 0;

    // KNOWN LIMITATION:
    // Ingestion currently removes repeated source keys before inserting RawRecord.
    // Therefore duplicateRecordCount can under-report duplicates.
    // Duplicate preservation must be handled as a separate follow-up task.
    for (const count of sourceKeyMap.values()) {
        if (count > 1) {
            duplicateRecordCount += count - 1;
        }
    }

    const totalRecords = records.length;
    const completenessPercentage = percentage(
        completeRecords,
        totalRecords
    );
    const uniquenessPercentage = percentage(
        Math.max(0, totalRecords - duplicateRecordCount),
        totalRecords
    );
    const validityPercentage = validatedValueCount > 0
        ? percentage(
            Math.max(0, validatedValueCount - invalidValueCount),
            validatedValueCount
        )
        : 100;

    const qualityScore = roundPercentage(
        completenessPercentage * QUALITY_SCORE_WEIGHTS.completeness +
        uniquenessPercentage * QUALITY_SCORE_WEIGHTS.uniqueness +
        validityPercentage * QUALITY_SCORE_WEIGHTS.validity
    );
    const resultQualityStatus = qualityStatus(qualityScore);

    const fieldResults = Array.from(fieldProfiles.values()).map((profile) => {
        const fieldCompleteness = percentage(
            profile.populatedCount,
            totalRecords
        );
        const distinctCount = profile.distinctValues.size;

        return {
            fieldName: profile.fieldName,
            dataType: profile.dataType,
            required: profile.required,
            populatedCount: profile.populatedCount,
            missingCount: profile.missingCount,
            completenessPercentage: fieldCompleteness,
            distinctCount,
            duplicateValueCount: profile.populatedCount - distinctCount,
            invalidCount: profile.invalidCount,
            status: fieldStatus({
                completenessPercentage: fieldCompleteness,
                required: profile.required,
                invalidCount: profile.invalidCount
            })
        };
    });

    return {
        runId,
        batchId,
        sourceObject,
        totalRecords,
        completeRecords,
        incompleteRecords,
        completenessPercentage,
        requiredFieldCount: requiredFields.length,
        duplicateRecordCount,
        qualityScore,
        qualityStatus: resultQualityStatus,
        fieldResults,

        // Backward-compatible response fields.
        duplicateSourceKeys: duplicateRecordCount,
        invalidEmailCount,
        missingFieldCount,
        status: resultQualityStatus,
        profiledAt: new Date(),
        message:
            `Data profiling completed. Records: ${totalRecords}, ` +
            `Complete: ${completeRecords}, Incomplete: ${incompleteRecords}, ` +
            `Completeness: ${completenessPercentage}%, ` +
            `Duplicate source keys: ${duplicateRecordCount}, ` +
            `Invalid emails: ${invalidEmailCount}, ` +
            `Malformed payloads: ${malformedRecordCount}, ` +
            `Quality score: ${qualityScore}.`
    };
};

module.exports = {
    AllRecordsMalformedError,
    FIELD_COMPLETENESS_THRESHOLDS,
    QUALITY_SCORE_WEIGHTS,
    profileRecords
};
