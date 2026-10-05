namespace migration.framework;

using {
    cuid,
    managed
} from '@sap/cds/common';

using { migration.orchestrator.SourceObject } from './schema';


/**
 * ============================================================
 * CODE LISTS
 * ============================================================
 */
type ModelLayer     : String(20) enum { SOURCE; CANONICAL; TARGET };
type ModelStatus    : String(20) enum { DRAFT; IN_REVIEW; APPROVED; RETIRED };
type ModelOrigin    : String(20) enum { AI_ASSEMBLED; IMPORTED; MANUAL };
type Cardinality    : String(10) enum { ONE = '1'; ZERO_OR_ONE = '0..1'; ZERO_OR_MANY = '0..N'; ONE_OR_MANY = '1..N' };
type RelationKind   : String(20) enum { NAVIGATION; KEY_JOIN; EMBEDDED };
type MappingHop     : String(30) enum { SOURCE_TO_CANONICAL; CANONICAL_TO_TARGET };
type SuggestionStatus : String(20) enum { SUGGESTED; APPROVED; REJECTED; MODIFIED };
type SuggestionOrigin : String(20) enum { AI; HEURISTIC; MANUAL; REUSED };
type StructurePattern : String(20) enum { ONE_TO_ONE; JOIN; EXPLODE; PICK; AGGREGATE; PIVOT; FILTER; DERIVE };


/**
 * ============================================================
 * CATALOG
 * ============================================================
 *
 * Business concepts, independent of any system.
 */
entity BusinessObjectType : managed {
    key code         : String(60);          // BUSINESS_PARTNER
        name         : String(200);
        description  : LargeString;

        // JSON list of semantic tags that identify this business object,
        // used by AI identification, e.g. ["party.id","party.name","address.city"]
        signature    : LargeString;

        dependencies : Composition of many BusinessObjectDependency
                           on dependencies.type = $self;
        models       : Association to many BusinessObjectModel
                           on models.type = $self;
}

/**
 * Load-order dependency: `type` can only be loaded after `requires`.
 */
entity BusinessObjectDependency {
    key type     : Association to BusinessObjectType;
    key requires : Association to BusinessObjectType;
        note     : String(500);
}

/**
 * Controlled vocabulary shared by source, canonical and target models.
 * Matching fields by semantic tag instead of technical name is what
 * makes mapping source-independent.
 */
entity SemanticTag {
    key code        : String(120);           // address.city
        domain      : String(60);            // address
        description : String(500);
        dataClass   : String(40);            // ID | TEXT | CODE | AMOUNT | DATE | FLAG | NUMBER
        isPersonal  : Boolean default false; // GDPR / masking relevance
}


/**
 * ============================================================
 * MODEL LAYER
 * ============================================================
 *
 * The shape of one business object in one system and layer.
 */
entity BusinessObjectModel : cuid, managed {
    type          : Association to BusinessObjectType not null;
    layer         : ModelLayer not null;
    systemId      : String(100);             // null for CANONICAL
    name          : String(200) not null;
    version       : String(20) not null;
    status        : ModelStatus default 'DRAFT';
    origin        : ModelOrigin default 'MANUAL';
    description   : LargeString;

    structures    : Composition of many Structure
                        on structures.model = $self;
    relationships : Composition of many Relationship
                        on relationships.model = $self;
}

entity Structure : cuid {
    model        : Association to BusinessObjectModel not null;
    name         : String(200) not null;
    isRoot       : Boolean default false;
    sortOrder    : Integer;
    description  : LargeString;

    // Link to the discovered technical object (source/target layers only)
    sourceObject : Association to SourceObject;

    // JSON, adapter-specific: how to physically read this structure
    accessPath   : LargeString;

    fields       : Composition of many Field
                       on fields.structure = $self;
}

entity Relationship : cuid {
    model       : Association to BusinessObjectModel not null;
    parent      : Association to Structure not null;
    child       : Association to Structure not null;
    cardinality : Cardinality not null;
    kind        : RelationKind default 'NAVIGATION';

    // JSON: [{ "parent": "legacyKey", "child": "legacyKey" }]
    joinKeys    : LargeString;
}

