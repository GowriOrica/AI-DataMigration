using FrameworkService from './framework-service';

/**
 * ============================================================
 * MIGRATION WORKBENCH - FIORI ELEMENTS ANNOTATIONS
 * ============================================================
 *
 * List reports and object pages for the functional team:
 *   Business object models -> structures -> fields (meanings)
 *   Mapping sets -> structure mappings -> field mappings (review)
 *   Preview runs -> issues, target rows, canonical documents
 *   Value mappings
 */


/*
 * ---------- Business object models ----------
 */
annotate FrameworkService.BusinessObjectModels with @(
    UI.HeaderInfo: {
        TypeName      : 'Business Object Model',
        TypeNamePlural: 'Business Object Models',
        Title         : { Value: name },
        Description   : { Value: layer }
    },
    UI.SelectionFields: [ type_code, layer, systemId, status ],
    UI.LineItem: [
        { Value: type_code, Label: 'Business Object' },
        { Value: layer,     Label: 'Layer' },
        { Value: systemId,  Label: 'System' },
        { Value: name,      Label: 'Model' },
        { Value: version,   Label: 'Version' },
        { Value: status,    Label: 'Status' },
        { Value: origin,    Label: 'Origin' },
        { Value: modifiedAt, Label: 'Changed' }
    ],
    UI.Identification: [
        { $Type: 'UI.DataFieldForAction', Action: 'FrameworkService.tagFields',  Label: 'Tag Fields' },
        { $Type: 'UI.DataFieldForAction', Action: 'FrameworkService.runPreview', Label: 'Preview Migration' }
    ],
    UI.FieldGroup #General: {
        Data: [
            { Value: type_code,   Label: 'Business Object' },
            { Value: layer,       Label: 'Layer' },
            { Value: systemId,    Label: 'System' },
            { Value: version,     Label: 'Version' },
            { Value: status,      Label: 'Status' },
            { Value: origin,      Label: 'Origin' },
            { Value: description, Label: 'Description' }
        ]
    },
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'General',       Label: 'General',         Target: '@UI.FieldGroup#General' },
        { $Type: 'UI.ReferenceFacet', ID: 'Structures',    Label: 'Structures',      Target: 'structures/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'Relationships', Label: 'Relationships',   Target: 'relationships/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'MappingSets',   Label: 'Mapping Sets (from this model)', Target: 'mappingSets/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'PreviewRuns',   Label: 'Preview Runs',    Target: 'previewRuns/@UI.LineItem' }
    ]
);

annotate FrameworkService.BusinessObjectModels actions {
    tagFields  @Common.SideEffects: { TargetEntities: [ '_it/structures' ] };
    runPreview @Common.SideEffects: { TargetEntities: [ '_it/previewRuns' ] };
};


/*
 * ---------- Structures / relationships / fields ----------
 */
annotate FrameworkService.Structures with @(
    UI.HeaderInfo: {
        TypeName      : 'Structure',
        TypeNamePlural: 'Structures',
        Title         : { Value: name },
        Description   : { Value: description }
    },
    UI.LineItem: [
        { Value: sortOrder,   Label: '#' },
        { Value: name,        Label: 'Structure' },
        { Value: isRoot,      Label: 'Root' },
        { Value: description, Label: 'Description' }
    ],
    UI.FieldGroup #General: {
        Data: [
            { Value: name,        Label: 'Structure' },
            { Value: isRoot,      Label: 'Root' },
            { Value: description, Label: 'Description' },
            { Value: accessPath,  Label: 'Access Path (how the adapter reads it)' }
        ]
    },
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'General', Label: 'General', Target: '@UI.FieldGroup#General' },
        { $Type: 'UI.ReferenceFacet', ID: 'Fields',  Label: 'Fields',  Target: 'fields/@UI.LineItem' }
    ]
);

annotate FrameworkService.Relationships with @(
    UI.LineItem: [
        { Value: parent.name, Label: 'Parent' },
        { Value: child.name,  Label: 'Child' },
        { Value: cardinality, Label: 'Cardinality' },
        { Value: kind,        Label: 'Kind' },
        { Value: joinKeys,    Label: 'Join Keys' }
    ]
);

