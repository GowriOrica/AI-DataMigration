namespace migration.orchestrator;

using {
    cuid,
    managed
} from '@sap/cds/common';


/**
 * ============================================================
 * MIGRATION RUN
 * ============================================================
 */
entity MigrationRun : cuid, managed {
    runId           : String(50) not null;

    sourceSystem    : String(100) not null;
    sourceType      : String(50);
    sourceInterface : String(50);

    targetSystem    : String(100) not null;
    targetType      : String(50);
    targetInterface : String(50);

    businessObject  : String(100);

    status          : String(40) default 'CREATED';
    currentStage    : String(50);

    startedAt       : Timestamp;
    completedAt     : Timestamp;

    errorCode       : String(50);
    errorMessage    : LargeString;
}


/**
 * ============================================================
 * SOURCE SYSTEM
 * ============================================================
 */
entity SourceSystem : cuid, managed {
    systemId    : String(100) not null;
    systemName  : String(200) not null;
    systemType  : String(50);
    description : LargeString;
    active      : Boolean default true;

    connections : Composition of many SourceConnection on connections.sourceSystem = $self;
    objects     : Composition of many SourceObject on objects.sourceSystem = $self;
}


/**
 * ============================================================
 * SOURCE CONNECTION
 * ============================================================
 */
entity SourceConnection : cuid, managed {
    connectionId                : String(100) not null;
    connectionName              : String(200) not null;
    interfaceType               : String(50) not null;
    endpointReference           : String(500);
    authenticationType          : String(50);
    adapterType                 : String(100);
    status                      : String(40) default 'UNKNOWN';

    discoveryPath               : String(255);
    metadataEndpointReference   : String(100);
    extractionEndpointReference : String(100);
    extractionPath              : String(255);

    lastTestedAt                : Timestamp;
    errorCode                   : String(50);
    errorMessage                : LargeString;

    sourceSystem                : Association to SourceSystem not null;
}


/**
 * ============================================================
 * SOURCE OBJECT
 * ============================================================
 */
entity SourceObject : cuid, managed {
    objectId       : String(100) not null;
    objectName     : String(200) not null;
    businessObject : String(100);
    objectType     : String(50);
    schemaVersion  : String(50);
    description    : LargeString;

    sourceSystem   : Association to SourceSystem not null;
    metadata       : Composition of many SourceMetadata on metadata.sourceObject = $self;
}


/**
 * ============================================================
 * SOURCE METADATA
 * ============================================================
 */
entity SourceMetadata : cuid, managed {
    metadataId     : String(100) not null;
    schemaVersion  : String(50);
    extractedAt    : Timestamp;
    recordCount    : Integer64;
    metadataStatus : String(40);

    sourceObject   : Association to SourceObject not null;
    fields         : Composition of many SourceField on fields.metadata = $self;
}


/**
 * ============================================================
 * SOURCE FIELD
 * ============================================================
 */
entity SourceField : cuid {
    fieldName   : String(200) not null;
    objectName  : String(100);
    dataType    : String(500);
    length      : Integer;
    precision   : Integer;
    scale       : Integer;
    nullable    : Boolean default true;
    description : LargeString;

    metadata    : Association to SourceMetadata;
}

entity MigrationAssessment : cuid, managed {

    sourceSystemId  : String(100) ;
    sourceObject    : String(200) ;

    // Identifies which version of source metadata was assessed
    metadataVersion : String(50);

    // AI assessment result
    businessObject  : String(200);
    component       : String(200);
    confidence      : Decimal(5,2);

    // Evidence and explanation produced by AI
    evidenceFields  : LargeString;
    reason          : LargeString;

    // AI execution information
    modelName       : String(100);
    promptVersion   : String(50);

    // Token/cost tracking
    inputTokens     : Integer;
    outputTokens    : Integer;
    totalTokens     : Integer;

    // Assessment lifecycle
    status          : String(40);
    assessedAt      : Timestamp;

    // Human review of the AI proposal (governance)
    reviewStatus    : String(20) default 'SUGGESTED';   // SUGGESTED | CONFIRMED | REJECTED
    reviewedBy      : String(255);
    reviewedAt      : Timestamp;
    reviewComment   : String(1000);
    originalBusinessObject : String(200);               // AI answer, kept when a person changes it
}


