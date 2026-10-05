const SourceAdapter = require("./SourceAdapter");
const { getDestination } = require("@sap-cloud-sdk/connectivity");
const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");
const fs = require("fs");
const path = require("path");
const { parseEdmx } = require("./odata/EdmxGraphParser");

/**
 * ============================================================
 * S/4HANA SOURCE ADAPTER (STANDARDIZED DYNAMIC METADATA ENGINE)
 * ============================================================
 *
 * 100% Generic & Dynamic:
 * - Direct live OData V4 and V2 dual-catalog discovery via BTP Destination.
 * - Dynamic resolution of business services (SRVD_A2X / WEB_API).
 * - Generic EDMX metadata introspection and root-entity scoring.
 * - Dynamic primary key deduction and data plane extraction.
 * - Zero hardcoded service or entity names.
 * ============================================================
 */
class S4SourceAdapter extends SourceAdapter {
    constructor(connection) {
        super(connection);
        this.adapterType = "S4";

        this.discoveryMode = (process.env.S4_DISCOVERY_MODE || "LIVE").toUpperCase();
        this.discoveryDestinationName =
            connection.endpointReference || "S4_SOURCE_DISCOVERY";

        this.discoveryPath =
            connection.discoveryPath || "/http/s4/source/discovery";

        this.metadataDestinationName =
            connection.metadataEndpointReference ||
            connection.endpointReference ||
            "S4_SOURCE_METADATA";

        this.extractionDestinationName =
            connection.extractionEndpointReference ||
            connection.endpointReference ||
            "S4_SOURCE_DISCOVERY";

        this.extractionPath =
            connection.extractionPath || "/http/s4/source/extract";

        this._cachedLiveDiscovery = null;
    }

    /**
     * ============================================================
     * CONNECTION LIFECYCLE
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

    async authenticate() {
        if (this._isMockMode()) {
            return {
                authenticated: true,
                mode: "MOCK",
                message: "S/4HANA authentication simulated in MOCK mode"
            };
        }

        try {
            const destinationName = this.discoveryDestinationName;

            const destination = await getDestination({
                destinationName
            });

            if (!destination) {
                throw new Error(
                    `BTP destination '${destinationName}' could not be resolved`
                );
            }

            return {
                authenticated: true,
                mode: "LIVE",
                destination: destinationName,
                message:
                    `S/4HANA destination '${destinationName}' resolved successfully`
            };
        } catch (error) {
            throw new Error(
                `S/4HANA authentication/connectivity failed: ${error.message}`
            );
        }
    }

    async getMetadata() {
        const response = await this._getDiscoveryResponse();
        const apis = this._extractApis(response.data);

        return {
            systemId: this.connection.systemId,
            systemName: this.connection.systemName,
            systemType: this.connection.systemType,
            interfaceType: this.connection.interfaceType,
            adapterType: this.adapterType,
            metadataVersion: "1.0",
            metadataStatus: "AVAILABLE",
            sourceType: "S4HANA",
            apiCount: apis.length,
            apis
        };
    }

    /**
     * ============================================================
     * 1. CATALOG DISCOVERY
     * DYNAMIC DUAL V2 & V4 INVENTORY
     * ============================================================
     */
    async discoverObjects() {
        const response = await this._getDiscoveryResponse();
        const apis = this._extractApis(response.data);

        return apis.map((api) => ({
            objectId: api.objectId || api.serviceId || api.apiName,
            objectName:
                api.technicalServiceName || api.apiName,
            businessObject:
                api.businessObject ||
                api.technicalServiceName ||
                api.apiName,
            objectType:
                api.objectType ||
                (api.version === "V4"
                    ? "ODATA_V4"
                    : "ODATA_V2"),
            schemaVersion:
                api.schemaVersion || "1.0",
            description:
                api.description ||
                `S/4HANA OData API ${
                    api.technicalServiceName ||
                    api.apiName
                }`,
            protocol:
                api.protocol || "OData",
            version:
                api.version || "UNKNOWN",
            serviceUrl:
                api.serviceUrl || null,
            metadataUrl:
                api.metadataUrl || null,
            attributes:
                api.attributes || {}
        }));
    }

    _findApi(apis, targetName) {
        if (!targetName) {
            return null;
        }

        const clean = (str) =>
            String(str || "")
                .replace(/_0001$/, "")
                .replace(/^\/+/, "")
                .toLowerCase();

        const targetClean = clean(targetName);

        return apis.find((api) => {
            const sid = clean(api.serviceId);
            const aname = clean(api.apiName);
            const tsname = clean(api.technicalServiceName);
            const title = clean(api.title);
            const oid = clean(api.objectId);
            const gid = clean(api.groupId);

            return (
                sid === targetClean ||
                aname === targetClean ||
                tsname === targetClean ||
                title === targetClean ||
                oid === targetClean ||
                gid === targetClean ||
                (
                    api.serviceUrl &&
                    clean(api.serviceUrl).includes(targetClean)
                )
            );
        });
    }

