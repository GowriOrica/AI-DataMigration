using { MigrationService } from './migration-service';

/*
 * Object Store administration: what is stored, how much, and a folder view like a file explorer.
 * Read only; part of the MigrationService, so the cockpit and Joule use the same base address.
 */
extend service MigrationService with {

    /**
     * Summary of the whole Object Store: total files and size, per area (extractions, exports ...),
     * one row per extraction (business object, source, records, files, size, exports) and the problems
     * found (extractions without a manifest, failed or partial extractions, files missing from a manifest).
     */
    action getObjectStoreOverview() returns ObjectStoreOverview;

    type ObjectStoreOverview {
        storageKind    : String(20);        // OBJECT_STORE | LOCAL
        location       : String(1000);
        region         : String(50);
        totalFiles     : Integer;
        totalBytes     : Integer64;
        sizeText       : String(40);
        lastWrite      : Timestamp;
        extractionCount : Integer;
        exportCount    : Integer;
        problemCount   : Integer;
        areas          : LargeString;       // JSON: [{ area, label, files, bytes, sizeText, items }]
        extractions    : LargeString;       // JSON: one row per extraction
        problems       : LargeString;       // JSON: [{ type, key, message }]
        message        : String(2000);
    }

    /**
     * One level of the Object Store, like opening a folder in a file explorer: its sub folders (with
     * the number of files and the size inside) and its files. prefix is '' (the top) or a folder
     * that ends with '/'.
     */
    action browseObjectStore(
        prefix : String(1000)
    ) returns ObjectStoreFolder;

    type ObjectStoreFolder {
        prefix  : String(1000);
        parent  : String(1000);
        crumbs  : LargeString;              // JSON: [{ name, prefix }] from the top to this folder
        folders : LargeString;              // JSON: [{ name, prefix, files, bytes, sizeText, lastModified, description }]
        files   : LargeString;              // JSON: [{ name, key, bytes, sizeText, lastModified, type }]
        fileCount   : Integer;              // files in this folder and below
        totalBytes  : Integer64;
        sizeText    : String(40);
    }

    /**
     * Shows what is inside a file: a manifest as formatted JSON, the first records of a data file,
     * or a note for other files.
     */
    action previewObjectStoreFile(
        fileKey : String(1000)
    ) returns ObjectStoreFilePreview;

    type ObjectStoreFilePreview {
        fileKey   : String(1000);
        fileName  : String(300);
        type      : String(40);
        bytes     : Integer64;
        records   : Integer;                // records in the file (data files)
        text      : LargeString;            // the content that is shown
        truncated : Boolean;
    }

    /** A link to download one file straight from the Object Store, valid for 15 minutes. */
    action getObjectStoreFileLink(
        fileKey : String(1000)
    ) returns ObjectStoreFileLink;

    type ObjectStoreFileLink {
        fileKey            : String(1000);
        fileName           : String(300);
        url                : String(4000);
        expiresInMinutes   : Integer;
        message            : String(1000);
    }
}
