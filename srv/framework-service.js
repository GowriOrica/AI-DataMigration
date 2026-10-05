const cds = require("@sap/cds");

// Use the query API of this project's CAP instance explicitly - the global
// SELECT/INSERT/... may belong to another (e.g. globally installed) cds copy
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

const { createSourceAdapter } = require("./adapters/SourceAdapterFactory");
const { buildSourceModel } = require("./model/SourceModelBuilder");
const { proposeKeyJoins } = require("./model/KeyJoinProposer");
const { tagFields, HIGH_CONFIDENCE } = require("./model/tagging/RuleBasedTagger");
const { tagFieldsWithAi } = require("./model/tagging/AiTagger");
const { buildModelView } = require("./engine/ModelView");
const { suggestMappings } = require("./engine/MappingSuggester");
const {
    compileMappingSet,
    transformInstance,
    documentToInstance,
    toStructureRows
} = require("./engine/TransformationEngine");
const { assembleInstances } = require("./engine/InstanceAssembler");
const { getStorage } = require("./lib/storage");
const zlib = require("zlib");

const {
    BusinessObjectType,
    BusinessObjectModel,
    Structure,
    Relationship,
    Field,
    SemanticTag,
    MappingSet,
    StructureMapping,
    FieldMapping,
    ValueMapping,
    PreviewRun,
    PreviewIssue,
    PreviewRow,
    PreviewDocument
} = cds.entities("migration.framework");

/**
 * Readable one-line summary of a row / document for list display:
 * "KUNNR=C1001 · NAME1=Northern Quarry · CITY1=Mackay"
 */
