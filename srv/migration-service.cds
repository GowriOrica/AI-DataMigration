using { migration.orchestrator as db } from '../db/schema';

@path: '/migration'
@title: 'AI Migration Orchestrator API'
@description: 'API for the AI Migration Framework Migration Orchestrator'
@Core.SchemaVersion: '1.0.0'
service MigrationService {

    /*
     * ============================================================
     * MIGRATION RUN
     * ============================================================
     */
    entity MigrationRuns
        as projection on db.MigrationRun;

    action clearAllAssessments() returns String;
    /*
     * ============================================================
     * MIGRATION ASSESSMENTS
     * ============================================================
     */
    @readonly
    @cds.persistence.skip
    entity MigrationAssessments
        as projection on db.MigrationAssessment;
    /*
     * ============================================================
     * SOURCE SYSTEM
     * ============================================================
     */
    entity SourceSystems
        as projection on db.SourceSystem;


    /*
     * ============================================================
     * SOURCE CONNECTION
     * ============================================================
     */
    entity SourceConnections
        as projection on db.SourceConnection;


    /*
     * ============================================================
     * SOURCE OBJECT
     * ============================================================
     */
    entity SourceObjects
        as projection on db.SourceObject;


    /*
     * ============================================================
     * SOURCE METADATA
     * ============================================================
     */
    entity SourceMetadata
        as projection on db.SourceMetadata;


    /*
     * ============================================================
     * SOURCE FIELDS
     * ============================================================
     */
    entity SourceFields
        as projection on db.SourceField;


    /*
     * ============================================================
     * RAW RECORDS
     * ============================================================
     */
    @readonly
    entity RawRecords
        as projection on db.RawRecord;


    /*
     * ============================================================
     * CANONICAL CUSTOMERS
     * ============================================================
     */
    @readonly
    entity CanonicalCustomers
        as projection on db.CanonicalCustomer;


    /*
     * ============================================================
     * TARGET SYSTEM
     * ============================================================
     */
    entity TargetSystems
        as projection on db.TargetSystem;


    /*
     * ============================================================
     * TARGET CONNECTION
     * ============================================================
     */
    entity TargetConnections
        as projection on db.TargetConnection;


    /*
     * ============================================================
     * TARGET OBJECT
     * ============================================================
     */
    entity TargetObjects
        as projection on db.TargetObject;


    /*
     * ============================================================
     * TARGET METADATA
     * ============================================================
     */
    entity TargetMetadata
        as projection on db.TargetMetadata;


    /*
     * ============================================================
     * TARGET FIELDS
     * ============================================================
     */
    entity TargetFields
        as projection on db.TargetField;


    /*
     * ============================================================
     * SERVICE ACTIONS
     * ============================================================
     */
    action testSourceConnection(
        connectionId : String(100)
    ) returns ConnectivityResult;

    action discoverSourceMetadata(
        sourceSystemId : String(100)
    ) 
    returns SourceMetadataResult;

    action ingestSourceData(
        connectionId : String(100),
        runId         : String(100),
        batchId       : String(100),
        objectName    : String(200)
    ) returns IngestionResult;

    action transformRawToCanonicalCustomer(
        runId        : String(100),
        batchId      : String(100),
        sourceObject : String(200)
    ) returns CanonicalizationResult;

    action profileData(
        runId        : String(100),
        batchId      : String(100),
        sourceObject : String(200)
    ) returns ProfilingResult;

    action discoverTargetMetadata(
        runId : String(100)
    ) returns TargetMetadataResult;

    action analyzeMapping(
        runId        : String(100),
        batchId      : String(100),
        sourceObject : String(200)
    ) returns MappingAnalysisResult;


    /*
     * ============================================================
     * STRUCTURED RETURN TYPES
     * ============================================================
     */
    type ConnectivityResult {
        connectionId       : String(100);
        sourceSystem       : String(100);
        interfaceType      : String(50);
        adapterType        : String(100);
        authenticationType : String(50);
        status             : String(40);
        mode               : String(20);   // LIVE | MOCK
        testedAt           : Timestamp;
        message            : String(500);
    }

    type SourceMetadataResult {
        connectionId      : String(100);
        sourceSystem      : String(100);
        systemType        : String(100);
        interfaceType     : String(50);
        adapterType       : String(100);
        status            : String(40);
        metadataVersion   : String(40);
        discoveredAt      : Timestamp;
        objectsDiscovered : Integer;
        message           : String(500);
    }

    type IngestionResult {
        runId           : String(100);
        batchId         : String(100);
        connectionId    : String(100);
        sourceSystem    : String(100);
        sourceType      : String(50);
        sourceInterface : String(50);
        sourceObject    : String(200);
        schemaVersion   : String(50);
        status          : String(40);
        extractedCount  : Integer;
        ingestedCount   : Integer;
        duplicateCount  : Integer;
        failedCount     : Integer;
        extractedAt     : Timestamp;
        message         : String(500);
    }

    type ProfilingFieldResult {
        fieldName              : String(200);
        dataType               : String(500);
        required               : Boolean;
        populatedCount         : Integer;
        missingCount           : Integer;
        completenessPercentage : Decimal(5,2);
        distinctCount          : Integer;
        duplicateValueCount    : Integer;
        invalidCount           : Integer;
        status                 : String(40);
    }

    type ProfilingResult {
        runId               : String(100);
        batchId             : String(100);
        sourceObject        : String(200);
        totalRecords        : Integer;
        completeRecords     : Integer;
        incompleteRecords   : Integer;
        completenessPercentage : Decimal(5,2);
        requiredFieldCount  : Integer;
        duplicateRecordCount : Integer;
        qualityStatus       : String(40);
        fieldResults        : many ProfilingFieldResult;

        // Backward-compatible fields used by existing callers.
        duplicateSourceKeys : Integer;
        invalidEmailCount   : Integer;
        missingFieldCount   : Integer;
        qualityScore        : Decimal(5,2);
        status              : String(40);
        profiledAt          : Timestamp;
        message             : String(1000);
    }

    type CanonicalizationResult {
        runId              : String(100);
        batchId            : String(100);
        sourceObject       : String(200);
        extractedCount     : Integer;
        canonicalizedCount : Integer;
        duplicateCount     : Integer;
        failedCount        : Integer;
        status             : String(40);
        canonicalizedAt    : Timestamp;
        message            : String(500);
    }

    type TargetMetadataResult {
        runId             : String(100);
        targetSystem      : String(100);
        targetType        : String(50);
        targetInterface   : String(50);
        targetObject      : String(200);
        status            : String(40);
        metadataVersion   : String(50);
        objectsDiscovered : Integer;
        fieldsDiscovered  : Integer;
        discoveredAt      : Timestamp;
        message           : String(1000);
    }

    type MappingAnalysisResult {
        runId                 : String(100);
        batchId               : String(100);
        sourceObject          : String(200);
        targetObject          : String(200);
        status                : String(40);
        mappings              : LargeString;
        mappingCount          : Integer;
        highConfidenceCount   : Integer;
        approvalRequiredCount : Integer;
        analyzedAt            : Timestamp;
        message               : String(1000);
    }

    // action clearDiscoveredMetadata() returns String;
    action discoverAllSourceMetadata(
        connectionId : String(100)
    ) returns String;

    /*
     * ============================================================
     * AI QUERY CAPABILITIES
     * ============================================================
     */

    action queryMetadata(
        request : LargeString
    ) returns MetadataQueryResult;

    action querySourceData(
        request : LargeString
    ) returns SourceDataQueryResult;

    action clearAssessment(
        sourceObject : String(200)
    ) returns String;

    /*
     * ============================================================
     * AI QUERY RETURN TYPES
     * ============================================================
     */

    type MetadataQueryResult {
        status       : String(40);
        resource     : String(100);
        objectName   : String(200);
        entityName   : String(200);
        count        : Integer;
        data         : LargeString;
        message      : String(1000);
    }

    type SourceDataQueryResult {
        status          : String(40);
        mode            : String(40);
        sourceObject    : String(200);
        entityName      : String(200);
        totalCount      : Integer;
        returnedCount   : Integer;
        hasMore         : Boolean;
        data            : LargeString;
        jobId           : String(100);
        message         : String(1000);
    }

    // action resetDiscoveredCatalog(
    //     sourceSystemId : String(100)
    // ) returns String;

    //Catalog Service 
    

    @readonly
    entity Services {
        key TechnicalServiceName    : String(255);
        key TechnicalServiceVersion : Integer;
        Description                 : String(1000);
        ServiceUrl                  : String(1000);
    }


    type EntitySetInfo {
        EntitySetName : String(255);
        Description   : String(1000);
        EntityType    : String(500);
        Creatable     : Boolean;
        Updatable     : Boolean;
        Deletable     : Boolean;
        Searchable    : Boolean;
    }


    type PropertyInfo {
        EntityName   : String(255);
        PropertyName : String(255);
        Type         : String(255);
        IsKey        : Boolean;
        Nullable     : Boolean;
        MaxLength    : String(50);
    }


    type NavigationInfo {
        EntityName         : String(255);
        NavigationProperty : String(255);
        Relationship       : String(500);
    }


    type MetadataResult {

        ServiceName : String(255);
        ServiceUrl  : String(1000);

        EntitySets :
            many EntitySetInfo;

        Properties :
            many PropertyInfo;

        NavigationProperties :
            many NavigationInfo;
    }

    /**
     * Shows which discovered APIs / programs would go to the AI assessment
     * (filter funnel, size estimate) WITHOUT sending anything to the AI.
     */
    action previewAssessmentScope(
        sourceSystemId   : String(100),
        scopePrefixes    : many String(50),
        includeCustom    : Boolean,
        readOnly         : Boolean,
        businessApisOnly : Boolean
    ) returns AssessmentScopeResult;

    /**
     * Extracts the CONFIRMED APIs / programs of a business object from the source
     * system into the Object Store (page by page, compressed, with a manifest
     * and a SHA-256 checksum per file). The data does not go into the database.
     */
    action extractToObjectStore(
        sourceSystemId      : String(100),
        businessObject      : String(200),
        objectNames         : many String(200),
        pageSize            : Integer,
        maxRecordsPerObject : Integer
    ) returns ExtractionResult;

    type ExtractionResult {
        extractionId     : String(100);
        status           : String(20);
        businessObject   : String(200);
        sourceSystem     : String(100);
        storage          : String(1000);
        objectCount      : Integer;
        totalRecords     : Integer;
        totalPages       : Integer;
        totalBytes       : Integer64;
        truncatedObjects : Integer;
        failedObjects    : Integer;
        manifestLocation : String(1000);
        objects          : LargeString;   // JSON: per object records, pages, bytes, truncated, error
        message          : String(1000);
    }

    /**
     * Re-reads the files of an extraction and compares them with the
     * checksums in its manifest.
     */
    action verifyExtraction(
        extractionId : String(100)
    ) returns VerifyExtractionResult;

    /**
     * Lists the extractions stored in the Object Store (newest first),
     * optionally only those of one source system / business object.
     */
    action listExtractions(
        sourceSystemId : String(100),
        businessObject : String(200)
    ) returns many ExtractionSummary;

    type ExtractionSummary {
        extractionId   : String(100);
        status         : String(20);
        businessObject : String(200);
        sourceSystem   : String(100);
        startedAt      : String(40);
        objectCount    : Integer;
        totalRecords   : Integer;
        objects        : LargeString;   // JSON: [{ objectName, records, pages, truncated, error }]
    }

    /**
     * Profiles the extracted data of a business object (latest extraction, or the given one):
     * how complete every field is, fields that are always empty, probable duplicates, mixed
     * date formats, spelling variants and an indicative quality score. The records are read
     * from the Object Store and counted by the server; no AI is involved and nothing is
     * changed. The message is a short summary in plain words; objects has the details.
     */
    action profileExtraction(
        extractionId   : String(100),   // optional when businessObject is given
        businessObject : String(200),   // e.g. "Business Partner": uses its latest extraction
        sourceSystemId : String(100),   // optional: only needed if several source systems have it
        objectName     : String(200)    // optional: only this API
    ) returns ExtractionProfileResult;

    type ExtractionProfileResult {
        extractionId   : String(100);
        businessObject : String(200);
        sourceSystem   : String(100);
        startedAt      : String(40);
        apiCount       : Integer;
        totalRecords   : Integer;
        message        : String(5000);   // the summary in plain words (for Joule and the screen)
        objects        : LargeString;    // JSON: per API the full profile (fields, findings, score)
    }

    /**
     * Exports an extraction to one Excel workbook: an Info sheet (the extraction
     * report), one sheet per API with all its records, and a Fields sheet.
     * Without objectName all APIs of the extraction are exported.
     * The file is stored in the Object Store (exports/<extractionId>/) and can be
     * downloaded with downloadExport(exportKey).
     */
    action exportExtractionToExcel(
        extractionId   : String(100),   // optional when businessObject is given
        objectName     : String(200),   // optional: only this API
        businessObject : String(200),   // e.g. "Business Partner": exports its latest extraction
        sourceSystemId : String(100)    // optional: only needed if several source systems have it
    ) returns ExcelExportResult;

    type ExcelExportResult {
        extractionId : String(100);
        fileName     : String(300);
        exportKey    : String(500);     // storage key, used by downloadExport
        location     : String(1000);
        sizeBytes    : Integer;
        totalRows    : Integer;
        sheets       : LargeString;     // JSON: [{ name, objectName, rows, columns }]
        checksums    : String(20);      // OK | CHANGED
        downloadUrl  : String(4000);   // direct time-limited link (Object Store) or the application link
        downloadExpiresInMinutes : Integer;
        message      : String(5000);
    }

    /**
     * Downloads a file created by exportExtractionToExcel (only keys under exports/).
     */
    function downloadExport(
        exportKey : String(500)
    ) returns LargeBinary @Core.MediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    /**
     * Reads records of one extracted API / program back from the Object Store
     * (skip / top over the stored pages) so they can be viewed in the UI.
     */
    action readExtractionRecords(
        extractionId : String(100),
        objectName   : String(200),
        skip         : Integer,
        top          : Integer
    ) returns ExtractionRecords;

    type ExtractionRecords {
        extractionId : String(100);
        objectName   : String(200);
        totalRecords : Integer;
        skip         : Integer;
        top          : Integer;
        records      : LargeString;     // JSON array of the source records
    }

    type VerifyExtractionResult {
        extractionId : String(100);
        status       : String(20);      // OK | CHANGED | NOT_FOUND
        filesChecked : Integer;
        mismatches   : LargeString;     // JSON
        message      : String(1000);
    }

    /**
     * A person reviews the AI proposal for one API / program:
     * CONFIRM, REJECT, or CHANGE (confirm with a different business object).
     */
    action reviewAssessment(
        sourceSystemId : String(100),
        sourceObject   : String(200),
        decision       : String(10),
        businessObject : String(200),
        comment        : String(1000)
    ) returns String;

    /**
     * Runs the AI assessment for the objects of the assessment scope that
     * are not assessed yet. Metadata of those objects is discovered first.
     * Only API / program names, descriptions and field metadata go to the
     * AI provider - no records.
     */
    action assessScope(
        sourceSystemId   : String(100),
        scopePrefixes    : many String(50),
        includeCustom    : Boolean,
        readOnly         : Boolean,
        businessApisOnly : Boolean,
        maxObjects       : Integer
    ) returns BusinessObjectAssessmentResult;

    type AssessmentScopeResult {
        sourceSystem      : String(100);
        adapterType       : String(50);
        discovered        : Integer;
        toAssess          : Integer;
        alreadyAssessed   : Integer;
        newToAssess       : Integer;
        batches           : Integer;
        estimatedInputTokens  : Integer;
        estimatedOutputTokens : Integer;
        steps             : LargeString;   // JSON: filter funnel
        candidates        : LargeString;   // JSON
        excluded          : LargeString;   // JSON: name + reason
        message           : String(1000);
    }

    action assessBusinessObjects(
        sourceSystemId : String(100),
        instructions   : LargeString
    ) returns BusinessObjectAssessmentResult;
    type BusinessObjectAssessmentResult {
        status          : String(40);
        sourceSystem    : String(100);
        objectsAssessed : Integer;
        objectsReused   : Integer;
        objectsFailed   : Integer;
        inputTokens     : Integer;
        outputTokens    : Integer;
        totalTokens     : Integer;
        assessedAt      : Timestamp;
        message         : String(1000);
    }

    type EntityDataResult {
    EntitySetName : String(255);
    ColumnsJson   : LargeString;
    RowsJson      : LargeString;
    Count         : Integer;
    HasMore : Boolean;
};

function getEntityData(
    serviceUrl    : String,
    entitySetName : String,
    top           : Integer,
    skip : Integer
) returns EntityDataResult;

   function getMetadata(
        serviceUrl : String
    ) returns MetadataResult;
    
}