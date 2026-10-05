using { migration.framework as fw } from '../db/framework';

@path: '/framework'
@title: 'AI Migration Framework - Metamodel API'
@description: 'Business object catalog, semantic tags and business object models (source, canonical, target)'
service FrameworkService {

    /*
     * ============================================================
     * CATALOG
     * ============================================================
     */
    @readonly
    entity BusinessObjectTypes
        as projection on fw.BusinessObjectType;

    @readonly
    entity BusinessObjectDependencies
        as projection on fw.BusinessObjectDependency;

    @readonly
    entity SemanticTags
        as projection on fw.SemanticTag;


    /*
     * ============================================================
     * MODEL LAYER
     * ============================================================
     */
    @readonly
    entity BusinessObjectModels
        as projection on fw.BusinessObjectModel {
            *,
            mappingSets : Association to many MappingSets on mappingSets.fromModel = $self,
            previewRuns : Association to many PreviewRuns on previewRuns.sourceModel = $self
        }
        actions {
            @description: 'Tag the fields of this model with semantic tags (rule-based)'
            action tagFields() returns TaggingResult;

            @description: 'Run the latest approved mappings of this source model (source -> canonical -> target) as a preview'
            action runPreview(
                @description: 'Maximum number of business object instances'
                limit : Integer
            ) returns MigrationPreviewResult;
        };

    @readonly
    entity Structures
        as projection on fw.Structure;

    @readonly
    entity Relationships
        as projection on fw.Relationship;

    @readonly
    entity Fields
        as projection on fw.Field;


    /*
     * ============================================================
     * MAPPING LAYER
     * ============================================================
     */
    @readonly
    entity MappingSets
        as projection on fw.MappingSet
        actions {
            @description: 'Approve this mapping set; optionally approve all open suggestions'
            action approveSet(
                @description: 'Also approve all suggestions that are still open'
                approvePending : Boolean
            ) returns MappingChangeResult;
        };

    @readonly
    entity StructureMappings
        as projection on fw.StructureMapping
        actions {
            action approveMapping() returns MappingChangeResult;
            action rejectMapping()  returns MappingChangeResult;
        };

    @readonly
    entity FieldMappings
        as projection on fw.FieldMapping
        actions {
            action approveMapping() returns MappingChangeResult;
            action rejectMapping()  returns MappingChangeResult;
        };

    @readonly
    entity ValueMappings
        as projection on fw.ValueMapping;


    /*
     * ============================================================
     * PREVIEW RUNS
     * ============================================================
     */
    @readonly
    entity PreviewRuns
        as projection on fw.PreviewRun;

    @readonly
    entity PreviewIssues
        as projection on fw.PreviewIssue;

    @readonly
    entity PreviewRows
        as projection on fw.PreviewRow;

    @readonly
    entity PreviewDocuments
        as projection on fw.PreviewDocument;


    /*
     * ============================================================
     * STORED FILES (Object Store or local folder)
     * ============================================================
     *
     * Not database tables: rows are read from the storage itself
     * (Object Store bucket when bound, local folder otherwise).
     */

    /**
     * Overview: one row for all files, one row per folder group
     * (e.g. one preview run).
     */
    @readonly
    @cds.persistence.skip
    entity StorageFolders {
        key ID          : String(1500);    // URL-safe encoding of the folder
            folder      : String(1024);    // '' = all files
            description : String(200);
            fileCount   : Integer;
            totalSize   : Integer64;       // bytes
            sizeText    : String(40);      // e.g. "11.2 KB"
            lastWrite   : Timestamp;
            storage     : String(1000);    // OBJECT_STORE s3://bucket/prefix | LOCAL <folder>
            files       : Association to many StoredFiles on files.folderGroup = $self.folder;
    }

    @readonly
    @cds.persistence.skip
    entity StoredFiles {
        key ID           : String(1500);   // URL-safe encoding of the path
            path         : String(1024);
            folder       : String(1024);
            folderGroup  : String(1024);
            name         : String(255);
            fileType     : String(40);     // JSON | NDJSON (gzip) | TEXT | OTHER
            size         : Integer64;      // bytes
            sizeText     : String(40);
            lastModified : Timestamp;
            content      : LargeString;    // only when one file is opened (first 200 KB)
    }

    @description: 'Which storage the app uses (Object Store bucket or local folder) and how much is stored'
    function getStorageInfo() returns {
        kind      : String(20);
        location  : String(1000);
        region    : String(50);
        fileCount : Integer;
        totalSize : Integer64;
        sizeText  : String(40);
        lastWrite : Timestamp;
    };


    /*
     * ============================================================
     * FUNCTIONS
     * ============================================================
     */

    /**
     * Returns a business object model as a nested tree:
     * root structure -> child structures (with cardinality) -> fields.
     */
    @description: 'Get a business object model (source, canonical or target) as a nested tree of structures and fields'
    function getModelTree(
        @description: 'ID of the BusinessObjectModel'
        modelId : UUID
    ) returns ModelTreeResult;

    /**
     * Reads the relationships of a source object (e.g. S/4 navigation
     * properties in $metadata) and stores the source system's own
     * business object model as a tree.
     *
     * Re-running replaces the latest DRAFT model; an APPROVED model is
     * kept and a new version is created.
     */
    @description: 'Build the source system business object model (tree of structures, relationships and fields) from source metadata'
    action buildSourceModel(
        @description: 'Source system ID (SourceSystem.systemId)'
        sourceSystemId     : String(100),
        @description: 'Source object / API name, e.g. API_BUSINESS_PARTNER (S/4) or CRS610MI (M3)'
        sourceObject       : String(200),
        @description: 'Further source objects that belong to the same business object (sources without declared relationships, e.g. M3: OIS002MI)'
        relatedObjects     : many String(200),
        @description: 'Business object type code from the catalog, e.g. BUSINESS_PARTNER'
        businessObjectType : String(60),
        @description: 'Optional root entity set; detected from the metadata when empty'
        rootEntity         : String(200),
        @description: 'Optional navigation depth (default 3)'
        maxDepth           : Integer
    ) returns BuildModelResult;

    /**
     * Tags the fields of a business object model with semantic tags.
     *
     * engine:
     *   RULES          rule-based tagger only (default, no AI needed)
     *   AI             configured AI provider only (metadata only is sent)
     *   AI_WITH_RULES  AI first, rule-based tagger where AI gives no tag or fails
     *
     * Approved tags are kept unless overwrite = true.
     */
    @description: 'Tag the fields of a business object model with semantic tags (rule-based and/or AI), with confidence and reason'
    action tagModelFields(
        @description: 'ID of the BusinessObjectModel'
        modelId   : UUID,
        @description: 'RULES (default) | AI | AI_WITH_RULES'
        engine    : String(20),
        @description: 'Also re-tag fields whose tag is already APPROVED'
        overwrite : Boolean
    ) returns TaggingResult;

    type TaggingResult {
        modelId         : UUID;
        engine          : String(20);
        fieldCount      : Integer;
        tagged          : Integer;
        highConfidence  : Integer;
        reviewRequired  : Integer;
        untagged        : Integer;
        skippedApproved : Integer;
        aiUsed          : Boolean;
        aiDiscarded     : Integer;
        message         : String(1000);
    }

    /**
     * Lines up the fields of all models of a business object type
     * (canonical, sources, targets) by semantic tag.
     */
    @description: 'Show the fields of all models of a business object type side by side, grouped by semantic tag'
    function getSemanticAlignment(
        @description: 'Business object type code, e.g. BUSINESS_PARTNER'
        businessObjectType : String(60)
    ) returns SemanticAlignmentResult;

    type SemanticAlignmentResult {
        businessObjectType : String(60);
        models             : LargeString;   // JSON
        tagCount           : Integer;
        alignment          : LargeString;   // JSON
        untagged           : LargeString;   // JSON
    }

    /*
     * ============================================================
     * MODEL IMPORT (generic - any business object, any layer)
     * ============================================================
     */
    @description: 'Import a business object model from a JSON definition (e.g. a Migration Cockpit template converted to JSON)'
    action importModel(
        @description: 'JSON: { businessObjectType, layer, systemId, name, description, structures: [{ name, parent, cardinality, description, fields: [{ name, description, dataType, length, isKey, mandatory, semanticTag }] }] }'
        definition : LargeString
    ) returns BuildModelResult;


    /*
     * ============================================================
     * MAPPING GOVERNANCE
     * ============================================================
     *
     * suggestMappings      app proposes (status SUGGESTED)
     * upsert* / review*    functional team completes, approves, rejects
     * approveMappingSet    set becomes APPROVED and immutable
     * previewMigration     engine runs APPROVED mappings only
     */
    @description: 'Suggest structure and field mappings from one model to another (source -> canonical or canonical -> target) using semantic tags'
    action suggestMappings(
        fromModelId : UUID,
        toModelId   : UUID
    ) returns MappingSuggestionResult;

    type MappingSuggestionResult {
        mappingSetId         : UUID;
        hop                  : String(30);
        version              : String(20);
        structureMappings    : Integer;
        fieldMappings        : Integer;
        unmappedStructures   : Integer;
        unmappedMandatory    : Integer;
        coverage             : LargeString;   // JSON
        message              : String(1000);
    }

    @description: 'Add or change a structure mapping (functional team decision)'
    action upsertStructureMapping(
        mappingSetId   : UUID,
        @description: 'Target structure name'
        toStructure    : String(200),
        @description: 'Source structure names'
        fromStructures : many String(200),
        @description: 'ONE_TO_ONE | EXPLODE | PICK | FILTER | DERIVE'
        pattern        : String(20),
        @description: 'JSON pattern configuration, e.g. { "rows": "all" }'
        patternConfig  : LargeString
    ) returns MappingChangeResult;

    @description: 'Add or change a field mapping rule (functional team decision)'
    action upsertFieldMapping(
        structureMappingId : UUID,
        @description: 'Target field name'
        toField            : String(200),
        @description: 'JSON list of source fields: [{ "structure": "...", "field": "..." }]'
        fromFields         : LargeString,
        @description: 'JSON rule, e.g. { "type": "CONSTANT", "value": "CUST" }'
        rule               : LargeString
    ) returns MappingChangeResult;

    @description: 'Approve or reject a suggested structure or field mapping'
    action reviewMapping(
        structureMappingId : UUID,
        fieldMappingId     : UUID,
        @description: 'APPROVED | REJECTED'
        status             : String(20)
    ) returns MappingChangeResult;

    @description: 'Approve a mapping set; optionally approve all remaining suggestions. Approved sets cannot be changed.'
    action approveMappingSet(
        mappingSetId   : UUID,
        approvePending : Boolean
    ) returns MappingChangeResult;

    type MappingChangeResult {
        ID      : UUID;
        status  : String(20);
        message : String(1000);
    }

    @description: 'Maintain value mappings (code conversions) of one domain, e.g. payment terms'
    action upsertValueMappings(
        @description: 'Domain, e.g. finance.paymentTerms'
        domain     : String(100),
        @description: 'Source system ID or CANONICAL'
        fromSystem : String(100),
        @description: 'Target system ID or CANONICAL'
        toSystem   : String(100),
        @description: 'JSON list: [{ "fromValue": "30", "toValue": "0001" }]'
        entries    : LargeString
    ) returns Integer;


    /*
     * ============================================================
     * PREVIEW MIGRATION (end-to-end slice)
     * ============================================================
     */
    @description: 'Run the approved mappings on source data: source -> canonical -> target structures, with issues. Preview only - nothing is loaded.'
    action previewMigration(
        sourceModelId          : UUID,
        sourceToCanonicalSetId : UUID,
        canonicalToTargetSetId : UUID,
        @description: 'Maximum number of business object instances (default 100)'
        limit                  : Integer
    ) returns MigrationPreviewResult;

    type MigrationPreviewResult {
        runId           : UUID;
        archiveLocation : String(1000);
        archiveStatus   : String(1000);
        instanceCount : Integer;
        issueCount    : Integer;
        targetRowCounts : LargeString;   // JSON { structure: count }
        canonical     : LargeString;     // JSON
        target        : LargeString;     // JSON { structure: rows }
        issues        : LargeString;     // JSON
        scopeNote     : String(1000);
        message       : String(1000);
    }

    type BuildModelResult {
        modelId           : UUID;
        name              : String(200);
        version           : String(20);
        rootStructure     : String(200);
        structureCount    : Integer;
        relationshipCount : Integer;
        fieldCount        : Integer;
        inferredJoinCount : Integer;
        proposedJoinCount : Integer;
        missingJoinCount  : Integer;
        reviewRequired    : Boolean;
        message           : String(1000);
    }

    type ModelTreeResult {
        modelId        : UUID;
        name           : String(200);
        businessObject : String(60);
        layer          : String(20);
        systemId       : String(100);
        version        : String(20);
        status         : String(20);
        structureCount : Integer;
        fieldCount     : Integer;
        tree           : LargeString;   // JSON
    }
}