    /**
     * ============================================================
     * 2. SCHEMA RESOLUTION
     * DYNAMIC $metadata INTROSPECTION
     * ============================================================
     */
    async getSchema(objectName, entityName = null) {
        if (!objectName) {
            throw new Error("objectName is required");
        }

        const response = await this._getDiscoveryResponse();
        const apis = this._extractApis(response.data);
        const api = this._findApi(apis, objectName);

        if (!api) {
            console.warn(
                `[S4SourceAdapter] S/4HANA OData API '${objectName}' ` +
                `was not found in catalog, synthesizing descriptor.`
            );

            return {
                objectName: objectName,
                objectId:
                    `${this.connection.systemId}_${objectName}`,
                entityName:
                    entityName || null,
                businessObject:
                    objectName,
                schemaVersion:
                    "1.0",
                fields: [],
                entitySets: [],
                metadata: {
                    discoveryMode:
                        this.discoveryMode
                }
            };
        }

        const metadataUrl =
            this._resolveMetadataUrl(api);

        /**
         * ========================================================
         * MOCK MODE
         * ========================================================
         */
        if (this._isMockMode()) {
            const fixtureName =
                api.technicalServiceName ||
                api.apiName ||
                objectName;

            const mockSchema =
                this._loadLocalMetadataFixture(
                    fixtureName
                );

            if (mockSchema) {
                const parsed =
                    this._parseODataMetadata(
                        mockSchema,
                        entityName,
                        objectName
                    );

                return {
                    objectName:
                        api.technicalServiceName ||
                        api.apiName ||
                        objectName,

                    objectId:
                        api.objectId ||
                        api.serviceId ||
                        null,

                    entityName:
                        entityName || null,

                    businessObject:
                        api.businessObject ||
                        api.technicalServiceName ||
                        api.apiName ||
                        objectName,

                    schemaVersion:
                        api.schemaVersion ||
                        "1.0",

                    fields:
                        parsed.fields,

                    entitySets:
                        parsed.entitySets,

                    metadata: {
                        objectType:
                            api.objectType ||
                            "ODATA_SERVICE",

                        protocol:
                            api.protocol ||
                            "OData",

                        version:
                            api.version ||
                            "UNKNOWN",

                        serviceUrl:
                            api.serviceUrl ||
                            null,

                        metadataUrl:
                            metadataUrl,

                        description:
                            api.description ||
                            null,

                        discoveryMode:
                            "MOCK"
                    }
                };
            }

            return {
                objectName:
                    api.technicalServiceName ||
                    api.apiName ||
                    objectName,

                objectId:
                    api.objectId ||
                    api.serviceId ||
                    null,

                entityName:
                    entityName || null,

                businessObject:
                    api.businessObject ||
                    api.technicalServiceName ||
                    api.apiName ||
                    objectName,

                schemaVersion:
                    api.schemaVersion ||
                    "1.0",

                fields: [],
                entitySets: [],

                metadata: {
                    objectType:
                        api.objectType ||
                        "ODATA_SERVICE",

                    protocol:
                        api.protocol ||
                        "OData",

                    version:
                        api.version ||
                        "UNKNOWN",

                    serviceUrl:
                        api.serviceUrl ||
                        null,

                    metadataUrl,

                    description:
                        api.description ||
                        null,

                    discoveryMode:
                        "MOCK"
                }
            };
        }

        /**
         * ========================================================
         * LIVE MODE
         * ========================================================
         */
        if (!metadataUrl) {
            throw new Error(
                `No metadata URL could be resolved dynamically for '${objectName}'`
            );
        }

        try {
            console.log(
                `[S4SourceAdapter] Fetching metadata dynamically from: ${metadataUrl}`
            );

            const metadataResponse =
                await this._callMetadata(
                    metadataUrl
                );

            console.log(
                `[S4SourceAdapter] Metadata response received: ` +
                `status=${metadataResponse.status}, ` +
                `contentType=${
                    metadataResponse.headers?.["content-type"] ||
                    metadataResponse.headers?.["Content-Type"] ||
                    "unknown"
                }, ` +
                `dataType=${typeof metadataResponse.data}, ` +
                `length=${
                    typeof metadataResponse.data === "string"
                        ? metadataResponse.data.length
                        : "n/a"
                }`
            );

            const parsed =
                this._parseODataMetadata(
                    metadataResponse.data,
                    entityName,
                    objectName
                );

            console.log(
                `[S4SourceAdapter] Metadata parsed successfully: ` +
                `object=${objectName}, ` +
                `entity=${entityName || "ROOT"}, ` +
                `entitySets=${parsed.entitySets.length}, ` +
                `fields=${parsed.fields.length}`
            );

            return {
                objectName:
                    api.technicalServiceName ||
                    api.apiName ||
                    objectName,

                objectId:
                    api.objectId ||
                    api.serviceId ||
                    null,

                entityName:
                    entityName || null,

                businessObject:
                    api.businessObject ||
                    api.technicalServiceName ||
                    api.apiName ||
                    objectName,

                schemaVersion:
                    api.schemaVersion ||
                    "1.0",

                fields:
                    parsed.fields,

                entitySets:
                    parsed.entitySets,

                metadata: {
                    objectType:
                        api.objectType ||
                        "ODATA_SERVICE",

                    protocol:
                        api.protocol ||
                        "OData",

                    version:
                        api.version ||
                        "UNKNOWN",

                    serviceUrl:
                        api.serviceUrl ||
                        null,

                    metadataUrl,

                    description:
                        api.description ||
                        null,

                    discoveryMode:
                        "LIVE"
                }
            };
        } catch (error) {
            console.error(
                `[S4SourceAdapter] Metadata fetch failed for '${objectName}'` +
                `${entityName ? ` / entity '${entityName}'` : ""}: ` +
                `${error.message}`
            );

            /**
             * IMPORTANT:
             *
             * Do not return fields: [] here.
             *
             * Returning an empty schema makes the caller believe
             * discovery succeeded even though metadata discovery failed.
             *
             * Joule must receive the actual error so that the MCP /
             * MigrationService layer can report the failure correctly.
             */
            throw new Error(
                `Metadata discovery failed for '${objectName}'` +
                `${entityName ? ` / entity '${entityName}'` : ""}: ` +
                `${error.message}`
            );
        }
    }

    /**
     * ============================================================
     * 2b. RELATIONSHIP DISCOVERY
     * ENTITY GRAPH FROM $metadata NAVIGATION PROPERTIES
     * ============================================================
     */
    async getRelationships(objectName) {
        if (!objectName) {
            throw new Error("objectName is required");
        }

        const response = await this._getDiscoveryResponse();
        const apis = this._extractApis(response.data);
        const api = this._findApi(apis, objectName);

        if (!api) {
            throw new Error(
                `S/4HANA OData API '${objectName}' was not found in the service catalog`
            );
        }

        const serviceName =
            api.technicalServiceName ||
            api.apiName ||
            objectName;

        let xml;

        if (this._isMockMode()) {
            xml = this._loadLocalMetadataFixture(serviceName);

            if (!xml) {
                throw new Error(
                    `No local metadata fixture found for '${serviceName}' (MOCK mode)`
                );
            }
        } else {
            const metadataUrl = this._resolveMetadataUrl(api);

            if (!metadataUrl) {
                throw new Error(
                    `No metadata URL could be resolved for '${objectName}'`
                );
            }

            const metadataResponse = await this._callMetadata(metadataUrl);

            xml = typeof metadataResponse.data === "string"
                ? metadataResponse.data
                : String(metadataResponse.data || "");
        }

        const graph = parseEdmx(xml);

        return {
            objectName: serviceName,
            protocol: "OData",
            odataVersion: graph.odataVersion,
            serviceUrl: api.serviceUrl || null,
            discoveryMode: this.discoveryMode,
            entityTypes: graph.entityTypes,
            entitySets: graph.entitySets
        };
    }

