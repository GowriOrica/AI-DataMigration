"use strict";

/**
 * ============================================================
 * GENERIC MIGRATION MAPPING ENGINE - POC
 * ============================================================
 *
 * POC ONLY
 *
 * This engine:
 *   - Does not call SAP AI Core
 *   - Does not call Generative AI Hub
 *   - Does not call Joule
 *   - Does not contain M3 -> S/4 mapping rules
 *   - Does not contain customer-specific mapping dictionaries
 *
 * It uses:
 *   - Field names
 *   - Descriptions
 *   - Data types
 *   - Semantic types
 *   - Technical compatibility
 *   - Generic token/compound-name similarity
 *
 * Production:
 *   Semantic reasoning will be delegated to the AI layer.
 *
 * ============================================================
 */

class MappingEngine {

    /**
     * ========================================================
     * MAIN ENTRY
     * ========================================================
     */
    static async analyze(context) {

        if (!context) {
            throw new Error(
                "Mapping context is required."
            );
        }


        const sourceFields =
            Array.isArray(context.source?.fields)
                ? context.source.fields
                : [];


        const canonicalFields =
            Array.isArray(context.canonical?.fields)
                ? context.canonical.fields
                : [];


        const targetFields =
            Array.isArray(context.target?.fields)
                ? context.target.fields
                : [];


        if (sourceFields.length === 0) {

            return this._emptyResult(
                "NO_SOURCE_FIELDS"
            );
        }


        if (canonicalFields.length === 0) {

            return this._emptyResult(
                "NO_CANONICAL_FIELDS"
            );
        }


        if (targetFields.length === 0) {

            return this._emptyResult(
                "NO_TARGET_FIELDS"
            );
        }


        /**
         * ----------------------------------------------------
         * Remove technical canonical fields.
         *
         * These fields are migration framework metadata and
         * must never participate in business mapping.
         * ----------------------------------------------------
         */
        const usableCanonicalFields =
            canonicalFields.filter(
                field =>
                    !this._isTechnicalField(
                        field
                    )
            );


        /**
         * ----------------------------------------------------
         * Build source -> canonical candidates
         * ----------------------------------------------------
         */
        const sourceToCanonical =
            this._buildCandidateMatrix(
                sourceFields,
                usableCanonicalFields
            );


        /**
         * ----------------------------------------------------
         * Build canonical -> target candidates
         * ----------------------------------------------------
         */
        const canonicalToTarget =
            this._buildCandidateMatrix(
                usableCanonicalFields,
                targetFields
            );


        /**
         * ----------------------------------------------------
         * Build final mappings
         * ----------------------------------------------------
         */
        const mappings =
            this._buildFinalMappings(
                sourceToCanonical,
                canonicalToTarget
            );


        const highConfidenceCount =
            mappings.filter(
                mapping =>
                    mapping.confidenceLevel === "HIGH"
            ).length;


        const approvalRequiredCount =
            mappings.filter(
                mapping =>
                    mapping.approvalRequired === true
            ).length;


        return {

            status:
                mappings.length > 0
                    ? "PENDING_APPROVAL"
                    : "NO_MAPPING",

            mappings,

            mappingCount:
                mappings.length,

            highConfidenceCount,

            approvalRequiredCount
        };
    }


    /**
     * ========================================================
     * TECHNICAL FIELD DETECTION
     * ========================================================
     *
     * These are framework/control/lineage fields.
     *
     * They are not business mappings.
     *
     * This is structural filtering, NOT M3/S4 business logic.
     * ========================================================
     */
    static _isTechnicalField(field) {

        const name =
            String(
                field?.fieldName || ""
            )
                .trim()
                .toLowerCase();


        if (!name) {
            return true;
        }


        /**
         * Framework generated fields
         */
        const technicalNames = new Set([
            "id",
            "createdat",
            "createdby",
            "modifiedat",
            "modifiedby",
            "runid",
            "batchid",
            "sourcesystem",
            "sourcekey",
            "sourceobject",
            "rawrecordid",
            "processingstatus",
            "validationstatus",
            "mappingstatus",
            "mappingversion",
            "mappingevidence",
            "transformationrequired",
            "transformationreference",
            "canonicalizedat"
        ]);


        if (
            technicalNames.has(
                name
            )
        ) {
            return true;
        }


        return false;
    }


