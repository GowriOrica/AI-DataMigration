"use strict";

const path = require("path");
const cds = require("@sap/cds");

const LocalStorage = require("./LocalStorage");
const S3Storage = require("./S3Storage");

/**
 * ============================================================
 * STORAGE FACTORY
 * ============================================================
 *
 * Object Store when the app has an Object Store binding
 * (deployed: VCAP_SERVICES label "objectstore"; local: `cds bind ... --for company`),
 * otherwise a local folder (STORAGE_DIR, default <project>/.storage).
 *
 * The code using storage does not change between the two.
 */

const KEY_PREFIX = "migration-orchestrator/";

let instance = null;

function getStorage() {
    if (instance) {
        return instance;
    }

    const credentials = cds.env.requires?.objectstore?.credentials;

    instance = credentials
        ? new S3Storage(credentials, { prefix: KEY_PREFIX })
        : new LocalStorage(process.env.STORAGE_DIR || path.join(cds.root, ".storage"));

    return instance;
}

/** For tests: forget the cached instance. */
function resetStorage() {
    instance = null;
}

module.exports = {
    getStorage,
    resetStorage,
    LocalStorage,
    S3Storage
};