    /**
     * ============================================================
     * 3. GENERIC ROOT ENTITY HEURISTIC
     * ZERO HARDCODING
     * ============================================================
     */
    _resolveRootEntitySet(entitySets, targetName) {
        if (
            !Array.isArray(entitySets) ||
            entitySets.length === 0
        ) {
            return null;
        }

        const clean = (str) =>
            String(str || "")
                .replace(/_0001$/, "")
                .replace(/^api_|^a_/i, "")
                .replace(/_/g, "")
                .toLowerCase();

        const cleanTarget =
            clean(targetName);

        /**
         * 1. Exact match against target business object name
         */
        const exactMatch =
            entitySets.find(
                (es) =>
                    clean(
                        es.name ||
                        es.Name ||
                        ""
                    ) === cleanTarget
            );

        if (exactMatch) {
            return (
                exactMatch.name ||
                exactMatch.Name
            );
        }

        /**
         * 2. Contains match
         */
        const containsMatch =
            entitySets.find((es) => {
                const n =
                    clean(
                        es.name ||
                        es.Name ||
                        ""
                    );

                return (
                    cleanTarget.includes(n) ||
                    n.includes(cleanTarget)
                );
            });

        if (containsMatch) {
            return (
                containsMatch.name ||
                containsMatch.Name
            );
        }

        /**
         * 3. Filter out generic dependent navigation children
         */
        const candidates =
            entitySets.filter((es) => {
                const name =
                    (
                        es.name ||
                        es.Name ||
                        ""
                    ).toLowerCase();

                return (
                    !name.includes("addr") &&
                    !name.includes("email") &&
                    !name.includes("phone") &&
                    !name.includes("fax") &&
                    !name.includes("text") &&
                    !name.includes("item") &&
                    !name.includes("role") &&
                    !name.includes("tax") &&
                    !name.includes("ident") &&
                    !name.includes("locnumber")
                );
            });

        if (candidates.length > 0) {
            return (
                candidates[0].name ||
                candidates[0].Name
            );
        }

        return (
            entitySets[0].name ||
            entitySets[0].Name
        );
    }

    /**
     * ============================================================
     * 4. DATA EXTRACTION
     * GENERIC DATA PLANE STREAMING
     * ============================================================
     */
    async extract(targetName, options = {}) {
        if (!targetName) {
            throw new Error(
                "targetName is required for extraction"
            );
        }

        const top =
            options.top || 50;

        const skip =
            options.skip || 0;

        const destinationName =
            this.extractionDestinationName ||
            this.discoveryDestinationName ||
            "S4_SOURCE_DISCOVERY";

        const destination =
            await getDestination({
                destinationName
            });

        if (!destination) {
            throw new Error(
                `BTP destination '${destinationName}' could not be resolved`
            );
        }

        // "API_BUSINESS_PARTNER" reads the root entity set; "API_BUSINESS_PARTNER/A_BusinessPartnerAddress" one named entity set
        const [apiName, requestedEntitySet] = String(targetName).split("/");

        if (requestedEntitySet !== undefined && !/^[A-Za-z0-9_]+$/.test(requestedEntitySet)) {
            throw new Error(`'${requestedEntitySet}' is not a valid entity set name`);
        }

        const response =
            await this._getDiscoveryResponse();

        const apis =
            this._extractApis(
                response.data
            );

        const api =
            this._findApi(
                apis,
                apiName
            );

        let serviceBasePath = "";
        let primaryEntitySet = requestedEntitySet || "";

        if (api && api.serviceUrl) {
            try {
                const parsedUrl =
                    new URL(
                        api.serviceUrl
                    );

                serviceBasePath =
                    parsedUrl.pathname
                        .replace(/\/+$/, "");
            } catch (e) {
                serviceBasePath =
                    String(api.serviceUrl)
                        .split("?")[0]
                        .replace(/\/+$/, "");
            }
        }

        // $metadata is large: resolve the root entity set once per object, not once per page
        if (!this._rootEntitySetCache) {
            this._rootEntitySetCache = new Map();
        }

        try {
            if (requestedEntitySet) {
                // a named entity set needs no search for the root
            } else if (this._rootEntitySetCache.has(targetName)) {
                primaryEntitySet = this._rootEntitySetCache.get(targetName);
            } else {
                const schema =
                    await this.getSchema(
                        targetName
                    );

                if (
                    schema &&
                    Array.isArray(
                        schema.entitySets
                    ) &&
                    schema.entitySets.length > 0
                ) {
                    primaryEntitySet =
                        this._resolveRootEntitySet(
                            schema.entitySets,
                            targetName
                        );
                }

                this._rootEntitySetCache.set(targetName, primaryEntitySet);
            }
        } catch (err) {
            /**
             * Extraction may still use the service base path
             * if schema discovery is unavailable.
             */
            console.warn(
                `[S4SourceAdapter] Schema discovery fallback during extraction: ${err.message}`
            );
        }

        let fullEndpoint = "";

        if (serviceBasePath) {
            fullEndpoint =
                primaryEntitySet
                    ? `${serviceBasePath}/${primaryEntitySet}`
                    : serviceBasePath;
        } else {
            fullEndpoint =
                primaryEntitySet
                    ? `/${primaryEntitySet}`
                    : `/${targetName}`;
        }

        const queryParam =
            fullEndpoint.includes("?")
                ? `&$top=${top}&$skip=${skip}`
                : `?$top=${top}&$skip=${skip}`;

        const endpoint =
            `${fullEndpoint}${queryParam}`;

        console.log(
            `[S4SourceAdapter] --------------------------------------------------`
        );

        console.log(
            `[S4SourceAdapter] Extraction Target: ${endpoint}`
        );

        console.log(
            `[S4SourceAdapter] Destination:       ${destinationName}`
        );

        console.log(
            `[S4SourceAdapter] --------------------------------------------------`
        );

        try {
            const httpResponse =
                await executeHttpRequest(
                    destination,
                    {
                        method: "GET",
                        url: endpoint,
                        headers: {
                            "Accept":
                                "application/json",
                            "Content-Type":
                                "application/json"
                        }
                    }
                );

            const rawData =
                this._extractRecords(
                    httpResponse.data
                );

            const records =
                rawData.map((item) => {
                    const dynamicKey =
                        item.sourceKey ||
                        item.BusinessPartner ||
                        item.Customer ||
                        item.Supplier ||
                        item.ID ||
                        item.id ||
                        (
                            Object.keys(item)
                                .find(
                                    (k) =>
                                        /key|id|number|code/i.test(k) &&
                                        item[k]
                                )
                                ?
                                item[
                                    Object.keys(item)
                                        .find(
                                            (k) =>
                                                /key|id|number|code/i.test(k) &&
                                                item[k]
                                        )
                                ]
                                :
                                Object.values(item)[0]
                        );

                    return {
                        ...item,
                        sourceKey:
                            String(dynamicKey)
                    };
                });

            return {
                records,

                metadata: {
                    extractedAt:
                        new Date().toISOString(),

                    recordCount:
                        records.length,

                    entityPath:
                        fullEndpoint
                }
            };
        } catch (error) {
            console.error(
                `\n==================================================`
            );

            console.error(
                `[S4SourceAdapter] S/4HANA EXTRACTION FAILED`
            );

            console.error(
                `Destination:        ${destinationName}`
            );

            console.error(
                `Attempted Endpoint: ${endpoint}`
            );

            if (error.response) {
                console.error(
                    `HTTP Status:        ${error.response.status}`
                );

                console.error(
                    `Response Body:      `,
                    typeof error.response.data === "object"
                        ? JSON.stringify(
                              error.response.data,
                              null,
                              2
                          )
                        : error.response.data
                );
            } else {
                console.error(
                    `Error Details:      ${error.message}`
                );
            }

            console.error(
                `==================================================\n`
            );

            throw new Error(
                `Extraction failed for '${targetName}': ${error.message}`
            );
        }
    }