    /**
     * ========================================================
     * CANDIDATE MATRIX
     * ========================================================
     */
    static _buildCandidateMatrix(
        sourceFields,
        targetFields
    ) {

        const result = [];


        for (
            const sourceField
            of sourceFields
        ) {

            const candidates = [];


            for (
                const targetField
                of targetFields
            ) {

                const evidence =
                    this._buildEvidence(
                        sourceField,
                        targetField
                    );


                candidates.push({

                    targetField,

                    score:
                        evidence.score,

                    evidence
                });
            }


            candidates.sort(
                (a, b) =>
                    b.score -
                    a.score
            );


            result.push({

                sourceField,

                candidates
            });
        }


        return result;
    }


    /**
     * ========================================================
     * EVIDENCE
     * ========================================================
     */
    static _buildEvidence(
        sourceField,
        targetField
    ) {

        const nameSimilarity =
            this._nameSimilarity(
                sourceField.fieldName,
                targetField.fieldName
            );


        const descriptionSimilarity =
            this._textSimilarity(
                sourceField.description,
                targetField.description
            );


        const semanticSimilarity =
            this._textSimilarity(
                sourceField.semanticType,
                targetField.semanticType
            );


        const dataTypeCompatibility =
            this._dataTypeCompatibility(
                sourceField.dataType,
                targetField.dataType
            );


        const lengthCompatibility =
            this._numericCompatibility(
                sourceField.length,
                targetField.length
            );


        const precisionCompatibility =
            this._numericCompatibility(
                sourceField.precision,
                targetField.precision
            );


        const scaleCompatibility =
            this._numericCompatibility(
                sourceField.scale,
                targetField.scale
            );


        const nullableCompatibility =
            this._nullableCompatibility(
                sourceField.nullable,
                targetField.nullable
            );


        /**
         * ----------------------------------------------------
         * Weighted score
         *
         * Name is strongest because our POC metadata currently
         * does not have rich semantic annotations.
         * ----------------------------------------------------
         */
        let score =
            (
                nameSimilarity * 0.45 +
                descriptionSimilarity * 0.10 +
                semanticSimilarity * 0.15 +
                dataTypeCompatibility * 0.20 +
                lengthCompatibility * 0.04 +
                precisionCompatibility * 0.02 +
                scaleCompatibility * 0.02 +
                nullableCompatibility * 0.02
            ) * 100;


        /**
         * ----------------------------------------------------
         * Exact field name
         * ----------------------------------------------------
         */
        if (
            nameSimilarity >= 0.99 &&
            dataTypeCompatibility >= 0.8
        ) {

            score =
                Math.max(
                    score,
                    95
                );
        }


        /**
         * ----------------------------------------------------
         * Strong compound-name relationship
         *
         * Examples:
         *
         * email      -> emailAddress
         * phone      -> phoneNumber
         * postalCode -> postalCode
         * name       -> organizationName
         * ----------------------------------------------------
         */
        if (
            nameSimilarity >= 0.80 &&
            dataTypeCompatibility >= 0.8
        ) {

            score =
                Math.max(
                    score,
                    88
                );
        }


        /**
         * ----------------------------------------------------
         * Strong semantic relationship
         * ----------------------------------------------------
         */
        if (
            semanticSimilarity >= 0.90 &&
            dataTypeCompatibility >= 0.8
        ) {

            score =
                Math.max(
                    score,
                    90
                );
        }


        score =
            Math.max(
                0,
                Math.min(
                    100,
                    Number(
                        score.toFixed(2)
                    )
                )
            );


        return {

            score,

            sourceField:
                sourceField.fieldName,

            targetCandidate:
                targetField.fieldName,

            sourceDescription:
                sourceField.description ||
                null,

            targetDescription:
                targetField.description ||
                null,

            sourceDataType:
                sourceField.dataType ||
                null,

            targetDataType:
                targetField.dataType ||
                null,

            sourceSemanticType:
                sourceField.semanticType ||
                null,

            targetSemanticType:
                targetField.semanticType ||
                null,

            nameSimilarity:
                Number(
                    nameSimilarity.toFixed(4)
                ),

            descriptionSimilarity:
                Number(
                    descriptionSimilarity.toFixed(4)
                ),

            semanticTypeSimilarity:
                Number(
                    semanticSimilarity.toFixed(4)
                ),

            dataTypeCompatibility:
                Number(
                    dataTypeCompatibility.toFixed(4)
                ),

            lengthCompatibility:
                Number(
                    lengthCompatibility.toFixed(4)
                ),

            precisionCompatibility:
                Number(
                    precisionCompatibility.toFixed(4)
                ),

            scaleCompatibility:
                Number(
                    scaleCompatibility.toFixed(4)
                ),

            nullableCompatibility:
                Number(
                    nullableCompatibility.toFixed(4)
                ),

            matchingMethod:
                "generic-metadata-evidence",

            evidenceType:
                "technical-and-semantic-metadata"
        };
    }


