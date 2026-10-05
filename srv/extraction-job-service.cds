using { MigrationService } from './migration-service';
using { migration.framework as fw } from '../db/extraction-job';

/*
 * Background extraction. A job starts at once and runs in the application; the caller asks for the
 * status. Part of the MigrationService, so the cockpit and Joule use the same base address.
 * The table is read only; every change goes through an action.
 */
extend service MigrationService with {

    @readonly entity ExtractionJobs as projection on fw.ExtractionJob;

    /**
     * Starts an extraction in the background and answers at once with the job (its ID is the extraction
     * ID). Without objectNames the CONFIRMED APIs of the business object are extracted. Only one
     * extraction of a business object runs at a time per source system.
     */
    action startExtraction(
        sourceSystemId      : String(100),
        businessObject      : String(200),
        objectNames         : many String(200),
        pageSize            : Integer,
        maxRecordsPerObject : Integer
    ) returns ExtractionJobInfo;

    /** Status of a job: by its ID, or the latest job of a business object (by name). */
    action getExtractionStatus(
        extractionId   : String(100),
        businessObject : String(200),
        sourceSystemId : String(100)
    ) returns ExtractionJobInfo;

    /** Asks a running job to stop. It stops after the current page; what is stored stays in the Object Store. */
    action cancelExtraction(
        extractionId   : String(100),
        businessObject : String(200),
        sourceSystemId : String(100)
    ) returns ExtractionJobInfo;

    /**
     * Continues an interrupted, cancelled, partial or failed job in the same extraction folder: APIs that
     * were stored completely are kept, the others are read again.
     */
    action resumeExtraction(
        extractionId   : String(100),
        businessObject : String(200),
        sourceSystemId : String(100)
    ) returns ExtractionJobInfo;

    type ExtractionJobInfo {
        extractionId    : String(100);
        status          : String(20);
        businessObject  : String(200);
        sourceSystemId  : String(100);
        startedAt       : String(40);
        finishedAt      : String(40);
        totalRecords    : Integer64;
        expectedRecords : Integer64;
        percent         : Integer;               // empty when the source cannot tell how many records it holds
        currentObject   : String(300);
        resumable       : Boolean;
        objects         : LargeString;           // JSON: per API { objectName, state, records, expected, pages }
        message         : String(2000);          // the state in plain words (for Joule and the screen)
    }

    /**
     * Puts entity sets of a confirmed API into the business object, so that the extraction reads them as well
     * (an entity set becomes the item 'API/EntitySet' next to the API itself). Without entitySets, the entity
     * sets that hold data are added. The person who calls decides: with confirm (default) the items are
     * confirmed at once, otherwise they wait for the review. Items that exist already are not changed.
     */
    action addEntitySets(
        sourceSystemId : String(100),
        businessObject : String(200),
        apiName        : String(200),
        entitySets     : many String(200),
        onlyWithData   : Boolean,
        confirm        : Boolean
    ) returns EntitySetResult;

    type EntitySetResult {
        sourceSystemId : String(100);
        businessObject : String(200);
        added          : Integer;
        kept           : Integer;
        skipped        : Integer;
        items          : LargeString;            // JSON: [{ apiName, entitySet, sourceObject, records, result, reviewStatus }]
        message        : String(5000);
    }

    /**
     * What one discovered object (an S/4 API, an M3 program) offers, in the words of its source: the entity sets of
     * an API, the read transactions of a program. Read only; nothing is extracted. Same answer for every source.
     */
    action describeSourceObject(
        sourceSystemId : String(100),
        objectName     : String(200)
    ) returns SourceObjectDescription;

    type SourceObjectDescription {
        objectName  : String(200);
        title       : String(200);
        description : String(1000);
        itemLabel   : String(200);
        items       : LargeString;           // JSON: [{ name, description, kind }]
        hiddenCount : Integer;               // items the migration never uses (for example M3 transactions that change data)
        note        : String(1000);
    }

    /**
     * How many records the source holds, per API and per entity set (read only). Tells how big an
     * extraction will be before it is started.
     */
    action countSourceRecords(
        sourceSystemId : String(100),
        businessObject : String(200),
        objectNames    : many String(200)
    ) returns SourceCountResult;

    type SourceCountResult {
        sourceSystemId : String(100);
        businessObject : String(200);
        rootRecords    : Integer64;              // sum over the root entity sets
        objects        : LargeString;            // JSON: [{ objectName, entitySets: [{ entitySet, isRoot, count, error }] }]
        message        : String(5000);
    }
}