    /**
     * How many records every entity set of an API holds in the source (GET <entity set>/$count).
     * Used to tell the user how big an extraction will be and to show progress. Read only.
     * One entity set that cannot be counted does not stop the others: it carries an error text.
     */
    async countEntitySets(targetName, { rootOnly = false, only = null, includeRoot = false } = {}) {
        if (!targetName) {
            throw new Error("targetName is required for counting");
        }

        const destinationName =
            this.extractionDestinationName ||
            this.discoveryDestinationName ||
            "S4_SOURCE_DISCOVERY";

        const destination = await getDestination({ destinationName });

        if (!destination) {
            throw new Error(`BTP destination '${destinationName}' could not be resolved`);
        }

        const response = await this._getDiscoveryResponse();
        const api = this._findApi(this._extractApis(response.data), targetName);

        if (!api || !api.serviceUrl) {
            throw new Error(`API '${targetName}' is not in the source system's API list`);
        }

        let serviceBasePath;

        try {
            serviceBasePath = new URL(api.serviceUrl).pathname.replace(/\/+$/, "");
        } catch (e) {
            serviceBasePath = String(api.serviceUrl).split("?")[0].replace(/\/+$/, "");
        }

        // all entity sets of the service ($metadata), not only the root one
        const graph = await this.getRelationships(targetName);
        const sets = Object.values(graph.entitySets || {});
        const entitySets = sets.map((set) => set.name).filter(Boolean);
        const root = sets.length ? this._resolveRootEntitySet(sets, targetName) : "";
        const results = [];

        // everything, or only the root, or only the named entity sets (and the root when asked)
        const wanted = (name) =>
            only ? only.includes(name) || (includeRoot && name === root) : !rootOnly || name === root;

        for (const entitySet of entitySets.filter(wanted)) {
            try {
                const httpResponse = await executeHttpRequest(destination, {
                    method: "GET",
                    url: `${serviceBasePath}/${entitySet}/$count`,
                    headers: { Accept: "text/plain" }
                });
                const count = parseInt(String(httpResponse.data).trim(), 10);

                results.push({ entitySet, isRoot: entitySet === root, count: Number.isNaN(count) ? null : count });
            } catch (error) {
                const status = error.response && error.response.status;

                results.push({
                    entitySet, isRoot: entitySet === root, count: null,
                    error: status ? `HTTP ${status}` : error.message
                });
            }
        }

        return results;
    }

    /**
     * What a functional person wants to know about one discovered object: what does it offer?
     * S/4: the entity sets of the OData service (the data tables of the API). Same answer shape for every source.
     */
    async describeObject(objectName) {
        const graph = await this.getRelationships(objectName);
        const sets = Object.values(graph.entitySets || {});

        return {
            title: graph.objectName || objectName,
            description: "",
            itemLabel: "Entity sets of this API (its data tables)",
            items: sets.map((set) => ({ name: set.name, description: set.label || set.entityType || "", kind: "ENTITY_SET" })),
            hiddenCount: 0,
            note: "Use 'Add entity sets' on the business object to extract these as well. The source is asked how many records each one holds first."
        };
    }

    async getDelta(
        request = {},
        legacyOptions = {}
    ) {
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

        throw new Error(
            `S/4HANA delta extraction for '${objectName}' is not yet implemented.`
        );
    }