annotate FrameworkService.Fields with @(
    UI.HeaderInfo: {
        TypeName      : 'Field',
        TypeNamePlural: 'Fields',
        Title         : { Value: name },
        Description   : { Value: description }
    },
    UI.SelectionFields: [ semanticTag_code, tagStatus, tagOrigin ],
    UI.LineItem: [
        { Value: name,             Label: 'Field' },
        { Value: description,      Label: 'Description' },
        { Value: dataType,         Label: 'Type' },
        { Value: length,           Label: 'Length' },
        { Value: isKey,            Label: 'Key' },
        { Value: mandatory,        Label: 'Mandatory' },
        { Value: semanticTag_code, Label: 'Meaning' },
        { Value: tagConfidence,    Label: 'Confidence' },
        { Value: tagOrigin,        Label: 'Tagged By' },
        { Value: tagStatus,        Label: 'Tag Status' },
        { Value: tagReason,        Label: 'Why' }
    ]
);


/*
 * ---------- Mapping sets ----------
 */
annotate FrameworkService.MappingSets with @(
    UI.HeaderInfo: {
        TypeName      : 'Mapping Set',
        TypeNamePlural: 'Mapping Sets',
        Title         : { Value: hop },
        Description   : { Value: status }
    },
    UI.LineItem: [
        { Value: fromModel.name, Label: 'From Model' },
        { Value: toModel.name,   Label: 'To Model' },
        { Value: hop,            Label: 'Hop' },
        { Value: version,        Label: 'Version' },
        { Value: status,         Label: 'Status' },
        { Value: approvedBy,     Label: 'Approved By' },
        { Value: approvedAt,     Label: 'Approved At' }
    ],
    UI.Identification: [
        { $Type: 'UI.DataFieldForAction', Action: 'FrameworkService.approveSet', Label: 'Approve Mapping Set' }
    ],
    UI.FieldGroup #General: {
        Data: [
            { Value: fromModel.name, Label: 'From Model' },
            { Value: toModel.name,   Label: 'To Model' },
            { Value: hop,            Label: 'Hop' },
            { Value: version,        Label: 'Version' },
            { Value: status,         Label: 'Status' },
            { Value: approvedBy,     Label: 'Approved By' },
            { Value: approvedAt,     Label: 'Approved At' }
        ]
    },
    UI.FieldGroup #Coverage: {
        Data: [
            { Value: coverage, Label: 'Open points at suggestion time (unmapped structures / fields)' }
        ]
    },
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'General',           Label: 'General',            Target: '@UI.FieldGroup#General' },
        { $Type: 'UI.ReferenceFacet', ID: 'StructureMappings', Label: 'Structure Mappings', Target: 'structureMappings/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'Coverage',          Label: 'Open Points',        Target: '@UI.FieldGroup#Coverage' }
    ]
);

annotate FrameworkService.MappingSets actions {
    approveSet @Common.SideEffects: { TargetProperties: [ '_it/status', '_it/approvedBy', '_it/approvedAt' ], TargetEntities: [ '_it/structureMappings' ] };
};


/*
 * ---------- Structure mappings ----------
 */
annotate FrameworkService.StructureMappings with @(
    UI.HeaderInfo: {
        TypeName      : 'Structure Mapping',
        TypeNamePlural: 'Structure Mappings',
        Title         : { Value: toStructure.name },
        Description   : { Value: pattern }
    },
    UI.LineItem: [
        { Value: toStructure.name, Label: 'Target Structure' },
        { Value: fromStructures,   Label: 'From' },
        { Value: pattern,          Label: 'Pattern' },
        { Value: patternConfig,    Label: 'Configuration' },
        { Value: confidence,       Label: 'Confidence' },
        { Value: status,           Label: 'Status' },
        { Value: reason,           Label: 'Why' },
        { $Type: 'UI.DataFieldForAction', Action: 'FrameworkService.approveMapping', Label: 'Approve' },
        { $Type: 'UI.DataFieldForAction', Action: 'FrameworkService.rejectMapping',  Label: 'Reject' }
    ],
    UI.Identification: [
        { $Type: 'UI.DataFieldForAction', Action: 'FrameworkService.approveMapping', Label: 'Approve' },
        { $Type: 'UI.DataFieldForAction', Action: 'FrameworkService.rejectMapping',  Label: 'Reject' }
    ],
    UI.FieldGroup #General: {
        Data: [
            { Value: toStructure.name, Label: 'Target Structure' },
            { Value: fromStructures,   Label: 'From' },
            { Value: pattern,          Label: 'Pattern' },
            { Value: patternConfig,    Label: 'Configuration' },
            { Value: confidence,       Label: 'Confidence' },
            { Value: status,           Label: 'Status' },
            { Value: reason,           Label: 'Why' }
        ]
    },
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'General',       Label: 'General',        Target: '@UI.FieldGroup#General' },
        { $Type: 'UI.ReferenceFacet', ID: 'FieldMappings', Label: 'Field Mappings', Target: 'fieldMappings/@UI.LineItem' }
    ]
);

