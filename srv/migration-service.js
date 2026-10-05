const cds = require("@sap/cds");

// Query API of this project's CAP instance (a globally installed cds may bring its own copy)
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { XMLParser } = require("fast-xml-parser");
const {
    SourceSystem,
    SourceConnection,
    SourceObject,
    SourceMetadata,
    SourceField,
    RawRecord,
    CanonicalCustomer,
    TargetSystem,
    TargetConnection,
    TargetObject,
    TargetMetadata,
    TargetField,
    MigrationRun
} = cds.entities("migration.orchestrator");

const SyntheticTargetAdapter = require("./adapters/SyntheticTargetAdapter");
const MappingEngine = require("./mapping/MappingEngine");
const { createSourceAdapter } = require("./adapters/SourceAdapterFactory");
const {
    AllRecordsMalformedError,
    profileRecords
} = require("./profiling/ProfileDataProfiler");
const GeminiProvider = require("./lib/ai/GeminiProvider");
// created at the first use, so the app starts without an AI key
let geminiProviderInstance = null;
const geminiProvider = {
    generateText: (prompt) => (geminiProviderInstance || (geminiProviderInstance = new GeminiProvider())).generateText(prompt)
};

const { buildScope, estimateTokens } = require("./lib/assessment/AssessmentScope");
const { getStorage } = require("./lib/storage");
const { runExtraction, verifyExtraction, listExtractions, findLatestExtraction, resolveExtractionId, readExtractionRecords } = require("./lib/extraction/ExtractionRunner");
const { buildExtractionWorkbook, XLSX_MEDIA_TYPE } = require("./lib/extraction/ExcelExport");
const { profileExtraction } = require("./lib/profiling/ExtractionProfiler");

const BusinessObjectAssessmentService =
    require("./lib/ai/BusinessObjectAssessmentService");