    async getStatus() {
        if (this._isMockMode()) {
            return {
                status: "CONNECTED",
                adapterType:
                    this.adapterType,
                connectionId:
                    this.connection.connectionId,
                mode: "MOCK",
                checkedAt:
                    new Date().toISOString()
            };
        }

        try {
            const response =
                await this._callDiscovery();

            return {
                status: "CONNECTED",
                adapterType:
                    this.adapterType,
                connectionId:
                    this.connection.connectionId,
                destination:
                    this.discoveryDestinationName,
                httpStatus:
                    response.status,
                checkedAt:
                    new Date().toISOString()
            };
        } catch (error) {
            return {
                status: "ERROR",
                adapterType:
                    this.adapterType,
                connectionId:
                    this.connection.connectionId,
                destination:
                    this.discoveryDestinationName,
                message:
                    error?.message ||
                    "S/4HANA connectivity check failed",
                checkedAt:
                    new Date().toISOString()
            };
        }
    }

    handleError(error) {
        const statusCode =
            error?.response?.status;

        return {
            errorCode:
                "S4_SOURCE_ERROR",

            message:
                error?.message ||
                "S/4HANA source error",

            httpStatus:
                statusCode || null,

            retryable:
                statusCode >= 500 ||
                statusCode === 429
        };
    }

    _isMockMode() {
        return this.discoveryMode === "MOCK";
    }

    _loadLocalMetadataFixture(
        objectName
    ) {
        const filePath =
            path.join(
                __dirname,
                "../mock/metadata",
                `${objectName}.xml`
            );

        if (!fs.existsSync(filePath)) {
            return null;
        }

        try {
            return fs.readFileSync(
                filePath,
                "utf8"
            );
        } catch (error) {
            throw new Error(
                `Unable to read local metadata fixture for '${objectName}': ${error.message}`
            );
        }
    }

    async _getDiscoveryResponse() {
        if (this._isMockMode()) {
            return this._loadLocalDiscoveryResponse();
        }

        if (this._cachedLiveDiscovery) {
            return this._cachedLiveDiscovery;
        }

        this._cachedLiveDiscovery =
            await this._callDiscovery();

        return this._cachedLiveDiscovery;
    }

    _loadLocalDiscoveryResponse() {
        const filePath =
            path.join(
                __dirname,
                "../mock/s4-discovery-response.json"
            );

        if (!fs.existsSync(filePath)) {
            throw new Error(
                `Local S/4 discovery fixture not found: ${filePath}`
            );
        }

        const body =
            fs.readFileSync(
                filePath,
                "utf8"
            );

        try {
            return {
                status: 200,
                data: JSON.parse(body)
            };
        } catch (error) {
            throw new Error(
                `Invalid local S/4 discovery fixture: ${error.message}`
            );
        }
    }

    /**
     * ============================================================
     * Dynamic dual V4 & V2 live catalog query
     * with business service prioritization
     * ============================================================
     */
    async _callDiscovery() {
        const destination =
            await getDestination({
                destinationName:
                    this.discoveryDestinationName
            });

        if (!destination) {
            throw new Error(
                `BTP destination '${this.discoveryDestinationName}' could not be resolved`
            );
        }

        const apis = [];

        /**
         * ========================================================
         * 1. Live V4 Catalog Query
         * ========================================================
         */
        try {
            const v4Response =
                await executeHttpRequest(
                    destination,
                    {
                        method: "GET",

                        url:
                            "/sap/opu/odata4/iwfnd/config/default/iwfnd/catalog/0002/ServiceGroups?$expand=DefaultSystem($expand=Services)",

                        headers: {
                            "Accept":
                                "application/json"
                        }
                    }
                );

            const serviceGroups =
                v4Response.data?.value ||
                [];

            for (const group of serviceGroups) {
                const services =
                    group.DefaultSystem?.Services ||
                    [];

                const groupId =
                    group.GroupId;

                if (services.length > 0) {
                    const businessSvc =
                        services.find(
                            (s) =>
                                s.RepositoryId ===
                                    "SRVD_A2X" ||
                                s.ServiceType ===
                                    "WEB_API"
                        ) ||
                        services.find(
                            (s) =>
                                !s.ServiceId.includes(
                                    "COMMON"
                                ) &&
                                !s.ServiceId.includes(
                                    "TEST"
                                )
                        ) ||
                        services[0];

                    apis.push({
                        protocol:
                            "OData",

                        version:
                            "V4",

                        groupId:
                            groupId,

                        serviceId:
                            groupId,

                        technicalServiceName:
                            groupId,

                        apiName:
                            groupId,

                        serviceVersion:
                            businessSvc.ServiceVersion ||
                            "0001",

                        serviceUrl:
                            businessSvc.ServiceUrl,

                        description:
                            group.Description ||
                            businessSvc.Description ||
                            groupId,

                        repositoryId:
                            businessSvc.RepositoryId,

                        isReleased:
                            businessSvc.IsReleasedC2,

                        source:
                            "S4_V4_CATALOG"
                    });
                } else if (groupId) {
                    apis.push({
                        protocol:
                            "OData",

                        version:
                            "V4",

                        groupId:
                            groupId,

                        serviceId:
                            groupId,

                        technicalServiceName:
                            groupId,

                        apiName:
                            groupId,

                        serviceVersion:
                            "0001",

                        serviceUrl:
                            null,

                        description:
                            group.Description ||
                            groupId,

                        source:
                            "S4_V4_CATALOG"
                    });
                }
            }
        } catch (v4Err) {
            console.warn(
                "[S4SourceAdapter] Native V4 discovery skipped:",
                v4Err.message
            );
        }

        /**
         * ========================================================
         * 2. Live V2 Catalog Query
         * ========================================================
         */
        try {
            const v2Response =
                await executeHttpRequest(
                    destination,
                    {
                        method: "GET",

                        url:
                            "/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection",

                        headers: {
                            "Accept":
                                "application/json"
                        }
                    }
                );

            const v2Results =
                v2Response.data?.d?.results ||
                v2Response.data?.value ||
                [];

            for (const svc of v2Results) {
                const sCleanId =
                    String(
                        svc.ID ||
                        svc.TechnicalServiceName ||
                        ""
                    ).replace(
                        /_0001$/,
                        ""
                    );

                apis.push({
                    protocol:
                        "OData",

                    version:
                        "V2",

                    serviceId:
                        svc.ID ||
                        sCleanId,

                    technicalServiceName:
                        sCleanId,

                    apiName:
                        sCleanId,

                    serviceVersion:
                        svc.TechnicalServiceVersion ||
                        svc.Version ||
                        "1",

                    serviceUrl:
                        svc.ServiceUrl ||
                        `/sap/opu/odata/sap/${sCleanId}`,

                    metadataUrl:
                        svc.MetadataUrl,

                    description:
                        svc.Description ||
                        svc.Title ||
                        sCleanId,

                    title:
                        svc.Title,

                    author:
                        svc.Author,

                    isSapService:
                        svc.IsSapService,

                    serviceType:
                        svc.ServiceType,

                    source:
                        "S4_V2_CATALOG"
                });
            }
        } catch (v2Err) {
            console.warn(
                "[S4SourceAdapter] Native V2 discovery skipped:",
                v2Err.message
            );
        }

        /**
         * ========================================================
         * De-duplicate inventory items
         * ========================================================
         */
        const uniqueMap =
            new Map();

        for (const item of apis) {
            const key =
                String(
                    item.serviceId
                ).toUpperCase();

            if (!uniqueMap.has(key)) {
                uniqueMap.set(
                    key,
                    item
                );
            }
        }

        const consolidatedApis =
            Array.from(
                uniqueMap.values()
            );

        console.log(
            `[S4SourceAdapter] Unified catalog discovered ${consolidatedApis.length} total APIs`
        );

        return {
            status: 200,

            data: {
                sourceType:
                    "S4HANA",

                protocol:
                    "OData",

                apiCount:
                    consolidatedApis.length,

                apis:
                    consolidatedApis
            }
        };
    }