/**
 * ============================================================
 * RAW RECORD
 * ============================================================
 */
entity RawRecord : cuid, managed {
    runId            : String(50);
    batchId          : String(50);
    sourceSystem     : String(100);
    sourceType       : String(50);
    sourceInterface  : String(50);
    sourceObject     : String(100);
    schemaVersion    : String(50);
    sourceKey        : String(100);
    ingestionKey     : String(255);
    extractedAt      : Timestamp;
    ingestedAt       : Timestamp;
    payload          : LargeString;
    processingStatus : String(40);
    errorCode        : String(50);
    errorMessage     : LargeString;
}


/**
 * ============================================================
 * CANONICAL CUSTOMER
 * ============================================================
 */
entity CanonicalCustomer : cuid, managed {
    runId                     : String(100);
    batchId                   : String(100);
    sourceRecordId            : String(200);
    sourceSystem              : String(100);
    sourceObject              : String(100);
    sourceKey                 : String(100);

    externalId                : String(100);
    customerNumber            : String(100);
    name                      : String(255);
    address1                  : String(255);
    address2                  : String(255);
    city                      : String(100);
    postalCode                : String(50);
    country                   : String(10);
    phone                     : String(50);
    email                     : String(255);

    processingStatus          : String(40);
    canonicalPayload          : LargeString;
}


/**
 * ============================================================
 * TARGET SYSTEM
 * ============================================================
 */
entity TargetSystem : cuid, managed {
    systemId    : String(100) not null;
    systemName  : String(200) not null;
    systemType  : String(50);
    description : LargeString;
    active      : Boolean default true;

    connections : Composition of many TargetConnection on connections.targetSystem = $self;
    objects     : Composition of many TargetObject on objects.targetSystem = $self;
}


/**
 * ============================================================
 * TARGET CONNECTION
 * ============================================================
 */
entity TargetConnection : cuid, managed {
    connectionId       : String(100) not null;
    connectionName     : String(200) not null;
    interfaceType      : String(50) not null;
    endpointReference  : String(500);
    authenticationType : String(50);
    adapterType        : String(100);
    status             : String(40) default 'UNKNOWN';

    lastTestedAt       : Timestamp;
    errorCode          : String(50);
    errorMessage       : LargeString;

    targetSystem       : Association to TargetSystem not null;
}


/**
 * ============================================================
 * TARGET OBJECT
 * ============================================================
 */
entity TargetObject : cuid, managed {
    objectId       : String(100) not null;
    objectName     : String(200) not null;
    businessObject : String(100);
    objectType     : String(50);
    schemaVersion  : String(50);
    description    : LargeString;

    targetSystem   : Association to TargetSystem not null;
    metadata       : Composition of many TargetMetadata on metadata.targetObject = $self;
}


/**
 * ============================================================
 * TARGET METADATA
 * ============================================================
 */
entity TargetMetadata : cuid, managed {
    metadataId     : String(100) not null;
    schemaVersion  : String(50);
    extractedAt    : Timestamp;
    recordCount    : Integer64;
    metadataStatus : String(40);
    resourceId     : String(200);
    resourceName   : String(200);
    resourceType   : String(100);

    targetObject   : Association to TargetObject not null;
    fields         : Composition of many TargetField on fields.metadata = $self;
}


/**
 * ============================================================
 * TARGET FIELD
 * ============================================================
 */
entity TargetField : cuid {
    fieldName    : String(200) not null;
    dataType     : String(500);
    length       : Integer;
    precision    : Integer;
    scale        : Integer;
    nullable     : Boolean default true;
    mandatory    : Boolean default false;
    semanticType : String(100);
    description  : LargeString;

    metadata     : Association to TargetMetadata;
}