entity Field : cuid {
    structure     : Association to Structure not null;
    name          : String(200) not null;
    sortOrder     : Integer;
    description   : LargeString;
    dataType      : String(100);
    length        : Integer;
    precision     : Integer;
    scale         : Integer;
    isKey         : Boolean default false;
    mandatory     : Boolean default false;

    semanticTag   : Association to SemanticTag;
    tagConfidence : Decimal(5, 2);           // 0-100
    tagOrigin     : SuggestionOrigin;        // HEURISTIC | AI | MANUAL
    tagReason     : LargeString;             // why this tag was chosen
    tagStatus     : SuggestionStatus;        // SUGGESTED | APPROVED | REJECTED | MODIFIED

    // JSON: fill rate, distinct count, patterns (from profiling)
    profile       : LargeString;
}


/**
 * ============================================================
 * MAPPING LAYER
 * ============================================================
 *
 * Tables are defined now so the model is complete; they are
 * populated from increment 5 (mapping suggestions) onwards.
 */
entity MappingSet : cuid, managed {
    fromModel         : Association to BusinessObjectModel not null;
    toModel           : Association to BusinessObjectModel not null;
    hop               : MappingHop not null;
    version           : String(20) not null;
    status            : ModelStatus default 'DRAFT';
    coverage          : LargeString;         // JSON: unmapped structures / fields at suggestion time
    approvedBy        : String(255);
    approvedAt        : Timestamp;

    structureMappings : Composition of many StructureMapping
                            on structureMappings.mappingSet = $self;
}

entity StructureMapping : cuid {
    mappingSet     : Association to MappingSet not null;
    toStructure    : Association to Structure not null;

    // JSON list of Structure IDs (N sources possible)
    fromStructures : LargeString;

    pattern        : StructurePattern not null;
    patternConfig  : LargeString;            // JSON
    confidence     : Decimal(5, 2);
    reason         : LargeString;
    status         : SuggestionStatus default 'SUGGESTED';

    fieldMappings  : Composition of many FieldMapping
                         on fieldMappings.structureMapping = $self;
}

entity FieldMapping : cuid {
    structureMapping : Association to StructureMapping not null;
    toField          : Association to Field not null;

    // JSON list of Field IDs (N:1 possible)
    fromFields       : LargeString;

    rule             : LargeString;          // JSON transformation rule
    confidence       : Decimal(5, 2);
    reason           : LargeString;
    origin           : SuggestionOrigin default 'AI';
    status           : SuggestionStatus default 'SUGGESTED';
    approvedBy       : String(255);
    approvedAt       : Timestamp;
}

/**
 * ============================================================
 * PREVIEW RUNS
 * ============================================================
 *
 * Result of previewMigration: approved mappings executed on source
 * data, nothing loaded. Kept for review and comparison in the UI.
 */
entity PreviewRun : cuid, managed {
    sourceModel          : Association to BusinessObjectModel;
    sourceToCanonicalSet : Association to MappingSet;
    canonicalToTargetSet : Association to MappingSet;
    instanceCount        : Integer;
    issueCount           : Integer;
    targetRowCounts      : String(1000);     // e.g. "GENERAL 4, ADDRESS 3, ..."
    message              : String(1000);
    scopeNote            : String(1000);
    archiveLocation      : String(1000);     // e.g. s3://<bucket>/migration-orchestrator/preview-runs/<id>/
    archiveStatus        : String(1000);     // ARCHIVED | FAILED: <reason>

    issues    : Composition of many PreviewIssue    on issues.run = $self;
    rows      : Composition of many PreviewRow      on rows.run = $self;
    documents : Composition of many PreviewDocument on documents.run = $self;
}

entity PreviewIssue : cuid {
    run         : Association to PreviewRun;
    instanceKey : String(200);
    hop         : MappingHop;
    structure   : String(200);
    entry       : Integer;
    field       : String(200);
    code        : String(40);
    message     : String(1000);
}

entity PreviewRow : cuid {
    run         : Association to PreviewRun;
    structure   : String(200);
    instanceKey : String(200);
    sortOrder   : Integer;
    summary     : String(2000);              // readable "FIELD=value · FIELD=value"
    content     : LargeString;               // JSON row
}

entity PreviewDocument : cuid {
    run         : Association to PreviewRun;
    instanceKey : String(200);
    summary     : String(2000);
    content     : LargeString;               // JSON canonical document
}

entity ValueMapping : cuid, managed {
    domain     : String(100) not null;       // PAYMENT_TERMS, COUNTRY, TAX_TYPE
    fromSystem : String(100) not null;
    toSystem   : String(100) not null;       // system ID or 'CANONICAL'
    fromValue  : String(255) not null;
    toValue    : String(255);
    status     : SuggestionStatus default 'SUGGESTED';
}