    /**
     * ============================================================
     * DYNAMIC METADATA REQUEST
     * ============================================================
     */
    async _callMetadata(metadataUrl) {
        const destination =
            await getDestination({
                destinationName:
                    this.metadataDestinationName
            });

        if (!destination) {
            throw new Error(
                `BTP destination '${this.metadataDestinationName}' could not be resolved`
            );
        }

        let url =
            metadataUrl;

        if (
            typeof url === "string" &&
            /^https?:\/\//i.test(url)
        ) {
            try {
                const parsedUrl =
                    new URL(url);

                url =
                    `${parsedUrl.pathname}${
                        parsedUrl.search || ""
                    }`;
            } catch (error) {
                throw new Error(
                    `Invalid metadata URL '${metadataUrl}'`
                );
            }
        }

        /**
         * IMPORTANT:
         *
         * OData $metadata is XML/EDMX.
         * Explicitly request XML and force text response.
         */
        const response =
            await executeHttpRequest(
                destination,
                {
                    method: "GET",

                    url,

                    headers: {
                        Accept:
                            "application/xml, text/xml;q=0.9, */*;q=0.8"
                    },

                    responseType:
                        "text"
                }
            );

        console.log(
            `[S4SourceAdapter] Metadata response received: ` +
            `status=${response.status}, ` +
            `contentType=${
                response.headers?.["content-type"] ||
                response.headers?.["Content-Type"] ||
                "unknown"
            }, ` +
            `dataType=${typeof response.data}, ` +
            `length=${
                typeof response.data === "string"
                    ? response.data.length
                    : "n/a"
            }`
        );

        return response;
    }

    _extractApis(data) {
        if (!data) {
            return [];
        }

        let candidates = [];

        if (Array.isArray(data.apis)) {
            candidates =
                data.apis;
        } else if (Array.isArray(data.value)) {
            candidates =
                data.value;
        } else if (Array.isArray(data)) {
            candidates =
                data;
        } else if (
            Array.isArray(data.services)
        ) {
            candidates =
                data.services;
        }

        return candidates
            .map((api) =>
                this._normalizeApi(api)
            )
            .filter(
                (api) =>
                    api.apiName
            );
    }

    _normalizeApi(api) {
        const objectId =
            api.objectId ||
            api.serviceId ||
            api.id ||
            api.ID ||
            null;

        const technicalServiceName =
            api.technicalServiceName ||
            api.TechnicalServiceName ||
            api.title ||
            api.apiName ||
            api.name ||
            api.serviceId ||
            null;

        return {
            objectId,

            groupId:
                api.groupId ||
                null,

            serviceId:
                api.serviceId ||
                null,

            technicalServiceName,

            apiName:
                api.apiName ||
                technicalServiceName,

            title:
                api.title ||
                null,

            businessObject:
                api.businessObject ||
                null,

            objectType:
                api.objectType ||
                "ODATA_SERVICE",

            schemaVersion:
                api.schemaVersion ||
                "1.0",

            description:
                api.description ||
                null,

            protocol:
                api.protocol ||
                "OData",

            version:
                api.version ||
                "UNKNOWN",

            serviceUrl:
                api.serviceUrl ||
                null,

            metadataUrl:
                api.metadataUrl ||
                null,

            // Catalog facts the assessment scope filter can use (not all catalogs provide all of them)
            attributes: {
                serviceType: api.serviceType || api.ServiceType || null,
                isSapService: api.isSapService ?? api.IsSapService ?? null,
                releaseStatus: api.releaseStatus || api.ReleaseStatus || null,
                author: api.author || api.Author || null
            }
        };
    }

