/**
 * Generic Source Adapter Contract
 *
 * This class defines the standard contract that every source adapter
 * must implement.
 *
 * The framework must remain source-system agnostic.
 *
 * Examples of future adapters:
 * - M3
 * - REST
 * - OData
 * - SOAP
 * - Database
 * - SFTP
 * - File
 * - Event
 * - Existing ETL
 */

class SourceAdapter {

    constructor(connection) {
        this.connection = connection;
    }

    /**
     * Discover the source system.
     *
     * @returns {Promise<Object>}
     */
    async discover() {
        throw new Error("SourceAdapter.discover() must be implemented");
    }

    /**
     * Authenticate against the source system.
     *
     * Credentials must never be passed through prompts
     * or stored in application code.
     *
     * @returns {Promise<Object>}
     */
    async authenticate() {
        throw new Error("SourceAdapter.authenticate() must be implemented");
    }

    /**
     * Retrieve source-level metadata.
     *
     * @returns {Promise<Object>}
     */
    async getMetadata() {
        throw new Error("SourceAdapter.getMetadata() must be implemented");
    }

    /**
     * Discover business/data objects available in the source.
     *
     * @returns {Promise<Array>}
     */
    async discoverObjects() {
        throw new Error("SourceAdapter.discoverObjects() must be implemented");
    }

    /**
     * Retrieve schema for a specific source object.
     *
     * @param {string} objectName
     * @returns {Promise<Object>}
     */
    async getSchema(objectName) {
        throw new Error("SourceAdapter.getSchema() must be implemented");
    }

    /**
     * Retrieve the technical entity graph of a source object:
     * entity types (keys, properties) and the relationships between them
     * (navigation, cardinality, join keys).
     *
     * Returns null when the source system cannot describe relationships
     * itself (e.g. flat APIs); relationships are then proposed by AI.
     *
     * @param {string} objectName
     * @returns {Promise<Object|null>}
     */
    async getRelationships(objectName) {
        return null;
    }

    /**
     * Extract source data.
     *
     * @param {Object} request
     * @returns {Promise<Object>}
     */
    async extract(request) {
        throw new Error("SourceAdapter.extract() must be implemented");
    }

    /**
     * Extract incremental/delta data.
     *
     * @param {Object} request
     * @returns {Promise<Object>}
     */
    async getDelta(request) {
        throw new Error("SourceAdapter.getDelta() must be implemented");
    }

    /**
     * Get status of the source connection or extraction.
     *
     * @returns {Promise<Object>}
     */
    async getStatus() {
        throw new Error("SourceAdapter.getStatus() must be implemented");
    }

    /**
     * Normalize and handle adapter-specific errors.
     *
     * @param {Error|Object} error
     * @returns {Object}
     */
    handleError(error) {
        return {
            errorCode: "SOURCE_ADAPTER_ERROR",
            message: error?.message || "Unknown source adapter error",
            retryable: false
        };
    }
}

module.exports = SourceAdapter;