    /**
     * ========================================================
     * NAME SIMILARITY
     * ========================================================
     *
     * Better than simple Jaccard.
     *
     * Handles:
     *
     * email
     * emailAddress
     *
     * phone
     * phoneNumber
     *
     * postalCode
     * postal_code
     *
     * organizationName
     * name
     * ========================================================
     */
    static _nameSimilarity(
    value1,
    value2
) {

    if (
        value1 === null ||
        value1 === undefined ||
        value2 === null ||
        value2 === undefined
    ) {
        return 0;
    }


    const normalized1 =
        this._normalizeFieldName(
            value1
        );


    const normalized2 =
        this._normalizeFieldName(
            value2
        );


    if (
        !normalized1 ||
        !normalized2
    ) {
        return 0;
    }


    // Exact match
    if (
        normalized1 === normalized2
    ) {
        return 1;
    }


    const tokens1 =
        this._tokenize(
            normalized1
        );


    const tokens2 =
        this._tokenize(
            normalized2
        );


    if (
        !tokens1.length ||
        !tokens2.length
    ) {
        return 0;
    }


    const set1 =
        new Set(tokens1);


    const set2 =
        new Set(tokens2);


    let intersection = 0;


    for (
        const token of set1
    ) {

        if (
            set2.has(token)
        ) {
            intersection++;
        }
    }


    /*
     * Complete-token similarity.
     *
     * customerNumber vs taxNumber
     *
     * shared = number
     * source tokens = 2
     * target tokens = 2
     *
     * This must NOT be treated as a strong match.
     */
    const tokenCoverage =
        intersection /
        Math.max(
            tokens1.length,
            tokens2.length
        );


    /*
     * Single generic token should never create
     * a strong mapping.
     *
     * Example:
     *
     * name -> CityName
     * number -> TaxNumber
     */
    if (
        intersection === 1 &&
        (
            tokens1.length === 1 ||
            tokens2.length === 1
        )
    ) {

        return 0.45;
    }


    /*
     * One complete token set contained inside the other.
     *
     * email -> emailAddress
     * phone -> phoneNumber
     *
     * This is useful for generic compound field names.
     */
    if (
        tokens1.length === 1 &&
        tokens2.length > 1 &&
        set2.has(tokens1[0])
    ) {

        return 0.80;
    }


    if (
        tokens2.length === 1 &&
        tokens1.length > 1 &&
        set1.has(tokens2[0])
    ) {

        return 0.80;
    }


    /*
     * Multiple shared tokens.
     */
    if (
        intersection >= 2
    ) {

        return Math.min(
            0.90,
            tokenCoverage
        );
    }


    /*
     * No meaningful token relationship.
     */
    return tokenCoverage;
}


    /**
     * ========================================================
     * NORMALIZE FIELD NAME
     * ========================================================
     */
    static _normalizeFieldName(
        value
    ) {

        return String(value)
            .trim()
            .replace(
                /([a-z])([A-Z])/g,
                "$1 $2"
            )
            .replace(
                /([A-Z]+)([A-Z][a-z])/g,
                "$1 $2"
            )
            .replace(
                /[_\-.]+/g,
                " "
            )
            .replace(
                /\s+/g,
                " "
            )
            .toLowerCase();
    }


    /**
     * ========================================================
     * TOKENIZE
     * ========================================================
     */
    static _tokenize(
        value
    ) {

        return String(value)
            .trim()
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
    }


    /**
     * ========================================================
     * TEXT SIMILARITY
     * ========================================================
     */
    static _textSimilarity(
        value1,
        value2
    ) {

        if (
            !value1 ||
            !value2
        ) {
            return 0;
        }


        const text1 =
            this._normalizeFieldName(
                value1
            );


        const text2 =
            this._normalizeFieldName(
                value2
            );


        if (
            text1 === text2
        ) {
            return 1;
        }


        const tokens1 =
            new Set(
                this._tokenize(
                    text1
                )
            );


        const tokens2 =
            new Set(
                this._tokenize(
                    text2
                )
            );


        let intersection = 0;


        for (
            const token
            of tokens1
        ) {

            if (
                tokens2.has(token)
            ) {
                intersection++;
            }
        }


        const union =
            new Set([
                ...tokens1,
                ...tokens2
            ]).size;


        if (
            union === 0
        ) {
            return 0;
        }


        return (
            intersection /
            union
        );
    }


