const SourceAdapter = require("./SourceAdapter");

/**
 * ============================================================
 * SYNTHETIC SOURCE ADAPTER
 * ============================================================
 *
 * Generic technical proof adapter.
 *
 * IMPORTANT:
 * The adapter itself contains no Customer-specific discovery
 * logic and no Customer-specific schema mapping.
 *
 * The synthetic dataset is only a temporary POC data provider.
 *
 * Real adapters will later obtain metadata/schema/data directly
 * from their source systems.
 * ============================================================
 */

class SyntheticSourceAdapter extends SourceAdapter {

    constructor(connection) {

        super(connection);

        this.adapterType = "Synthetic";

        /*
         * Synthetic POC data provider.
         *
         * This is deliberately separated from the adapter methods.
         * The adapter methods only consume the provider output.
         */
        this.sourceDefinition =
            this.connection.syntheticSourceDefinition ||
            SyntheticSourceAdapter.getDefaultDefinition();
    }


    /**
     * ============================================================
     * DISCOVER
     * ============================================================
     */
    async discover() {

        return {
            systemId: this.connection.systemId,
            systemName: this.connection.systemName,
            systemType: this.connection.systemType,
            interfaceType: this.connection.interfaceType,
            adapterType: this.adapterType,
            status: "AVAILABLE"
        };
    }


    /**
     * ============================================================
     * AUTHENTICATE
     * ============================================================
     */
    async authenticate() {

        return {
            status: "AUTHENTICATED",
            authenticationType:
                this.connection.authenticationType,
            message: "Synthetic authentication successful"
        };
    }


    /**
     * ============================================================
     * GET METADATA
     * ============================================================
     */
    async getMetadata() {

        return {
            systemId: this.connection.systemId,
            systemName: this.connection.systemName,
            systemType: this.connection.systemType,
            interfaceType: this.connection.interfaceType,
            adapterType: this.adapterType,

            metadataVersion:
                this.sourceDefinition.metadataVersion || "1.0",

            metadataStatus: "AVAILABLE"
        };
    }


    /**
     * ============================================================
     * DISCOVER OBJECTS
     * ============================================================
     *
     * Objects are resolved from the source definition.
     *
     * There is no:
     *
     * if (objectName === "Customer")
     *
     * logic here.
     */
    async discoverObjects() {

        const objects =
            Array.isArray(this.sourceDefinition.objects)
                ? this.sourceDefinition.objects
                : [];

        return objects.map((object) => ({

            objectName:
                object.objectName,

            businessObject:
                object.businessObject || null,

            objectType:
                object.objectType || null,

            schemaVersion:
                object.schemaVersion ||
                this.sourceDefinition.metadataVersion ||
                "1.0",

            description:
                object.description || null
        }));
    }


    /**
     * ============================================================
     * GET SCHEMA
     * ============================================================
     */
    async getSchema(objectName) {

        if (!objectName) {
            throw new Error(
                "objectName is required"
            );
        }

        const object =
            this._findObject(objectName);

        if (!object) {
            throw new Error(
                `Synthetic source object '${objectName}' is not available`
            );
        }

        return {

            objectName:
                object.objectName,

            businessObject:
                object.businessObject || null,

            schemaVersion:
                object.schemaVersion ||
                this.sourceDefinition.metadataVersion ||
                "1.0",

            fields:
                Array.isArray(object.fields)
                    ? object.fields
                    : []
        };
    }


    /**
     * ============================================================
     * EXTRACT
     * ============================================================
     *
     * Supports the generic request structure:
     *
     * extract({
     *     objectName,
     *     runId,
     *     batchId
     * })
     *
     * Also supports the old calling style:
     *
     * extract(objectName, {
     *     runId,
     *     batchId
     * })
     *
     * This compatibility prevents existing service logic from
     * breaking while we refactor the framework.
     */
    async extract(request = {}, legacyOptions = {}) {

        /*
         * Support both invocation styles.
         */
        if (typeof request === "string") {

            request = {
                objectName: request,
                ...(legacyOptions || {})
            };
        }


        const objectName =
            request.objectName;


        if (!objectName) {
            throw new Error(
                "objectName is required"
            );
        }


        const object =
            this._findObject(objectName);


        if (!object) {
            throw new Error(
                `Synthetic source object '${objectName}' is not available`
            );
        }


        const records =
            Array.isArray(object.records)
                ? object.records
                : [];


        return {

            runId:
                request.runId || null,

            batchId:
                request.batchId || null,

            source: {

                system:
                    this.connection.systemId,

                type:
                    this.connection.systemType,

                interface:
                    this.connection.interfaceType,

                object:
                    objectName
            },

            schemaVersion:
                object.schemaVersion ||
                this.sourceDefinition.metadataVersion ||
                "1.0",

            records,

            metadata: {

                extractedAt:
                    new Date().toISOString(),

                recordCount:
                    records.length
            }
        };
    }


