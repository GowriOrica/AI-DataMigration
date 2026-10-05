namespace migration.framework;

using {
    managed
} from '@sap/cds/common';


/**
 * ============================================================
 * EXTRACTION JOBS (background extraction)
 * ============================================================
 *
 * One row per extraction run. The ID is the extraction ID, so a job and its folder in the Object Store
 * (extractions/<ID>/) carry the same name. The data itself is in the Object Store; this row holds the
 * state: what is running, how far it is, who started it, whether it was cancelled or interrupted.
 *
 * Status:  QUEUED -> RUNNING -> COMPLETED | PARTIAL | FAILED | CANCELLED
 *          RUNNING that stops reporting (the application restarted) -> INTERRUPTED (can be resumed)
 */
type ExtractionJobStatus : String(20) enum { QUEUED; RUNNING; COMPLETED; PARTIAL; FAILED; CANCELLED; INTERRUPTED };

entity ExtractionJob : managed {
    key extractionId        : String(100);
        businessObject      : String(200) not null;
        sourceSystemId      : String(100) not null;
        status              : ExtractionJobStatus default 'QUEUED';
        objectNames         : LargeString;          // JSON: the APIs of this run
        pageSize            : Integer;
        maxRecordsPerObject : Integer;
        requestedBy         : String(255);
        startedAt           : Timestamp;
        finishedAt          : Timestamp;
        heartbeatAt         : Timestamp;            // last sign of life of the running application
        cancelRequested     : Boolean default false;
        resumeCount         : Integer default 0;
        expectedRecords     : Integer64;            // sum of the source counts, when the source can count
        totalRecords        : Integer64 default 0;
        totalPages          : Integer default 0;
        progress            : LargeString;          // JSON: per object { objectName, records, expected, pages, state }
        currentObject       : String(300);
        message             : String(2000);         // the last result or error in plain words
}
