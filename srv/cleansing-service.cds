using { MigrationService } from './migration-service';
using { migration.framework as fw } from '../db/cleansing';

/*
 * Cleansing rules of the functional team, kept as versions per business object.
 * Part of the MigrationService, so the cockpit and Joule use the same base address.
 * The tables are read only; every change goes through an action (draft, approve, new version).
 */
extend service MigrationService with {

    @readonly entity CleansingRuleSets as projection on fw.CleansingRuleSet;
    @readonly entity CleansingRules    as projection on fw.CleansingRule;

    /**
     * Stores the rules of a business object as a new DRAFT version (from the screen or from an uploaded
     * Excel). Every row is checked first; if any row is wrong nothing is stored and the answer lists
     * every problem with its row. rules is a JSON array of rows (RuleID, Source system, Entity, Field ...).
     */
    action importCleansingRules(
        businessObject : String(200),
        rules          : LargeString,
        origin         : String(20),
        note           : String(1000),
        fileKey        : String(500)
    ) returns CleansingImportResult;

    type CleansingImportResult {
        status    : String(20);        // CREATED | REJECTED
        ruleSetId : UUID;
        version   : Integer;
        accepted  : Integer;
        errors    : LargeString;       // JSON: [{ row, ruleId, messages }]
        message   : String(2000);
    }

    /** Adds or changes ONE rule in a draft version. rule is a JSON object (one row). */
    action upsertCleansingRule(
        ruleSetId : UUID,
        rule      : LargeString
    ) returns CleansingRuleSetInfo;

    /** Removes one rule from a draft version. */
    action deleteCleansingRule(
        ruleSetId : UUID,
        ruleId    : String(50)
    ) returns CleansingRuleSetInfo;

    /** Approves a draft version. The approved version before it becomes SUPERSEDED. */
    action approveCleansingRules(
        ruleSetId : UUID
    ) returns CleansingRuleSetInfo;

    /** Copies the latest version of a business object into a new DRAFT, to change it. */
    action newCleansingRulesVersion(
        businessObject : String(200)
    ) returns CleansingRuleSetInfo;

    type CleansingRuleSetInfo {
        ruleSetId      : UUID;
        businessObject : String(200);
        version        : Integer;
        status         : String(20);
        ruleCount      : Integer;
        message        : String(2000);
    }

    /**
     * What the rules would do on the extracted data of a business object: per API and per rule how many
     * values would change, how many records are left out, how many issues, with before / after examples.
     * Nothing is written, not to the extraction and not to the source. Uses the latest extraction, the
     * given rule set, the latest draft or approved set of the business object, or the rules passed in
     * rules (a rule that is being edited and not saved yet).
     */
    action previewCleansingRules(
        businessObject : String(200),
        ruleSetId      : UUID,
        extractionId   : String(100),
        objectName     : String(200),
        sourceSystemId : String(100),
        rules          : LargeString
    ) returns CleansingPreviewResult;

    type CleansingPreviewResult {
        extractionId   : String(100);
        businessObject : String(200);
        ruleSetId      : UUID;
        ruleSetVersion : Integer;
        ruleSetStatus  : String(20);
        message        : String(5000);   // the effect in plain words
        objects        : LargeString;    // JSON: per API the details
    }
}