    /**
     * ============================================================
     * GET DELTA
     * ============================================================
     */
    async getDelta(request = {}, legacyOptions = {}) {

        if (typeof request === "string") {

            request = {
                objectName: request,
                ...(legacyOptions || {})
            };
        }


        const objectName =
            request.objectName;


        if (!objectName) {
            throw new Error(
                "objectName is required"
            );
        }


        const object =
            this._findObject(objectName);


        if (!object) {
            throw new Error(
                `Synthetic source object '${objectName}' is not available`
            );
        }


        const records =
            Array.isArray(object.deltaRecords)
                ? object.deltaRecords
                : [];


        return {

            runId:
                request.runId || null,

            batchId:
                request.batchId || null,

            source: {

                system:
                    this.connection.systemId,

                type:
                    this.connection.systemType,

                interface:
                    this.connection.interfaceType,

                object:
                    objectName
            },

            schemaVersion:
                object.schemaVersion ||
                this.sourceDefinition.metadataVersion ||
                "1.0",

            records,

            metadata: {

                extractedAt:
                    new Date().toISOString(),

                recordCount:
                    records.length,

                delta: true
            }
        };
    }


    /**
     * ============================================================
     * GET STATUS
     * ============================================================
     */
    async getStatus() {

        return {

            status: "CONNECTED",

            adapterType:
                this.adapterType,

            connectionId:
                this.connection.connectionId,

            checkedAt:
                new Date().toISOString()
        };
    }


    /**
     * ============================================================
     * HANDLE ERROR
     * ============================================================
     */
    handleError(error) {

        return {

            errorCode:
                "SYNTHETIC_SOURCE_ERROR",

            message:
                error?.message ||
                "Synthetic source error",

            retryable:
                false
        };
    }


    /**
     * ============================================================
     * INTERNAL OBJECT LOOKUP
     * ============================================================
     */
    _findObject(objectName) {

        const objects =
            Array.isArray(this.sourceDefinition.objects)
                ? this.sourceDefinition.objects
                : [];

        return objects.find(
            object =>
                object.objectName === objectName
        );
    }


    /**
     * ============================================================
     * DEFAULT POC DEFINITION
     * ============================================================
     *
     * This is ONLY temporary synthetic test data.
     *
     * It is NOT framework logic.
     *
     * When we connect M3, this definition disappears and the
     * real M3 adapter obtains metadata/data from M3.
     * ============================================================
     */
    static getDefaultDefinition() {

        return {

            metadataVersion: "1.0",

            objects: [

                {
                    objectName: "Customer",

                    businessObject: "Customer",

                    objectType: "MASTER_DATA",

                    schemaVersion: "1.0",

                    description:
                        "Synthetic customer master data for POC",

                    fields: [

                        {
                            fieldName: "customerId",
                            dataType: "String",
                            nullable: false,
                            description:
                                "Source customer identifier"
                        },

                        {
                            fieldName: "name",
                            dataType: "String",
                            nullable: false,
                            description:
                                "Customer name"
                        },

                        {
                            fieldName: "country",
                            dataType: "String",
                            nullable: true,
                            description:
                                "Customer country"
                        },

                        {
                            fieldName: "email",
                            dataType: "String",
                            nullable: true,
                            description:
                                "Customer email address"
                        }
                    ],

                    records: [

                        {
                            customerId: "CUST001",
                            name:
                                "Synthetic Customer 001",
                            country: "SA",
                            email:
                                "customer001@example.com"
                        },

                        {
                            customerId: "CUST002",
                            name:
                                "Synthetic Customer 002",
                            country: "SA",
                            email:
                                "customer002@example.com"
                        }
                    ],

                    deltaRecords: []
                }
            ]
        };
    }
}


module.exports = SyntheticSourceAdapter;