    /**
     * ============================================================
     * DYNAMIC METADATA URL BUILDER
     * ZERO HARDCODING
     * ============================================================
     */
    _resolveMetadataUrl(api) {
        if (api?.metadataUrl) {
            return api.metadataUrl;
        }

        if (api?.serviceUrl) {
            let serviceUrl =
                String(
                    api.serviceUrl
                ).trim();

            let cleanUrl =
                serviceUrl
                    .split("?")[0]
                    .replace(/\/+$/, "");

            if (
                /\/\$metadata$/i.test(
                    cleanUrl
                )
            ) {
                return serviceUrl;
            }

            const queryIndex =
                serviceUrl.indexOf("?");

            const query =
                queryIndex >= 0
                    ? serviceUrl.substring(
                          queryIndex
                      )
                    : "";

            return `${cleanUrl}/$metadata${query}`;
        }

        /**
         * Standard OData Gateway fallback
         * using the dynamically discovered
         * service name.
         */
        const cleanTarget =
            String(
                api.technicalServiceName ||
                api.apiName ||
                api.serviceId ||
                ""
            ).replace(
                /_0001$/,
                ""
            );

        return `/sap/opu/odata/sap/${cleanTarget}/$metadata`;
    }

    /**
     * ============================================================
     * GENERIC ODATA / EDMX PARSER
     * ============================================================
     */
    _parseODataMetadata(
        data,
        entityName = null,
        objectName = ""
    ) {
        let xml = "";

        if (typeof data === "string") {
            xml = data;
        } else if (Buffer.isBuffer(data)) {
            xml =
                data.toString(
                    "utf8"
                );
        } else if (
            data &&
            typeof data === "object"
        ) {
            xml =
                data.data ||
                data.raw ||
                JSON.stringify(data);
        }

        if (!xml || typeof xml !== "string") {
            throw new Error(
                `OData metadata response for '${objectName}' is empty or not XML text`
            );
        }

        if (
            !xml.includes("<") ||
            !xml.includes("Entity")
        ) {
            throw new Error(
                `OData metadata response for '${objectName}' does not contain recognizable EDMX/XML metadata`
            );
        }

        const entitySets =
            this._parseEntitySets(
                xml
            );

        const entityTypes =
            this._parseEntityTypes(
                xml
            );

        if (
            entitySets.length === 0 &&
            entityTypes.length === 0
        ) {
            throw new Error(
                `No EntitySet or EntityType definitions were found in metadata for '${objectName}'`
            );
        }

        let targetEntity =
            entityName;

        /**
         * No explicit entity requested:
         * use the generic root entity heuristic.
         */
        if (
            !targetEntity &&
            entitySets.length > 0
        ) {
            targetEntity =
                this._resolveRootEntitySet(
                    entitySets,
                    objectName
                ) ||
                entitySets[0].name;
        }

        let selectedEntitySets =
            entitySets;

        if (targetEntity) {
            /**
             * ====================================================
             * First:
             * match requested entity directly against EntitySet
             * name or referenced EntityType.
             * ====================================================
             */
            selectedEntitySets =
                entitySets.filter(
                    (entitySet) => {
                        const setName =
                            entitySet.name ||
                            entitySet.Name ||
                            entitySet.entitySetName;

                        const entityType =
                            entitySet.entityType ||
                            entitySet.EntityType;

                        return (
                            this._entityTypeNamesMatch(
                                setName,
                                targetEntity
                            ) ||
                            this._entityTypeNamesMatch(
                                entityType,
                                targetEntity
                            )
                        );
                    }
                );

            /**
             * ====================================================
             * Second:
             * the requested name may represent an EntityType
             * instead of an EntitySet.
             *
             * Example:
             *
             * A_BusinessPartner
             * A_BusinessPartnerType
             *
             * Resolve the EntityType first and then locate
             * the EntitySet pointing to that EntityType.
             * ====================================================
             */
            if (
                selectedEntitySets.length === 0
            ) {
                const matchingEntityType =
                    entityTypes.find(
                        (type) =>
                            this._entityTypeNamesMatch(
                                type.name,
                                targetEntity
                            ) ||
                            this._entityTypeNamesMatch(
                                type.fullName,
                                targetEntity
                            )
                    );

                if (matchingEntityType) {
                    selectedEntitySets =
                        entitySets.filter(
                            (entitySet) =>
                                this._entityTypeNamesMatch(
                                    entitySet.entityType ||
                                        entitySet.EntityType,
                                    matchingEntityType.fullName ||
                                        matchingEntityType.name
                                )
                        );
                }
            }

            /**
             * ====================================================
             * CRITICAL:
             *
             * If Joule explicitly asked for an entity and
             * we cannot find it, DO NOT silently use the first
             * EntitySet.
             *
             * Otherwise the framework could return fields for
             * the wrong business object.
             * ====================================================
             */
            if (
                selectedEntitySets.length === 0 &&
                entityName
            ) {
                throw new Error(
                    `Entity '${entityName}' was not found in OData metadata for object '${objectName}'`
                );
            }
        }

        /**
         * Generic discovery without an explicit entity:
         * preserve the original fallback behavior.
         */
        if (
            selectedEntitySets.length === 0 &&
            entitySets.length > 0
        ) {
            selectedEntitySets = [
                entitySets[0]
            ];
        }

        const fields = [];

        for (
            const entitySet
            of selectedEntitySets
        ) {
            const entityTypeName =
                entitySet.entityType ||
                entitySet.EntityType;

            const entityType =
                entityTypes.find(
                    (type) =>
                        this._entityTypeNamesMatch(
                            type.name,
                            entityTypeName
                        ) ||
                        this._entityTypeNamesMatch(
                            type.fullName,
                            entityTypeName
                        )
                );

            if (!entityType) {
                console.warn(
                    `[S4SourceAdapter] EntityType '${entityTypeName}' ` +
                    `could not be resolved for EntitySet '${entitySet.name}'`
                );

                continue;
            }

            const properties =
                entityType.properties ||
                entityType.fields ||
                [];

            for (
                const property
                of properties
            ) {
                fields.push({
                    entityName:
                        entitySet.name ||
                        entitySet.Name,

                    fieldName:
                        property.name ||
                        property.Name,

                    dataType:
                        property.dataType ||
                        property.type ||
                        property.Type ||
                        null,

                    nullable:
                        property.nullable ??
                        property.Nullable ??
                        null,

                    length:
                        property.length ??
                        property.maxLength ??
                        property.MaxLength ??
                        null
                });
            }
        }

        if (
            entityName &&
            fields.length === 0
        ) {
            throw new Error(
                `No fields could be resolved for entity '${entityName}' in object '${objectName}'`
            );
        }

        return {
            fields,
            entitySets:
                selectedEntitySets
        };
    }