    /**
 * ========================================================
 * DATA TYPE COMPATIBILITY
 * ========================================================
 *
 * Normalizes technical type names before comparison.
 *
 * Examples:
 *
 * String      -> string
 * cds.String  -> string
 * Edm.String  -> string
 *
 * Integer     -> integer
 * cds.Integer -> integer
 *
 * Decimal     -> decimal
 * cds.Decimal -> decimal
 *
 * This keeps the mapping engine generic and metadata-driven.
 * ========================================================
 */
static _dataTypeCompatibility(
    type1,
    type2
) {

    if (
        !type1 ||
        !type2
    ) {
        return 0.5;
    }


    const normalizedType1 =
        this._normalizeDataType(
            type1
        );


    const normalizedType2 =
        this._normalizeDataType(
            type2
        );


    /**
     * Exact logical type match
     */
    if (
        normalizedType1 ===
        normalizedType2
    ) {
        return 1;
    }


    /**
     * Numeric types
     */
    const numericTypes =
        new Set([
            "integer",
            "integer64",
            "decimal",
            "double",
            "float",
            "number",
            "int",
            "bigint"
        ]);


    /**
     * String types
     */
    const stringTypes =
        new Set([
            "string",
            "varchar",
            "nvarchar",
            "char",
            "text"
        ]);


    /**
     * Date/time types
     */
    const dateTypes =
        new Set([
            "date",
            "datetime",
            "timestamp",
            "datetimeoffset",
            "time"
        ]);


    /**
     * Boolean types
     */
    const booleanTypes =
        new Set([
            "boolean",
            "bool"
        ]);


    if (
        numericTypes.has(
            normalizedType1
        ) &&
        numericTypes.has(
            normalizedType2
        )
    ) {
        return 0.8;
    }


    if (
        stringTypes.has(
            normalizedType1
        ) &&
        stringTypes.has(
            normalizedType2
        )
    ) {
        return 0.8;
    }


    if (
        dateTypes.has(
            normalizedType1
        ) &&
        dateTypes.has(
            normalizedType2
        )
    ) {
        return 0.8;
    }


    if (
        booleanTypes.has(
            normalizedType1
        ) &&
        booleanTypes.has(
            normalizedType2
        )
    ) {
        return 0.8;
    }


    return 0;
}


/**
 * ========================================================
 * NORMALIZE DATA TYPE
 * ========================================================
 */
static _normalizeDataType(
    value
) {

    let type =
        String(value)
            .trim()
            .toLowerCase();


    /**
     * Remove common framework prefixes.
     *
     * cds.String  -> string
     * edm.string  -> string
     * sap.string  -> string
     */
    type =
        type.replace(
            /^(cds|edm|sap)\./,
            ""
        );


    /**
     * Remove namespaces if present.
     *
     * Example:
     *
     * com.sap.String
     *
     * -> string
     */
    if (
        type.includes(".")
    ) {

        const parts =
            type.split(".");


        type =
            parts[
                parts.length - 1
            ];
    }


    /**
     * Normalize common aliases.
     */
    const aliases = {

        "nvarchar": "string",

        "varchar": "string",

        "char": "string",

        "text": "string",

        "int": "integer",

        "int32": "integer",

        "int64": "integer64",

        "bigint": "integer64",

        "number": "decimal",

        "numeric": "decimal",

        "double": "double",

        "float": "double",

        "datetimeoffset": "datetime",

        "timestamp": "datetime",

        "bool": "boolean"
    };


    return (
        aliases[type] ||
        type
    );
}


    /**
     * ========================================================
     * NUMERIC COMPATIBILITY
     * ========================================================
     */
    static _numericCompatibility(
        value1,
        value2
    ) {

        if (
            value1 === null ||
            value1 === undefined ||
            value2 === null ||
            value2 === undefined
        ) {
            return 0.5;
        }


        const number1 =
            Number(value1);


        const number2 =
            Number(value2);


        if (
            !Number.isFinite(number1) ||
            !Number.isFinite(number2)
        ) {
            return 0.5;
        }


        if (
            number1 === number2
        ) {
            return 1;
        }


        if (
            number1 <= number2
        ) {
            return 0.8;
        }


        return 0.2;
    }


