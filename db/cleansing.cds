namespace migration.framework;

using {
    cuid,
    managed
} from '@sap/cds/common';


/**
 * ============================================================
 * CLEANSING RULE LIBRARY
 * ============================================================
 *
 * The cleansing rules of the functional team, per business object.
 *
 * A rule set is a VERSION of all the rules of one business object. It is created as a draft (on the
 * screen or from an Excel upload), reviewed, and approved as a whole: who approved and when is kept.
 * An approved set never changes; a change is a new version. Only the approved set is applied to
 * real runs. A preview may use a draft.
 *
 * Code conversions (the rule VALUE_MAP) are not stored here: they use the existing ValueMapping table
 * (domain, from system, from value, to value, status).
 */
type RuleSetStatus : String(20) enum { DRAFT; APPROVED; SUPERSEDED };

entity CleansingRuleSet : cuid, managed {
    businessObject : String(200) not null;
    version        : Integer not null;
    status         : RuleSetStatus default 'DRAFT';
    origin         : String(20);            // SCREEN | EXCEL | COPY
    note           : String(1000);
    fileKey        : String(500);           // the uploaded Excel in the Object Store, if any
    ruleCount      : Integer default 0;
    approvedBy     : String(255);
    approvedAt     : Timestamp;
    rules          : Composition of many CleansingRule on rules.ruleSet = $self;
}

entity CleansingRule : cuid {
    ruleSet      : Association to CleansingRuleSet;
    ruleId       : String(50) not null;     // BP-001
    sourceSystem : String(100);             // S4SOURCE01, M3, * = every system
    sourceEntity : String(300);             // API / entity set, program.transaction, * = every entity
    field        : String(200);             // technical field name, * = every text field, empty for Select rules
    level        : String(20) default 'Source';
    ruleGroup    : String(20);              // Standardise | Convert | Default | Derive | Select | Validate
    ruleType     : String(50) not null;     // TRIM, DATE_TO_ISO, ...
    parameter    : String(1000);
    condition    : String(1000);
    sortOrder    : Integer default 1;
    onFailure    : String(10);              // ERROR | WARNING (Validate rules)
    reason       : String(1000);
    owner        : String(100);
    status       : String(20);              // Draft | Approved
}