annotate FrameworkService.StructureMappings actions {
    approveMapping @Common.SideEffects: { TargetProperties: [ '_it/status' ] };
    rejectMapping  @Common.SideEffects: { TargetProperties: [ '_it/status' ] };
};


/*
 * ---------- Field mappings ----------
 */
annotate FrameworkService.FieldMappings with @(
    UI.HeaderInfo: {
        TypeName      : 'Field Mapping',
        TypeNamePlural: 'Field Mappings',
        Title         : { Value: toField.name },
        Description   : { Value: status }
    },
    UI.LineItem: [
        { Value: toField.name, Label: 'Target Field' },
        { Value: fromFields,   Label: 'From' },
        { Value: rule,         Label: 'Rule' },
        { Value: confidence,   Label: 'Confidence' },
        { Value: origin,       Label: 'Origin' },
        { Value: status,       Label: 'Status' },
        { Value: approvedBy,   Label: 'Decided By' },
        { Value: reason,       Label: 'Why' },
        { $Type: 'UI.DataFieldForAction', Action: 'FrameworkService.approveMapping', Label: 'Approve' },
        { $Type: 'UI.DataFieldForAction', Action: 'FrameworkService.rejectMapping',  Label: 'Reject' }
    ]
);

annotate FrameworkService.FieldMappings actions {
    approveMapping @Common.SideEffects: { TargetProperties: [ '_it/status', '_it/approvedBy' ] };
    rejectMapping  @Common.SideEffects: { TargetProperties: [ '_it/status', '_it/approvedBy' ] };
};


/*
 * ---------- Preview runs ----------
 */
annotate FrameworkService.PreviewRuns with @(
    UI.HeaderInfo: {
        TypeName      : 'Preview Run',
        TypeNamePlural: 'Preview Runs',
        Title         : { Value: createdAt },
        Description   : { Value: targetRowCounts }
    },
    UI.LineItem: [
        { Value: createdAt,       Label: 'Run At' },
        { Value: instanceCount,   Label: 'Business Objects' },
        { Value: issueCount,      Label: 'Issues' },
        { Value: targetRowCounts, Label: 'Target Rows' },
        { Value: message,         Label: 'Result' }
    ],
    UI.FieldGroup #General: {
        Data: [
            { Value: createdAt,       Label: 'Run At' },
            { Value: instanceCount,   Label: 'Business Objects' },
            { Value: issueCount,      Label: 'Issues' },
            { Value: targetRowCounts, Label: 'Target Rows' },
            { Value: message,         Label: 'Result' },
            { Value: scopeNote,       Label: 'Scope' },
            { Value: archiveStatus,   Label: 'Archive' },
            { Value: archiveLocation, Label: 'Archive Location (files)' }
        ]
    },
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'General',   Label: 'Summary',             Target: '@UI.FieldGroup#General' },
        { $Type: 'UI.ReferenceFacet', ID: 'Issues',    Label: 'Issues',              Target: 'issues/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'Rows',      Label: 'Target Rows',         Target: 'rows/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'Documents', Label: 'Canonical Documents', Target: 'documents/@UI.LineItem' }
    ]
);

annotate FrameworkService.PreviewIssues with @(
    UI.LineItem: [
        { Value: instanceKey, Label: 'Business Object' },
        { Value: hop,         Label: 'Hop' },
        { Value: structure,   Label: 'Structure' },
        { Value: field,       Label: 'Field' },
        { Value: code,        Label: 'Issue' },
        { Value: message,     Label: 'Message' }
    ]
);

annotate FrameworkService.PreviewRows with @(
    UI.LineItem: [
        { Value: structure,   Label: 'Target Structure' },
        { Value: instanceKey, Label: 'Business Object' },
        { Value: summary,     Label: 'Row' }
    ]
);

annotate FrameworkService.PreviewDocuments with @(
    UI.LineItem: [
        { Value: instanceKey, Label: 'Business Object' },
        { Value: summary,     Label: 'Canonical (root fields)' }
    ]
);


/*
 * ---------- Value mappings ----------
 */