    /**
     * ========================================================
     * NULLABLE COMPATIBILITY
     * ========================================================
     */
    static _nullableCompatibility(
        sourceNullable,
        targetNullable
    ) {

        if (
            sourceNullable === undefined ||
            targetNullable === undefined ||
            sourceNullable === null ||
            targetNullable === null
        ) {
            return 0.5;
        }


        if (
            sourceNullable ===
            targetNullable
        ) {
            return 1;
        }


        if (
            sourceNullable === true &&
            targetNullable === false
        ) {
            return 0;
        }


        return 0.5;
    }


    /**
     * ========================================================
     * FINAL MAPPING DECISION
     * ========================================================
     */
    static _buildFinalMappings(
        sourceToCanonical,
        canonicalToTarget
    ) {

        const mappings = [];


        for (
            const sourceCandidate
            of sourceToCanonical
        ) {

            const canonicalCandidate =
                this._selectCandidate(
                    sourceCandidate.candidates
                );


            if (
                !canonicalCandidate
            ) {
                continue;
            }


            const canonicalField =
                canonicalCandidate.targetField;


            const targetCandidateGroup =
                canonicalToTarget.find(
                    item =>
                        item.sourceField.fieldName ===
                        canonicalField.fieldName
                );


            if (
                !targetCandidateGroup
            ) {
                continue;
            }


            const targetCandidate =
                this._selectCandidate(
                    targetCandidateGroup.candidates
                );


            if (
                !targetCandidate
            ) {
                continue;
            }


            const targetField =
                targetCandidate.targetField;


            /**
             * ------------------------------------------------
             * Combined confidence
             *
             * Use weakest link.
             * ------------------------------------------------
             */
            const confidence =
                Number(
                    Math.min(
                        canonicalCandidate.score,
                        targetCandidate.score
                    ).toFixed(2)
                );


            const confidenceLevel =
                this._getConfidenceLevel(
                    confidence
                );


            const transformationRequired =
                this._requiresTransformation(
                    sourceCandidate.sourceField,
                    targetField
                );


            /**
             * POC:
             * Every mapping is still approval-controlled.
             */
            const approvalRequired =
                true;


            mappings.push({

                sourceField:
                    sourceCandidate
                        .sourceField
                        .fieldName,

                canonicalField:
                    canonicalField
                        .fieldName,

                targetField:
                    targetField
                        .fieldName,

                confidence,

                confidenceLevel,

                transformationRequired,

                approvalRequired,

                evidence: {

                    sourceToCanonical:
                        canonicalCandidate.evidence,

                    canonicalToTarget:
                        targetCandidate.evidence,

                    sourceCanonicalScore:
                        canonicalCandidate.score,

                    canonicalTargetScore:
                        targetCandidate.score,

                    matchingMethod:
                        "generic-metadata-evidence",

                    semanticDecision:
                        "POC_METADATA_REASONING",

                    note:
                        "POC mapping recommendation generated from discovered source, canonical and target metadata."
                }
            });
        }


        return mappings;
    }


    /**
     * ========================================================
     * SELECT CANDIDATE
     * ========================================================
     */
static _selectCandidate(candidates) {

    if (
        !Array.isArray(candidates) ||
        candidates.length === 0
    ) {
        return null;
    }

    const best = candidates[0];

    /*
     * POC:
     *
     * Always return the best available candidate.
     *
     * We do NOT reject it here based on an arbitrary
     * confidence threshold.
     *
     * Confidence is exposed to the consumer so that:
     *
     * HIGH   -> strong recommendation
     * MEDIUM -> review
     * LOW    -> investigate / AI reasoning required
     *
     * Production AI will make the actual semantic decision.
     */
    return best;
}


    /**
     * ========================================================
     * CONFIDENCE
     * ========================================================
     */
    static _getConfidenceLevel(
        confidence
    ) {

        if (
            confidence >= 90
        ) {
            return "HIGH";
        }


        if (
            confidence >= 70
        ) {
            return "MEDIUM";
        }


        return "LOW";
    }


    /**
     * ========================================================
     * TRANSFORMATION REQUIRED
     * ========================================================
     */
    static _requiresTransformation(
        sourceField,
        targetField
    ) {

        if (
            !sourceField?.dataType ||
            !targetField?.dataType
        ) {
            return false;
        }


        return (
            this._dataTypeCompatibility(
                sourceField.dataType,
                targetField.dataType
            ) < 1
        );
    }


    /**
     * ========================================================
     * EMPTY RESULT
     * ========================================================
     */
    static _emptyResult(
        status
    ) {

        return {

            status,

            mappings: [],

            mappingCount: 0,

            highConfidenceCount: 0,

            approvalRequiredCount: 0
        };
    }
}


module.exports = MappingEngine;