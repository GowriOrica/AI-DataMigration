const cds = require("@sap/cds");

const {
    SourceSystem,
    SourceObject,
    SourceMetadata,
    SourceField,
    MigrationAssessment
} = cds.entities("migration.orchestrator");

const { createAIProvider } = require("./AIProviderFactory");
// created at the first AI call, so the app starts (and everything else works) without an AI key
let aiProvider = null;
const getAIProvider = () => aiProvider || (aiProvider = createAIProvider());

class BusinessObjectAssessmentService {

    getConfiguration() {
        return {
            maxObjectsPerBatch: Number(process.env.ASSESSMENT_BATCH_MAX_OBJECTS || 5),
            maxCharsPerBatch: Number(process.env.ASSESSMENT_BATCH_MAX_CHARS || 45000),
            maxRetries: Number(process.env.ASSESSMENT_MAX_RETRIES || 3),
            retryBaseDelayMs: Number(process.env.ASSESSMENT_RETRY_BASE_DELAY_MS || 3000),
            interBatchDelayMs: Number(process.env.ASSESSMENT_INTER_BATCH_DELAY_MS || 1500)
        };
    }

    async assess({
        sourceSystemId,
        tx,
        assessmentInstructions = null,
        onlyObjectNames = null,
        knownBusinessObjects = []
    }) {
    if (!sourceSystemId) {
        throw new Error("sourceSystemId is required");
    }

    if (!tx) {
        throw new Error("Transaction context is required");
    }

    console.log(
        `[BUSINESS OBJECT ASSESSMENT] Starting assessment for source system '${sourceSystemId}'.`
    );

    const sourceSystem = await tx.run(
        SELECT.one.from(SourceSystem).where({
            ID: sourceSystemId
        })
    );

    if (!sourceSystem) {
        throw new Error(
            `Source system '${sourceSystemId}' was not found.`
        );
    }

    let sourceObjects = await tx.run(
        SELECT.from(SourceObject).where({
            sourceSystem_ID: sourceSystemId
        })
    );

    // Optional restriction (assessment scope): only the given objects, names compared without _0001
    if (Array.isArray(onlyObjectNames)) {
        const clean = (name) => String(name || "").replace(/_0001$/, "");
        const wanted = new Set(onlyObjectNames.map(clean));

        sourceObjects = sourceObjects.filter(object => wanted.has(clean(object.objectName)));
    }

    if (!sourceObjects || sourceObjects.length === 0) {
        console.log(
            `[BUSINESS OBJECT ASSESSMENT] No source objects found for '${sourceSystemId}'.`
        );

        return {
            sourceSystemId,
            totalObjects: 0,
            objectsAssessed: 0,
            objectsReused: 0,
            objectsFailed: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            failures: []
        };
    }

    console.log(
        `[BUSINESS OBJECT ASSESSMENT] Found ${sourceObjects.length} source objects.`
    );

    const contexts = [];

    for (const sourceObject of sourceObjects) {
        try {
            const context = await this.prepareObjectContext(
                sourceSystem,
                sourceObject,
                tx
            );

            if (context) {
                contexts.push(context);
            }
        } catch (error) {
            console.error(
                `[BUSINESS OBJECT ASSESSMENT] Failed preparing source object '${sourceObject.objectName}'.`,
                error
            );

            contexts.push({
                sourceObject,
                preparationError: error
            });
        }
    }

    const result = {
        sourceSystemId,
        totalObjects: sourceObjects.length,
        objectsAssessed: 0,
        objectsReused: 0,
        objectsFailed: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        failures: []
    };

    const pendingObjects = [];

    for (const context of contexts) {
        if (context.preparationError) {
            result.objectsFailed++;

            result.failures.push({
                sourceObject: context.sourceObject.objectName,
                reason: context.preparationError.message
            });

            continue;
        }

        if (
            context.existingAssessment &&
            context.existingAssessment.status === "COMPLETED"
        ) {
            result.objectsReused++;

            console.log(
                `[BUSINESS OBJECT ASSESSMENT] Reusing existing completed assessment for '${context.sourceObject.objectName}'.`
            );

            continue;
        }

        pendingObjects.push(context);
    }

    if (pendingObjects.length === 0) {
        console.log(
            `[BUSINESS OBJECT ASSESSMENT] No new objects require AI assessment.`
        );

        return result;
    }

    /*
     * ============================================================
     * ASSESSMENT OBJECT LIMIT
     *
     * 0 = process ALL pending objects
     * >0 = process only the configured number
     * ============================================================
     */
    const maxObjects = Number(
        process.env.ASSESSMENT_MAX_OBJECTS || 0
    );

    const objectsToAssess =
        maxObjects > 0
            ? pendingObjects.slice(0, maxObjects)
            : pendingObjects;

    console.log(
        `[BUSINESS OBJECT ASSESSMENT] ASSESSMENT_MAX_OBJECTS=${maxObjects}`
    );

    console.log(
        `[BUSINESS OBJECT ASSESSMENT] ASSESSMENT_BATCH_MAX_OBJECTS=${process.env.ASSESSMENT_BATCH_MAX_OBJECTS}`
    );

    console.log(
        `[BUSINESS OBJECT ASSESSMENT] Selected ${objectsToAssess.length} of ${pendingObjects.length} pending object(s) for assessment.`
    );

    /*
     * ============================================================
     * CREATE AI BATCHES
     *
     * Example:
     * 105 objects + batch size 11
     *
     * Batch 1  = 11
     * Batch 2  = 11
     * ...
     * Batch 9  = 11
     * Batch 10 = 6
     * ============================================================
     */
    const batches = this.buildAssessmentBatches(
        objectsToAssess
    );

    const config = this.getConfiguration();

    console.log(
        `[BUSINESS OBJECT ASSESSMENT] Created ${batches.length} AI batch(es) for ${objectsToAssess.length} object(s).`
    );

    for (
        let batchIndex = 0;
        batchIndex < batches.length;
        batchIndex++
    ) {
        const batch = batches[batchIndex];

        if (
            batchIndex > 0 &&
            config.interBatchDelayMs > 0
        ) {
            await this.sleep(
                config.interBatchDelayMs
            );
        }

        console.log(
            `[BUSINESS OBJECT ASSESSMENT] Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} object(s).`
        );

        try {
            const {
                assessments,
                usage
            } = await this.assessBatch(batch, assessmentInstructions, knownBusinessObjects);

            if (usage) {
                result.inputTokens +=
                    usage.prompt_tokens || 0;

                result.outputTokens +=
                    usage.completion_tokens || 0;

                result.totalTokens +=
                    usage.total_tokens || 0;
            }

            const assessmentMap = new Map();

            for (const assessment of assessments) {
                if (
                    assessment &&
                    assessment.sourceObject
                ) {
                    assessmentMap.set(
                        assessment.sourceObject
                            .trim()
                            .toLowerCase(),
                        assessment
                    );
                }
            }

            for (const context of batch) {
                const sourceObjectName =
                    context.sourceObject.objectName;

                const key =
                    sourceObjectName
                        .trim()
                        .toLowerCase();

                const assessment =
                    assessmentMap.get(key);

                if (!assessment) {
                    const error = new Error(
                        `AI did not return an assessment for source object '${sourceObjectName}'.`
                    );

                    console.error(
                        `[BUSINESS OBJECT ASSESSMENT] ${error.message}`
                    );

                    await this.persistFailedAssessment(
                        context,
                        error,
                        tx
                    );

                    result.objectsFailed++;

                    result.failures.push({
                        sourceObject: sourceObjectName,
                        reason: error.message
                    });

                    continue;
                }

                try {
                    const validated =
                        this.validateAssessmentResult(
                            assessment,
                            context
                        );

                    await this.persistAssessment(
                        context,
                        validated,
                        tx
                    );

                    result.objectsAssessed++;
                } catch (error) {
                    console.error(
                        `[BUSINESS OBJECT ASSESSMENT] Validation failed for '${sourceObjectName}'.`,
                        error
                    );

                    await this.persistFailedAssessment(
                        context,
                        error,
                        tx
                    );

                    result.objectsFailed++;

                    result.failures.push({
                        sourceObject: sourceObjectName,
                        reason: error.message
                    });
                }
            }
        } catch (error) {
            console.error(
                `[BUSINESS OBJECT ASSESSMENT] Batch ${batchIndex + 1} failed: ${error.message}`
            );

            for (const context of batch) {
                try {
                    await this.persistFailedAssessment(
                        context,
                        error,
                        tx
                    );
                } catch (persistError) {
                    console.error(
                        `[BUSINESS OBJECT ASSESSMENT] Failed to persist error for '${context.sourceObject.objectName}'.`,
                        persistError
                    );
                }

                result.objectsFailed++;

                result.failures.push({
                    sourceObject:
                        context.sourceObject.objectName,
                    reason: error.message
                });
            }

            const errMsg =
                String(
                    error.message || ""
                ).toLowerCase();

            const isRateLimit =
                errMsg.includes("429") ||
                errMsg.includes("rate-limited") ||
                errMsg.includes("quota");

            if (isRateLimit) {
                console.warn(
                    `[BUSINESS OBJECT ASSESSMENT] Halting remaining batches due to upstream rate limit. Progress has been saved.`
                );

                break;
            }
        }
    }

    console.log(
        `[BUSINESS OBJECT ASSESSMENT] Assessment completed. Assessed=${result.objectsAssessed}, Reused=${result.objectsReused}, Failed=${result.objectsFailed}.`
    );

    return result;
}