    /**
     * ============================================================
     * ENTITY SET PARSER
     * ============================================================
     */
    _parseEntitySets(xml) {
        const entitySets = [];

        const entitySetPattern =
            /<EntitySet\b([^>]*)\/?>/gi;

        let match;

        while (
            (match =
                entitySetPattern.exec(
                    xml
                )) !== null
        ) {
            const attributes =
                this._parseXmlAttributes(
                    match[1]
                );

            if (!attributes.Name) {
                continue;
            }

            entitySets.push({
                name:
                    attributes.Name,

                entityType:
                    attributes.EntityType ||
                    null
            });
        }

        return entitySets;
    }

    /**
     * ============================================================
     * ENTITY TYPE PARSER
     * ============================================================
     */
    _parseEntityTypes(xml) {
        const entityTypes = [];

        const entityTypePattern =
            /<EntityType\b([^>]*)>([\s\S]*?)<\/EntityType>/gi;

        let match;

        while (
            (match =
                entityTypePattern.exec(
                    xml
                )) !== null
        ) {
            const attributes =
                this._parseXmlAttributes(
                    match[1]
                );

            const name =
                attributes.Name;

            if (!name) {
                continue;
            }

            const fullName =
                this._resolveEntityTypeFullName(
                    xml,
                    match.index,
                    name
                );

            const properties =
                this._parseProperties(
                    match[2]
                );

            entityTypes.push({
                name,
                fullName,
                properties
            });
        }

        return entityTypes;
    }

    /**
     * ============================================================
     * PROPERTY PARSER
     * ============================================================
     */
    _parseProperties(fragment) {
        const properties = [];

        const propertyPattern =
            /<Property\b([^>]*)\/?>/gi;

        let match;

        while (
            (match =
                propertyPattern.exec(
                    fragment
                )) !== null
        ) {
            const attributes =
                this._parseXmlAttributes(
                    match[1]
                );

            const name =
                attributes.Name ||
                attributes.name;

            if (!name) {
                continue;
            }

            const nullableValue =
                attributes.Nullable ??
                attributes.nullable;

            let nullable = true;

            if (
                nullableValue !==
                undefined
            ) {
                nullable =
                    String(
                        nullableValue
                    ).toLowerCase() !==
                    "false";
            }

            properties.push({
                name,

                dataType:
                    attributes.Type ||
                    attributes.type ||
                    null,

                length:
                    this._parseNumber(
                        attributes.MaxLength ||
                        attributes.maxLength
                    ),

                precision:
                    this._parseNumber(
                        attributes.Precision ||
                        attributes.precision
                    ),

                scale:
                    this._parseNumber(
                        attributes.Scale ||
                        attributes.scale
                    ),

                nullable,

                description:
                    attributes.Description ||
                    attributes.description ||
                    null
            });
        }

        return properties;
    }

    /**
     * ============================================================
     * XML ATTRIBUTE PARSER
     * ============================================================
     */
    _parseXmlAttributes(fragment) {
        const attributes = {};

        const attributePattern =
            /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

        let match;

        while (
            (match =
                attributePattern.exec(
                    fragment
                )) !== null
        ) {
            attributes[
                match[1]
            ] =
                match[2] !==
                undefined
                    ? match[2]
                    : match[3];
        }

        return attributes;
    }

    /**
     * ============================================================
     * ENTITY TYPE FULL NAME RESOLUTION
     * ============================================================
     */
    _resolveEntityTypeFullName(
        xml,
        position,
        name
    ) {
        const before =
            xml.substring(
                0,
                position
            );

        const schemaMatches =
            [
                ...before.matchAll(
                    /<Schema\b([^>]*)>/gi
                )
            ];

        if (
            schemaMatches.length === 0
        ) {
            return name;
        }

        const lastSchema =
            schemaMatches[
                schemaMatches.length - 1
            ];

        const attributes =
            this._parseXmlAttributes(
                lastSchema[1]
            );

        const namespace =
            attributes.Namespace;

        return namespace
            ? `${namespace}.${name}`
            : name;
    }

    /**
     * ============================================================
     * ENTITY / ENTITY TYPE NORMALIZATION
     * ============================================================
     *
     * Handles:
     *
     *   A_BusinessPartner
     *   A_BusinessPartner_0001
     *   A_BusinessPartnerType
     *   Namespace.A_BusinessPartnerType
     *
     * without hardcoding a specific business object.
     * ============================================================
     */
    _entityTypeNamesMatch(
        first,
        second
    ) {
        if (
            !first ||
            !second
        ) {
            return false;
        }

        const normalize =
            (value) =>
                String(value)
                    .split(".")
                    .pop()
                    .replace(
                        /_0001$/i,
                        ""
                    )
                    .replace(
                        /Type$/i,
                        ""
                    )
                    .replace(
                        /^Entity$/i,
                        ""
                    )
                    .toLowerCase();

        return (
            normalize(first) ===
            normalize(second)
        );
    }

    /**
     * ============================================================
     * NUMBER PARSER
     * ============================================================
     */
    _parseNumber(value) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return null;
        }

        const number =
            Number(value);

        return Number.isNaN(
            number
        )
            ? null
            : number;
    }

    /**
     * ============================================================
     * GENERIC RESPONSE RECORD EXTRACTION
     * ============================================================
     */
    _extractRecords(data) {
        if (!data) {
            return [];
        }

        if (
            Array.isArray(
                data.value
            )
        ) {
            return data.value;
        }

        if (
            data.d &&
            Array.isArray(
                data.d.results
            )
        ) {
            return data.d.results;
        }

        if (
            Array.isArray(data)
        ) {
            return data;
        }

        if (
            typeof data ===
            "object"
        ) {
            return [data];
        }

        return [];
    }
}

module.exports =
    S4SourceAdapter;