module.exports = cds.service.impl(async function () {

    // cleansing rule library (srv/cleansing-service.cds); only when its tables are part of the model
    if (cds.model.definitions["migration.framework.CleansingRuleSet"]) {
        require("./cleansing-handlers")(this);
    }

    // background extraction (srv/extraction-job-service.cds); resolveSourceContext is defined further down
    if (cds.model.definitions["migration.framework.ExtractionJob"]) {
        require("./extraction-job-handlers")(this, {
            resolveSourceContext: (...args) => resolveSourceContext(...args)
        });
    }

    // Object Store administration (srv/storage-admin-service.cds)
    if (cds.model.definitions["MigrationService.getObjectStoreOverview"]) {
        require("./storage-admin-handlers")(this);
    }

    this.on("clearAssessment", async (req) => {
        const { sourceObject } = req.data;
        if (!sourceObject) {
            return req.reject(400, "sourceObject is required");
        }

        const tx = cds.tx(req);
        const deleted = await tx.run(
            DELETE.from(MigrationAssessment).where({ sourceObject })
        );

        return `Successfully deleted ${deleted} assessment record(s) for '${sourceObject}'.`;
    });

    this.on("clearAllAssessments", async (req) => {

        const tx = cds.tx(req);

        const deleted = await tx.run(
            DELETE.from(MigrationAssessment)
        );

        return `Successfully deleted ${deleted} assessment record(s).`;
    });

    const { MigrationAssessment } = cds.entities("migration.orchestrator");

    this.on("READ", "MigrationAssessments", async (req) => {

    const tx = cds.tx(req);

    // Read assessments directly from HANA
    const assessments = await tx.run(
        SELECT.from(MigrationAssessment)
            .where(req.query.SELECT.where || {})
    );

    /*
     * ============================================================
     * BUSINESS OBJECT GROUPING
     * ============================================================
     *
     * The AI already classified each API/source object into:
     *
     *   businessObject
     *   component
     *   confidence
     *
     * Here we group the assessed APIs by businessObject.
     *
     * Example:
     *
     * Business Partner
     *   -> API_BUSINESS_PARTNER
     *
     * Customer Master
     *   -> API_CNSLDTNCUSTOMER
     *   -> MD_CUSTOMER_MASTER_SRV_01
     *
     * Supplier Master
     *   -> MD_SUPPLIER_MASTER_SRV
     */

    const groups = {};

    for (const assessment of assessments) {

        // Only include valid completed assessments
        if (
            assessment.status !== "COMPLETED" ||
            !assessment.sourceObject ||
            !assessment.businessObject
        ) {
            continue;
        }

        const businessObject = assessment.businessObject.trim();

        if (!groups[businessObject]) {
            groups[businessObject] = {
                businessObject,
                component: assessment.component || null,
                apiCount: 0,
                apis: []
            };
        }

        groups[businessObject].apiCount++;

        groups[businessObject].apis.push({
            reviewStatus: assessment.reviewStatus || "SUGGESTED",
            reviewedBy: assessment.reviewedBy || null,
            reviewComment: assessment.reviewComment || null,
            originalBusinessObject: assessment.originalBusinessObject || null,
            // AI = proposed by the AI (maybe moved by a person, see originalBusinessObject); MANUAL = added by a person
            origin: assessment.modelName === "MANUAL" ? "MANUAL" : assessment.modelName === "ENTITY_SET" ? "ENTITY_SET" : "AI",
            sourceObject: assessment.sourceObject,
            component: assessment.component,
            confidence: assessment.confidence,
            evidenceFields: assessment.evidenceFields,
            reason: assessment.reason,
            modelName: assessment.modelName,
            status: assessment.status
        });
    }

    /*
     * Keep the normal READ response unchanged unless
     * the caller explicitly asks for grouping.
     *
     * Use:
     *   ?groupByBusinessObject=true
     *
     * to receive grouped Business Objects.
     */

    const groupByBusinessObject =
        req._.req?.query?.groupByBusinessObject === "true";

    if (!groupByBusinessObject) {
        return assessments;
    }

    // catalog match (framework): AI business object name -> BusinessObjectType code
    const normalize = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const catalogByName = new Map();

    try {
        const { BusinessObjectType } = cds.entities("migration.framework");

        for (const type of await tx.run(SELECT.from(BusinessObjectType).columns("code", "name"))) {
            catalogByName.set(normalize(type.name), type.code);
            catalogByName.set(normalize(type.code), type.code);
        }
    } catch (error) {
        // framework tables not deployed - no catalog match, grouping still works
    }

    for (const group of Object.values(groups)) {
        group.catalogCode = catalogByName.get(normalize(group.businessObject)) || null;
        group.confirmedCount = group.apis.filter(api => api.reviewStatus === "CONFIRMED").length;
        group.rejectedCount = group.apis.filter(api => api.reviewStatus === "REJECTED").length;
        group.openCount = group.apiCount - group.confirmedCount - group.rejectedCount;
    }

    return {
        totalObjects: assessments.filter(
            a =>
                a.status === "COMPLETED" &&
                a.sourceObject &&
                a.businessObject
        ).length,

        businessObjectCount: Object.keys(groups).length,

        groups: Object.values(groups).sort(
            (a, b) =>
                a.businessObject.localeCompare(b.businessObject)
        )
    };
});
    
    /**
     * ============================================================
     * REVIEW OF AN AI PROPOSAL (governance)
     * ============================================================
     */
    this.on("reviewAssessment", async (req) => {

        const { sourceSystemId, sourceObject, decision, businessObject, comment } = req.data;
        // ADD = a person puts an API into a business object (works like CHANGE, also for APIs the AI never assessed)
        const choice = String(decision || "").toUpperCase() === "ADD" ? "CHANGE" : String(decision || "").toUpperCase();

        if (!sourceSystemId || !sourceObject) {
            return req.reject(400, "sourceSystemId and sourceObject are required");
        }

        if (!["CONFIRM", "REJECT", "CHANGE"].includes(choice)) {
            return req.reject(400, "decision must be CONFIRM, REJECT, CHANGE or ADD");
        }

        if (choice === "CHANGE" && !String(businessObject || "").trim()) {
            return req.reject(400, "businessObject is required to change the assignment");
        }

        const tx = cds.tx(req);

        const rows = await tx.run(
            SELECT.from(MigrationAssessment).where({ sourceSystemId, sourceObject })
        );

        if (rows.length === 0) {
            if (choice !== "CHANGE") {
                return req.reject(404, `No assessment found for '${sourceObject}' in '${sourceSystemId}'`);
            }

            // added by hand: only APIs that were really discovered in this source system
            const system = await tx.run(SELECT.one.from(SourceSystem).where({ systemId: sourceSystemId }));
            const discovered = system && await tx.run(
                SELECT.one.from(SourceObject).where({ sourceSystem_ID: system.ID, objectName: sourceObject })
            );

            if (!discovered) {
                return req.reject(404, `'${sourceObject}' was not discovered in '${sourceSystemId}'`);
            }

            await tx.run(INSERT.into(MigrationAssessment).entries({
                sourceSystemId,
                sourceObject,
                businessObject: String(businessObject).trim(),
                confidence: 100,
                reason: discovered.description || null,
                modelName: "MANUAL",            // origin: added by a person, not proposed by the AI
                status: "COMPLETED",
                assessedAt: new Date().toISOString(),
                reviewStatus: "CONFIRMED",
                reviewedBy: req.user?.id || null,
                reviewedAt: new Date().toISOString(),
                reviewComment: comment || null
            }));

            return `${sourceObject}: added to '${String(businessObject).trim()}' and confirmed`;
        }

        const set = {
            reviewStatus: choice === "REJECT" ? "REJECTED" : "CONFIRMED",
            reviewedBy: req.user?.id || null,
            reviewedAt: new Date().toISOString(),
            reviewComment: comment || null
        };

        if (choice === "CHANGE") {
            const latest = rows[0];

            // keep what the AI said, once
            set.originalBusinessObject = latest.originalBusinessObject || latest.businessObject;
            set.businessObject = String(businessObject).trim();
            set.confidence = 100;
        }

        await tx.run(UPDATE(MigrationAssessment).set(set).where({ sourceSystemId, sourceObject }));

        return `${sourceObject}: ${set.reviewStatus.toLowerCase()}${choice === "CHANGE" ? ` as '${set.businessObject}'` : ""}`;
    });

    /**
     * ============================================================
     * EXTRACT TO OBJECT STORE (confirmed APIs of a business object)
     * ============================================================
     */
    this.on("extractToObjectStore", async (req) => {

        const { sourceSystemId, businessObject, objectNames, pageSize, maxRecordsPerObject } = req.data;

        if (!sourceSystemId) {
            return req.reject(400, "sourceSystemId is required");
        }

        const tx = cds.tx(req);

        try {
            const { sourceSystem, connection } = await resolveSourceContext(tx, sourceSystemId);

            // Which APIs: explicit list, or the CONFIRMED ones of the business object (governance)
            let names = (objectNames || []).map(name => String(name).trim()).filter(Boolean);

            if (names.length === 0) {
                if (!businessObject) {
                    return req.reject(400, "Provide a businessObject (its confirmed APIs are extracted) or objectNames");
                }

                const rows = await tx.run(
                    SELECT.from(MigrationAssessment)
                        .columns("sourceObject")
                        .where({ sourceSystemId: sourceSystem.systemId, businessObject, reviewStatus: "CONFIRMED" })
                );

                names = rows.map(row => row.sourceObject);

                if (names.length === 0) {
                    return req.reject(
                        409,
                        `No confirmed APIs for business object '${businessObject}'. Review and confirm the AI proposals first.`
                    );
                }
            }

            const adapter = createSourceAdapter({
                ...connection,
                systemId: sourceSystem.systemId,
                systemName: sourceSystem.systemName,
                systemType: sourceSystem.systemType
            });

            const storage = getStorage();
            const extractionId = `EX-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;

            const manifest = await runExtraction({
                adapter,
                storage,
                extractionId,
                objectNames: names,
                context: {
                    sourceSystem: sourceSystem.systemId,
                    adapterType: connection.adapterType,
                    businessObject: businessObject || null,
                    requestedBy: req.user?.id || null
                },
                pageSize,
                maxRecordsPerObject
            });

            const { kind, location } = storage.describe();
            const base = kind === "LOCAL" ? `${location.replace(/[\\/]$/, "")}/` : location;
            const t = manifest.totals;

            return {
                extractionId,
                status: manifest.status,
                businessObject: businessObject || null,
                sourceSystem: sourceSystem.systemId,
                storage: `${kind} ${location}`,
                objectCount: t.objects,
                totalRecords: t.records,
                totalPages: t.pages,
                totalBytes: t.bytes,
                truncatedObjects: t.truncatedObjects,
                failedObjects: t.failedObjects,
                manifestLocation: `${base}extractions/${extractionId}/manifest.json`,
                objects: JSON.stringify(
                    manifest.objects.map(o => ({
                        objectName: o.objectName, records: o.records, pages: o.pages,
                        bytes: o.bytes, truncated: o.truncated, error: o.error
                    }))
                ),
                message:
                    `${manifest.status}: ${t.records} record(s) from ${t.objects} API(s) in ${t.pages} file(s) (${t.bytes} bytes)` +
                    (t.truncatedObjects > 0 ? `; ${t.truncatedObjects} API(s) stopped at the record limit` : "") +
                    (t.failedObjects > 0 ? `; ${t.failedObjects} API(s) failed (see details)` : "") + "."
            };

        } catch (error) {
            // req.reject() above throws an error that already carries its HTTP code - keep it
            const status = error.status || (Number.isInteger(error.code) ? error.code : 500);

            if (status >= 500) {
                console.error("[extractToObjectStore] FAILED:", error);
            }

            return req.reject(status, error.message || "Extraction failed");
        }
    });

    this.on("listExtractions", async (req) => {

        const { sourceSystemId, businessObject } = req.data;

        try {
            const manifests = await listExtractions({
                storage: getStorage(),
                sourceSystem: sourceSystemId || null,
                businessObject: businessObject || null
            });

            return manifests.map(m => ({
                extractionId: m.extractionId,
                status: m.status,
                businessObject: m.businessObject || null,
                sourceSystem: m.sourceSystem || null,
                startedAt: m.startedAt,
                objectCount: m.totals?.objects || 0,
                totalRecords: m.totals?.records || 0,
                objects: JSON.stringify((m.objects || []).map(o => ({
                    objectName: o.objectName, records: o.records, pages: o.pages, truncated: o.truncated, error: o.error
                })))
            }));
        } catch (error) {
            console.error("[listExtractions] FAILED:", error);
            return req.reject(500, error.message || "Listing the extractions failed");
        }
    });

    this.on("readExtractionRecords", async (req) => {

        const { extractionId, objectName, skip, top } = req.data;

        if (!extractionId) {
            return req.reject(400, "extractionId is required");
        }

        let result;

        try {
            result = await readExtractionRecords({ storage: getStorage(), extractionId, objectName, skip, top });
        } catch (error) {
            console.error("[readExtractionRecords] FAILED:", error);
            return req.reject(500, error.message || "Reading the records failed");
        }

        if (!result.found) {
            return req.reject(404, `No records found for '${objectName || ""}' in extraction '${extractionId}'`);
        }

        return {
            extractionId,
            objectName: result.entry.objectName,
            totalRecords: result.totalRecords,
            skip: result.skip,
            top: result.top,
            records: JSON.stringify(result.records)
        };
    });

    /**
     * ============================================================
     * EXCEL EXPORT OF AN EXTRACTION (UI button and Joule)
     * ============================================================
     */
    /**
     * ============================================================
     * PROFILING OF AN EXTRACTION (UI and Joule)
     * ============================================================
     */
    this.on("profileExtraction", async (req) => {

        const { objectName, businessObject, sourceSystemId } = req.data;
        const storage = getStorage();

        try {
            const extractionId = await resolveExtractionId({ storage, extractionId: req.data.extractionId, businessObject, sourceSystem: sourceSystemId });
            const profile = await profileExtraction({ storage, extractionId, objectName });

            const header = `${profile.businessObject || "Extraction"}, extraction ${extractionId} of ${String(profile.startedAt || "").slice(0, 16).replace("T", " ")} UTC.`;
            const body = profile.objects.map(o =>
                o.error ? `${o.objectName}: extraction failed (${o.error}).` : `${o.objectName}: ${o.findings.join(" ")}`
            );

            return {
                extractionId,
                businessObject: profile.businessObject,
                sourceSystem: profile.sourceSystem,
                startedAt: profile.startedAt,
                apiCount: profile.objects.length,
                totalRecords: profile.objects.reduce((sum, o) => sum + o.records, 0),
                message: [header, ...body].join("\n"),
                objects: JSON.stringify(profile.objects)
            };
        } catch (error) {
            const status = error.status || 500;
            if (status >= 500) { console.error("[profileExtraction] FAILED:", error); }
            return req.reject(status, error.message || "Profiling failed");
        }
    });

    this.on("exportExtractionToExcel", async (req) => {

        const { objectName, businessObject, sourceSystemId } = req.data;
        let { extractionId } = req.data;

        const storage = getStorage();
        let result;

        // no ID needed: a business object name gives its latest extraction (used by Joule)
        try {
            extractionId = await resolveExtractionId({ storage, extractionId, businessObject, sourceSystem: sourceSystemId });
        } catch (error) {
            return req.reject(error.status || 500, error.message);
        }

        try {
            // checksums first, so the Info sheet says whether the data is unchanged
            const verification = await verifyExtraction({ storage, extractionId });

            if (!verification.found) {
                const notFound = new Error(`Extraction '${extractionId}' was not found in the storage`);
                notFound.status = 404;
                throw notFound;
            }

            const names = verification.manifest.objects.map(o => o.objectName);
            const fieldRows = await cds.tx(req).run(
                SELECT.from(SourceField)
                    .columns("objectName", "fieldName", "dataType", "length", "nullable", "description")
                    .where({ objectName: objectName ? [objectName] : names })
            );

            const fieldsByObject = {};
            for (const field of fieldRows) {
                (fieldsByObject[field.objectName] = fieldsByObject[field.objectName] || []).push(field);
            }

            result = await buildExtractionWorkbook({
                storage, extractionId, objectName, fieldsByObject, verification,
                exportedBy: req.user?.id || null
            });

            result.verification = verification;
        } catch (error) {
            const status = error.status || 500;
            if (status >= 500) { console.error("[exportExtractionToExcel] FAILED:", error); }
            return req.reject(status, error.message || "Excel export failed");
        }

        const key = `exports/${extractionId}/${result.fileName}`;

        try {
            await storage.put(key, result.buffer, { contentType: XLSX_MEDIA_TYPE });
        } catch (error) {
            console.error("[exportExtractionToExcel] storing the file FAILED:", error);
            return req.reject(500, `The Excel file was built but could not be stored: ${error.message}`);
        }

        const { kind, location } = storage.describe();
        const base = kind === "LOCAL" ? `${location.replace(/[\\/]$/, "")}/` : location;

        // a link that works from a chat: straight to the file in the Object Store, valid for a short time
        const LINK_MINUTES = 15;
        let directUrl = null;

        try {
            directUrl = await storage.signedDownloadUrl(key, { expiresInSeconds: LINK_MINUTES * 60, fileName: result.fileName });
        } catch (error) {
            console.error("[exportExtractionToExcel] signed link FAILED:", error.message);
        }

        return {
            extractionId,
            fileName: result.fileName,
            exportKey: key,
            location: base + key,
            sizeBytes: result.buffer.length,
            totalRows: result.totalRows,
            sheets: JSON.stringify(result.sheets),
            checksums: result.verification.ok ? "OK" : "CHANGED",
            downloadExpiresInMinutes: directUrl ? LINK_MINUTES : null,
            downloadUrl: directUrl || `/migration/downloadExport(exportKey='${encodeURIComponent(key)}')`,
            message:
                `Excel created: ${result.fileName} (${Math.round(result.buffer.length / 1024)} KB, ` +
                `${result.totalRows} records in ${result.sheets.length} API sheet(s)), stored in the Object Store. ` +
                `Checksums: ${result.verification.ok ? "OK" : "the files differ from the manifest"}.` +
                (directUrl ? ` Download (link valid for ${LINK_MINUTES} minutes): ${directUrl}` : "")
        };
    });

    this.on("downloadExport", async (req) => {

        const key = String(req.data.exportKey || "");

        // only files created by the export, no paths outside exports/
        if (!/^exports\/[^/]+\/[^/]+\.xlsx$/.test(key) || key.includes("..")) {
            return req.reject(400, "Only Excel exports can be downloaded");
        }

        let data;

        try {
            data = await getStorage().get(key);
        } catch (error) {
            return req.reject(404, `Export '${key}' was not found`);
        }

        const { Readable } = require("stream");

        return {
            value: Readable.from(data),
            $mediaContentType: XLSX_MEDIA_TYPE,
            $mediaContentDispositionFilename: key.split("/").pop(),
            $mediaContentDispositionType: "attachment"
        };
    });

    this.on("verifyExtraction", async (req) => {

        const { extractionId } = req.data;

        if (!extractionId) {
            return req.reject(400, "extractionId is required");
        }

        try {
            const result = await verifyExtraction({ storage: getStorage(), extractionId });

            return {
                extractionId,
                status: !result.found ? "NOT_FOUND" : (result.ok ? "OK" : "CHANGED"),
                filesChecked: result.filesChecked,
                mismatches: JSON.stringify(result.mismatches),
                message: !result.found
                    ? `Extraction '${extractionId}' was not found in the storage.`
                    : result.ok
                        ? `All ${result.filesChecked} file(s) match their checksums.`
                        : `${result.mismatches.length} of ${result.filesChecked} file(s) differ from the manifest.`
            };
        } catch (error) {
            console.error("[verifyExtraction] FAILED:", error);
            return req.reject(500, error.message || "Verification failed");
        }
    });

    this.on("assessBusinessObjects", async (req) => {

    const {
        sourceSystemId,
        instructions
    } = req.data;

    if (!sourceSystemId) {
        return req.reject(
            400,
            "sourceSystemId is required"
        );
    }

    try {

        const result =
            await BusinessObjectAssessmentService.assess({

                sourceSystemId,

                assessmentInstructions:
                    instructions || null,

                tx: cds.tx(req)
            });

        return {

            status:
                result.objectsFailed === 0
                    ? "COMPLETED"
                    : (
                        result.objectsAssessed > 0
                            ? "PARTIAL"
                            : "FAILED"
                    ),

            sourceSystem:
                result.sourceSystemId,

            objectsAssessed:
                result.objectsAssessed,

            objectsReused:
                result.objectsReused,

            objectsFailed:
                result.objectsFailed,

            inputTokens:
                result.inputTokens || 0,

            outputTokens:
                result.outputTokens || 0,

            totalTokens:
                result.totalTokens || 0,

            assessedAt:
                new Date(),

            message:
                `Assessment run completed. Assessed: ${result.objectsAssessed}, Reused: ${result.objectsReused}, Failed: ${result.objectsFailed}.`
        };

    } catch (error) {

        console.error(
            "[BUSINESS OBJECT ASSESSMENT] Fatal error:",
            error
        );

        return req.reject(
            500,
            error.message ||
            "Business object assessment failed"
        );
    }
});

    /**
     * ============================================================
     * PREVIEW ASSESSMENT SCOPE (no AI call)
     * ============================================================
     */
    /**
     * Shared by previewAssessmentScope and assessScope:
     * discover -> filter funnel -> already assessed -> size estimate.
     */
    const computeAssessmentScope = async (tx, req) => {

        const { sourceSystemId, scopePrefixes, includeCustom, readOnly, businessApisOnly } = req.data;

        if (!sourceSystemId) {
            const error = new Error("sourceSystemId is required");
            error.status = 400;
            throw error;
        }

        const { sourceSystem, connection } = await resolveSourceContext(tx, sourceSystemId);

        const adapter = createSourceAdapter({
            ...connection,
            systemId: sourceSystem.systemId,
            systemName: sourceSystem.systemName,
            systemType: sourceSystem.systemType
        });

        const adapterType = String(connection.adapterType || "").toUpperCase();
        // the scope is passed on: a source with thousands of objects (M3) expands only the chosen areas
        const objects = await adapter.discoverObjects({
            forScope: true,
            scopePrefixes: scopePrefixes || [],
            includeCustom: includeCustom === true
        });

        const scope = buildScope(adapterType, objects, {
            scopePrefixes: scopePrefixes || [],
            includeCustom: includeCustom === true,
            readOnly: readOnly !== false,
            businessApisOnly: businessApisOnly !== false
        });

        const assessed = new Set(
            (await tx.run(
                SELECT.from(MigrationAssessment)
                    .columns("sourceObject")
                    .where({ sourceSystemId: sourceSystem.systemId, status: "COMPLETED" })
            )).map(row => row.sourceObject)
        );

        const counts = await tx.run(
            SELECT.from(SourceField)
                .columns("objectName", "count(*) as fields")
                .groupBy("objectName")
        );
        const fieldCounts = new Map(counts.map(row => [row.objectName, Number(row.fields)]));

        const isAssessed = (candidate) =>
            candidate.members.some(member => assessed.has(member) || assessed.has(member.replace(/_0001$/, "")));

        const open = scope.candidates.filter(candidate => !isAssessed(candidate));

        return {
            sourceSystem, connection, adapter, adapterType, objects,
            scope, open, isAssessed,
            estimate: estimateTokens(adapterType, open, fieldCounts, 11)
        };
    };

    /**
     * ============================================================
     * PREVIEW ASSESSMENT SCOPE (no AI call)
     * ============================================================
     */
    this.on("previewAssessmentScope", async (req) => {

        const tx = cds.tx(req);

        try {
            const { sourceSystem, adapterType, scope, open, isAssessed, estimate } =
                await computeAssessmentScope(tx, req);

            return {
                sourceSystem: sourceSystem.systemId,
                adapterType,
                discovered: scope.discovered,
                toAssess: scope.candidates.length,
                alreadyAssessed: scope.candidates.length - open.length,
                newToAssess: open.length,
                batches: estimate.batches,
                estimatedInputTokens: estimate.inputTokens,
                estimatedOutputTokens: estimate.outputTokens,
                steps: JSON.stringify(scope.steps),
                candidates: JSON.stringify(
                    scope.candidates.map(candidate => ({
                        name: candidate.name,
                        description: candidate.description,
                        assessed: isAssessed(candidate)
                    }))
                ),
                excluded: JSON.stringify(scope.excluded),
                message:
                    `${scope.discovered} discovered, ${scope.candidates.length} in scope, ` +
                    `${open.length} still to assess (~${estimate.inputTokens + estimate.outputTokens} tokens). Nothing was sent to the AI.`
            };

        } catch (error) {
            console.error("[previewAssessmentScope] FAILED:", error);
            return req.reject(error.status || 500, error.message || "Scope preview failed");
        }
    });

    /**
     * Business object names of the framework catalog (e.g. "Business Partner"),
     * given to the AI as the preferred vocabulary. Empty when the framework
     * tables are not deployed.
     */
    const loadKnownBusinessObjects = async (tx) => {
        try {
            const { BusinessObjectType } = cds.entities("migration.framework");

            return (await tx.run(SELECT.from(BusinessObjectType).columns("name"))).map(type => type.name);
        } catch (error) {
            return [];
        }
    };

    /**
     * Makes sure SourceObject / SourceMetadata / SourceField exist for one
     * discovered object (same data as discoverSourceMetadata, for a single object).
     */
    // objects that are assessed by name and description only (an M3 program on its own): they have no fields by design
    const NO_FIELD_OBJECT_TYPES = new Set(["M3_MI_PROGRAM"]);

    const ensureObjectMetadata = async (tx, { sourceSystem, adapter, discovered }) => {

        let sourceObject = await tx.run(
            SELECT.one.from(SourceObject).where({ objectName: discovered.objectName, sourceSystem_ID: sourceSystem.ID })
        );

        if (!sourceObject) {
            await tx.run(INSERT.into(SourceObject).entries({
                objectId: discovered.objectId || `${sourceSystem.systemId}_${discovered.objectName}`,
                objectName: discovered.objectName,
                businessObject: discovered.businessObject || null,
                objectType: discovered.objectType || "SOURCE_OBJECT",
                schemaVersion: discovered.schemaVersion || "1.0",
                description: discovered.description || null,
                sourceSystem_ID: sourceSystem.ID
            }));

            sourceObject = await tx.run(
                SELECT.one.from(SourceObject).where({ objectName: discovered.objectName, sourceSystem_ID: sourceSystem.ID })
            );
        }

        const existing = await tx.run(
            SELECT.from(SourceMetadata).columns("ID").where({ sourceObject_ID: sourceObject.ID })
        );

        const noFields = NO_FIELD_OBJECT_TYPES.has(String(discovered.objectType || sourceObject.objectType || ""));

        if (existing.length > 0) {
            const withFields = await tx.run(
                SELECT.one.from(SourceField).columns("ID").where({ metadata_ID: { in: existing.map(m => m.ID) } })
            );

            if (withFields || noFields) {
                return false;               // already discovered
            }
        }

        const schema = noFields ? { fields: [], schemaVersion: discovered.schemaVersion || "live" } : await adapter.getSchema(discovered.objectName);
        const fields = (Array.isArray(schema?.fields) ? schema.fields : []).filter(field => field && field.fieldName);

        if (fields.length === 0 && !noFields) {
            throw new Error(`No fields could be discovered for '${discovered.objectName}'`);
        }

        const schemaVersion = schema.schemaVersion || discovered.schemaVersion || "1.0";

        await tx.run(INSERT.into(SourceMetadata).entries({
            metadataId: `${sourceObject.objectId}_${schemaVersion}`,
            schemaVersion,
            extractedAt: new Date(),
            recordCount: 0,
            metadataStatus: "AVAILABLE",
            sourceObject_ID: sourceObject.ID
        }));

        const metadata = await tx.run(
            SELECT.one.from(SourceMetadata).where({ sourceObject_ID: sourceObject.ID, schemaVersion })
        );

        const cleanName = String(discovered.objectName).replace(/_0001$/, "");

        if (fields.length === 0) {
            return true;                    // metadata without fields (a program on its own)
        }

        await tx.run(INSERT.into(SourceField).entries(fields.map(field => ({
            fieldName: field.fieldName,
            objectName: cleanName,
            dataType: field.dataType || null,
            length: field.length || null,
            precision: field.precision || null,
            scale: field.scale || null,
            nullable: field.nullable !== false,
            description: field.description || null,
            metadata_ID: metadata.ID
        }))));

        return true;
    };

    /**
     * ============================================================
     * ASSESS SCOPE (AI): only the objects of the scope not yet assessed
     * ============================================================
     */
    this.on("assessScope", async (req) => {

        const tx = cds.tx(req);
        const maxObjects = Number(req.data.maxObjects) > 0 ? Number(req.data.maxObjects) : 50;

        try {
            const context = await computeAssessmentScope(tx, req);
            const { sourceSystem, adapter, objects, open } = context;

            if (open.length === 0) {
                return {
                    status: "COMPLETED",
                    sourceSystem: sourceSystem.systemId,
                    objectsAssessed: 0,
                    objectsReused: context.scope.candidates.length,
                    objectsFailed: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                    assessedAt: new Date(),
                    message: "Nothing to assess: all objects in scope are already assessed."
                };
            }

            const selected = open.slice(0, maxObjects);
            const byName = new Map(objects.map(object => [object.objectName, object]));
            const members = selected.flatMap(candidate => candidate.members);

            // 1. metadata of the selected objects (only those missing)
            let discoveredNow = 0;

            for (const member of members) {
                const discovered = byName.get(member);

                if (discovered && await ensureObjectMetadata(tx, { sourceSystem, adapter, discovered })) {
                    discoveredNow++;
                }
            }

            // 2. AI assessment, restricted to these objects
            const result = await BusinessObjectAssessmentService.assess({
                sourceSystemId: sourceSystem.ID,
                tx,
                assessmentInstructions: null,
                onlyObjectNames: members,
                knownBusinessObjects: await loadKnownBusinessObjects(tx)
            });

            const trimmed = open.length > selected.length
                ? ` ${open.length - selected.length} more object(s) remain (limit ${maxObjects} per run).`
                : "";

            return {
                status: result.objectsFailed === 0 ? "COMPLETED" : (result.objectsAssessed > 0 ? "PARTIAL" : "FAILED"),
                sourceSystem: sourceSystem.systemId,
                objectsAssessed: result.objectsAssessed,
                objectsReused: result.objectsReused,
                objectsFailed: result.objectsFailed,
                inputTokens: result.inputTokens || 0,
                outputTokens: result.outputTokens || 0,
                totalTokens: result.totalTokens || 0,
                assessedAt: new Date(),
                message:
                    `Metadata discovered for ${discoveredNow} object(s). Assessed: ${result.objectsAssessed}, ` +
                    `failed: ${result.objectsFailed}.${trimmed}` +
                    (result.failures && result.failures.length > 0 ? ` First failure: ${result.failures[0].reason}` : "")
            };

        } catch (error) {
            console.error("[assessScope] FAILED:", error);
            return req.reject(error.status || 500, error.message || "Assessment of the scope failed");
        }
    });

    this.on("testGemini", async (req) => {

    const prompt = req.data.prompt;

    if (!prompt) {
        req.error(400, "Prompt is required");
    }

    try {

        const result = await geminiProvider.generateText(prompt);

        return result;

    } catch (error) {

        console.error("Gemini API error:", error);

        req.error(
            500,
            `Gemini API call failed: ${error.message}`
        );
    }
});

    this.on("testAIMapping", async (req) => {

        const { prompt } = req.data;

        if (!prompt || !prompt.trim()) {
            return req.error(400, "Prompt is required");
        }

        try {

            const orchestrationClient = new OrchestrationClient({
                promptTemplating: {
                    model: {
                        name: "anthropic--claude-4.6-sonnet"
                    }
                }
            });

            const response = await orchestrationClient.chatCompletion({
                messages: [
                    {
                        role: "user",
                        content: prompt
                    }
                ]
            });

            // Actual token usage returned by SAP AI Core
            const usage = response.getTokenUsage();

            const inputTokens =
                usage?.prompt_tokens ?? 0;

            const outputTokens =
                usage?.completion_tokens ?? 0;

            const totalTokens =
                usage?.total_tokens ??
                (inputTokens + outputTokens);

            return {
                response: response.getContent(),
                inputTokens,
                outputTokens,
                totalTokens
            };

        } catch (error) {

            console.error("AI Mapping test failed:", error);

            return req.error(
                500,
                error.message || "AI Mapping execution failed"
            );
        }
    });

    const adapterError = (err) => {
        if (!err) return "Unknown error occurred";
        return err.message || (typeof err === "string" ? err : JSON.stringify(err));
    };

    /**
     * ============================================================
     * SOURCE CONTEXT RESOLUTION
     * ============================================================
     *
     * Current production configuration:
     * - Exactly one source system
     * - Exactly one source connection
     * - Joule/business users do not provide connectionId
     *
     * The database configuration is the source of truth.
     * No source system or connection ID is hard-coded.
     *
     * If a connectionId is explicitly supplied internally, it must
     * match the one configured source connection.
     */
    const resolveSourceContext = async (tx, sourceSystemId) => {

    if (!sourceSystemId) {
        throw new Error(
            "sourceSystemId is required"
        );
    }

    const sourceSystem = await tx.run(
        SELECT.one
            .from(SourceSystem)
            .where({
                systemId: sourceSystemId,
                active: true
            })
    );

    if (!sourceSystem) {
        throw new Error(
            `Active source system '${sourceSystemId}' was not found`
        );
    }

    const connections = await tx.run(
        SELECT
            .from(SourceConnection)
            .where({
                sourceSystem_ID: sourceSystem.ID,
                status: "CONNECTED"
            })
    );

    if (!connections || connections.length === 0) {
        throw new Error(
            `No connected source connection found for source system '${sourceSystemId}'`
        );
    }

    if (connections.length > 1) {
        throw new Error(
            `Multiple connected source connections found for source system '${sourceSystemId}'`
        );
    }

    return {
        sourceSystem,
        connection: connections[0]
    };
};


    /**
     * Finds the connection to test. Accepts a connectionId (preferred) or a
     * source system ID. Unlike resolveSourceContext, the connection does not
     * have to be CONNECTED yet - testing is what makes it CONNECTED.
     */
    const resolveConnectionForTest = async (tx, idOrSystemId) => {

        if (!idOrSystemId) {
            throw new Error("connectionId is required");
        }

        let connection = await tx.run(
            SELECT.one.from(SourceConnection).where({ connectionId: idOrSystemId })
        );

        let sourceSystem = null;

        if (connection) {
            sourceSystem = await tx.run(
                SELECT.one.from(SourceSystem).where({ ID: connection.sourceSystem_ID })
            );
        } else {
            sourceSystem = await tx.run(
                SELECT.one.from(SourceSystem).where({ systemId: idOrSystemId })
            );

            const connections = sourceSystem
                ? await tx.run(SELECT.from(SourceConnection).where({ sourceSystem_ID: sourceSystem.ID }))
                : [];

            if (connections.length > 1) {
                throw new Error(`Source system '${idOrSystemId}' has several connections - pass the connectionId`);
            }

            connection = connections[0];
        }

        if (!connection) {
            throw new Error(`No source connection '${idOrSystemId}' was found`);
        }

        if (!sourceSystem) {
            throw new Error(`Connection '${connection.connectionId}' belongs to a source system that no longer exists - delete or fix this connection`);
        }

        return { connection, sourceSystem };
    };

    /**
     * ============================================================
     * TEST SOURCE CONNECTION
     * ============================================================
     */
    this.on("testSourceConnection", async (req) => {

        const tx = cds.tx(req);

        let connection;
        let sourceSystem;

        try {

            const context = await resolveConnectionForTest(
                tx,
                req.data.connectionId
            );

            connection = context.connection;
            sourceSystem = context.sourceSystem;

        } catch (error) {

            return req.reject(
                400,
                error.message
            );
        }

        const missingConfiguration = [];

        if (!connection.interfaceType) {
            missingConfiguration.push("interfaceType");
        }

        if (!connection.adapterType) {
            missingConfiguration.push("adapterType");
        }

        if (!connection.authenticationType) {
            missingConfiguration.push("authenticationType");
        }

        if (missingConfiguration.length > 0) {

            await tx.run(
                UPDATE(SourceConnection)
                    .set({
                        status: "FAILED",
                        errorCode: "CONNECTION_CONFIGURATION_ERROR",
                        errorMessage:
                            `Missing configuration: ${missingConfiguration.join(", ")}`
                    })
                    .where({
                        ID: connection.ID
                    })
            );

            return {
                connectionId: connection.connectionId,
                sourceSystem: sourceSystem.systemId,
                interfaceType: connection.interfaceType,
                adapterType: connection.adapterType,
                authenticationType: connection.authenticationType,
                status: "FAILED",
                testedAt: new Date(),
                message:
                    `Connection configuration is incomplete. Missing: ${missingConfiguration.join(", ")}`
            };
        }

        let adapter;

        try {

            adapter = createSourceAdapter({
                ...connection,
                systemId: sourceSystem.systemId,
                systemName: sourceSystem.systemName,
                systemType: sourceSystem.systemType
            });

        } catch (error) {

            await tx.run(
                UPDATE(SourceConnection)
                    .set({
                        status: "FAILED",
                        errorCode: "ADAPTER_NOT_IMPLEMENTED",
                        errorMessage: error.message
                    })
                    .where({
                        ID: connection.ID
                    })
            );

            return {
                connectionId: connection.connectionId,
                sourceSystem: sourceSystem.systemId,
                interfaceType: connection.interfaceType,
                adapterType: connection.adapterType,
                authenticationType: connection.authenticationType,
                status: "FAILED",
                testedAt: new Date(),
                message: error.message
            };
        }

        try {

            await adapter.discover();

            const authResult = await adapter.authenticate();

            const statusResult = await adapter.getStatus();

            const testedAt = new Date();

            await tx.run(
                UPDATE(SourceConnection)
                    .set({
                        status: "CONNECTED",
                        lastTestedAt: testedAt,
                        errorCode: null,
                        errorMessage: null
                    })
                    .where({
                        ID: connection.ID
                    })
            );

            return {
                connectionId: connection.connectionId,
                sourceSystem: sourceSystem.systemId,
                interfaceType: connection.interfaceType,
                adapterType: connection.adapterType,
                authenticationType: connection.authenticationType,
                status: statusResult.status || "CONNECTED",
                mode: authResult?.mode || statusResult?.mode || null,
                testedAt,
                message: authResult?.message || "Source connection test successful"
            };

        } catch (error) {

            const normalizedError = adapter.handleError
                ? adapter.handleError(error)
                : {
                    errorCode: "CONNECTION_FAILED",
                    message: error.message
                };

            await tx.run(
                UPDATE(SourceConnection)
                    .set({
                        status: "FAILED",
                        lastTestedAt: new Date(),
                        errorCode: normalizedError.errorCode,
                        errorMessage: normalizedError.message
                    })
                    .where({
                        ID: connection.ID
                    })
            );

            return {
                connectionId: connection.connectionId,
                sourceSystem: sourceSystem.systemId,
                interfaceType: connection.interfaceType,
                adapterType: connection.adapterType,
                authenticationType: connection.authenticationType,
                status: "FAILED",
                testedAt: new Date(),
                message: normalizedError.message
            };
        }
    });


    /**
     * ============================================================
     * DISCOVER SOURCE METADATA
     * ============================================================
     */
    /**
 * ============================================================
 * DISCOVER SOURCE METADATA
 * ============================================================
 */
/**
 * ============================================================
 * DISCOVER SOURCE METADATA
 * ============================================================
 */
this.on("discoverSourceMetadata", async (req) => {

    const tx = cds.tx(req);

    try {

        /*
         * ========================================================
         * RESOLVE CONFIGURED SOURCE
         * ========================================================
         */

        const {
    connection,
    sourceSystem
} = await resolveSourceContext(
    tx,
    req.data.sourceSystemId
);

        /*
         * ========================================================
         * SOURCE CONNECTION MUST BE CONNECTED
         * ========================================================
         */

        if (connection.status !== "CONNECTED") {

            return req.reject(
                400,
                `Source connection '${connection.connectionId}' is not connected`
            );
        }

        /*
         * ========================================================
         * CREATE SOURCE ADAPTER
         * ========================================================
         *
         * Adapter type comes from SourceConnection.
         * Nothing is hard-coded here.
         */

        let adapter;

        try {

            adapter = createSourceAdapter({

                ...connection,

                systemId:
                    sourceSystem.systemId,

                systemName:
                    sourceSystem.systemName,

                systemType:
                    sourceSystem.systemType
            });

        } catch (error) {

            return req.reject(
                400,
                error.message
            );
        }

        /*
         * ========================================================
         * SOURCE-LEVEL METADATA
         * ========================================================
         */

        const metadata =
            await adapter.getMetadata();

        /*
         * ========================================================
         * EXISTING OBJECT DISCOVERY ENGINE
         * ========================================================
         *
         * Discover ALL objects.
         *
         * No objectName supplied by caller.
         */

        const objects =
            await adapter.discoverObjects();

        if (
            !Array.isArray(objects) ||
            objects.length === 0
        ) {

            return req.reject(
                404,
                "No source objects were discovered"
            );
        }

        const discoveredAt =
            new Date();

        let totalFields = 0;

        /*
         * ========================================================
         * SEMANTIC ASSESSMENT INPUT
         * ========================================================
         */

        const assessmentInputs = [];

        /*
         * ========================================================
         * PROCESS EVERY DISCOVERED OBJECT
         * ========================================================
         */

        // objects that exist already; the new ones are saved in bulk (a catalog can hold thousands of objects)
        const knownObjects = new Map(
            (await tx.run(SELECT.from(SourceObject).where({ sourceSystem_ID: sourceSystem.ID }))).map(row => [row.objectName, row])
        );
        const queued = new Set();
        const fresh = [];

        for (const object of objects) {
            if (!object || !object.objectName || knownObjects.has(object.objectName) || queued.has(object.objectName)) {
                continue;
            }

            queued.add(object.objectName);
            fresh.push({
                objectId: object.objectId || `${sourceSystem.systemId}_${object.objectName}`,
                objectName: object.objectName,
                businessObject: object.businessObject || null,
                objectType: object.objectType || "SOURCE_OBJECT",
                schemaVersion: object.schemaVersion || metadata.metadataVersion || "1.0",
                description: object.description || null,
                sourceSystem_ID: sourceSystem.ID
            });
        }

        for (let i = 0; i < fresh.length; i += 200) {
            await tx.run(INSERT.into(SourceObject).entries(fresh.slice(i, i + 200)));
        }

        if (fresh.length > 0) {
            (await tx.run(SELECT.from(SourceObject).where({ sourceSystem_ID: sourceSystem.ID })))
                .forEach(row => knownObjects.set(row.objectName, row));
        }

        for (const object of objects) {

            if (
                !object ||
                !object.objectName
            ) {
                continue;
            }

            /*
             * ----------------------------------------------------
             * SOURCE OBJECT
             * ----------------------------------------------------
             */

            const sourceObject = knownObjects.get(object.objectName);

            if (!sourceObject) {

                throw new Error(
                    `SourceObject '${object.objectName}' could not be created or retrieved`
                );
            }

            /*
             * ----------------------------------------------------
             * GET SCHEMA FOR THIS OBJECT
             * ----------------------------------------------------
             */

            let schema;

try {

    schema = await adapter.getSchema(
        object.objectName
    );

} catch (schemaError) {

    console.warn(
        `[discoverSourceMetadata] Skipping object '${object.objectName}' because schema discovery failed:`,
        schemaError.message
    );

    continue;
}

if (!schema) {

    console.warn(
        `[discoverSourceMetadata] Skipping object '${object.objectName}' because no schema was returned`
    );

    continue;
}

            // an object without fields (for example an M3 program on its own) is listed, but has no metadata to store
            if (!Array.isArray(schema.fields) || schema.fields.length === 0) {
                continue;
            }

            /*
             * ----------------------------------------------------
             * SCHEMA VERSION
             * ----------------------------------------------------
             */

            const schemaVersion =
                schema.schemaVersion ||
                object.schemaVersion ||
                metadata.metadataVersion ||
                "1.0";

            /*
             * ----------------------------------------------------
             * SOURCE METADATA
             * ----------------------------------------------------
             */

            let sourceMetadata =
                await tx.run(
                    SELECT.one
                        .from(SourceMetadata)
                        .columns(
                            "ID",
                            "metadataId",
                            "schemaVersion",
                            "extractedAt",
                            "recordCount",
                            "metadataStatus",
                            "sourceObject_ID"
                        )
                        .where({
                            sourceObject_ID:
                                sourceObject.ID,

                            schemaVersion
                        })
                );

            if (!sourceMetadata) {

                const metadataId =
                    `${sourceObject.objectId}_${schemaVersion}`;

                await tx.run(
                    INSERT.into(SourceMetadata)
                        .entries({

                            metadataId,

                            schemaVersion,

                            extractedAt:
                                discoveredAt,

                            recordCount:
                                0,

                            metadataStatus:
                                "AVAILABLE",

                            sourceObject_ID:
                                sourceObject.ID
                        })
                );

                sourceMetadata =
                    await tx.run(
                        SELECT.one
                            .from(SourceMetadata)
                            .columns(
                                "ID",
                                "metadataId",
                                "schemaVersion",
                                "extractedAt",
                                "recordCount",
                                "metadataStatus",
                                "sourceObject_ID"
                            )
                            .where({
                                sourceObject_ID:
                                    sourceObject.ID,

                                schemaVersion
                            })
                    );
            }

            if (!sourceMetadata) {

                throw new Error(
                    `SourceMetadata for '${object.objectName}' could not be created or retrieved`
                );
            }

            /*
             * ----------------------------------------------------
             * SOURCE FIELDS
             * ----------------------------------------------------
             */

            const fields =
                Array.isArray(schema.fields)
                    ? schema.fields
                    : [];

            totalFields +=
                fields.length;

            const cleanObjectName =
                String(object.objectName)
                    .replace(/_0001$/, "");

            for (const field of fields) {

                if (
                    !field ||
                    !field.fieldName
                ) {
                    continue;
                }

                const existingField =
                    await tx.run(
                        SELECT.one
                            .from(SourceField)
                            .where({
                                fieldName:
                                    field.fieldName,

                                metadata_ID:
                                    sourceMetadata.ID
                            })
                    );

                if (!existingField) {

                    await tx.run(
                        INSERT.into(SourceField)
                            .entries({

                                fieldName:
                                    field.fieldName,

                                objectName:
                                    cleanObjectName,

                                dataType:
                                    field.dataType ||
                                    null,

                                length:
                                    field.length ||
                                    null,

                                precision:
                                    field.precision ||
                                    null,

                                scale:
                                    field.scale ||
                                    null,

                                nullable:
                                    field.nullable !== false,

                                description:
                                    field.description ||
                                    null,

                                metadata_ID:
                                    sourceMetadata.ID
                            })
                    );
                }
            }

            /*
             * ----------------------------------------------------
             * BUILD ASSESSMENT INPUT
             * ----------------------------------------------------
             */

            assessmentInputs.push({

                object: {

                    objectId:
                        sourceObject.objectId,

                    objectName:
                        sourceObject.objectName,

                    objectType:
                        sourceObject.objectType,

                    schemaVersion:
                        sourceMetadata.schemaVersion,

                    description:
                        sourceObject.description ||
                        null
                },

                fields:
                    fields
                        .filter(
                            field =>
                                field &&
                                field.fieldName
                        )
                        .map(
                            field => ({

                                fieldName:
                                    field.fieldName,

                                dataType:
                                    field.dataType ||
                                    null,

                                length:
                                    field.length ||
                                    null,

                                precision:
                                    field.precision ||
                                    null,

                                scale:
                                    field.scale ||
                                    null,

                                nullable:
                                    field.nullable !== false,

                                description:
                                    field.description ||
                                    null
                            })
                        )
            });
        }

        /*
         * ========================================================
         * DISCOVERY COMPLETED
         * ========================================================
         */

        console.log(
            "[discoverSourceMetadata] Completed",
            {
                sourceSystem:
                    sourceSystem.systemId,

                adapterType:
                    connection.adapterType,

                objectCount:
                    objects.length,

                assessmentObjectCount:
                    assessmentInputs.length,

                totalFields
            }
        );

        return {

            sourceSystem:
                sourceSystem.systemId,

            systemType:
                sourceSystem.systemType,

            interfaceType:
                connection.interfaceType,

            adapterType:
                connection.adapterType,

            status:
                "DISCOVERED",

            metadataVersion:
                metadata.metadataVersion ||
                "1.0",

            discoveredAt,

            objectsDiscovered:
                objects.length,

            fieldsDiscovered:
                totalFields,

            message:
                `Source metadata discovery completed successfully. ${objects.length} object(s) and ${totalFields} field(s) discovered.`
        };

    } catch (error) {

        console.error(
            "[discoverSourceMetadata] FAILED:",
            error
        );

        return req.reject(
            500,
            error.message ||
            "Source metadata discovery failed"
        );
    }
});


    /**
     * ============================================================
     * STANDARD INGESTION CONTRACT
     * ============================================================
     */
    this.on("ingestSourceData", async (req) => {

        const {
            connectionId,
            objectName
        } = req.data;

        let {
            runId,
            batchId
        } = req.data;

        if (!objectName) {
            return req.reject(
                400,
                "objectName is required"
            );
        }

        runId =
            runId ||
            `RUN-${Date.now()}-${Math.random()
                .toString(36)
                .substring(2, 8)}`;

        batchId =
            batchId ||
            `BATCH-${Date.now()}-${Math.random()
                .toString(36)
                .substring(2, 8)}`;

        const tx = cds.tx(req);

        try {

            const context = await resolveSourceContext(
                tx,
                connectionId
            );

            const connection = context.connection;
            const sourceSystem = context.sourceSystem;

            if (connection.status !== "CONNECTED") {

                return req.reject(
                    400,
                    `Source connection '${connection.connectionId}' is not connected. Run testSourceConnection first.`
                );
            }

            let adapter;

            try {

                adapter = createSourceAdapter({
                    ...connection,
                    systemId: sourceSystem.systemId,
                    systemName: sourceSystem.systemName,
                    systemType: sourceSystem.systemType
                });

            } catch (error) {

                return req.reject(
                    400,
                    error.message
                );
            }

            const cleanName =
                String(objectName)
                    .replace(/_0001$/, "");

            const sourceObject = await tx.run(
                SELECT.one
                    .from(SourceObject)
                    .where({
                        sourceSystem_ID: sourceSystem.ID
                    })
                    .and(
                        `objectName = '${objectName}' or objectName = '${cleanName}' or objectName = '${cleanName}_0001' or objectId like '%${cleanName}%' or businessObject = '${objectName}'`
                    )
            );

            if (!sourceObject) {

                return req.reject(
                    404,
                    `Source object '${objectName}' was not found. Run source metadata discovery first.`
                );
            }

            const sourceMetadata = await tx.run(
                SELECT.one
                    .from(SourceMetadata)
                    .columns(
                        "ID",
                        "metadataId",
                        "schemaVersion",
                        "extractedAt",
                        "recordCount",
                        "metadataStatus",
                        "sourceObject_ID"
                    )
                    .where({
                        sourceObject_ID: sourceObject.ID,
                        schemaVersion:
                            sourceObject.schemaVersion || "1.0"
                    })
            );

            if (!sourceMetadata) {

                return req.reject(
                    404,
                    `Source metadata for object '${objectName}' was not found. Run source metadata discovery first.`
                );
            }

            const schema =
                await adapter.getSchema(objectName);

            const schemaVersion =
                schema.schemaVersion ||
                sourceMetadata.schemaVersion ||
                sourceObject.schemaVersion ||
                "1.0";

            const extracted =
                await adapter.extract(
                    objectName,
                    {
                        runId,
                        batchId
                    }
                );

            if (!extracted) {

                return req.reject(
                    500,
                    "Source adapter returned no extraction result"
                );
            }

            const extractedRecords =
                Array.isArray(extracted.records)
                    ? extracted.records
                    : [];

            const extractedAt =
                extracted.metadata &&
                extracted.metadata.extractedAt
                    ? new Date(
                        extracted.metadata.extractedAt
                    )
                    : new Date();

            const standardIngestionContract = {

                runId,

                batchId,

                source: {
                    system: sourceSystem.systemId,
                    type:
                        sourceSystem.systemType ||
                        connection.adapterType,
                    interface:
                        connection.interfaceType,
                    object: objectName
                },

                schema: {
                    version: schemaVersion,
                    fields: schema.fields || []
                },

                records: extractedRecords,

                metadata: {
                    extractedAt,
                    recordCount:
                        extractedRecords.length
                }
            };

            let ingestedCount = 0;
            let duplicateCount = 0;
            let failedCount = 0;

            const rawRecordElements =
                RawRecord.elements || {};

            for (
                let index = 0;
                index < standardIngestionContract.records.length;
                index++
            ) {

                const record =
                    standardIngestionContract.records[index];

                try {

                    let sourceKey =
                        record.sourceKey ||
                        record.BusinessPartner ||
                        record.Customer ||
                        record.Supplier ||
                        record.id ||
                        record.ID;

                    if (
                        sourceKey === undefined ||
                        sourceKey === null ||
                        String(sourceKey).trim() === ""
                    ) {

                        throw new Error(
                            "Source record does not contain a source key"
                        );
                    }

                    sourceKey =
                        String(sourceKey);

                    const whereClause = {
                        runId,
                        sourceKey
                    };

                    if ("sourceObject" in rawRecordElements) {

                        whereClause.sourceObject =
                            objectName;
                    }

                    const existingRecord =
                        await tx.run(
                            SELECT.one
                                .from(RawRecord)
                                .where(whereClause)
                        );

                    if (existingRecord) {

                        duplicateCount++;
                        continue;
                    }

                    const candidatePayload = {

                        runId,

                        batchId,

                        sourceKey,

                        schemaVersion:
                            standardIngestionContract
                                .schema
                                .version,

                        sourceInterface:
                            standardIngestionContract
                                .source
                                .interface,

                        sourceType:
                            standardIngestionContract
                                .source
                                .type,

                        sourceObject:
                            standardIngestionContract
                                .source
                                .object,

                        extractedAt,

                        ingestedAt:
                            new Date(),

                        payload:
                            typeof record === "string"
                                ? record
                                : JSON.stringify(record),

                        processingStatus:
                            "INGESTED",

                        errorCode: null,

                        errorMessage: null
                    };

                    if (
                        "sourceSystem_ID"
                        in rawRecordElements
                    ) {

                        candidatePayload.sourceSystem_ID =
                            sourceSystem.ID;

                    } else if (
                        "sourceSystem"
                        in rawRecordElements
                    ) {

                        candidatePayload.sourceSystem =
                            sourceSystem.systemId;
                    }

                    if (
                        "ingestionKey"
                        in rawRecordElements
                    ) {

                        candidatePayload.ingestionKey =
                            `${runId}|${sourceSystem.systemId}|${objectName}|${sourceKey}`;
                    }

                    const safeInsertData = {};

                    for (
                        const [
                            colName,
                            colVal
                        ]
                        of Object.entries(candidatePayload)
                    ) {

                        if (
                            colName
                            in rawRecordElements
                        ) {

                            safeInsertData[colName] =
                                colVal;
                        }
                    }

                    await tx.run(
                        INSERT.into(RawRecord)
                            .entries(safeInsertData)
                    );

                    ingestedCount++;

                } catch (recordError) {

                    failedCount++;

                    console.error(
                        `RAW_RECORD ingestion failed for record ${index + 1}:`,
                        recordError.message ||
                        recordError
                    );
                }
            }

            await tx.run(
                UPDATE(SourceMetadata)
                    .set({
                        recordCount:
                            standardIngestionContract
                                .metadata
                                .recordCount || 0,

                        extractedAt:
                            standardIngestionContract
                                .metadata
                                .extractedAt,

                        metadataStatus:
                            "AVAILABLE"
                    })
                    .where({
                        ID: sourceMetadata.ID
                    })
            );

            let status = "INGESTED";

            if (
                failedCount > 0 &&
                ingestedCount === 0
            ) {

                status = "FAILED";

            } else if (
                failedCount > 0
            ) {

                status = "PARTIAL";
            }

            return {

                runId,

                batchId,

                connectionId:
                    connection.connectionId,

                sourceSystem:
                    sourceSystem.systemId,

                sourceType:
                    standardIngestionContract
                        .source
                        .type,

                sourceInterface:
                    standardIngestionContract
                        .source
                        .interface,

                sourceObject:
                    standardIngestionContract
                        .source
                        .object,

                schemaVersion:
                    standardIngestionContract
                        .schema
                        .version,

                status,

                extractedCount:
                    standardIngestionContract
                        .metadata
                        .recordCount,

                ingestedCount,

                duplicateCount,

                failedCount,

                extractedAt:
                    standardIngestionContract
                        .metadata
                        .extractedAt,

                message:
                    `Source ingestion completed. Extracted: ${standardIngestionContract.metadata.recordCount}, Ingested: ${ingestedCount}, Duplicates: ${duplicateCount}, Failed: ${failedCount}.`
            };

        } catch (error) {

            console.error(
                "Standard ingestion failed:",
                error
            );

            const msg =
                error.message ||
                "Unknown ingestion error";

            const code =
                msg.startsWith("SCHEMA_ERROR:")
                    ? "SCHEMA_ERROR"
                    : "INGESTION_ERROR";

            return req.reject(
                500,
                `${code}: ${msg.replace(
                    /^(SCHEMA_ERROR|INGESTION_ERROR):\s*/,
                    ""
                )}`
            );
        }
    });


    /**
     * ============================================================
     * RAW → CANONICAL CUSTOMER
     * ============================================================
     */
    this.on("transformRawToCanonicalCustomer", async (req) => {

        const {
            runId,
            batchId,
            sourceObject
        } = req.data;

        if (!runId) {
            return req.reject(
                400,
                "runId is required"
            );
        }

        if (!batchId) {
            return req.reject(
                400,
                "batchId is required"
            );
        }

        if (!sourceObject) {
            return req.reject(
                400,
                "sourceObject is required"
            );
        }

        const tx = cds.tx(req);

        try {

            const rawRecords =
                await tx.run(
                    SELECT
                        .from(RawRecord)
                        .where({
                            runId,
                            batchId,
                            sourceObject
                        })
                );

            if (
                !rawRecords ||
                rawRecords.length === 0
            ) {

                return {
                    runId,
                    batchId,
                    sourceObject,
                    extractedCount: 0,
                    canonicalizedCount: 0,
                    duplicateCount: 0,
                    failedCount: 0,
                    status: "NO_DATA",
                    canonicalizedAt: new Date(),
                    message:
                        "No RAW_RECORD entries were found for the supplied runId, batchId and sourceObject."
                };
            }

            let canonicalizedCount = 0;
            let duplicateCount = 0;
            let failedCount = 0;

            const canonicalizedAt =
                new Date();

            const canonicalElements =
                CanonicalCustomer.elements || {};

            for (
                const rawRecord
                of rawRecords
            ) {

                try {

                    const existingCanonical =
                        await tx.run(
                            SELECT.one
                                .from(CanonicalCustomer)
                                .where({
                                    runId,
                                    sourceRecordId:
                                        String(rawRecord.ID)
                                })
                        );

                    if (existingCanonical) {

                        duplicateCount++;
                        continue;
                    }

                    let payload;

                    try {

                        payload =
                            typeof rawRecord.payload === "string"
                                ? JSON.parse(
                                    rawRecord.payload
                                )
                                : rawRecord.payload;

                    } catch (parseError) {

                        throw new Error(
                            `TRANSFORMATION_ERROR: Invalid JSON payload for RAW_RECORD '${rawRecord.ID}'`
                        );
                    }

                    if (
                        !payload ||
                        typeof payload !== "object" ||
                        Array.isArray(payload)
                    ) {

                        throw new Error(
                            `TRANSFORMATION_ERROR: RAW_RECORD '${rawRecord.ID}' payload must be a JSON object`
                        );
                    }

                    const readFirst = (names) => {

                        for (
                            const name
                            of names
                        ) {

                            if (
                                Object.prototype.hasOwnProperty.call(
                                    payload,
                                    name
                                ) &&
                                payload[name] !== null &&
                                payload[name] !== undefined &&
                                String(
                                    payload[name]
                                ).trim() !== ""
                            ) {

                                return payload[name];
                            }
                        }

                        return null;
                    };

                    const candidateCanonical = {

                        runId:
                            rawRecord.runId,

                        batchId:
                            rawRecord.batchId,

                        sourceRecordId:
                            String(rawRecord.ID),

                        sourceSystem:
                            rawRecord.sourceSystem ||
                            rawRecord.sourceSystem_ID ||
                            null,

                        sourceKey:
                            rawRecord.sourceKey,

                        sourceObject:
                            rawRecord.sourceObject,

                        rawRecordId:
                            rawRecord.ID,

                        externalId:
                            readFirst([
                                "BusinessPartner",
                                "Customer",
                                "id",
                                "ID"
                            ]),

                        customerNumber:
                            readFirst([
                                "Customer",
                                "BusinessPartner",
                                "customerNumber",
                                "customerNo",
                                "customerId",
                                "customerID"
                            ]),

                        name:
                            readFirst([
                                "BusinessPartnerFullName",
                                "OrganizationBPName1",
                                "name",
                                "customerName",
                                "customer_name",
                                "displayName"
                            ]),

                        address1:
                            readFirst([
                                "StreetName",
                                "address1",
                                "addressLine1",
                                "address",
                                "street",
                                "street1"
                            ]),

                        address2:
                            readFirst([
                                "address2",
                                "addressLine2",
                                "street2"
                            ]),

                        city:
                            readFirst([
                                "CityName",
                                "city",
                                "town"
                            ]),

                        postalCode:
                            readFirst([
                                "PostalCode",
                                "postalCode",
                                "postal_code",
                                "zipCode",
                                "zip"
                            ]),

                        country:
                            readFirst([
                                "Country",
                                "country",
                                "countryCode",
                                "country_code"
                            ]),

                        phone:
                            readFirst([
                                "PhoneNumber",
                                "phone",
                                "telephone",
                                "mobile"
                            ]),

                        email:
                            readFirst([
                                "EmailAddress",
                                "email",
                                "emailAddress",
                                "email_address"
                            ]),

                        contactPerson:
                            readFirst([
                                "contactPerson",
                                "contactName",
                                "contact"
                            ]),

                        taxNumber:
                            readFirst([
                                "TaxNumber",
                                "taxNumber",
                                "taxNo",
                                "taxId"
                            ]),

                        taxClassification:
                            readFirst([
                                "taxClassification",
                                "taxClass"
                            ]),

                        paymentTerm:
                            readFirst([
                                "PaymentTerms",
                                "paymentTerm",
                                "paymentTerms"
                            ]),

                        currency:
                            readFirst([
                                "Currency",
                                "currency",
                                "currencyCode"
                            ]),

                        companyCode:
                            readFirst([
                                "CompanyCode",
                                "companyCode",
                                "company"
                            ]),

                        salesArea:
                            readFirst([
                                "SalesOrganization",
                                "salesArea"
                            ]),

                        activeBlocked:
                            readFirst([
                                "BusinessPartnerIsBlocked",
                                "activeBlocked",
                                "blocked"
                            ]),

                        sourceStatus:
                            readFirst([
                                "sourceStatus",
                                "status",
                                "recordStatus"
                            ]),

                        processingStatus:
                            "CANONICALIZED",

                        validationStatus:
                            "NOT_VALIDATED",

                        mappingStatus:
                            "DETERMINISTIC",

                        mappingVersion:
                            "1.0",

                        mappingEvidence:
                            JSON.stringify({
                                method:
                                    "semantic-alias-normalization",
                                sourceObject:
                                    rawRecord.sourceObject,
                                sourceKey:
                                    rawRecord.sourceKey,
                                rawRecordId:
                                    rawRecord.ID
                            }),

                        transformationRequired:
                            false,

                        transformationReference:
                            null,

                        canonicalPayload:
                            JSON.stringify(payload),

                        canonicalizedAt
                    };

                    const safeData = {};

                    for (
                        const [
                            propName,
                            propVal
                        ]
                        of Object.entries(
                            candidateCanonical
                        )
                    ) {

                        if (
                            propName
                            in canonicalElements
                        ) {

                            safeData[propName] =
                                propVal;
                        }
                    }

                    await tx.run(
                        INSERT.into(
                            CanonicalCustomer
                        ).entries(safeData)
                    );

                    await tx.run(
                        UPDATE(RawRecord)
                            .set({
                                processingStatus:
                                    "PROCESSED",
                                errorCode: null,
                                errorMessage: null
                            })
                            .where({
                                ID: rawRecord.ID
                            })
                    );

                    canonicalizedCount++;

                } catch (recordError) {

                    failedCount++;

                    console.error(
                        `Canonicalization failed for RAW_RECORD '${rawRecord.ID}':`,
                        recordError
                    );

                    await tx.run(
                        UPDATE(RawRecord)
                            .set({
                                processingStatus:
                                    "FAILED",
                                errorCode:
                                    "TRANSFORMATION_ERROR",
                                errorMessage:
                                    recordError.message
                            })
                            .where({
                                ID: rawRecord.ID
                            })
                    );
                }
            }

            let status =
                "CANONICALIZED";

            if (
                failedCount > 0 &&
                canonicalizedCount === 0
            ) {

                status = "FAILED";

            } else if (
                failedCount > 0
            ) {

                status = "PARTIAL";
            }

            return {

                runId,

                batchId,

                sourceObject,

                extractedCount:
                    rawRecords.length,

                canonicalizedCount,

                duplicateCount,

                failedCount,

                status,

                canonicalizedAt,

                message:
                    `RAW to Canonical Customer transformation completed. RAW records: ${rawRecords.length}, Canonicalized: ${canonicalizedCount}, Duplicates: ${duplicateCount}, Failed: ${failedCount}.`
            };

        } catch (error) {

            console.error(
                "RAW to Canonical Customer transformation failed:",
                error
            );

            return req.reject(
                500,
                `TRANSFORMATION_ERROR: ${error.message || "Unknown canonicalization error"}`
            );
        }
    });


    /**
     * ============================================================
     * DATA PROFILING / QUALITY ANALYSIS
     * ============================================================
     */
    this.on("profileData", async (req) => {

        const {
            runId,
            batchId,
            sourceObject
        } = req.data;

        if (!runId) {
            return req.reject(
                400,
                "runId is required"
            );
        }

        if (!batchId) {
            return req.reject(
                400,
                "batchId is required"
            );
        }

        if (!sourceObject) {
            return req.reject(
                400,
                "sourceObject is required"
            );
        }

        const tx = cds.tx(req);

        try {

            const rawRecords =
                await tx.run(
                    SELECT
                        .from(RawRecord)
                        .where({
                            runId,
                            batchId,
                            sourceObject
                        })
                );

            if (
                !rawRecords ||
                rawRecords.length === 0
            ) {
                return profileRecords({
                    runId,
                    batchId,
                    sourceObject,
                    rawRecords: [],
                    sourceFields: []
                });
            }

            const cleanSourceObject =
                String(sourceObject)
                    .replace(/_0001$/, "");

            const candidateObjectNames =
                Array.from(
                    new Set([
                        sourceObject,
                        cleanSourceObject,
                        `${cleanSourceObject}_0001`
                    ])
                );

            const sourceSystemId =
                rawRecords.find(
                    (record) => record.sourceSystem
                )?.sourceSystem;

            const sourceSystemRecord =
                sourceSystemId
                    ? await tx.run(
                        SELECT.one
                            .from(SourceSystem)
                            .where({
                                systemId: sourceSystemId
                            })
                    )
                    : null;

            const sourceObjects = [];
            const seenSourceObjectIds =
                new Set();

            for (
                const candidateObjectName
                of candidateObjectNames
            ) {
                const objectRows =
                    await tx.run(
                        SELECT
                            .from(SourceObject)
                            .where({
                                objectName:
                                    candidateObjectName
                            })
                    );

                for (const objectRow of objectRows) {
                    if (
                        sourceSystemRecord &&
                        objectRow.sourceSystem_ID !==
                            sourceSystemRecord.ID
                    ) {
                        continue;
                    }

                    if (
                        !seenSourceObjectIds.has(
                            objectRow.ID
                        )
                    ) {
                        sourceObjects.push(objectRow);
                        seenSourceObjectIds.add(
                            objectRow.ID
                        );
                    }
                }
            }

            const rawSchemaVersion =
                rawRecords.find(
                    (record) => record.schemaVersion
                )?.schemaVersion;

            let sourceFields = [];

            for (const sourceObjectRow of sourceObjects) {
                const metadataRows =
                    await tx.run(
                        SELECT
                            .from(SourceMetadata)
                            .where({
                                sourceObject_ID:
                                    sourceObjectRow.ID
                            })
                    );

                metadataRows.sort((left, right) => {
                    if (
                        rawSchemaVersion &&
                        left.schemaVersion === rawSchemaVersion
                    ) {
                        return -1;
                    }

                    if (
                        rawSchemaVersion &&
                        right.schemaVersion === rawSchemaVersion
                    ) {
                        return 1;
                    }

                    return new Date(
                        right.modifiedAt ||
                        right.extractedAt ||
                        0
                    ) - new Date(
                        left.modifiedAt ||
                        left.extractedAt ||
                        0
                    );
                });

                for (const metadataRow of metadataRows) {
                    sourceFields =
                        await tx.run(
                            SELECT
                                .from(SourceField)
                                .where({
                                    metadata_ID:
                                        metadataRow.ID
                                })
                        );

                    if (sourceFields.length > 0) {
                        break;
                    }
                }

                if (sourceFields.length > 0) {
                    break;
                }
            }

            /*
             * Compatibility fallback for metadata discovered by an
             * earlier version that populated SourceField.objectName
             * without a resolvable SourceMetadata association.
             */
            if (sourceFields.length === 0) {
                sourceFields =
                    await tx.run(
                        SELECT
                            .from(SourceField)
                            .where({
                                objectName:
                                    cleanSourceObject
                            })
                    );
            }

            if (sourceFields.length === 0) {
                const metadataError =
                    new Error(
                        `No source field metadata was found for '${sourceObject}'`
                    );

                metadataError.code =
                    "SOURCE_METADATA_NOT_FOUND";

                throw metadataError;
            }

            return profileRecords({
                runId,
                batchId,
                sourceObject,
                rawRecords,
                sourceFields
            });

        } catch (error) {

            console.error(
                "Data profiling failed:",
                error
            );

            if (
                error instanceof
                    AllRecordsMalformedError ||
                error.code ===
                    "ALL_RECORDS_MALFORMED"
            ) {
                return req.reject(
                    422,
                    `DATA_QUALITY_ERROR: ${error.message}`
                );
            }

            if (
                error.code ===
                    "SOURCE_METADATA_NOT_FOUND"
            ) {
                return req.reject(
                    404,
                    error.message
                );
            }

            return req.reject(
                500,
                `DATA_QUALITY_ERROR: ${error.message || "Unknown profiling error"}`
            );
        }
    });


    /**
     * ============================================================
     * TARGET METADATA DISCOVERY
     * ============================================================
     */
    this.on("discoverTargetMetadata", async (req) => {

        const effectiveRunId =
            req.data.runId ||
            `EXPLORE_${Date.now()}`;

        const tx = cds.tx(req);

        try {

            const migrationRun =
                await tx.run(
                    SELECT.one
                        .from(MigrationRun)
                        .where({
                            runId: effectiveRunId
                        })
                );

            let targetSystem;

            if (
                migrationRun &&
                migrationRun.targetSystem
            ) {

                targetSystem =
                    await tx.run(
                        SELECT.one
                            .from(TargetSystem)
                            .where({
                                systemId:
                                    migrationRun.targetSystem
                            })
                    );
            }

            if (!targetSystem) {

                targetSystem =
                    await tx.run(
                        SELECT.one
                            .from(TargetSystem)
                            .where({
                                active: true
                            })
                    );
            }

            if (!targetSystem) {

                return req.reject(
                    404,
                    "No active target system was found in configuration"
                );
            }

            const targetConnection =
                await tx.run(
                    SELECT.one
                        .from(TargetConnection)
                        .where({
                            targetSystem_ID:
                                targetSystem.ID
                        })
                );

            if (!targetConnection) {

                return req.reject(
                    404,
                    `No target connection is configured for target system '${targetSystem.systemId}'`
                );
            }

            let adapter;

            if (
                (
                    targetConnection.adapterType ||
                    ""
                ).toUpperCase() === "SYNTHETIC"
            ) {

                adapter =
                    new SyntheticTargetAdapter({
                        ...targetConnection,
                        systemId:
                            targetSystem.systemId,
                        systemName:
                            targetSystem.systemName,
                        systemType:
                            targetSystem.systemType
                    });

            } else {

                return req.reject(
                    400,
                    `No target discovery implementation is currently available for adapter type '${targetConnection.adapterType}'`
                );
            }

            await adapter.discover();

            await adapter.authenticate();

            const metadata =
                await adapter.getMetadata();

            const objects =
                await adapter.discoverObjects();

            const discoveredAt =
                new Date();

            let totalFields = 0;

            for (
                const object
                of objects
            ) {

                let targetObject =
                    await tx.run(
                        SELECT.one
                            .from(TargetObject)
                            .where({
                                objectName:
                                    object.objectName,
                                targetSystem_ID:
                                    targetSystem.ID
                            })
                    );

                if (!targetObject) {

                    await tx.run(
                        INSERT.into(TargetObject)
                            .entries({
                                objectId:
                                    object.objectId ||
                                    `${targetSystem.systemId}_${object.objectName}`,

                                objectName:
                                    object.objectName,

                                businessObject:
                                    object.businessObject ||
                                    object.objectName,

                                objectType:
                                    object.objectType ||
                                    "ODATA_V4",

                                schemaVersion:
                                    object.schemaVersion ||
                                    metadata.metadataVersion ||
                                    "1.0",

                                description:
                                    object.description ||
                                    null,

                                targetSystem_ID:
                                    targetSystem.ID
                            })
                    );

                    targetObject =
                        await tx.run(
                            SELECT.one
                                .from(TargetObject)
                                .where({
                                    objectName:
                                        object.objectName,
                                    targetSystem_ID:
                                        targetSystem.ID
                                })
                        );
                }

                const schema =
                    await adapter.getSchema(
                        object.objectName
                    );

                const schemaVersion =
                    schema.schemaVersion ||
                    object.schemaVersion ||
                    metadata.metadataVersion ||
                    "1.0";

                let targetMetadata =
                    await tx.run(
                        SELECT.one
                            .from(TargetMetadata)
                            .where({
                                targetObject_ID:
                                    targetObject.ID,
                                schemaVersion
                            })
                    );

                if (!targetMetadata) {

                    const metadataId =
                        `${targetObject.objectId}_${schemaVersion}`;

                    await tx.run(
                        INSERT.into(TargetMetadata)
                            .entries({
                                metadataId,
                                schemaVersion,
                                extractedAt:
                                    discoveredAt,
                                metadataStatus:
                                    "DISCOVERED",
                                targetObject_ID:
                                    targetObject.ID
                            })
                    );

                    targetMetadata =
                        await tx.run(
                            SELECT.one
                                .from(TargetMetadata)
                                .where({
                                    targetObject_ID:
                                        targetObject.ID,
                                    schemaVersion
                                })
                        );
                }

                const fields =
                    Array.isArray(schema.fields)
                        ? schema.fields
                        : [];

                for (
                    const field
                    of fields
                ) {

                    const existingField =
                        await tx.run(
                            SELECT.one
                                .from(TargetField)
                                .where({
                                    fieldName:
                                        field.fieldName,
                                    metadata_ID:
                                        targetMetadata.ID
                                })
                        );

                    if (!existingField) {

                        await tx.run(
                            INSERT.into(TargetField)
                                .entries({
                                    fieldName:
                                        field.fieldName,
                                    dataType:
                                        field.dataType ||
                                        null,
                                    length:
                                        field.length ||
                                        null,
                                    precision:
                                        field.precision ||
                                        null,
                                    scale:
                                        field.scale ||
                                        null,
                                    nullable:
                                        field.nullable !== false,
                                    mandatory:
                                        field.mandatory === true,
                                    description:
                                        field.description ||
                                        null,
                                    semanticType:
                                        field.semanticType ||
                                        null,
                                    metadata_ID:
                                        targetMetadata.ID
                                })
                        );

                        totalFields++;
                    }
                }
            }

            return {

                runId:
                    effectiveRunId,

                targetSystem:
                    targetSystem.systemId,

                targetType:
                    targetSystem.systemType,

                targetInterface:
                    targetConnection.interfaceType,

                targetObject:
                    objects.length > 0
                        ? objects[0].objectName
                        : null,

                status:
                    "DISCOVERED",

                metadataVersion:
                    metadata.metadataVersion ||
                    "1.0",

                objectsDiscovered:
                    objects.length,

                fieldsDiscovered:
                    totalFields,

                discoveredAt,

                message:
                    `Target metadata discovery completed successfully. ${objects.length} object(s) and ${totalFields} field(s) discovered.`
            };

        } catch (error) {

            console.error(
                "Target metadata discovery failed:",
                error
            );

            const normalizedError =
                adapterError(error);

            return req.reject(
                500,
                `TARGET_DISCOVERY_ERROR: ${normalizedError}`
            );
        }
    });


    /**
     * ============================================================
     * INTELLIGENT MAPPING ANALYSIS
     * ============================================================
     */
    this.on("analyzeMapping", async (req) => {

        const {
            runId,
            batchId,
            sourceObject
        } = req.data;

        if (!runId) {
            return req.reject(
                400,
                "runId is required"
            );
        }

        if (!batchId) {
            return req.reject(
                400,
                "batchId is required"
            );
        }

        if (!sourceObject) {
            return req.reject(
                400,
                "sourceObject is required"
            );
        }

        const tx = cds.tx(req);

        try {

            let migrationRun =
                await tx.run(
                    SELECT.one
                        .from(MigrationRun)
                        .where({
                            runId
                        })
                );

            if (!migrationRun) {

                console.log(
                    `[analyzeMapping] Run '${runId}' not found. Auto-registering run...`
                );

                const srcObj =
                    await tx.run(
                        SELECT.one
                            .from(SourceObject)
                            .where({
                                objectName:
                                    sourceObject
                            })
                    );

                const srcSys =
                    srcObj &&
                    srcObj.sourceSystem_ID
                        ? await tx.run(
                            SELECT.one
                                .from(SourceSystem)
                                .where({
                                    ID:
                                        srcObj.sourceSystem_ID
                                })
                        )
                        : await tx.run(
                            SELECT.one
                                .from(SourceSystem)
                        );

                /*
                 * Do not hard-code a source system ID.
                 * The configured SourceSystem is the source of truth.
                 */
                if (!srcSys) {

                    return req.reject(
                        400,
                        "No source system is configured"
                    );
                }

                const sourceSystemVal =
                    srcSys.systemId;

                const sourceSystemGuid =
                    srcSys.ID;

                const trgSys =
                    await tx.run(
                        SELECT.one
                            .from(TargetSystem)
                            .where({
                                active: true
                            })
                    );

                if (!trgSys) {

                    return req.reject(
                        400,
                        "No active target system is configured"
                    );
                }

                const targetSystemVal =
                    trgSys.systemId;

                const targetSystemGuid =
                    trgSys.ID;

                await tx.run(
                    INSERT.into(MigrationRun)
                        .entries({

                            runId:
                                runId,

                            businessObject:
                                sourceObject,

                            status:
                                "IN_PROGRESS",

                            currentStage:
                                "MAPPING_ANALYSIS",

                            sourceSystem:
                                sourceSystemVal,

                            sourceSystem_ID:
                                sourceSystemGuid,

                            targetSystem:
                                targetSystemVal,

                            targetSystem_ID:
                                targetSystemGuid,

                            startedAt:
                                new Date()
                        })
                );

                migrationRun =
                    await tx.run(
                        SELECT.one
                            .from(MigrationRun)
                            .where({
                                runId
                            })
                    );
            }

            const cleanName =
                String(sourceObject)
                    .replace(/_0001$/, "");

            const sourceObjectRow =
                await tx.run(
                    SELECT.one
                        .from(SourceObject)
                        .where({
                            objectName:
                                sourceObject
                        })
                        .or({
                            objectName:
                                cleanName
                        })
                        .or({
                            objectName:
                                `${cleanName}_0001`
                        })
                );

            if (!sourceObjectRow) {

                return req.reject(
                    404,
                    `Source object '${sourceObject}' was not found`
                );
            }

            const resolvedSourceMetadata =
                await tx.run(
                    SELECT
                        .from(SourceMetadata)
                        .columns(
                            "ID",
                            "metadataId",
                            "schemaVersion",
                            "extractedAt",
                            "recordCount",
                            "metadataStatus",
                            "sourceObject_ID"
                        )
                        .where({
                            sourceObject_ID:
                                sourceObjectRow.ID
                        })
                );

            if (
                !resolvedSourceMetadata ||
                resolvedSourceMetadata.length === 0
            ) {

                return req.reject(
                    404,
                    `No source metadata found for source object '${sourceObject}'`
                );
            }

            const sourceMetadataIds =
                resolvedSourceMetadata.map(
                    (m) => m.ID
                );

            const sourceFields =
                await tx.run(
                    SELECT
                        .from(SourceField)
                        .where({
                            metadata_ID: {
                                in:
                                    sourceMetadataIds
                            }
                        })
                );

            if (
                !sourceFields ||
                sourceFields.length === 0
            ) {

                return req.reject(
                    404,
                    `No source field metadata found for source object '${sourceObject}'`
                );
            }

            const targetSystemId =
                migrationRun.targetSystem;

            if (!targetSystemId) {

                return req.reject(
                    400,
                    `Target system is not defined for migration run '${runId}'`
                );
            }

            const targetSystem =
                await tx.run(
                    SELECT.one
                        .from(TargetSystem)
                        .where({
                            systemId:
                                targetSystemId
                        })
                );

            if (!targetSystem) {

                return req.reject(
                    404,
                    `Target system '${targetSystemId}' was not found`
                );
            }

            const targetObjects =
                await tx.run(
                    SELECT
                        .from(TargetObject)
                        .where({
                            targetSystem_ID:
                                targetSystem.ID
                        })
                );

            if (
                !targetObjects ||
                targetObjects.length === 0
            ) {

                return req.reject(
                    404,
                    `No target objects found for target system '${targetSystemId}'`
                );
            }

            const targetObjectIds =
                targetObjects.map(
                    (obj) => obj.ID
                );

            const targetMetadata =
                await tx.run(
                    SELECT
                        .from(TargetMetadata)
                        .where({
                            targetObject_ID: {
                                in:
                                    targetObjectIds
                            }
                        })
                );

            if (
                !targetMetadata ||
                targetMetadata.length === 0
            ) {

                return req.reject(
                    404,
                    `No target metadata found for target system '${targetSystemId}'`
                );
            }

            const targetMetadataIds =
                targetMetadata.map(
                    (m) => m.ID
                );

            const targetFields =
                await tx.run(
                    SELECT
                        .from(TargetField)
                        .where({
                            metadata_ID: {
                                in:
                                    targetMetadataIds
                            }
                        })
                );

            if (
                !targetFields ||
                targetFields.length === 0
            ) {

                return req.reject(
                    404,
                    `No target fields found for target system '${targetSystemId}'`
                );
            }

            const canonicalDefinition =
                cds.model.definitions[
                    "migration.orchestrator.CanonicalCustomer"
                ];

            if (!canonicalDefinition) {

                return req.reject(
                    500,
                    "Canonical model definition was not found"
                );
            }

            const canonicalFields =
                Object.entries(
                    canonicalDefinition.elements || {}
                )
                    .filter(
                        ([fieldName]) =>
                            ![
                                "createdAt",
                                "createdBy",
                                "modifiedAt",
                                "modifiedBy"
                            ].includes(fieldName)
                    )
                    .map(
                        ([fieldName, element]) => ({
                            fieldName,
                            dataType:
                                element.type,
                            length:
                                element.length,
                            precision:
                                element.precision,
                            scale:
                                element.scale,
                            nullable:
                                !element.notNull,
                            description:
                                element["@description"] ||
                                element["@Common.Label"] ||
                                null,
                            semanticType:
                                element[
                                    "@Common.SemanticObject"
                                ] ||
                                null
                        })
                    );

            const mappingContext = {

                source: {

                    metadata:
                        resolvedSourceMetadata,

                    fields:
                        sourceFields,

                    object: {

                        id:
                            sourceObjectRow.ID,

                        objectName:
                            sourceObjectRow.objectName,

                        description:
                            sourceObjectRow.description ||
                            null
                    }
                },

                canonical: {

                    definition:
                        "migration.orchestrator.CanonicalCustomer",

                    fields:
                        canonicalFields
                },

                target: {

                    system: {

                        id:
                            targetSystem.ID,

                        systemId:
                            targetSystem.systemId,

                        name:
                            targetSystem.name ||
                            null,

                        description:
                            targetSystem.description ||
                            null
                    },

                    objects:
                        targetObjects,

                    metadata:
                        targetMetadata,

                    fields:
                        targetFields
                },

                run: {

                    runId,

                    batchId,

                    sourceObject,

                    targetSystem:
                        targetSystemId
                }
            };

            const mappingResult =
                await MappingEngine.analyze(
                    mappingContext
                );

            let targetObjectName = null;

            if (
                targetMetadata.length > 0
            ) {

                const firstTargetMetadata =
                    targetMetadata[0];

                const targetObjectId =
                    firstTargetMetadata.targetObject_ID;

                if (targetObjectId) {

                    const targetObject =
                        targetObjects.find(
                            (obj) =>
                                obj.ID ===
                                targetObjectId
                        );

                    if (targetObject) {

                        targetObjectName =
                            targetObject.objectName ||
                            targetObject.name ||
                            targetObject.ID;
                    }
                }
            }

            const mappings =
                Array.isArray(
                    mappingResult.mappings
                )
                    ? mappingResult.mappings
                    : [];

            const mappingCount =
                mappings.length;

            const highConfidenceCount =
                mappings.filter(
                    (m) =>
                        m.confidenceLevel ===
                        "HIGH"
                ).length;

            const approvalRequiredCount =
                mappings.filter(
                    (m) =>
                        m.approvalRequired === true
                ).length;

            return {

                runId,

                batchId,

                sourceObject,

                targetObject:
                    targetObjectName ||
                    "UNKNOWN",

                status:
                    mappingResult.status ||
                    "PENDING_APPROVAL",

                mappings:
                    JSON.stringify(
                        mappings,
                        null,
                        2
                    ),

                mappingCount,

                highConfidenceCount,

                approvalRequiredCount,

                analyzedAt:
                    new Date(),

                message:
                    `Mapping analysis completed. ${mappingCount} mapping candidate(s) generated, ${highConfidenceCount} high-confidence mapping(s), ${approvalRequiredCount} mapping(s) requiring approval.`
            };

        } catch (error) {

            console.error(
                "MAPPING ANALYSIS FAILED:",
                error
            );

            return req.reject(
                500,
                `MAPPING_ERROR: ${error.message || "Unknown mapping analysis error"}`
            );
        }
    });


    /**
     * ============================================================
     * DISCOVER ALL SOURCE METADATA
     * ============================================================
     */
    this.on("discoverAllSourceMetadata", async (req) => {

        const {
            connectionId
        } = req.data;

        const tx = cds.tx(req);

        try {

            const context =
                await resolveSourceContext(
                    tx,
                    connectionId
                );

            const connection =
                context.connection;

            const sourceSystem =
                context.sourceSystem;

            if (
                connection.status !==
                "CONNECTED"
            ) {

                return req.reject(
                    400,
                    `Source connection '${connection.connectionId}' is not connected`
                );
            }

            const adapter =
                createSourceAdapter({
                    ...connection,
                    systemId:
                        sourceSystem.systemId,
                    systemName:
                        sourceSystem.systemName,
                    systemType:
                        sourceSystem.systemType
                });

            const objects =
                await tx.run(
                    SELECT
                        .from(SourceObject)
                        .where({
                            sourceSystem_ID:
                                sourceSystem.ID
                        })
                );

            console.log(
                `[discoverAllSourceMetadata] Starting batch discovery for ${objects.length} objects`
            );

            let discoveredCount = 0;
            let totalFieldsDiscovered = 0;

            for (
                const obj
                of objects
            ) {

                try {

                    const schema =
                        await adapter.getSchema(
                            obj.objectName
                        );

                    const fields =
                        Array.isArray(
                            schema.fields
                        )
                            ? schema.fields
                            : [];

                    if (
                        fields.length === 0
                    ) {
                        continue;
                    }

                    const schemaVersion =
                        schema.schemaVersion ||
                        "1.0";

                    const sCleanObjName =
                        String(
                            obj.objectName
                        ).replace(
                            /_0001$/,
                            ""
                        );

                    let metadata =
                        await tx.run(
                            SELECT.one
                                .from(SourceMetadata)
                                .where({
                                    sourceObject_ID:
                                        obj.ID,
                                    schemaVersion
                                })
                        );

                    if (!metadata) {

                        const metadataId =
                            `${obj.objectId}_${schemaVersion}`;

                        await tx.run(
                            INSERT.into(
                                SourceMetadata
                            ).entries({
                                metadataId,
                                schemaVersion,
                                extractedAt:
                                    new Date(),
                                recordCount:
                                    0,
                                metadataStatus:
                                    "AVAILABLE",
                                sourceObject_ID:
                                    obj.ID
                            })
                        );

                        metadata =
                            await tx.run(
                                SELECT.one
                                    .from(
                                        SourceMetadata
                                    )
                                    .where({
                                        sourceObject_ID:
                                            obj.ID,
                                        schemaVersion
                                    })
                            );
                    }

                    for (
                        const f
                        of fields
                    ) {

                        const exists =
                            await tx.run(
                                SELECT.one
                                    .from(
                                        SourceField
                                    )
                                    .where({
                                        fieldName:
                                            f.fieldName,
                                        metadata_ID:
                                            metadata.ID
                                    })
                            );

                        if (!exists) {

                            await tx.run(
                                INSERT.into(
                                    SourceField
                                ).entries({
                                    fieldName:
                                        f.fieldName,
                                    objectName:
                                        sCleanObjName,
                                    dataType:
                                        f.dataType ||
                                        null,
                                    length:
                                        f.length ||
                                        null,
                                    precision:
                                        f.precision ||
                                        null,
                                    scale:
                                        f.scale ||
                                        null,
                                    nullable:
                                        f.nullable !== false,
                                    description:
                                        f.description ||
                                        null,
                                    metadata_ID:
                                        metadata.ID
                                })
                            );

                            totalFieldsDiscovered++;
                        }
                    }

                    discoveredCount++;

                } catch (objErr) {

                    console.warn(
                        `[discoverAllSourceMetadata] Skipped ${obj.objectName}:`,
                        objErr.message
                    );
                }
            }

            return `Batch discovery completed: ${discoveredCount}/${objects.length} objects processed, ${totalFieldsDiscovered} fields persisted.`;

        } catch (error) {

            console.error(
                "[discoverAllSourceMetadata] Failed:",
                error
            );

            return req.reject(
                500,
                error.message ||
                "Batch discovery failed"
            );
        }
    });


    /**
 * ============================================================
 * QUERY SOURCE METADATA
 * ============================================================
 *
 * Generic AI-facing metadata query.
 *
 * Supported resources:
 * - FIELDS
 * - FIELD
 * - COUNT
 * - FIELD_COUNT
 * - SCHEMA
 *
 * Reads metadata already persisted in:
 *
 * SourceObject
 *      |
 *      | sourceObject_ID
 *      v
 * SourceMetadata
 *      |
 *      | metadata_ID
 *      v
 * SourceField
 *
 * Joule / MCP does not need to know:
 * - runId
 * - batchId
 * - connectionId
 * ============================================================
 */
this.on("queryMetadata", async (req) => {

    const tx = cds.tx(req);

    try {

        let request = req.data.request;

        if (!request) {
            return req.reject(
                400,
                "request is required"
            );
        }

        /*
         * MCP / Joule may send request as JSON text.
         * Also support an already parsed object.
         */
        if (typeof request === "string") {

            try {
                request = JSON.parse(request);
            } catch (parseError) {

                return req.reject(
                    400,
                    "request must contain valid JSON"
                );
            }
        }

        if (
            !request ||
            typeof request !== "object"
        ) {

            return req.reject(
                400,
                "request must be a JSON object"
            );
        }

        const resource =
            String(
                request.resource ||
                "FIELDS"
            ).toUpperCase();

        const operation =
            String(
                request.operation ||
                "LIST"
            ).toUpperCase();

        const objectName =
            request.objectName
                ? String(request.objectName)
                : null;

        const entityName =
            request.entityName
                ? String(request.entityName)
                : null;

        const fieldFilter =
            request.filter || {};

        /*
         * ========================================================
         * VALIDATE OBJECT NAME
         * ========================================================
         */

        if (
            [
                "FIELDS",
                "FIELD",
                "COUNT",
                "FIELD_COUNT",
                "SCHEMA"
            ].includes(resource) &&
            !objectName
        ) {

            return req.reject(
                400,
                "objectName is required for metadata queries"
            );
        }

        /*
         * ========================================================
         * RESOLVE SOURCE OBJECT
         * ========================================================
         */

        const cleanObjectName =
            String(objectName || "")
                .replace(/_0001$/i, "");

        let sourceObject = null;

        /*
         * First try exact object name.
         */
        const exactObjects =
            await tx.run(
                SELECT
                    .from(SourceObject)
                    .where({
                        objectName: objectName
                    })
            );

        if (
            Array.isArray(exactObjects) &&
            exactObjects.length > 0
        ) {

            sourceObject =
                exactObjects[0];

        } else {

            /*
             * Try normalized object names.
             */
            const alternateObjects =
                await tx.run(
                    SELECT
                        .from(SourceObject)
                        .where({
                            objectName:
                                cleanObjectName
                        })
                );

            if (
                Array.isArray(alternateObjects) &&
                alternateObjects.length > 0
            ) {

                sourceObject =
                    alternateObjects[0];

            } else {

                /*
                 * Finally try businessObject.
                 */
                const businessObjects =
                    await tx.run(
                        SELECT
                            .from(SourceObject)
                            .where({
                                businessObject:
                                    objectName
                            })
                    );

                if (
                    Array.isArray(businessObjects) &&
                    businessObjects.length > 0
                ) {

                    sourceObject =
                        businessObjects[0];
                }
            }
        }

        if (!sourceObject) {

            return req.reject(
                404,
                `Source object '${objectName}' was not found in discovered metadata`
            );
        }

        /*
         * ========================================================
         * RESOLVE SOURCE METADATA
         * ========================================================
         *
         * IMPORTANT:
         *
         * SourceMetadata contains sourceObject_ID.
         * SourceField does NOT.
         *
         * Correct relationship:
         *
         * SourceObject.ID
         *       |
         *       | sourceObject_ID
         *       v
         * SourceMetadata.ID
         *       |
         *       | metadata_ID
         *       v
         * SourceField
         */

        const sourceMetadata =
            await tx.run(
                SELECT.one
                    .from(SourceMetadata)
                    .where({
                        sourceObject_ID:
                            sourceObject.ID
                    })
            );

        if (!sourceMetadata) {

            return req.reject(
                404,
                `Source metadata for '${objectName}' was not found. Run source metadata discovery first.`
            );
        }

        /*
         * ========================================================
         * LOAD SOURCE FIELDS
         * ========================================================
         */

        let fields =
            await tx.run(
                SELECT
                    .from(SourceField)
                    .where({
                        metadata_ID:
                            sourceMetadata.ID
                    })
            );

        if (!Array.isArray(fields)) {
            fields = [];
        }

        /*
         * ========================================================
         * FIELD NAME CONTAINS FILTER
         * ========================================================
         *
         * Example:
         *
         * {
         *   "filter": {
         *      "nameContains": "BUSINESS"
         *   }
         * }
         */

        const nameContains =
            fieldFilter.nameContains
                ? String(
                    fieldFilter.nameContains
                ).toLowerCase()
                : null;

        if (nameContains) {

            fields =
                fields.filter(
                    (field) =>
                        String(
                            field.fieldName || ""
                        )
                            .toLowerCase()
                            .includes(
                                nameContains
                            )
                );
        }

        /*
         * ========================================================
         * EXACT FIELD FILTER
         * ========================================================
         */

        const requestedFieldName =
            request.fieldName ||
            fieldFilter.fieldName;

        if (requestedFieldName) {

            const normalizedFieldName =
                String(
                    requestedFieldName
                ).toLowerCase();

            fields =
                fields.filter(
                    (field) =>
                        String(
                            field.fieldName || ""
                        ).toLowerCase() ===
                        normalizedFieldName
                );
        }

        /*
         * ========================================================
         * LIMIT
         * ========================================================
         *
         * Prevent returning thousands of fields to Joule.
         */

        const requestedLimit =
            Number(
                request.limit || 100
            );

        const limit =
            Number.isFinite(
                requestedLimit
            ) &&
            requestedLimit > 0
                ? Math.min(
                    requestedLimit,
                    500
                )
                : 100;

        /*
         * Keep the complete count before applying limit.
         */
        const totalCount =
            fields.length;

        /*
         * Apply limit only for list responses.
         */
        const responseFields =
            fields.slice(
                0,
                limit
            );

        /*
         * ========================================================
         * COUNT
         * ========================================================
         */

        if (
            resource === "COUNT" ||
            resource === "FIELD_COUNT" ||
            operation === "COUNT"
        ) {

            return {
                status: "SUCCESS",
                resource,
                objectName,
                entityName,
                count: totalCount,
                data: JSON.stringify({
                    objectName,
                    entityName,
                    fieldCount:
                        totalCount
                }),
                message:
                    `Metadata query completed successfully. ${totalCount} field(s) found for '${objectName}'.`
            };
        }

        /*
         * ========================================================
         * FIELD / FIELDS
         * ========================================================
         */

        if (
            resource === "FIELD" ||
            resource === "FIELDS"
        ) {

            return {
                status: "SUCCESS",
                resource,
                objectName,
                entityName,
                count:
                    responseFields.length,
                data:
                    JSON.stringify(
                        responseFields
                    ),
                message:
                    `${totalCount} field(s) found for '${objectName}'. Returning ${responseFields.length}.`
            };
        }

        /*
         * ========================================================
         * SCHEMA
         * ========================================================
         */

        if (resource === "SCHEMA") {

            return {
                status: "SUCCESS",
                resource,
                objectName,
                entityName,
                count: totalCount,

                data:
                    JSON.stringify({

                        object: {
                            objectName:
                                sourceObject.objectName,

                            objectId:
                                sourceObject.objectId,

                            businessObject:
                                sourceObject.businessObject,

                            objectType:
                                sourceObject.objectType,

                            schemaVersion:
                                sourceObject.schemaVersion,

                            description:
                                sourceObject.description
                        },

                        metadata: {
                            metadataId:
                                sourceMetadata.metadataId,

                            schemaVersion:
                                sourceMetadata.schemaVersion,

                            metadataStatus:
                                sourceMetadata.metadataStatus,

                            extractedAt:
                                sourceMetadata.extractedAt,

                            recordCount:
                                sourceMetadata.recordCount
                        },

                        fields:
                            responseFields
                    }),

                message:
                    `Schema retrieved successfully for '${objectName}'.`
            };
        }

        /*
         * ========================================================
         * UNSUPPORTED RESOURCE
         * ========================================================
         */

        return req.reject(
            400,
            `Unsupported metadata resource '${resource}'. Supported resources: FIELDS, FIELD, COUNT, FIELD_COUNT, SCHEMA`
        );

    } catch (error) {

        console.error(
            "[queryMetadata] FAILED:",
            error
        );

        return req.reject(
            500,
            `METADATA_QUERY_ERROR: ${error.message || "Metadata query failed"}`
        );
    }
});


        /**
     * ============================================================
     * AI CAPABILITY: QUERY SOURCE DATA
     * ============================================================
     *
     * Purpose:
     * Allow Joule/MCP to preview source records.
     *
     * Examples:
     *
     * - Show me 10 Business Partners
     * - Show me the first 20 records from A_BusinessPartner
     *
     * This is PREVIEW mode.
     *
     * It must NOT be used for full migration extraction.
     * Full extraction continues through ingestSourceData().
     */

    this.on("querySourceData", async (req) => {

        const request =
            req.data.request;

        if (!request) {

            return req.reject(
                400,
                "request is required"
            );
        }


        let input;

        try {

            input =
                typeof request === "string"
                    ? JSON.parse(request)
                    : request;

        } catch (error) {

            return req.reject(
                400,
                "request must contain valid JSON"
            );
        }


        const objectName =
            input.objectName
                ? String(input.objectName)
                : null;

        const entityName =
            input.entityName
                ? String(input.entityName)
                : null;

        const requestedLimit =
            Number(input.limit || 20);

        /*
         * Protect the source system.
         *
         * Joule should never be able to request
         * thousands/millions of records through
         * the synchronous preview API.
         */

        const limit =
            Math.min(
                Math.max(requestedLimit, 1),
                100
            );


        if (!objectName) {

            return req.reject(
                400,
                "objectName is required"
            );
        }


        const tx =
            cds.tx(req);


        try {

            /*
             * ----------------------------------------------------
             * Resolve source context automatically.
             * ----------------------------------------------------
             */

            const {
                connection,
                sourceSystem
            } =
                await resolveSourceContext(tx);


            if (
                connection.status !==
                "CONNECTED"
            ) {

                return req.reject(
                    400,
                    `Source connection '${connection.connectionId}' is not connected`
                );
            }


            /*
             * ----------------------------------------------------
             * Create source adapter.
             * ----------------------------------------------------
             */

            let adapter;

            try {

                adapter =
                    createSourceAdapter({

                        ...connection,

                        systemId:
                            sourceSystem.systemId,

                        systemName:
                            sourceSystem.systemName,

                        systemType:
                            sourceSystem.systemType

                    });

            } catch (error) {

                return req.reject(
                    400,
                    error.message
                );
            }


            /*
             * ----------------------------------------------------
             * Resolve the object from discovered metadata.
             * ----------------------------------------------------
             */

            const cleanName =
                objectName
                    .replace(
                        /_0001$/i,
                        ""
                    );


            const sourceObjects =
                await tx.run(
                    SELECT.from(SourceObject)
                        .where({
                            sourceSystem_ID:
                                sourceSystem.ID
                        })
                );


            const sourceObject =
                sourceObjects.find(
                    object => {

                        const names =
                            [
                                object.objectName,
                                object.objectId,
                                object.businessObject
                            ]
                                .filter(Boolean)
                                .map(
                                    value =>
                                        String(value)
                                            .toLowerCase()
                                );

                        return (
                            names.includes(
                                objectName.toLowerCase()
                            )
                            ||
                            names.includes(
                                cleanName.toLowerCase()
                            )
                            ||
                            names.includes(
                                `${cleanName}_0001`
                                    .toLowerCase()
                            )
                        );
                    }
                );


            if (!sourceObject) {

                return req.reject(
                    404,
                    `Source object '${objectName}' was not found. Run source metadata discovery first.`
                );
            }


            /*
             * ----------------------------------------------------
             * PREVIEW extraction.
             *
             * The adapter remains responsible for the actual
             * source-system protocol.
             * ----------------------------------------------------
             */

            const extracted =
                await adapter.extract(
                    objectName,
                    {
                        preview: true,
                        limit,
                        entityName
                    }
                );


            if (!extracted) {

                return req.reject(
                    500,
                    "Source adapter returned no data"
                );
            }


            const records =
                Array.isArray(
                    extracted.records
                )
                    ? extracted.records
                    : [];


            const previewRecords =
                records.slice(
                    0,
                    limit
                );


            const totalCount =
                Number.isInteger(
                    extracted.totalCount
                )
                    ? extracted.totalCount
                    : records.length;


            const hasMore =
                totalCount >
                previewRecords.length;


            return {

                status: "SUCCESS",

                mode: "PREVIEW",

                sourceObject:
                    objectName,

                entityName:
                    entityName ||
                    null,

                totalCount,

                returnedCount:
                    previewRecords.length,

                hasMore,

                data:
                    JSON.stringify(
                        previewRecords,
                        null,
                        2
                    ),

                jobId:
                    null,

                message:
                    `Returned ${previewRecords.length} source record(s) for preview.`

            };

        } catch (error) {

            console.error(
                "[querySourceData] FAILED:",
                error
            );

            return req.reject(
                500,
                `SOURCE_DATA_QUERY_ERROR: ${error.message || "Unknown source data query error"}`
            );
        }
    });

    /**
     * ============================================================
     * CLEANUP DISCOVERED METADATA
     * ============================================================
     */
    this.on("clearDiscoveredMetadata", async (req) => {

        const tx = cds.tx(req);

        try {

            // Delete child fields first to satisfy foreign key constraints
            await tx.run(
                DELETE.from(SourceField)
            );

            await tx.run(
                DELETE.from(SourceMetadata)
            );

            await tx.run(
                DELETE.from(SourceObject)
            );

            return {

                status:
                    "SUCCESS",

                message:
                    "Successfully deleted all records from SourceField, SourceMetadata, and SourceObject."
            };

        } catch (error) {

            console.error(
                "Cleanup failed:",
                error
            );

            return req.reject(
                500,
                `CLEANUP_ERROR: ${error.message}`
            );
        }
    });


    /**
     * ============================================================
     * RESET DISCOVERED CATALOG
     * ============================================================
     */
    this.on("resetDiscoveredCatalog", async (req) => {

        const {
            sourceSystemId
        } = req.data;

        const tx = cds.tx(req);

        try {

            let whereClause = {};

            if (sourceSystemId) {

                const sys =
                    await tx.run(
                        SELECT.one
                            .from(SourceSystem)
                            .where({
                                systemId:
                                    sourceSystemId
                            })
                    );

                if (sys) {

                    whereClause = {
                        sourceSystem_ID:
                            sys.ID
                    };
                }
            }

            const objects =
                await tx.run(
                    SELECT
                        .from(SourceObject)
                        .where(whereClause)
                );

            const objectIds =
                objects.map(
                    (o) => o.ID
                );

            if (
                objectIds.length > 0
            ) {

                const metas =
                    await tx.run(
                        SELECT
                            .from(SourceMetadata)
                            .where({
                                sourceObject_ID: {
                                    in:
                                        objectIds
                                }
                            })
                    );

                const metaIds =
                    metas.map(
                        (m) => m.ID
                    );

                if (
                    metaIds.length > 0
                ) {

                    await tx.run(
                        DELETE
                            .from(SourceField)
                            .where({
                                metadata_ID: {
                                    in:
                                        metaIds
                                }
                            })
                    );

                    await tx.run(
                        DELETE
                            .from(SourceMetadata)
                            .where({
                                ID: {
                                    in:
                                        metaIds
                                }
                            })
                    );
                }

                await tx.run(
                    DELETE
                        .from(SourceObject)
                        .where({
                            ID: {
                                in:
                                    objectIds
                            }
                        })
                );
            }

            return {

                status:
                    "SUCCESS",

                message:
                    `Catalog reset completed. Removed ${objectIds.length} object definitions.`
            };

        } catch (error) {

            console.error(
                "[resetDiscoveredCatalog] Error:",
                error
            );

            return req.reject(
                500,
                error.message ||
                "Failed to reset catalog"
            );
        }
    });


       
    const { Services } = this.entities;
    this.on("READ", Services, async (req) => {

        try {

            const response = await executeHttpRequest(
                {
                    destinationName: "S4HANA_CLOUD"
                    //destinationName: "S4_BP_DESTINATION"
                },
                {
                    method: "GET",
                    url: "/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection",
                    params: {
                        "$format": "json"
                    },
                    headers: {
                        "Accept": "application/json"
                    }
                }
            );
//const S4 = await cds.connect.to('S4_BP_DESTINATION');
            const results =
                response.data?.d?.results || [];

            return results.map((item) => ({
                TechnicalServiceName:
                    item.TechnicalServiceName || "",

                TechnicalServiceVersion:
                    item.TechnicalServiceVersion || "",

                Description:
                    item.Description || "",

                ServiceUrl:
                    item.ServiceUrl || ""
            }));

        } catch (error) {

            console.error(
                "S/4HANA Catalog Service Error:",
                error.response?.status,
                error.response?.data || error.message
            );

            return req.reject(
                502,
                "Unable to retrieve OData service catalog from S/4HANA Cloud"
            );
        }

    });
    this.on("getMetadata", async (req) => {

    try {

        const serviceUrl = req.data.serviceUrl;

        if (!serviceUrl) {
            return req.reject(
                400,
                "Service URL is required"
            );
        }

        /*
         * Extract path only.
         *
         * We deliberately do not use the hostname
         * supplied by the browser.
         */
        const parsedUrl = new URL(serviceUrl);

        const servicePath =
            parsedUrl.pathname.replace(/\/$/, "");

        const serviceDocumentPath =
            servicePath + "/";

        const metadataPath =
            servicePath + "/$metadata";


        console.log(
            "Service document:",
            serviceDocumentPath
        );

        console.log(
            "Metadata:",
            metadataPath
        );


        /*
         * Retrieve service document and $metadata
         * at the same time.
         */
        const [
            serviceResponse,
            metadataResponse
        ] = await Promise.all([

            executeHttpRequest(
                {
                    destinationName:
                        "S4HANA_CLOUD"
                },
                {
                    method: "GET",
                    url: serviceDocumentPath,

                    headers: {
                        Accept:
                            "application/xml"
                    },

                    responseType: "text"
                }
            ),

            executeHttpRequest(
                {
                    destinationName:
                        "S4HANA_CLOUD"
                },
                {
                    method: "GET",
                    url: metadataPath,

                    headers: {
                        Accept:
                            "application/xml"
                    },

                    responseType: "text"
                }
            )

        ]);


        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: ""
        });


        /*
         * Parse both documents.
         */
        const serviceDocument =
            parser.parse(
                serviceResponse.data
            );

        const metadata =
            parser.parse(
                metadataResponse.data
            );


        /*
         * -----------------------------------
         * 1. Parse service document
         * -----------------------------------
         */

        const descriptionMap = {};

        const workspace =
            serviceDocument?.["app:service"]
                ?.["app:workspace"];


        let collections =
            workspace?.["app:collection"]
            || [];


        if (!Array.isArray(collections)) {
            collections = [collections];
        }


        collections.forEach(
            (collection) => {

                const name =
                    collection.href || "";

                let title =
                    collection["sap:member-title"]
                    || collection["atom:title"]
                    || "";


                /*
                 * fast-xml-parser may represent
                 * atom:title as an object.
                 */
                if (
                    typeof title === "object"
                ) {
                    title =
                        title["#text"] || "";
                }


                descriptionMap[name] = {

                    description:
                        title,

                    creatable:
                        collection["sap:creatable"]
                            !== "false",

                    updatable:
                        collection["sap:updatable"]
                            !== "false",

                    deletable:
                        collection["sap:deletable"]
                            !== "false",

                    searchable:
                        collection["sap:searchable"]
                            === "true"

                };

            }
        );


        /*
         * -----------------------------------
         * 2. Parse $metadata
         * -----------------------------------
         */

        const dataServices =
            metadata?.["edmx:Edmx"]
                ?.["edmx:DataServices"];


        if (!dataServices) {

            return req.reject(
                502,
                "Invalid OData metadata response"
            );

        }


        let schemas =
            dataServices.Schema || [];

        if (!Array.isArray(schemas)) {
            schemas = [schemas];
        }


        const entitySets = [];

        const properties = [];

        const navigationProperties = [];


        schemas.forEach((schema) => {

            /*
             * -------------------------------
             * Entity Sets
             * -------------------------------
             */

            let containers =
                schema.EntityContainer
                || [];


            if (!Array.isArray(containers)) {
                containers = [containers];
            }


            containers.forEach(
                (container) => {

                    let sets =
                        container.EntitySet
                        || [];


                    if (!Array.isArray(sets)) {
                        sets = [sets];
                    }


                    sets.forEach(
                        (set) => {

                            const serviceInfo =
                                descriptionMap[
                                    set.Name
                                ] || {};


                            entitySets.push({

                                EntitySetName:
                                    set.Name || "",

                                Description:
                                    serviceInfo
                                        .description
                                    || "",

                                EntityType:
                                    set.EntityType
                                    || "",

                                Creatable:
                                    serviceInfo
                                        .creatable
                                    ?? true,

                                Updatable:
                                    serviceInfo
                                        .updatable
                                    ?? true,

                                Deletable:
                                    serviceInfo
                                        .deletable
                                    ?? true,

                                Searchable:
                                    serviceInfo
                                        .searchable
                                    ?? false

                            });

                        }
                    );

                }
            );


            /*
             * -------------------------------
             * Entity Types
             * -------------------------------
             */

            let entities =
                schema.EntityType || [];


            if (!Array.isArray(entities)) {
                entities = [entities];
            }


            entities.forEach(
                (entity) => {

                    const entityName =
                        entity.Name || "";


                    /*
                     * Keys
                     */

                    let keys = [];


                    if (
                        entity.Key
                        && entity.Key.PropertyRef
                    ) {

                        let refs =
                            entity.Key
                                .PropertyRef;


                        if (!Array.isArray(refs)) {
                            refs = [refs];
                        }


                        keys =
                            refs.map(
                                ref => ref.Name
                            );

                    }


                    /*
                     * Properties
                     */

                    let props =
                        entity.Property || [];


                    if (!Array.isArray(props)) {
                        props = [props];
                    }


                    props.forEach(
                        (prop) => {

                            properties.push({

                                EntityName:
                                    entityName,

                                PropertyName:
                                    prop.Name
                                    || "",

                                Type:
                                    prop.Type
                                    || "",

                                IsKey:
                                    keys.includes(
                                        prop.Name
                                    ),

                                Nullable:
                                    prop.Nullable
                                    !== "false",

                                MaxLength:
                                    prop.MaxLength
                                    || ""

                            });

                        }
                    );


                    /*
                     * Navigation Properties
                     */

                    let navs =
                        entity.NavigationProperty
                        || [];


                    if (!Array.isArray(navs)) {
                        navs = [navs];
                    }


                    navs.forEach(
                        (nav) => {

                            navigationProperties.push({

                                EntityName:
                                    entityName,

                                NavigationProperty:
                                    nav.Name
                                    || "",

                                Relationship:
                                    nav.Relationship
                                    || nav.Type
                                    || ""

                            });

                        }
                    );

                }
            );

        });


        console.log({
            entitySets:
                entitySets.length,

            properties:
                properties.length,

            navigationProperties:
                navigationProperties.length
        });


        return {

            ServiceName:
                servicePath
                    .split("/")
                    .pop(),

            ServiceUrl:
                serviceUrl,

            EntitySets:
                entitySets,

            Properties:
                properties,

            NavigationProperties:
                navigationProperties

        };


    } catch (error) {

        console.error(
            "Metadata retrieval failed:",
            error.response?.status,
            error.response?.data
            || error.message
        );


        return req.reject(
            502,
            "Unable to retrieve S/4HANA service metadata"
        );

    }

    });
    this.on("getEntityData", async (req) => {

        try {

            const {
                serviceUrl,
                entitySetName,
                top,
                skip
            } = req.data;


            if (!serviceUrl) {

                return req.reject(
                    400,
                    "Service URL is required"
                );
            }


            if (!entitySetName) {

                return req.reject(
                    400,
                    "Entity Set name is required"
                );
            }


            /*
            * Allow only safe Entity Set names.
            */
            if (
                !/^[A-Za-z0-9_]+$/.test(
                    entitySetName
                )
            ) {

                return req.reject(
                    400,
                    "Invalid Entity Set name"
                );
            }


            /*
            * Extract only the service path from the URL.
            *
            * Authentication and the S/4HANA host
            * continue to come from the S4HANA_CLOUD
            * destination.
            */
            const oUrl =
                new URL(serviceUrl);


            const sServicePath =
                oUrl.pathname.replace(
                    /\/$/,
                    ""
                );


            /*
            * Determine page size.
            *
            * Default: 20
            * Minimum: 1
            * Maximum: 100
            */
            const iTop =
                Math.min(
                    Math.max(
                        Number(top) || 200,
                        1
                    ),
                    1000
                );


            /*
            * Determine paging offset.
            *
            * Initial request:
            * skip = 0
            *
            * Second request:
            * skip = 20
            *
            * Third request:
            * skip = 40
            */
            const iSkip =
                Math.max(
                    Number(skip) || 0,
                    0
                );


            const sEntityPath =
                sServicePath
                + "/"
                + entitySetName;


            console.log(
                "Reading Entity Set:",
                sEntityPath,
                "top:",
                iTop,
                "skip:",
                iSkip
            );


            /*
            * Call SAP S/4HANA through the
            * S4HANA_CLOUD destination.
            */
            const oResponse =
                await executeHttpRequest(
                    {
                        destinationName:
                            "S4HANA_CLOUD"
                    },
                    {
                        method: "GET",

                        url: sEntityPath,

                        params: {
                            "$top": iTop,
                            "$skip": iSkip,
                            "$format": "json"
                        },

                        headers: {
                            "Accept":
                                "application/json"
                        }
                    }
                );


            /*
            * OData V2 response:
            *
            * {
            *     d: {
            *         results: [...]
            *     }
            * }
            */
            const aRows =
                oResponse.data?.d?.results
                || [];


            /*
            * Clean the OData response.
            *
            * Remove:
            * - __metadata
            * - navigation properties / nested objects
            *
            * Keep:
            * - scalar values
            * - null values
            */
            const aCleanRows =
                aRows.map(
                    function (oRow) {

                        const oClean = {};


                        Object.keys(
                            oRow
                        ).forEach(
                            function (sKey) {

                                /*
                                * Ignore OData internal metadata.
                                */
                                if (
                                    sKey === "__metadata"
                                ) {

                                    return;
                                }


                                /*
                                * Ignore nested navigation
                                * properties for the first
                                * implementation.
                                *
                                * Null values are allowed.
                                */
                                if (
                                    oRow[sKey] !== null
                                    && typeof oRow[sKey] === "object"
                                ) {

                                    return;
                                }


                                oClean[sKey] =
                                    oRow[sKey];

                            }
                        );


                        return oClean;

                    }
                );


            /*
            * Dynamically determine table columns
            * from the first returned record.
            */
            const aColumns =
                aCleanRows.length > 0
                    ? Object.keys(
                        aCleanRows[0]
                    )
                    : [];


            /*
            * If S/4HANA returns fewer records than
            * requested, we know that we reached
            * the last page.
            *
            * Example:
            *
            * top = 20
            * returned = 8
            *
            * HasMore = false
            */
            const bHasMore =
                aCleanRows.length === iTop;


            console.log(
                "Entity data batch:",
                {
                    entitySet:
                        entitySetName,

                    skip:
                        iSkip,

                    requested:
                        iTop,

                    returned:
                        aCleanRows.length,

                    hasMore:
                        bHasMore
                }
            );


            /*
            * Return data to SAPUI5.
            */
            return {

                EntitySetName:
                    entitySetName,

                ColumnsJson:
                    JSON.stringify(
                        aColumns
                    ),

                RowsJson:
                    JSON.stringify(
                        aCleanRows
                    ),

                Count:
                    aCleanRows.length,

                HasMore:
                    bHasMore
            };


        } catch (oError) {

            console.error(
                "Entity data retrieval failed:",
                oError.response?.status,
                oError.response?.data
                    || oError.message
            );


            return req.reject(
                502,
                "Unable to retrieve Entity Set data from S/4HANA"
            );

        }

    });

});