    async prepareObjectContext(sourceSystem, sourceObject, tx) {
        const sourceObjectName = sourceObject.objectName;

        const metadata = await tx.run(
            SELECT.one.from(SourceMetadata)
                .where({ sourceObject_ID: sourceObject.ID })
                .orderBy({ ref: ["createdAt"], sort: "desc" })
        );

        if (!metadata) {
            throw new Error(`No metadata found for source object '${sourceObjectName}'.`);
        }

        const fields = await tx.run(
            SELECT.from(SourceField)
                .where({ metadata_ID: metadata.ID })
                .orderBy("fieldName")
        );

        const metadataVersion = metadata.schemaVersion || this.createMetadataFingerprint(metadata, fields);

        const existingAssessment = await tx.run(
            SELECT.one.from(MigrationAssessment).where({
                sourceSystemId: sourceSystem.systemId,
                sourceObject: sourceObject.objectName,
                metadataVersion
            }).orderBy({ ref: ["createdAt"], sort: "desc" })
        );

        const assessmentInput = this.buildAssessmentInput(sourceSystem, sourceObject, metadata, fields);

        return {
            sourceSystem,
            sourceObject,
            metadata,
            fields,
            metadataVersion,
            existingAssessment,
            assessmentInput
        };
    }

    buildAssessmentInput(sourceSystem, sourceObject, metadata, fields) {
        return {
            sourceSystem: {
                id: sourceSystem.ID,
                name: sourceSystem.name || sourceSystem.systemName || sourceSystem.ID,
                adapterType: sourceSystem.adapterType,
                endpointReference: sourceSystem.endpointReference
            },
            sourceObject: {
                id: sourceObject.ID,
                name: sourceObject.objectName,
                description: sourceObject.description || null,
                objectType: sourceObject.objectType || null
            },
            metadata: {
                id: metadata.ID,
                schemaVersion: metadata.schemaVersion || null,
                metadataVersion: metadata.schemaVersion || null,
                description: metadata.description || null
            },
            fields: (fields || []).map(field => ({
                name: field.fieldName,
                description: field.description || null,
                dataType: field.dataType || null,
                length: field.length || null,
                precision: field.precision || null,
                scale: field.scale || null,
                nullable: field.nullable,
                key: field.isKey || field.key || false
            }))
        };
    }