function summarize(record, maxLength = 2000) {
    const text = Object.entries(record)
        .filter(([, value]) => value !== null && value !== undefined && value !== "" && !Array.isArray(value))
        .map(([name, value]) => `${name}=${value}`)
        .join(" · ");

    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

const MODEL_LAYERS = ["SOURCE", "CANONICAL", "TARGET"];
const STRUCTURE_PATTERNS = ["ONE_TO_ONE", "JOIN", "EXPLODE", "PICK", "AGGREGATE", "PIVOT", "FILTER", "DERIVE"];
const RULE_TYPES = ["DIRECT", "CONSTANT", "DEFAULT", "SPLIT", "CONCAT", "VALUE_MAP", "FLAG", "CONDITIONAL"];

const parseJson = (text, what) => {
    if (text === null || text === undefined || text === "") {
        return null;
    }

    try {
        return typeof text === "string" ? JSON.parse(text) : text;
    } catch (error) {
        throw new StatusError(400, `${what} must be valid JSON: ${error.message}`);
    }
};

const TAGGING_ENGINES = ["RULES", "AI", "AI_WITH_RULES"];

/**
 * The AI provider is created only when AI tagging is requested, so the
 * service works without any AI configuration (e.g. on a BTP trial).
 */
function createAiProvider() {
    const { createAIProvider } = require("./lib/ai/AIProviderFactory");

    return createAIProvider();
}

const {
    SourceSystem,
    SourceConnection,
    SourceObject
} = cds.entities("migration.orchestrator");

/**
 * Error with an HTTP status, raised by shared helpers and turned
 * into req.reject() by the handlers.
 */
class StatusError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const rejectWith = (req, error) =>
    req.reject(error instanceof StatusError ? error.status : 500, error.message);

/**
 * Active source system + its single connected connection + adapter.
 */
async function adapterForSystem(sourceSystemId) {
    const sourceSystem = await SELECT.one
        .from(SourceSystem)
        .where({ systemId: sourceSystemId, active: true });

    if (!sourceSystem) {
        throw new StatusError(404, `Active source system '${sourceSystemId}' was not found`);
    }

    const connections = await SELECT
        .from(SourceConnection)
        .where({ sourceSystem_ID: sourceSystem.ID, status: "CONNECTED" });

    if (connections.length !== 1) {
        throw new StatusError(
            400,
            `Expected exactly one connected source connection for '${sourceSystemId}', found ${connections.length}. Run testSourceConnection first.`
        );
    }

    try {
        return {
            sourceSystem,
            connection: connections[0],
            adapter: createSourceAdapter({
                ...connections[0],
                systemId: sourceSystem.systemId,
                systemName: sourceSystem.systemName,
                systemType: sourceSystem.systemType
            })
        };
    } catch (error) {
        throw new StatusError(400, error.message);
    }
}

module.exports = cds.service.impl(async function () {

    /**
     * Next version of a model (type + layer + system).
     * The latest DRAFT is replaced; after an APPROVED model a new version is created.
     */
    async function nextModelVersion(typeCode, layer, systemId) {
        const existing = await SELECT
            .from(BusinessObjectModel)
            .where({ type_code: typeCode, layer, systemId: systemId || null });

        const latest = existing.sort(
            (left, right) => Number(right.version) - Number(left.version)
        )[0];

        // A draft that mapping sets already refer to is kept; it gets a successor version
        const referenced = latest && (
            (await SELECT.one.from(MappingSet).where({ fromModel_ID: latest.ID })) ||
            (await SELECT.one.from(MappingSet).where({ toModel_ID: latest.ID }))
        );

        if (latest && latest.status === "DRAFT" && !referenced) {
            await deleteModel(latest.ID);
            return latest.version;
        }

        return latest ? String(Number(latest.version) + 1) : "1";
    }

    /**
     * ============================================================
     * BUILD SOURCE MODEL
     * ============================================================
     *
     * Source metadata (entity graph)  ->  BusinessObjectModel (SOURCE)
     */
    this.on("buildSourceModel", async (req) => {

        const {
            sourceSystemId,
            sourceObject,
            relatedObjects,
            businessObjectType,
            rootEntity,
            maxDepth
        } = req.data;

        if (!sourceSystemId || !sourceObject || !businessObjectType) {
            return req.reject(
                400,
                "sourceSystemId, sourceObject and businessObjectType are required"
            );
        }

        const type = await SELECT.one
            .from(BusinessObjectType)
            .where({ code: businessObjectType });

        if (!type) {
            return req.reject(404, `Business object type '${businessObjectType}' is not in the catalog`);
        }

        let sourceSystem;
        let connection;
        let adapter;

        try {
            ({ sourceSystem, connection, adapter } = await adapterForSystem(sourceSystemId));
        } catch (error) {
            return rejectWith(req, error);
        }

        let graph;

        try {
            graph = await adapter.getRelationships(sourceObject, relatedObjects || []);
        } catch (error) {
            return req.reject(502, `Relationship discovery failed: ${error.message}`);
        }

        if (!graph) {
            return req.reject(
                422,
                `Source adapter '${connection.adapterType}' cannot describe '${sourceObject}'.`
            );
        }

        /*
         * Sources without declared relationships (e.g. M3):
         * propose links from key overlap - to be confirmed by a person.
         * (Increment 4: AI model assembly replaces / enriches this.)
         */
        if (graph.relationshipsDeclared === false) {
            graph = proposeKeyJoins(graph).graph;
        }

        const version = await nextModelVersion(businessObjectType, "SOURCE", sourceSystemId);

        const discoveredObject = await SELECT.one
            .from(SourceObject)
            .where({ sourceSystem_ID: sourceSystem.ID, objectName: sourceObject });

        let built;

        try {
            built = buildSourceModel(graph, {
                businessObjectType,
                systemId: sourceSystemId,
                modelName: `${sourceSystem.systemName || sourceSystemId} ${type.name}`,
                version,
                rootEntitySet: rootEntity || null,
                maxDepth,
                sourceObjectId: discoveredObject?.ID || null
            });
        } catch (error) {
            return req.reject(422, error.message);
        }

        await INSERT.into(BusinessObjectModel).entries(built.model);
        await INSERT.into(Structure).entries(built.structures);

        if (built.relationships.length > 0) {
            await INSERT.into(Relationship).entries(built.relationships);
        }

        if (built.fields.length > 0) {
            await INSERT.into(Field).entries(built.fields);
        }

        const { stats } = built;

        return {
            modelId: built.model.ID,
            name: built.model.name,
            version,
            rootStructure: stats.rootEntitySet,
            structureCount: stats.structureCount,
            relationshipCount: stats.relationshipCount,
            fieldCount: stats.fieldCount,
            inferredJoinCount: stats.inferredJoins,
            proposedJoinCount: stats.proposedJoins,
            missingJoinCount: stats.missingJoins,
            reviewRequired:
                stats.inferredJoins + stats.proposedJoins + stats.missingJoins > 0,
            message:
                `Source model '${built.model.name}' v${version} built from '${graph.objectName}': ` +
                `${stats.structureCount} structure(s), ${stats.relationshipCount} relationship(s), ` +
                `${stats.fieldCount} field(s). Join keys inferred by name: ${stats.inferredJoins}, ` +
                `proposed by key overlap: ${stats.proposedJoins}, missing: ${stats.missingJoins}.`
        };
    });

    /**
     * ============================================================
     * TAG MODEL FIELDS
     * ============================================================
     */
    this.on("tagModelFields", async (req) => {

        const { modelId, overwrite } = req.data;
        const engine = String(
            req.data.engine || process.env.TAGGING_ENGINE || "RULES"
        ).toUpperCase();

        if (!modelId) {
            return req.reject(400, "modelId is required");
        }

        if (!TAGGING_ENGINES.includes(engine)) {
            return req.reject(400, `engine must be one of ${TAGGING_ENGINES.join(", ")}`);
        }

        const model = await SELECT.one.from(BusinessObjectModel).where({ ID: modelId });

        if (!model) {
            return req.reject(404, `Business object model '${modelId}' was not found`);
        }

        const structures = await SELECT.from(Structure).where({ model_ID: modelId });
        const structureName = new Map(structures.map(s => [s.ID, s.name]));

        const allFields = structures.length > 0
            ? await SELECT.from(Field).where({ structure_ID: { in: structures.map(s => s.ID) } })
            : [];

        const fields = allFields
            .filter(field => overwrite || field.tagStatus !== "APPROVED")
            .map(field => ({ ...field, structureName: structureName.get(field.structure_ID) }));

        const tags = await SELECT.from(SemanticTag);

        /*
         * ---------- Run the engine(s) ----------
         */
        const ruleResults = new Map(
            tagFields(fields, tags).map(result => [result.fieldId, result])
        );

        let aiResults = new Map();
        let aiUsed = false;
        let aiDiscarded = 0;
        let aiNote = "";

        if (engine !== "RULES" && fields.length > 0) {
            try {
                const ai = await tagFieldsWithAi(fields, tags, createAiProvider());

                aiResults = new Map(ai.results.map(result => [result.fieldId, result]));
                aiUsed = true;
                aiDiscarded = ai.discarded;
                aiNote = ` AI (${ai.promptVersion}) tagged ${ai.results.filter(r => r.tag).length} field(s), discarded ${ai.discarded} invalid answer(s).`;
            } catch (error) {
                if (engine === "AI") {
                    return req.reject(502, `AI tagging failed: ${error.message}`);
                }

                aiNote = ` AI unavailable (${error.message}) - rule-based tagging used for all fields.`;
            }
        }

        const pick = (fieldId) => {
            const rules = ruleResults.get(fieldId);
            const ai = aiResults.get(fieldId);

            if (engine === "RULES") {
                return rules;
            }

            if (engine === "AI") {
                return ai || { tag: null, confidence: 0, origin: "AI", reason: "No AI answer for this field" };
            }

            // AI_WITH_RULES
            if (ai && ai.tag) {
                return rules && rules.tag === ai.tag
                    ? { ...ai, confidence: Math.max(ai.confidence, rules.confidence), reason: `${ai.reason || ""} (confirmed by rules)`.trim() }
                    : ai;
            }

            return rules;
        };

        /*
         * ---------- Persist ----------
         */
        let tagged = 0;
        let highConfidence = 0;

        for (const field of fields) {
            const result = pick(field.ID);

            await UPDATE(Field)
                .set({
                    semanticTag_code: result.tag,
                    tagConfidence: result.tag ? result.confidence : null,
                    tagOrigin: result.origin,
                    tagReason: result.reason,
                    tagStatus: "SUGGESTED"
                })
                .where({ ID: field.ID });

            if (result.tag) {
                tagged++;

                if (result.confidence >= HIGH_CONFIDENCE) {
                    highConfidence++;
                }
            }
        }

        const untagged = fields.length - tagged;
        const reviewRequired = tagged - highConfidence;

        return {
            modelId,
            engine,
            fieldCount: allFields.length,
            tagged,
            highConfidence,
            reviewRequired,
            untagged,
            skippedApproved: allFields.length - fields.length,
            aiUsed,
            aiDiscarded,
            message:
                `Tagged ${tagged} of ${fields.length} field(s) of '${model.name}' v${model.version}: ` +
                `${highConfidence} high confidence, ${reviewRequired} need review, ${untagged} untagged.` +
                aiNote
        };
    });


    /**
     * ============================================================
     * SEMANTIC ALIGNMENT
     * ============================================================
     *
     * For one business object type: which field of which model
     * carries which meaning.
     */
    this.on("getSemanticAlignment", async (req) => {

        const { businessObjectType } = req.data;

        if (!businessObjectType) {
            return req.reject(400, "businessObjectType is required");
        }

        const models = await SELECT
            .from(BusinessObjectModel)
            .where({ type_code: businessObjectType });

        if (models.length === 0) {
            return req.reject(404, `No models found for business object type '${businessObjectType}'`);
        }

        const modelLabel = new Map(
            models.map(m => [m.ID, m.layer === "CANONICAL" ? "CANONICAL" : `${m.layer}:${m.systemId}`])
        );

        const structures = await SELECT
            .from(Structure)
            .where({ model_ID: { in: models.map(m => m.ID) } });

        const structureById = new Map(structures.map(s => [s.ID, s]));

        const fields = structures.length > 0
            ? await SELECT.from(Field).where({ structure_ID: { in: structures.map(s => s.ID) } })
            : [];

        const tags = await SELECT.from(SemanticTag);
        const tagOrder = new Map(tags.map((tag, index) => [tag.code, index]));
        const tagDescription = new Map(tags.map(tag => [tag.code, tag.description]));

        const alignment = new Map();
        const untagged = {};

        for (const field of fields) {
            const structure = structureById.get(field.structure_ID);
            const label = modelLabel.get(structure.model_ID);
            const entry = {
                structure: structure.name,
                field: field.name,
                description: field.description,
                confidence: field.tagConfidence === null ? null : Number(field.tagConfidence),
                origin: field.tagOrigin,
                status: field.tagStatus
            };

            if (!field.semanticTag_code) {
                (untagged[label] = untagged[label] || []).push(`${structure.name}.${field.name}`);
                continue;
            }

            if (!alignment.has(field.semanticTag_code)) {
                alignment.set(field.semanticTag_code, {
                    tag: field.semanticTag_code,
                    description: tagDescription.get(field.semanticTag_code),
                    byModel: {}
                });
            }

            const byModel = alignment.get(field.semanticTag_code).byModel;

            (byModel[label] = byModel[label] || []).push(entry);
        }

        const ordered = [...alignment.values()].sort(
            (left, right) => (tagOrder.get(left.tag) ?? 999) - (tagOrder.get(right.tag) ?? 999)
        );

        return {
            businessObjectType,
            models: JSON.stringify(
                models.map(m => ({ id: m.ID, label: modelLabel.get(m.ID), name: m.name, version: m.version, status: m.status }))
            ),
            tagCount: ordered.length,
            alignment: JSON.stringify(ordered),
            untagged: JSON.stringify(untagged)
        };
    });

    /**
     * ============================================================
     * SHARED LOADERS
     * ============================================================
     */
    async function loadModelView(modelId) {
        const model = await SELECT.one.from(BusinessObjectModel).where({ ID: modelId });

        if (!model) {
            throw new StatusError(404, `Business object model '${modelId}' was not found`);
        }

        const structures = await SELECT.from(Structure).where({ model_ID: modelId });
        const relationships = await SELECT.from(Relationship).where({ model_ID: modelId });
        const fields = structures.length > 0
            ? await SELECT.from(Field).where({ structure_ID: { in: structures.map(s => s.ID) } })
            : [];

        return buildModelView({ model, structures, relationships, fields });
    }

    async function loadDraftSet(mappingSetId) {
        const set = await SELECT.one.from(MappingSet).where({ ID: mappingSetId });

        if (!set) {
            throw new StatusError(404, `Mapping set '${mappingSetId}' was not found`);
        }

        if (set.status !== "DRAFT") {
            throw new StatusError(409, `Mapping set v${set.version} is ${set.status} and cannot be changed`);
        }

        return set;
    }

    /**
     * Mapping set rows -> plain mappings with structure / field names
     * (input format of the engine).
     */
    async function loadMappings(set, toView) {
        const structureMappings = await SELECT.from(StructureMapping).where({ mappingSet_ID: set.ID });
        const fieldMappings = structureMappings.length > 0
            ? await SELECT.from(FieldMapping).where({ structureMapping_ID: { in: structureMappings.map(sm => sm.ID) } })
            : [];

        const fieldName = new Map(
            toView.structures.flatMap(structure => structure.fields.map(field => [field.ID, field.name]))
        );

        return structureMappings.map(sm => ({
            ID: sm.ID,
            toStructure: toView.byId.get(sm.toStructure_ID)?.name,
            fromStructures: parseJson(sm.fromStructures, "fromStructures") || [],
            pattern: sm.pattern,
            patternConfig: parseJson(sm.patternConfig, "patternConfig") || {},
            status: sm.status,
            fieldMappings: fieldMappings
                .filter(fm => fm.structureMapping_ID === sm.ID)
                .map(fm => ({
                    ID: fm.ID,
                    toField: fieldName.get(fm.toField_ID),
                    fromFields: parseJson(fm.fromFields, "fromFields") || [],
                    rule: parseJson(fm.rule, "rule"),
                    status: fm.status
                }))
        }));
    }


    /**
     * ============================================================
     * IMPORT MODEL
     * ============================================================
     */
    this.on("importModel", async (req) => {
        try {
            const definition = parseJson(req.data.definition, "definition");

            if (!definition || !Array.isArray(definition.structures) || definition.structures.length === 0) {
                throw new StatusError(400, "definition must contain at least one structure");
            }

            const { businessObjectType, layer, name } = definition;
            const systemId = layer === "CANONICAL" ? null : definition.systemId;

            if (!MODEL_LAYERS.includes(layer)) {
                throw new StatusError(400, `layer must be one of ${MODEL_LAYERS.join(", ")}`);
            }

            if (!name || (layer !== "CANONICAL" && !systemId)) {
                throw new StatusError(400, "name (and systemId for SOURCE/TARGET models) is required");
            }

            if (!(await SELECT.one.from(BusinessObjectType).where({ code: businessObjectType }))) {
                throw new StatusError(404, `Business object type '${businessObjectType}' is not in the catalog`);
            }

            const roots = definition.structures.filter(structure => !structure.parent);
            const names = new Set(definition.structures.map(structure => structure.name));

            if (roots.length !== 1) {
                throw new StatusError(400, `Exactly one root structure (without parent) is required, found ${roots.length}`);
            }

            const unknownParent = definition.structures.find(s => s.parent && !names.has(s.parent));

            if (unknownParent) {
                throw new StatusError(400, `Structure '${unknownParent.name}' has unknown parent '${unknownParent.parent}'`);
            }

            const tagCodes = new Set((await SELECT.from(SemanticTag).columns("code")).map(tag => tag.code));
            const version = await nextModelVersion(businessObjectType, layer, systemId);
            const modelId = cds.utils.uuid();
            const structureIds = new Map(definition.structures.map(s => [s.name, cds.utils.uuid()]));

            const structures = definition.structures.map((structure, index) => ({
                ID: structureIds.get(structure.name),
                model_ID: modelId,
                name: structure.name,
                isRoot: !structure.parent,
                sortOrder: index + 1,
                description: structure.description || null
            }));

            const relationships = definition.structures
                .filter(structure => structure.parent)
                .map(structure => ({
                    ID: cds.utils.uuid(),
                    model_ID: modelId,
                    parent_ID: structureIds.get(structure.parent),
                    child_ID: structureIds.get(structure.name),
                    cardinality: structure.cardinality || "0..N",
                    kind: "EMBEDDED",
                    joinKeys: null
                }));

            const fields = definition.structures.flatMap(structure =>
                (structure.fields || []).map((field, index) => {
                    if (field.semanticTag && !tagCodes.has(field.semanticTag)) {
                        throw new StatusError(400, `Field '${structure.name}.${field.name}' uses unknown semantic tag '${field.semanticTag}'`);
                    }

                    return {
                        ID: cds.utils.uuid(),
                        structure_ID: structureIds.get(structure.name),
                        name: field.name,
                        sortOrder: index + 1,
                        description: field.description || null,
                        dataType: field.dataType || null,
                        length: field.length ?? null,
                        precision: field.precision ?? null,
                        scale: field.scale ?? null,
                        isKey: field.isKey === true,
                        mandatory: field.mandatory === true || field.isKey === true,
                        semanticTag_code: field.semanticTag || null,
                        tagConfidence: field.semanticTag ? 100 : null,
                        tagOrigin: field.semanticTag ? "MANUAL" : null,
                        tagReason: field.semanticTag ? "Imported with the model definition" : null,
                        tagStatus: field.semanticTag ? "SUGGESTED" : null
                    };
                })
            );

            await INSERT.into(BusinessObjectModel).entries({
                ID: modelId,
                type_code: businessObjectType,
                layer,
                systemId,
                name,
                version,
                status: "DRAFT",
                origin: "IMPORTED",
                description: definition.description || null
            });
            await INSERT.into(Structure).entries(structures);

            if (relationships.length > 0) {
                await INSERT.into(Relationship).entries(relationships);
            }

            if (fields.length > 0) {
                await INSERT.into(Field).entries(fields);
            }

            return {
                modelId,
                name,
                version,
                rootStructure: roots[0].name,
                structureCount: structures.length,
                relationshipCount: relationships.length,
                fieldCount: fields.length,
                inferredJoinCount: 0,
                proposedJoinCount: 0,
                missingJoinCount: 0,
                reviewRequired: false,
                message: `Imported ${layer} model '${name}' v${version}: ${structures.length} structure(s), ${fields.length} field(s).`
            };
        } catch (error) {
            return rejectWith(req, error);
        }
    });


    /**
     * ============================================================
     * SUGGEST MAPPINGS
     * ============================================================
     */
    this.on("suggestMappings", async (req) => {
        try {
            const { fromModelId, toModelId } = req.data;

            const from = await loadModelView(fromModelId);
            const to = await loadModelView(toModelId);

            const hop =
                from.model.layer === "SOURCE" && to.model.layer === "CANONICAL" ? "SOURCE_TO_CANONICAL" :
                from.model.layer === "CANONICAL" && to.model.layer === "TARGET" ? "CANONICAL_TO_TARGET" :
                null;

            if (!hop) {
                throw new StatusError(400, `Mappings go SOURCE -> CANONICAL or CANONICAL -> TARGET, not ${from.model.layer} -> ${to.model.layer}`);
            }

            if (from.model.type_code !== to.model.type_code) {
                throw new StatusError(400, "Both models must describe the same business object type");
            }

            const tags = await SELECT.from(SemanticTag);
            const result = suggestMappings({ from, to, tags, hop });

            const previous = await SELECT.from(MappingSet).where({ fromModel_ID: fromModelId, toModel_ID: toModelId });
            const version = String(previous.length + 1);
            const mappingSetId = cds.utils.uuid();

            await INSERT.into(MappingSet).entries({
                ID: mappingSetId,
                fromModel_ID: fromModelId,
                toModel_ID: toModelId,
                hop,
                version,
                status: "DRAFT",
                coverage: JSON.stringify(result.coverage)
            });

            const structureRows = [];
            const fieldRows = [];

            for (const mapping of result.structureMappings) {
                const structureMappingId = cds.utils.uuid();

                structureRows.push({
                    ID: structureMappingId,
                    mappingSet_ID: mappingSetId,
                    toStructure_ID: mapping.toStructureId,
                    fromStructures: JSON.stringify(mapping.fromStructures),
                    pattern: mapping.pattern,
                    patternConfig: JSON.stringify(mapping.patternConfig),
                    confidence: mapping.confidence,
                    reason: mapping.reason,
                    status: "SUGGESTED"
                });

                for (const fieldMapping of mapping.fieldMappings) {
                    fieldRows.push({
                        ID: cds.utils.uuid(),
                        structureMapping_ID: structureMappingId,
                        toField_ID: fieldMapping.toFieldId,
                        fromFields: JSON.stringify(fieldMapping.fromFields),
                        rule: JSON.stringify(fieldMapping.rule),
                        confidence: fieldMapping.confidence,
                        reason: fieldMapping.reason,
                        origin: "HEURISTIC",
                        status: "SUGGESTED"
                    });
                }
            }

            if (structureRows.length > 0) {
                await INSERT.into(StructureMapping).entries(structureRows);
            }

            if (fieldRows.length > 0) {
                await INSERT.into(FieldMapping).entries(fieldRows);
            }

            const unmappedMandatory = result.coverage.unmappedFields.filter(field => field.mandatory).length;

            return {
                mappingSetId,
                hop,
                version,
                structureMappings: structureRows.length,
                fieldMappings: fieldRows.length,
                unmappedStructures: result.coverage.unmappedStructures.length,
                unmappedMandatory,
                coverage: JSON.stringify(result.coverage),
                message:
                    `Suggested ${structureRows.length} structure mapping(s) and ${fieldRows.length} field mapping(s) ` +
                    `(${from.model.name} -> ${to.model.name}). Open for the functional team: ` +
                    `${result.coverage.unmappedStructures.length} unmapped structure(s), ${unmappedMandatory} unmapped mandatory field(s).`
            };
        } catch (error) {
            return rejectWith(req, error);
        }
    });


    /**
     * ============================================================
     * FUNCTIONAL TEAM: CHANGE / REVIEW / APPROVE
     * ============================================================
     */
    this.on("upsertStructureMapping", async (req) => {
        try {
            const { mappingSetId, toStructure, fromStructures, pattern } = req.data;
            const patternConfig = parseJson(req.data.patternConfig, "patternConfig") || {};

            const set = await loadDraftSet(mappingSetId);
            const from = await loadModelView(set.fromModel_ID);
            const to = await loadModelView(set.toModel_ID);

            const target = to.byName.get(toStructure);

            if (!target) {
                throw new StatusError(404, `Target structure '${toStructure}' does not exist`);
            }

            if (!STRUCTURE_PATTERNS.includes(pattern)) {
                throw new StatusError(400, `pattern must be one of ${STRUCTURE_PATTERNS.join(", ")}`);
            }

            const unknown = (fromStructures || []).find(name => !from.byName.has(name));

            if (unknown) {
                throw new StatusError(404, `Source structure '${unknown}' does not exist`);
            }

            const fromJson = JSON.stringify(fromStructures || []);
            const existing = (await SELECT.from(StructureMapping).where({ mappingSet_ID: set.ID, toStructure_ID: target.ID }))
                .find(sm => sm.fromStructures === fromJson);

            if (existing) {
                await UPDATE(StructureMapping)
                    .set({ pattern, patternConfig: JSON.stringify(patternConfig), status: "MODIFIED" })
                    .where({ ID: existing.ID });

                return { ID: existing.ID, status: "MODIFIED", message: `Structure mapping for '${toStructure}' changed` };
            }

            const ID = cds.utils.uuid();

            await INSERT.into(StructureMapping).entries({
                ID,
                mappingSet_ID: set.ID,
                toStructure_ID: target.ID,
                fromStructures: fromJson,
                pattern,
                patternConfig: JSON.stringify(patternConfig),
                confidence: null,
                reason: `Added by ${req.user?.id || "functional team"}`,
                status: "APPROVED"
            });

            return { ID, status: "APPROVED", message: `Structure mapping for '${toStructure}' added` };
        } catch (error) {
            return rejectWith(req, error);
        }
    });

    this.on("upsertFieldMapping", async (req) => {
        try {
            const { structureMappingId, toField } = req.data;
            const fromFields = parseJson(req.data.fromFields, "fromFields") || [];
            const rule = parseJson(req.data.rule, "rule");

            const structureMapping = await SELECT.one.from(StructureMapping).where({ ID: structureMappingId });

            if (!structureMapping) {
                throw new StatusError(404, `Structure mapping '${structureMappingId}' was not found`);
            }

            const set = await loadDraftSet(structureMapping.mappingSet_ID);
            const from = await loadModelView(set.fromModel_ID);
            const to = await loadModelView(set.toModel_ID);

            const targetField = to.byId.get(structureMapping.toStructure_ID)?.fields.find(field => field.name === toField);

            if (!targetField) {
                throw new StatusError(404, `Target field '${toField}' does not exist in the target structure`);
            }

            if (!rule || !RULE_TYPES.includes(rule.type)) {
                throw new StatusError(400, `rule.type must be one of ${RULE_TYPES.join(", ")}`);
            }

            for (const source of fromFields) {
                const exists = from.byName.get(source.structure)?.fields.some(field => field.name === source.field);

                if (!exists) {
                    throw new StatusError(404, `Source field '${source.structure}.${source.field}' does not exist`);
                }
            }

            const values = {
                fromFields: JSON.stringify(fromFields),
                rule: JSON.stringify(rule),
                origin: "MANUAL",
                approvedBy: req.user?.id || null,
                approvedAt: new Date().toISOString()
            };

            const existing = await SELECT.one
                .from(FieldMapping)
                .where({ structureMapping_ID: structureMappingId, toField_ID: targetField.ID });

            if (existing) {
                await UPDATE(FieldMapping)
                    .set({ ...values, status: "MODIFIED", reason: `Changed by ${req.user?.id || "functional team"}` })
                    .where({ ID: existing.ID });

                return { ID: existing.ID, status: "MODIFIED", message: `Field mapping for '${toField}' changed` };
            }

            const ID = cds.utils.uuid();

            await INSERT.into(FieldMapping).entries({
                ID,
                structureMapping_ID: structureMappingId,
                toField_ID: targetField.ID,
                ...values,
                confidence: null,
                reason: `Added by ${req.user?.id || "functional team"}`,
                status: "APPROVED"
            });

            return { ID, status: "APPROVED", message: `Field mapping for '${toField}' added` };
        } catch (error) {
            return rejectWith(req, error);
        }
    });

    this.on("reviewMapping", async (req) => {
        try {
            const { structureMappingId, fieldMappingId, status } = req.data;

            if (!["APPROVED", "REJECTED"].includes(status)) {
                throw new StatusError(400, "status must be APPROVED or REJECTED");
            }

            if (!structureMappingId === !fieldMappingId) {
                throw new StatusError(400, "Provide either structureMappingId or fieldMappingId");
            }

            if (fieldMappingId) {
                const fieldMapping = await SELECT.one.from(FieldMapping).where({ ID: fieldMappingId });

                if (!fieldMapping) {
                    throw new StatusError(404, `Field mapping '${fieldMappingId}' was not found`);
                }

                const structureMapping = await SELECT.one.from(StructureMapping).where({ ID: fieldMapping.structureMapping_ID });

                await loadDraftSet(structureMapping.mappingSet_ID);
                await UPDATE(FieldMapping)
                    .set({ status, approvedBy: req.user?.id || null, approvedAt: new Date().toISOString() })
                    .where({ ID: fieldMappingId });

                return { ID: fieldMappingId, status, message: `Field mapping ${status.toLowerCase()}` };
            }

            const structureMapping = await SELECT.one.from(StructureMapping).where({ ID: structureMappingId });

            if (!structureMapping) {
                throw new StatusError(404, `Structure mapping '${structureMappingId}' was not found`);
            }

            await loadDraftSet(structureMapping.mappingSet_ID);
            await UPDATE(StructureMapping).set({ status }).where({ ID: structureMappingId });

            return { ID: structureMappingId, status, message: `Structure mapping ${status.toLowerCase()}` };
        } catch (error) {
            return rejectWith(req, error);
        }
    });

    this.on("approveMappingSet", async (req) => {
        try {
            const { mappingSetId, approvePending } = req.data;
            const set = await loadDraftSet(mappingSetId);

            const structureMappings = await SELECT.from(StructureMapping).where({ mappingSet_ID: set.ID });
            const structureIds = structureMappings.map(sm => sm.ID);

            let pending = 0;

            if (structureIds.length > 0) {
                pending =
                    structureMappings.filter(sm => sm.status === "SUGGESTED").length +
                    (await SELECT.from(FieldMapping).where({ structureMapping_ID: { in: structureIds }, status: "SUGGESTED" })).length;
            }

            if (pending > 0 && !approvePending) {
                throw new StatusError(
                    409,
                    `${pending} suggestion(s) are still open. Review them, or approve with approvePending = true.`
                );
            }

            if (approvePending && structureIds.length > 0) {
                await UPDATE(StructureMapping).set({ status: "APPROVED" }).where({ mappingSet_ID: set.ID, status: "SUGGESTED" });
                await UPDATE(FieldMapping)
                    .set({ status: "APPROVED", approvedBy: req.user?.id || null, approvedAt: new Date().toISOString() })
                    .where({ structureMapping_ID: { in: structureIds }, status: "SUGGESTED" });
            }

            await UPDATE(MappingSet)
                .set({ status: "APPROVED", approvedBy: req.user?.id || null, approvedAt: new Date().toISOString() })
                .where({ ID: set.ID });

            return {
                ID: set.ID,
                status: "APPROVED",
                message: `Mapping set v${set.version} approved${approvePending ? ` (${pending} open suggestion(s) approved)` : ""}`
            };
        } catch (error) {
            return rejectWith(req, error);
        }
    });

    this.on("upsertValueMappings", async (req) => {
        try {
            const { domain, fromSystem, toSystem } = req.data;
            const entries = parseJson(req.data.entries, "entries");

            if (!domain || !fromSystem || !toSystem || !Array.isArray(entries)) {
                throw new StatusError(400, "domain, fromSystem, toSystem and an entries list are required");
            }

            for (const entry of entries) {
                const key = { domain, fromSystem, toSystem, fromValue: String(entry.fromValue) };
                const existing = await SELECT.one.from(ValueMapping).where(key);

                if (existing) {
                    await UPDATE(ValueMapping)
                        .set({ toValue: entry.toValue === null ? null : String(entry.toValue), status: "APPROVED" })
                        .where({ ID: existing.ID });
                } else {
                    await INSERT.into(ValueMapping).entries({
                        ...key,
                        toValue: entry.toValue === null ? null : String(entry.toValue),
                        status: "APPROVED"
                    });
                }
            }

            return entries.length;
        } catch (error) {
            return rejectWith(req, error);
        }
    });


    /**
     * ============================================================
     * PREVIEW MIGRATION
     * ============================================================
     *
     * source adapter -> instances -> (approved set 1) canonical
     *                -> (approved set 2) target structure rows + issues
     */
    this.on("previewMigration", async (req) => {
        try {
            const { sourceModelId, sourceToCanonicalSetId, canonicalToTargetSetId } = req.data;
            const limit = Number(req.data.limit) > 0 ? Number(req.data.limit) : 100;

            const set1 = await SELECT.one.from(MappingSet).where({ ID: sourceToCanonicalSetId });
            const set2 = await SELECT.one.from(MappingSet).where({ ID: canonicalToTargetSetId });

            if (!set1 || !set2) {
                throw new StatusError(404, "Both mapping sets must exist");
            }

            if (set1.status !== "APPROVED" || set2.status !== "APPROVED") {
                throw new StatusError(409, "Only APPROVED mapping sets can be executed");
            }

            if (set1.fromModel_ID !== sourceModelId || set1.toModel_ID !== set2.fromModel_ID) {
                throw new StatusError(400, "Mapping sets do not chain: source -> canonical -> target");
            }

            const sourceView = await loadModelView(sourceModelId);
            const canonicalView = await loadModelView(set1.toModel_ID);
            const targetView = await loadModelView(set2.toModel_ID);

            const { adapter, connection } = await adapterForSystem(sourceView.model.systemId);

            if (String(connection.adapterType).toUpperCase() === "S4") {
                throw new StatusError(
                    422,
                    "Extraction of S/4 sources via OData navigation is not part of this slice yet (key-joined sources such as M3 are supported)"
                );
            }

            const mappings1 = await loadMappings(set1, canonicalView);
            const mappings2 = await loadMappings(set2, targetView);
            const compiled1 = compileMappingSet(canonicalView, mappings1, set1.hop);
            const compiled2 = compileMappingSet(targetView, mappings2, set2.hop);

            const rootMapping = mappings1.find(
                mapping => mapping.toStructure === canonicalView.root.name &&
                    mapping.pattern === "ONE_TO_ONE" &&
                    ["APPROVED", "MODIFIED"].includes(mapping.status)
            );

            /*
             * Every page read from the source is archived as received
             * (data plane: full data in files, metadata + samples in the database)
             */
            const runId = cds.utils.uuid();
            const rawArchive = rawPageArchiver(runId);

            const instances = await assembleInstances({
                view: sourceView,
                fetchPage: async (structureName, options) => {
                    const page = await adapter.extract(structureName, options);

                    await rawArchive.write(structureName, page.records || []);

                    return page;
                },
                groupBy: rootMapping?.patternConfig?.groupBy || null,
                limit
            });

            const valueMappings = new Map(
                (await SELECT.from(ValueMapping).where({ status: "APPROVED" })).map(vm => [
                    `${vm.domain}|${vm.fromSystem}|${vm.toSystem}|${vm.fromValue}`,
                    vm.toValue
                ])
            );

            const lookupFor = (fromSystem, toSystem) => (domain, value) => {
                const key = `${domain}|${fromSystem}|${toSystem}|${value}`;

                return valueMappings.has(key)
                    ? { found: true, value: valueMappings.get(key) }
                    : { found: false };
            };

            const sourceSystem = sourceView.model.systemId;
            const targetSystem = targetView.model.systemId;
            const canonicalChildren = compiled1.children.map(child => child.name);

            const canonical = [];
            const target = Object.fromEntries(targetView.structures.filter(s => s.depth <= 1).map(s => [s.name, []]));
            const issues = [];

            for (const instance of instances) {
                const hop1 = transformInstance(instance, compiled1, {
                    sourceSystem,
                    lookupValue: lookupFor(sourceSystem, "CANONICAL")
                });

                const hop2 = transformInstance(
                    documentToInstance(hop1.document, instance.key, canonicalView.root.name, canonicalChildren),
                    compiled2,
                    { sourceSystem: "CANONICAL", lookupValue: lookupFor("CANONICAL", targetSystem) }
                );

                canonical.push(hop1.document);
                issues.push(...hop1.issues, ...hop2.issues);

                for (const [structure, rows] of Object.entries(toStructureRows(hop2.document, compiled2))) {
                    target[structure].push(...rows);
                }
            }

            const targetRowCounts = Object.fromEntries(
                Object.entries(target).map(([structure, rows]) => [structure, rows.length])
            );

            const rowCountText = Object.entries(targetRowCounts)
                .map(([structure, count]) => `${structure} ${count}`)
                .join(", ");

            const scopeNote =
                "Preview only - nothing is loaded into S/4. Structures up to depth 1; " +
                "nested structures (e.g. communication under address) and navigation-based sources (S/4) follow later.";

            const message =
                `${instances.length} ${sourceView.model.type_code} instance(s) transformed ${sourceView.model.name} -> ` +
                `${canonicalView.model.name} -> ${targetView.model.name}: ${rowCountText}; ${issues.length} issue(s).`;

            /*
             * ---------- Keep the run for review in the UI ----------
             */
            await INSERT.into(PreviewRun).entries({
                ID: runId,
                sourceModel_ID: sourceModelId,
                sourceToCanonicalSet_ID: set1.ID,
                canonicalToTargetSet_ID: set2.ID,
                instanceCount: instances.length,
                issueCount: issues.length,
                targetRowCounts: rowCountText.slice(0, 1000),
                message: message.slice(0, 1000),
                scopeNote
            });

            if (issues.length > 0) {
                await INSERT.into(PreviewIssue).entries(issues.map(issue => ({
                    run_ID: runId,
                    instanceKey: issue.instance,
                    hop: issue.hop,
                    structure: issue.structure,
                    entry: issue.entry,
                    field: issue.field,
                    code: issue.code,
                    message: String(issue.message || "").slice(0, 1000)
                })));
            }

            // Every target row carries the target root key (e.g. KUNNR) - use it to attribute rows
            const rootKeyField = compiled2.root?.fields.find(field => field.isKey)?.name;

            const rowEntries = Object.entries(target).flatMap(([structure, rows]) =>
                rows.map((row, index) => ({
                    run_ID: runId,
                    structure,
                    instanceKey: rootKeyField ? String(row[rootKeyField] ?? "") || null : null,
                    sortOrder: index + 1,
                    summary: summarize(row),
                    content: JSON.stringify(row)
                }))
            );

            if (rowEntries.length > 0) {
                await INSERT.into(PreviewRow).entries(rowEntries);
            }

            if (canonical.length > 0) {
                await INSERT.into(PreviewDocument).entries(canonical.map((document, index) => ({
                    run_ID: runId,
                    instanceKey: instances[index].key,
                    summary: summarize(document),
                    content: JSON.stringify(document, null, 2)
                })));
            }

            /*
             * ---------- Archive the run as files (Object Store or local folder) ----------
             * A failing archive does not fail the run; the status is recorded.
             */
            const archive = await archivePreviewRun(runId, {
                summary: {
                    runId,
                    createdAt: new Date().toISOString(),
                    sourceSystem: sourceView.model.systemId,
                    sourceModel: sourceView.model.name,
                    canonicalModel: canonicalView.model.name,
                    targetModel: targetView.model.name,
                    sourceToCanonicalSet: { id: set1.ID, version: set1.version },
                    canonicalToTargetSet: { id: set2.ID, version: set2.version },
                    instanceCount: instances.length,
                    issueCount: issues.length,
                    targetRowCounts,
                    rawFiles: rawArchive.files,
                    rawArchiveErrors: rawArchive.errors
                },
                canonical,
                // staging-like: one file per target structure
                ...Object.fromEntries(
                    Object.entries(target).map(([structure, rows]) => [`target/${structure}`, rows])
                ),
                issues
            });

            if (archive.archiveStatus === "ARCHIVED" && rawArchive.errors.length > 0) {
                archive.archiveStatus = `PARTIAL: ${rawArchive.errors.length} raw page(s) not archived - ${rawArchive.errors[0].error}`;
            }

            await UPDATE(PreviewRun).set(archive).where({ ID: runId });

            return {
                runId,
                ...archive,
                instanceCount: instances.length,
                issueCount: issues.length,
                targetRowCounts: JSON.stringify(targetRowCounts),
                canonical: JSON.stringify(canonical),
                target: JSON.stringify(target),
                issues: JSON.stringify(issues),
                scopeNote,
                message
            };
        } catch (error) {
            return rejectWith(req, error);
        }
    });

    /**
     * ============================================================
     * UI BUTTONS (bound actions)
     * ============================================================
     *
     * Thin wrappers: each delegates to the unbound action above, so the
     * governance rules live in one place.
     */
    const boundKey = (req) => req.params[0]?.ID ?? req.params[0];

    const delegate = async (req, event, data) => {
        const result = await this.send(event, data);

        if (result?.message) {
            req.info(result.message);
        }

        return result;
    };

    this.on("tagFields", "BusinessObjectModels", (req) =>
        delegate(req, "tagModelFields", { modelId: boundKey(req) })
    );

    this.on("runPreview", "BusinessObjectModels", async (req) => {
        const sourceModelId = boundKey(req);

        const latestApproved = async (where) => (await SELECT.from(MappingSet).where({ ...where, status: "APPROVED" }))
            .sort((left, right) => Number(right.version) - Number(left.version))[0];

        const set1 = await latestApproved({ fromModel_ID: sourceModelId, hop: "SOURCE_TO_CANONICAL" });

        if (!set1) {
            return req.reject(409, "No approved source -> canonical mapping set exists for this model");
        }

        const set2 = await latestApproved({ fromModel_ID: set1.toModel_ID, hop: "CANONICAL_TO_TARGET" });

        if (!set2) {
            return req.reject(409, "No approved canonical -> target mapping set exists");
        }

        return delegate(req, "previewMigration", {
            sourceModelId,
            sourceToCanonicalSetId: set1.ID,
            canonicalToTargetSetId: set2.ID,
            limit: req.data.limit
        });
    });

    this.on("approveSet", "MappingSets", (req) =>
        delegate(req, "approveMappingSet", { mappingSetId: boundKey(req), approvePending: req.data.approvePending === true })
    );

    this.on("approveMapping", "StructureMappings", (req) =>
        delegate(req, "reviewMapping", { structureMappingId: boundKey(req), status: "APPROVED" })
    );

    this.on("rejectMapping", "StructureMappings", (req) =>
        delegate(req, "reviewMapping", { structureMappingId: boundKey(req), status: "REJECTED" })
    );

    this.on("approveMapping", "FieldMappings", (req) =>
        delegate(req, "reviewMapping", { fieldMappingId: boundKey(req), status: "APPROVED" })
    );

    this.on("rejectMapping", "FieldMappings", (req) =>
        delegate(req, "reviewMapping", { fieldMappingId: boundKey(req), status: "REJECTED" })
    );

    /**
     * Archives raw source pages of a run as compressed NDJSON
     * (one JSON record per line, gzip):
     *   preview-runs/<run>/raw/<structure>/page-00001.ndjson.gz
     * Failures are collected, never thrown - extraction must not break on archiving.
     */
    function rawPageArchiver(runId) {
        const pageNumbers = new Map();
        const files = [];
        const errors = [];

        return {
            files,
            errors,
            async write(structureName, records) {
                const number = (pageNumbers.get(structureName) || 0) + 1;
                pageNumbers.set(structureName, number);

                const key = `preview-runs/${runId}/raw/${structureName}/page-${String(number).padStart(5, "0")}.ndjson.gz`;

                try {
                    const ndjson = records.map(record => JSON.stringify(record)).join("\n");
                    const body = zlib.gzipSync(Buffer.from(ndjson, "utf8"));

                    await getStorage().put(key, body, { contentType: "application/gzip" });
                    files.push({ key, records: records.length, bytes: body.length });
                } catch (error) {
                    errors.push({ key, error: String(error.message).slice(0, 300) });
                }
            }
        };
    }

    /**
     * Writes summary / canonical / target / issues of a preview run as JSON files.
     * Returns { archiveLocation, archiveStatus }.
     */
    async function archivePreviewRun(runId, parts) {
        const prefix = `preview-runs/${runId}/`;

        try {
            const storage = getStorage();

            for (const [name, content] of Object.entries(parts)) {
                await storage.put(`${prefix}${name}.json`, JSON.stringify(content, null, 2), {
                    contentType: "application/json"
                });
            }

            const { kind, location } = storage.describe();
            const base = kind === "LOCAL" ? `${location.replace(/[\\/]$/, "")}/` : location;

            return { archiveLocation: `${base}${prefix}`, archiveStatus: "ARCHIVED" };
        } catch (error) {
            console.error(`[previewMigration] Archiving run ${runId} failed:`, error.message);

            return { archiveLocation: null, archiveStatus: `FAILED: ${String(error.message).slice(0, 900)}` };
        }
    }

    /**
     * ============================================================
     * STORAGE BROWSER (read from the storage, not the database)
     * ============================================================
     */
    const MAX_CONTENT_BYTES = 200 * 1024;

    const encodeId = (value) => Buffer.from(value, "utf8").toString("base64url") || "ALL";
    const decodeId = (id) => (id === "ALL" ? "" : Buffer.from(String(id), "base64url").toString("utf8"));

    const sizeText = (bytes) =>
        bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` :
        bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` :
        `${bytes} B`;

    const fileTypeOf = (filePath) =>
        filePath.endsWith(".ndjson.gz") ? "NDJSON (gzip)" :
        filePath.endsWith(".json") ? "JSON" :
        filePath.endsWith(".txt") ? "TEXT" :
        "OTHER";

    // preview-runs/<run>/raw/x.gz -> "preview-runs/<run>/";  smoke-test/a.txt -> "smoke-test/"
    const folderGroupOf = (filePath) => {
        const parts = filePath.split("/");
        return parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length > 1 ? `${parts[0]}/` : "";
    };

    const describeFolder = (folder) => {
        const run = /^preview-runs\/([^/]+)\/$/.exec(folder);
        const extraction = /^extractions\/([^/]+)\/$/.exec(folder);
        return !folder ? "All files" : run ? `Preview run ${run[1]}` : extraction ? `Extraction ${extraction[1]}` : folder;
    };

    const storageLabel = () => {
        const { kind, location } = getStorage().describe();
        return `${kind} ${location}`;
    };

    const toFileRow = (file) => {
        const slash = file.key.lastIndexOf("/");

        return {
            ID: encodeId(file.key),
            path: file.key,
            folder: slash >= 0 ? file.key.slice(0, slash + 1) : "",
            folderGroup: folderGroupOf(file.key),
            name: slash >= 0 ? file.key.slice(slash + 1) : file.key,
            fileType: fileTypeOf(file.key),
            size: file.size,
            sizeText: sizeText(file.size),
            lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
            content: null
        };
    };

    const folderRow = (folder, files) => {
        const total = files.reduce((sum, file) => sum + (file.size || 0), 0);
        const last = files.map(file => file.lastModified).filter(Boolean).sort().pop() || null;

        return {
            ID: encodeId(folder),
            folder,
            description: describeFolder(folder),
            fileCount: files.length,
            totalSize: total,
            sizeText: sizeText(total),
            lastWrite: last,
            storage: storageLabel()
        };
    };

    /**
     * Minimal evaluation of the filters Fiori elements sends for string
     * fields (=, contains, startswith, endswith, and/or groups).
     */
    const matchesWhere = (row, where) => {
        if (!Array.isArray(where) || where.length === 0) {
            return true;
        }

        let result = null;
        let joiner = "and";

        for (let index = 0; index < where.length; index++) {
            const token = where[index];
            let value = null;

            if (token === "and" || token === "or") {
                joiner = token;
                continue;
            }

            if (token?.ref && where[index + 1] === "=" && where[index + 2] && "val" in where[index + 2]) {
                value = String(row[token.ref[0]] ?? "") === String(where[index + 2].val);
                index += 2;
            } else if (token?.func && Array.isArray(token.args) && token.args[0]?.ref) {
                const actual = String(row[token.args[0].ref[0]] ?? "").toLowerCase();
                const expected = String(token.args[1]?.val ?? "").toLowerCase();

                value =
                    token.func === "contains" ? actual.includes(expected) :
                    token.func === "startswith" ? actual.startsWith(expected) :
                    token.func === "endswith" ? actual.endsWith(expected) :
                    true;
            } else if (token?.xpr) {
                value = matchesWhere(row, token.xpr);
            } else {
                continue;
            }

            result = result === null ? value : joiner === "or" ? result || value : result && value;
        }

        return result ?? true;
    };

    const searchTermOf = (req) =>
        String(req.query.SELECT.search?.[0]?.val || req._queryOptions?.$search || "")
            .replace(/^"|"$/g, "")
            .toLowerCase();

    /** OData paging + $count on an in-memory list */
    const page = (req, rows) => {
        const limit = req.query.SELECT.limit;
        const offset = Number(limit?.offset?.val || 0);
        const top = limit?.rows?.val;
        const result = rows.slice(offset, top ? offset + Number(top) : undefined);

        result.$count = rows.length;

        return result;
    };

    this.on("READ", "StorageFolders", async (req) => {
        const files = (await getStorage().list("")).map(toFileRow);
        const groups = new Map([["", files]]);

        for (const file of files) {
            if (!groups.has(file.folderGroup)) {
                groups.set(file.folderGroup, []);
            }

            groups.get(file.folderGroup).push(file);
        }

        const rows = [...groups.entries()].map(([folder, groupFiles]) => folderRow(folder, groupFiles));

        if (req.query.SELECT.one) {
            const folder = decodeId(req.params[0]?.ID ?? req.params[0]);
            return rows.find(row => row.folder === folder) || req.reject(404, `Folder '${folder}' was not found`);
        }

        const search = searchTermOf(req);

        return page(req, rows
            .filter(row => matchesWhere(row, req.query.SELECT.where))
            .filter(row => !search || `${row.folder} ${row.description}`.toLowerCase().includes(search))
            .sort((left, right) => (left.folder === "" ? -1 : right.folder === "" ? 1 : String(right.lastWrite).localeCompare(String(left.lastWrite)))));
    });

    this.on("READ", "StoredFiles", async (req) => {
        const storage = getStorage();
        const from = req.query.SELECT.from.ref || [];
        const viaFolder = from.length > 1;

        // ---------- one file, with content ----------
        if (req.query.SELECT.one) {
            const fileParam = req.params[req.params.length - 1];
            const filePath = decodeId(fileParam?.ID ?? fileParam);
            const listed = (await storage.list(filePath)).find(file => file.key === filePath);

            if (!listed) {
                return req.reject(404, `File '${filePath}' was not found in ${storageLabel()}`);
            }

            let data = await storage.get(filePath);

            if (filePath.endsWith(".gz")) {
                data = zlib.gunzipSync(data);
            }

            let text = data.subarray(0, MAX_CONTENT_BYTES).toString("utf8");

            if (filePath.endsWith(".json") && data.length <= MAX_CONTENT_BYTES) {
                try {
                    text = JSON.stringify(JSON.parse(text), null, 2);
                } catch {
                    // not valid JSON - show as stored
                }
            }

            if (data.length > MAX_CONTENT_BYTES) {
                text += `\n\n… showing the first ${MAX_CONTENT_BYTES / 1024} KB of ${sizeText(data.length)}`;
            }

            return { ...toFileRow(listed), content: text };
        }

        // ---------- list (all files, or the files of one folder) ----------
        let rows = (await storage.list("")).map(toFileRow);

        if (viaFolder) {
            const folder = decodeId(req.params[0]?.ID ?? req.params[0]);
            rows = folder ? rows.filter(row => row.folderGroup === folder) : rows;
        }

        const search = searchTermOf(req);

        return page(req, rows
            .filter(row => matchesWhere(row, req.query.SELECT.where))
            .filter(row => !search || row.path.toLowerCase().includes(search))
            .sort((left, right) => left.path.localeCompare(right.path)));
    });

    this.on("getStorageInfo", async () => {
        const { kind, location, region } = getStorage().describe();
        const files = await getStorage().list("");
        const totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
        const lastWrite = files.map(file => file.lastModified && new Date(file.lastModified).toISOString()).filter(Boolean).sort().pop() || null;

        return {
            kind,
            location,
            region: region || null,
            fileCount: files.length,
            totalSize,
            sizeText: sizeText(totalSize),
            lastWrite
        };
    });

    async function deleteModel(modelId) {
        const structureIds = (
            await SELECT.from(Structure).columns("ID").where({ model_ID: modelId })
        ).map(structure => structure.ID);

        if (structureIds.length > 0) {
            await DELETE.from(Field).where({ structure_ID: { in: structureIds } });
        }

        await DELETE.from(Relationship).where({ model_ID: modelId });
        await DELETE.from(Structure).where({ model_ID: modelId });
        await DELETE.from(BusinessObjectModel).where({ ID: modelId });
    }

    /**
     * ============================================================
     * GET MODEL TREE
     * ============================================================
     *
     * Builds the nested structure tree of one business object model:
     *
     *   BusinessPartner
     *    ├─ Address (0..N)
     *    │   └─ Communication (0..N)
     *    ├─ Role (0..N)
     *    └─ ...
     */
    this.on("getModelTree", async (req) => {

        const { modelId } = req.data;

        if (!modelId) {
            return req.reject(400, "modelId is required");
        }

        const model = await SELECT.one
            .from(BusinessObjectModel)
            .where({ ID: modelId });

        if (!model) {
            return req.reject(404, `Business object model '${modelId}' was not found`);
        }

        const structures = await SELECT
            .from(Structure)
            .where({ model_ID: modelId })
            .orderBy("sortOrder");

        const relationships = await SELECT
            .from(Relationship)
            .where({ model_ID: modelId });

        const fields = structures.length > 0
            ? await SELECT
                .from(Field)
                .where({ structure_ID: { in: structures.map(s => s.ID) } })
                .orderBy("sortOrder")
            : [];

        const fieldsByStructure = new Map();

        for (const field of fields) {
            if (!fieldsByStructure.has(field.structure_ID)) {
                fieldsByStructure.set(field.structure_ID, []);
            }

            fieldsByStructure.get(field.structure_ID).push({
                name: field.name,
                dataType: field.dataType,
                length: field.length,
                isKey: field.isKey,
                mandatory: field.mandatory,
                semanticTag: field.semanticTag_code,
                description: field.description
            });
        }

        const relationshipByChild = new Map(
            relationships.map(r => [r.child_ID, r])
        );

        const nodes = new Map(
            structures.map(s => [s.ID, {
                name: s.name,
                cardinality: relationshipByChild.get(s.ID)?.cardinality || "1",
                relationshipKind: relationshipByChild.get(s.ID)?.kind || null,
                joinKeys: relationshipByChild.get(s.ID)?.joinKeys
                    ? JSON.parse(relationshipByChild.get(s.ID).joinKeys)
                    : null,
                description: s.description,
                fields: fieldsByStructure.get(s.ID) || [],
                children: []
            }])
        );

        const roots = [];

        for (const structure of structures) {
            const relationship = relationshipByChild.get(structure.ID);
            const parent = relationship && nodes.get(relationship.parent_ID);

            if (parent) {
                parent.children.push(nodes.get(structure.ID));
            } else {
                roots.push(nodes.get(structure.ID));
            }
        }

        return {
            modelId: model.ID,
            name: model.name,
            businessObject: model.type_code,
            layer: model.layer,
            systemId: model.systemId,
            version: model.version,
            status: model.status,
            structureCount: structures.length,
            fieldCount: fields.length,
            tree: JSON.stringify(roots.length === 1 ? roots[0] : roots)
        };
    });
});