annotate FrameworkService.ValueMappings with @(
    UI.HeaderInfo: {
        TypeName      : 'Value Mapping',
        TypeNamePlural: 'Value Mappings',
        Title         : { Value: domain },
        Description   : { Value: fromValue }
    },
    UI.SelectionFields: [ domain, fromSystem, toSystem, status ],
    UI.LineItem: [
        { Value: domain,     Label: 'Domain' },
        { Value: fromSystem, Label: 'From System' },
        { Value: fromValue,  Label: 'From Value' },
        { Value: toSystem,   Label: 'To System' },
        { Value: toValue,    Label: 'To Value' },
        { Value: status,     Label: 'Status' },
        { Value: modifiedBy, Label: 'Changed By' }
    ]
);


/*
 * ---------- Field labels (filters, headers, dialogs) ----------
 */
annotate FrameworkService.BusinessObjectModels with {
    type        @title: 'Business Object';
    layer       @title: 'Layer';
    systemId    @title: 'System';
    name        @title: 'Model';
    version     @title: 'Version';
    status      @title: 'Status';
    origin      @title: 'Origin';
    description @title: 'Description';
};

annotate FrameworkService.Fields with {
    semanticTag @title: 'Meaning';
    tagStatus   @title: 'Tag Status';
    tagOrigin   @title: 'Tagged By';
};

annotate FrameworkService.ValueMappings with {
    domain     @title: 'Domain';
    fromSystem @title: 'From System';
    toSystem   @title: 'To System';
    fromValue  @title: 'From Value';
    toValue    @title: 'To Value';
    status     @title: 'Status';
};

annotate FrameworkService.MappingSets with actions {
    approveSet(approvePending @title: 'Also approve all open suggestions');
};

annotate FrameworkService.BusinessObjectModels with actions {
    runPreview(limit @title: 'Maximum number of business objects');
};


/*
 * ---------- Storage browser (Object Store or local folder) ----------
 */
annotate FrameworkService.StorageFolders with @(
    UI.HeaderInfo: {
        TypeName      : 'Storage Folder',
        TypeNamePlural: 'Storage',
        Title         : { Value: description },
        Description   : { Value: storage }
    },
    UI.LineItem: [
        { Value: description, Label: 'Folder' },
        { Value: fileCount,   Label: 'Files' },
        { Value: sizeText,    Label: 'Size' },
        { Value: lastWrite,   Label: 'Last Write' },
        { Value: storage,     Label: 'Storage' }
    ],
    UI.FieldGroup #General: {
        Data: [
            { Value: storage,   Label: 'Storage' },
            { Value: folder,    Label: 'Folder Path' },
            { Value: fileCount, Label: 'Files' },
            { Value: sizeText,  Label: 'Size' },
            { Value: totalSize, Label: 'Size (bytes)' },
            { Value: lastWrite, Label: 'Last Write' }
        ]
    },
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'General', Label: 'Summary', Target: '@UI.FieldGroup#General' },
        { $Type: 'UI.ReferenceFacet', ID: 'Files',   Label: 'Files',   Target: 'files/@UI.LineItem' }
    ]
);

annotate FrameworkService.StoredFiles with @(
    UI.HeaderInfo: {
        TypeName      : 'File',
        TypeNamePlural: 'Files',
        Title         : { Value: name },
        Description   : { Value: folder }
    },
    UI.LineItem: [
        { Value: folder,       Label: 'Folder' },
        { Value: name,         Label: 'File' },
        { Value: fileType,     Label: 'Type' },
        { Value: sizeText,     Label: 'Size' },
        { Value: lastModified, Label: 'Written At' }
    ],
    UI.FieldGroup #General: {
        Data: [
            { Value: path,         Label: 'Path' },
            { Value: fileType,     Label: 'Type' },
            { Value: sizeText,     Label: 'Size' },
            { Value: size,         Label: 'Size (bytes)' },
            { Value: lastModified, Label: 'Written At' }
        ]
    },
    UI.FieldGroup #Content: {
        Data: [ { Value: content, Label: 'Content (compressed files are shown unpacked)' } ]
    },
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'General', Label: 'File',    Target: '@UI.FieldGroup#General' },
        { $Type: 'UI.ReferenceFacet', ID: 'Content', Label: 'Content', Target: '@UI.FieldGroup#Content' }
    ]
);

annotate FrameworkService.StoredFiles with {
    content @UI.MultiLineText;
};