    buildAssessmentBatches(contexts) {
        const configuration = this.getConfiguration();
        const batches = [];
        let currentBatch = [];
        let currentChars = 0;

        for (const context of contexts) {
            const serialized = JSON.stringify(context.assessmentInput);
            const objectChars = serialized.length;
            const exceedsObjectLimit = currentBatch.length >= configuration.maxObjectsPerBatch;
            const exceedsCharLimit = currentBatch.length > 0 && (currentChars + objectChars) > configuration.maxCharsPerBatch;

            if (exceedsObjectLimit || exceedsCharLimit) {
                batches.push(currentBatch);
                currentBatch = [];
                currentChars = 0;
            }

            currentBatch.push(context);
            currentChars += objectChars;
        }

        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }

        return batches;
    }

    async assessBatch(batch, assessmentInstructions = null, knownBusinessObjects = []) {
        const inputs = batch.map(context => context.assessmentInput);
        const prompt = this.buildBatchPrompt(
    inputs,
    assessmentInstructions,
    knownBusinessObjects
);
        const aiResponse = await this.generateAssessmentWithRetry(prompt);

        return {
            assessments: this.normalizeBatchResponse(aiResponse.data),
            usage: aiResponse.usage
        };
    }

    buildBatchPrompt(inputs, userInstructions = null, knownBusinessObjects = []) {

    const defaultInstructions = `
Classify each source API / source object into the correct
MIGRATION-LEVEL BUSINESS OBJECT.

The purpose of this classification is to GROUP related source APIs
that belong to the same primary business object so that they can
be migrated together.

============================================================
PRIMARY CLASSIFICATION PRINCIPLE
============================================================

The businessObject MUST represent the PRIMARY BUSINESS ENTITY or
PRIMARY TRANSACTION represented by the source object.

Do NOT classify an object based only on a field that references,
relates to, or is commonly used by another business object.

A referenced business object is NOT automatically the primary
business object.

For example:

- An object containing BusinessPartner does NOT automatically mean
  Business Partner.
- An object containing Customer does NOT automatically mean Customer.
- An object containing Supplier does NOT automatically mean Supplier.
- An object containing CompanyCode does NOT automatically mean
  Company Code.
- An object containing ControllingArea does NOT automatically mean
  Controlling Area.
- An object containing Material does NOT automatically mean Material.
- An object containing Plant does NOT automatically mean Plant.
- An object containing Bank does NOT automatically mean Business Partner.

Determine the primary business meaning from the source object as a
WHOLE.

Consider together:

- source object name
- object description
- metadata description
- object type
- complete set of fields
- field names
- field descriptions
- relationships represented by the fields

Do NOT use a single field as the sole basis for classification when
the overall object meaning indicates another business object.

============================================================
SUPPORTING OBJECTS
============================================================

Supporting, reference, code-list, role, industry, identification type,
address, status, category, relationship, hierarchy, and similar
dependent concepts should normally be assigned to the PRIMARY
BUSINESS OBJECT they support.

Examples:

Business Partner Role -> Business Partner
Business Partner Industry -> Business Partner
Business Partner Identification Type -> Business Partner
Business Partner Legal Form -> Business Partner

Customer Group -> Customer
Supplier Group -> Supplier
Material Plant Data -> Material

However, this rule applies ONLY when the source object is genuinely
a supporting object of that primary business object.

Do NOT force an unrelated technical or functional object into a
business object merely because one of its fields references that
business object.

============================================================
PRIMARY ENTITY VS REFERENCED ENTITY
============================================================

Always distinguish between:

1. PRIMARY ENTITY
   The business entity represented by the source object.

2. REFERENCED ENTITY
   Another business entity that appears as a field, key, relationship,
   association, or reference inside the source object.

The PRIMARY ENTITY determines "businessObject".

A REFERENCED ENTITY alone must NOT determine "businessObject".

Example:

Source object:
API_CNSLDTNCOSTCENTER

Fields:
- ControllingArea
- CostCenter
- CostCenterName

Primary entity:
Cost Center

businessObject:
Cost Center

NOT:
Business Partner
NOT:
Controlling Area

------------------------------------------------------------

Source object:
API_CABILLINGDOCUMENT

Fields:
- BillingDocument
- Customer
- CompanyCode
- SoldToParty

Primary entity:
Billing Document

businessObject:
Billing Document

NOT:
Business Partner
NOT:
Customer
NOT:
Company Code

------------------------------------------------------------

Source object:
API_BUSINESSPARTNERROLECODE

Fields:
- BusinessPartnerRole

Primary concept:
Business Partner Role

This is a supporting/reference concept of Business Partner.

businessObject:
Business Partner

------------------------------------------------------------

Source object:
API_BUSINESSPARTNERINDUSTRYKEY

Fields:
- BusinessPartnerIndustrySector
- IndustrySystemType

Primary concept:
Business Partner Industry

This is a supporting concept of Business Partner.

businessObject:
Business Partner

============================================================
WHEN TO CREATE A SEPARATE BUSINESS OBJECT
============================================================

Create a separate businessObject when the source object represents
a genuinely independent business entity, master-data object, or
transactional object.

Examples include concepts such as:

Business Partner
Customer
Supplier
Material
Cost Center
Controlling Area
Company Code
Billing Document
Sales Order
Purchase Order
Bank
Plant
Distribution Channel
Calendar

Do NOT create a separate businessObject merely because the object
contains a field referring to another business object.

============================================================
GROUPING PRINCIPLE
============================================================

Related APIs representing the same primary business entity MUST use
the SAME businessObject value.

For example:

Business Partner:
- Business Partner master
- Business Partner Role
- Business Partner Industry
- Business Partner Identification Type
- Business Partner Legal Form
- Business Partner relationship/supporting objects

Customer:
- Customer master
- Customer-specific supporting objects
- Customer Group, when it is a customer supporting concept

Material:
- Material master
- Material Plant Data
- Material-related supporting objects

Billing Document:
- Billing Document
- Billing Document supporting objects

Cost Center:
- Cost Center
- Cost Center hierarchy/supporting objects

Do not split semantically related APIs into separate business objects
when they represent the same migration entity.

============================================================
TECHNICAL OBJECTS
============================================================

Do not automatically classify technical framework, configuration,
monitoring, UI, infrastructure, API management, or system objects
as a business master-data object merely because they contain fields
such as:

- ID
- Description
- Name
- CompanyCode
- BusinessPartner
- Customer
- Material
- Country
- Language

If the source object is clearly technical rather than a business
entity, classify it according to its actual independent purpose.

Do not force technical objects into Business Partner, Customer,
Material, or another business object.

============================================================
MIGRATION-LEVEL BUSINESS OBJECT
============================================================

"businessObject" represents the object that a migration team would
typically plan, map, transform, validate, and migrate as a coherent
business entity or transaction.

It is NOT:

- a single field
- a database table name
- an OData entity name
- an API technical name
- a code value
- a technical configuration object
- a random referenced entity

============================================================
DECISION ORDER
============================================================

For every source object, determine the businessObject using this
order:

1. Identify the primary entity represented by the source object.

2. Check the source object name and description.

3. Check the metadata description and object type.

4. Examine the complete set of fields.

5. Determine whether fields describe the primary entity or merely
   reference another entity.

6. If the object is a supporting concept, attach it to its primary
   business object.

7. Only create a separate businessObject when the object represents
   an independent business entity or transaction.

8. Use the same businessObject name for all semantically related
   objects.

============================================================
`;

    // Known business objects (catalog) + an honest "Unclear" answer.
    // ASSESSMENT_PROMPT=legacy switches this off (to compare prompts).
    const useCatalogSection = process.env.ASSESSMENT_PROMPT !== "legacy";
    const known = (knownBusinessObjects || []).filter(Boolean);

    const catalogSection = !useCatalogSection ? "" : `
============================================================
KNOWN BUSINESS OBJECTS AND "UNCLEAR"
============================================================

${known.length > 0
    ? `Known migration business objects (prefer these exact names when the
object clearly represents one of them):

${known.map(name => "- " + name).join("\n")}

`
    : ""}If the source object represents a different primary business entity,
use that entity's normal business name.

If the metadata does not make the primary business object clear, or the
object is technical / UI / infrastructure, use exactly:

    "businessObject": "Unclear"

with a LOW confidence (below 50). An honest "Unclear" is better than a
wrong guess. Never use a known business object as a default.

`;

    const classificationInstructions =
        userInstructions && userInstructions.trim()
            ? userInstructions.trim()
            : defaultInstructions;

    return `
You are a Business Object Classification Engine for an enterprise
data migration framework.

Your task is to classify each source API / source object into the
correct MIGRATION-LEVEL BUSINESS OBJECT.

============================================================
USER-PROVIDED CLASSIFICATION INSTRUCTIONS
============================================================

${classificationInstructions}

============================================================
CRITICAL TECHNICAL RULES
============================================================

1. "sourceObject" MUST exactly match the input sourceObject name.

2. "businessObject" MUST represent the PRIMARY BUSINESS ENTITY or
   PRIMARY TRANSACTION represented by the source object.

3. A referenced field MUST NOT by itself determine the businessObject.

4. Do NOT classify an object as Business Partner merely because it
   contains a BusinessPartner field.

5. Do NOT classify an object as Customer merely because it contains
   a Customer field.

6. Do NOT classify an object as Supplier merely because it contains
   a Supplier field.

7. Do NOT classify an object as Company Code merely because it
   contains a CompanyCode field.

8. Do NOT classify an object as Controlling Area merely because it
   contains a ControllingArea field.

9. Do NOT classify an object as Material merely because it contains
   a Material field.

10. Do NOT classify an object as Plant merely because it contains
    a Plant field.

11. Determine classification from the source object as a whole,
    including its name, descriptions, object type and complete
    metadata.

12. Supporting/reference APIs should be assigned to the primary
    business object they support ONLY when the supplied metadata
    demonstrates that relationship.

13. Related APIs representing the same primary business entity MUST
    use the SAME businessObject value.

14. Do NOT create separate businessObjects for attributes, fields,
    roles, industries, identification types, addresses, statuses,
    categories, relationships, hierarchies, or code lists when they
    clearly belong to a primary business object.

15. Do NOT force unrelated technical objects into Business Partner,
    Customer, Material, or another business object.

16. Do NOT use technical API names, CDS names, OData entity names,
    service names, database table names, or endpoint names as the
    businessObject.

17. Do NOT invent a new businessObject when an existing migration-level
    business object clearly applies.

18. Use consistent businessObject naming across all source objects.

19. The same businessObject name MUST be reused for semantically
    related source objects.

============================================================
BUSINESS OBJECT VS COMPONENT
============================================================

"businessObject" = PRIMARY MIGRATION BUSINESS OBJECT.

"component" = functional/business area associated with that object.

Example:

{
    "businessObject": "Business Partner",
    "component": "Master Data"
}

or:

{
    "businessObject": "Sales Order",
    "component": "Sales"
}

Do NOT use "component" to create additional businessObject categories.

============================================================
EVIDENCE RULES
============================================================

Determine the classification ONLY from the supplied source metadata.

Use:

- source object name
- object description
- object type
- metadata description
- field names
- field descriptions
- data types
- relationships represented by the fields
- overall field pattern

IMPORTANT:

The existence of a single field is NOT sufficient evidence for
classifying the entire source object unless that field clearly
identifies the primary entity represented by the object.

"evidenceFields" MUST contain only fields that actually exist in the
supplied input.

Do not invent evidence fields.

============================================================
CONFIDENCE
============================================================

"confidence" MUST be an integer from 0 to 100.

Use high confidence only when the primary business meaning is clearly
supported by the supplied metadata.

Use lower confidence when:

- the object has ambiguous meaning
- the object is technical
- metadata is insufficient
- multiple business objects are possible
- the classification depends mainly on weak field references

Do NOT use 85 or 90 simply because the model found one matching field.

============================================================
SOURCE OBJECT PRESERVATION
============================================================

The "sourceObject" returned by the AI MUST exactly match the supplied
sourceObject name.

Do not modify it.
Do not normalize it.
Do not rename it.

============================================================
OUTPUT REQUIREMENTS
============================================================

Return exactly ONE assessment for EVERY supplied source object.

Do not omit source objects.

Do not create additional source objects.

Return raw JSON only.

Do not return markdown.

Do not return explanations outside the JSON.

============================================================
OUTPUT FORMAT
============================================================

{
    "assessments": [
        {
            "sourceObject": "EXACT_SOURCE_OBJECT_NAME",
            "businessObject": "MIGRATION_LEVEL_BUSINESS_OBJECT",
            "component": "BUSINESS_COMPONENT",
            "confidence": 85,
            "evidenceFields": [
                "FIELD1",
                "FIELD2"
            ],
            "reason": "Explanation based strictly on supplied metadata. Explain why this source object represents the selected primary business object and distinguish it from merely referenced business objects."
        }
    ]
}

${catalogSection}
============================================================
SOURCE OBJECTS TO ASSESS
============================================================

${JSON.stringify(inputs, null, 2)}

`;
}

    async generateAssessmentWithRetry(prompt) {
        const configuration = this.getConfiguration();
        let lastError;

        for (let attempt = 0; attempt <= configuration.maxRetries; attempt++) {
            try {
                console.log(`[BUSINESS OBJECT ASSESSMENT] AI request attempt ${attempt + 1}/${configuration.maxRetries + 1}.`);
                return await getAIProvider().generateJSON(prompt);
            } catch (error) {
                lastError = error;
                const status = error.status;
                const message = String(error.message || "").toLowerCase();

                const quotaError = message.includes("quota exceeded") ||
                    message.includes("daily quota") ||
                    message.includes("free_tier_requests");

                if (quotaError) {
                    console.error(`[BUSINESS OBJECT ASSESSMENT] Provider quota reached. Halting retries.`);
                    throw error;
                }

                const networkError = message.includes("fetch failed") ||
                    message.includes("econnreset") ||
                    message.includes("etimedout") ||
                    message.includes("socket hang up");

                const isRetryable = [429, 500, 502, 503, 504].includes(status) || message.includes("429") || networkError;

                if (!isRetryable || attempt >= configuration.maxRetries) {
                    throw error;
                }

                // Exponential backoff with jitter
                const baseDelay = configuration.retryBaseDelayMs * Math.pow(2, attempt);
                const jitter = Math.floor(Math.random() * 800);
                const delay = baseDelay + jitter;

                console.warn(`[BUSINESS OBJECT ASSESSMENT] Request failed (${status || error.message}). Backing off for ${delay}ms...`);
                await this.sleep(delay);
            }
        }

        throw lastError;
    }

    normalizeBatchResponse(response) {
        if (response && Array.isArray(response.assessments)) {
            return response.assessments;
        }
        if (Array.isArray(response)) {
            return response;
        }
        throw new Error("AI response does not contain a valid assessments array.");
    }

    validateAssessmentResult(result, context) {
        if (!result || typeof result !== "object") {
            throw new Error("AI assessment result must be an object.");
        }

        const expectedSourceObject = context.sourceObject.objectName;
        if (!result.sourceObject || result.sourceObject.trim() !== expectedSourceObject.trim()) {
            throw new Error(`AI returned sourceObject '${result.sourceObject}' but expected '${expectedSourceObject}'.`);
        }

        if (!result.businessObject || !result.businessObject.trim()) {
            throw new Error("AI assessment businessObject is required.");
        }

        const confidence = Number(result.confidence);
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
            throw new Error("Confidence must be a number between 0 and 100.");
        }

        // an object without fields (an M3 program on its own) is judged by its name and description:
        // the AI has no field to cite, so what it names as evidence is ignored and not checked
        const hasFields = (context.fields || []).length > 0;

        if (hasFields) {
            if (!Array.isArray(result.evidenceFields)) {
                throw new Error("evidenceFields must be an array.");
            }

            const availableFields = new Set((context.fields || []).map(f => String(f.fieldName)));
            for (const evidenceField of result.evidenceFields) {
                if (!availableFields.has(evidenceField)) {
                    throw new Error(`Evidence field '${evidenceField}' was not supplied in source metadata.`);
                }
            }
        } else {
            result = { ...result, evidenceFields: [] };
        }

        return {
            sourceObject: result.sourceObject.trim(),
            businessObject: result.businessObject.trim(),
            component: (result.component || "General").trim(),
            confidence,
            evidenceFields: result.evidenceFields.map(f => f.trim()),
            reason: (result.reason || "").trim()
        };
    }

    async persistAssessment(context, assessment, tx) {
        const { sourceObject, metadataVersion } = context;

        const existing = await tx.run(
            SELECT.one.from(MigrationAssessment).where({
                sourceSystemId: context.sourceSystem.systemId,
                sourceObject: sourceObject.objectName,
                metadataVersion
            })
        );

        const data = {
            sourceSystemId: context.sourceSystem.systemId,
            sourceObject: sourceObject.objectName,
            metadataVersion,
            businessObject: assessment.businessObject,
            component: assessment.component,
            confidence: assessment.confidence,
            evidenceFields: JSON.stringify(assessment.evidenceFields),
            reason: assessment.reason,
            status: "COMPLETED",
            errorMessage: null
        };

        if (existing) {
            await tx.run(UPDATE(MigrationAssessment).set(data).where({ ID: existing.ID }));
        } else {
            await tx.run(INSERT.into(MigrationAssessment).entries(data));
        }

        console.log(`[BUSINESS OBJECT ASSESSMENT] Persisted successful assessment for '${sourceObject.objectName}'.`);
    }

    async persistFailedAssessment(context, error, tx) {
        const { sourceObject, metadataVersion } = context;
        const errorMessage = String(error?.message || error || "Unknown assessment error").substring(0, 5000);

        const existing = await tx.run(
            SELECT.one.from(MigrationAssessment).where({
                sourceSystemId: context.sourceSystem.systemId,
                sourceObject: sourceObject.objectName,
                metadataVersion: metadataVersion || null
            })
        );

        const data = {
            sourceSystemId: context.sourceSystem.systemId,
            sourceObject: sourceObject.objectName,
            metadataVersion: metadataVersion || null,
            businessObject: null,
            component: null,
            confidence: null,
            evidenceFields: null,
            reason: errorMessage,
            status: "FAILED",
            errorMessage
        };

        if (existing) {
            await tx.run(UPDATE(MigrationAssessment).set(data).where({ ID: existing.ID }));
        } else {
            await tx.run(INSERT.into(MigrationAssessment).entries(data));
        }

        console.error(`[BUSINESS OBJECT ASSESSMENT] Persisted failed assessment for '${sourceObject.objectName}'.`);
    }

    createMetadataFingerprint(metadata, fields) {
        const normalized = {
            id: metadata.ID || null,
            fields: (fields || []).map(f => f.fieldName).sort()
        };
        const str = JSON.stringify(normalized);
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return "FP-" + Math.abs(hash).toString(16);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = new BusinessObjectAssessmentService();