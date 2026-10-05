"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

// The UI5 dev-server plugin keeps the process alive after the tests finish
process.env.CDS_PLUGIN_UI5_ACTIVE = "false";

// S/4 adapter reads the local catalog + $metadata fixtures
process.env.S4_DISCOVERY_MODE = "MOCK";

// Never call a real AI service from tests: an unknown provider fails deterministically
process.env.AI_PROVIDER = "DISABLED_IN_TESTS";

// Preview runs are archived to a temporary local folder (no Object Store binding in tests)
const os = require("os");
const STORAGE_DIR = require("fs").mkdtempSync(path.join(os.tmpdir(), "mo-preview-archive-"));
process.env.STORAGE_DIR = STORAGE_DIR;

const cds = require("@sap/cds");

const { GET, POST } = cds.test(
    "serve",
    "srv/framework-service.cds",
    "--in-memory"
).in(path.join(__dirname, ".."));

describe("FrameworkService - canonical Business Partner v1", () => {

    let canonicalModel;

    before(async () => {
        const { data } = await GET(
            "/framework/BusinessObjectModels?$filter=layer eq 'CANONICAL' and type_code eq 'BUSINESS_PARTNER'"
        );

        canonicalModel = data.value[0];
    });

    it("seeds the Business Partner catalog entry with a signature", async () => {
        const { data } = await GET("/framework/BusinessObjectTypes('BUSINESS_PARTNER')");

        assert.equal(data.name, "Business Partner");
        assert.ok(JSON.parse(data.signature).includes("party.name"));
    });

    it("seeds the semantic tag vocabulary", async () => {
        const { data } = await GET("/framework/SemanticTags?$count=true&$top=0");

        assert.ok(data["@odata.count"] >= 40);
    });

    it("seeds exactly one canonical Business Partner model", () => {
        assert.ok(canonicalModel, "canonical BP model is missing");
        assert.equal(canonicalModel.version, "1");
        assert.equal(canonicalModel.systemId, null);
    });

    it("returns the canonical model as a nested tree", async () => {
        const { data } = await GET(
            `/framework/getModelTree(modelId=${canonicalModel.ID})`
        );

        const tree = JSON.parse(data.tree);

        assert.equal(data.structureCount, 8);
        assert.equal(tree.name, "BusinessPartner");
        assert.deepEqual(
            tree.children.map(child => child.name),
            ["Address", "Role", "TaxNumber", "BankAccount", "CompanyData", "SalesAreaData"]
        );

        const address = tree.children.find(child => child.name === "Address");

        assert.equal(address.cardinality, "0..N");
        assert.deepEqual(address.children.map(child => child.name), ["Communication"]);
    });

    it("tags every canonical field with a known semantic tag", async () => {
        const { data: fields } = await GET("/framework/Fields?$select=name,semanticTag_code&$top=1000");
        const { data: tags } = await GET("/framework/SemanticTags?$select=code&$top=1000");

        const knownTags = new Set(tags.value.map(tag => tag.code));

        for (const field of fields.value) {
            assert.ok(
                knownTags.has(field.semanticTag_code),
                `field '${field.name}' has unknown tag '${field.semanticTag_code}'`
            );
        }
    });

    it("rejects an unknown model ID", async () => {
        await assert.rejects(
            GET("/framework/getModelTree(modelId=00000000-0000-0000-0000-000000000000)"),
            /404/
        );
    });
});

describe("FrameworkService - buildSourceModel (S/4 in MOCK mode)", () => {

    const request = {
        sourceSystemId: "S4_TEST",
        sourceObject: "API_BUSINESS_PARTNER",
        businessObjectType: "BUSINESS_PARTNER"
    };

    before(async () => {
        const systemId = cds.utils.uuid();

        await INSERT.into("migration.orchestrator.SourceSystem").entries({
            ID: systemId,
            systemId: "S4_TEST",
            systemName: "S/4 Test",
            systemType: "S4HANA",
            active: true
        });

        await INSERT.into("migration.orchestrator.SourceConnection").entries({
            connectionId: "S4_TEST_CONN",
            connectionName: "S/4 Test connection",
            interfaceType: "ODATA",
            adapterType: "S4",
            authenticationType: "DESTINATION",
            status: "CONNECTED",
            sourceSystem_ID: systemId
        });
    });

    it("builds the S/4 Business Partner model as a tree", async () => {
        const { data: result } = await POST("/framework/buildSourceModel", request);

        assert.equal(result.rootStructure, "A_BusinessPartner");
        assert.equal(result.structureCount, 10);
        assert.equal(result.relationshipCount, 9);
        assert.equal(result.missingJoinCount, 0);

        const { data } = await GET(`/framework/getModelTree(modelId=${result.modelId})`);
        const tree = JSON.parse(data.tree);

        assert.equal(data.layer, "SOURCE");
        assert.equal(data.systemId, "S4_TEST");
        assert.equal(tree.name, "A_BusinessPartner");

        const customer = tree.children.find(child => child.name === "A_Customer");

        assert.equal(customer.cardinality, "0..1");
        assert.deepEqual(
            customer.children.map(child => child.name).sort(),
            ["A_CustomerCompany", "A_CustomerSalesArea"]
        );
        assert.equal(customer.joinKeys.source, "INFERRED_BY_NAME");
        assert.ok(tree.fields.find(field => field.name === "BusinessPartner").isKey);
    });

    it("replaces the DRAFT model when rebuilt instead of duplicating it", async () => {
        const { data: result } = await POST("/framework/buildSourceModel", request);

        assert.equal(result.version, "1");

        const { data } = await GET(
            "/framework/BusinessObjectModels?$filter=layer eq 'SOURCE' and systemId eq 'S4_TEST'"
        );

        assert.equal(data.value.length, 1);
    });

    it("rejects an unknown source system", async () => {
        await assert.rejects(
            POST("/framework/buildSourceModel", { ...request, sourceSystemId: "NOPE" }),
            /404/
        );
    });
});

describe("FrameworkService - buildSourceModel (M3 in MOCK mode)", () => {

    before(async () => {
        const systemId = cds.utils.uuid();

        await INSERT.into("migration.orchestrator.SourceSystem").entries({
            ID: systemId,
            systemId: "M3_TEST",
            systemName: "M3 Test",
            systemType: "M3",
            active: true
        });

        await INSERT.into("migration.orchestrator.SourceConnection").entries({
            connectionId: "M3_TEST_CONN",
            connectionName: "M3 Test connection",
            interfaceType: "M3_MI",
            adapterType: "M3",
            authenticationType: "OAUTH",
            status: "CONNECTED",
            sourceSystem_ID: systemId
        });
    });

    it("builds the M3 customer as a tree from flat MI transactions", async () => {
        const { data: result } = await POST("/framework/buildSourceModel", {
            sourceSystemId: "M3_TEST",
            sourceObject: "CRS610MI",
            relatedObjects: ["OIS002MI"],
            businessObjectType: "BUSINESS_PARTNER"
        });

        assert.equal(result.rootStructure, "CRS610MI.LstByNumber");
        assert.equal(result.structureCount, 3);
        assert.equal(result.proposedJoinCount, 2);
        assert.equal(result.reviewRequired, true);

        const { data } = await GET(`/framework/getModelTree(modelId=${result.modelId})`);
        const tree = JSON.parse(data.tree);

        const byName = Object.fromEntries(tree.children.map(child => [child.name, child]));

        assert.equal(byName["CRS610MI.GetFinancial"].cardinality, "0..1");
        assert.equal(byName["OIS002MI.LstAddress"].cardinality, "0..N");
        assert.equal(byName["OIS002MI.LstAddress"].relationshipKind, "KEY_JOIN");
        assert.equal(byName["OIS002MI.LstAddress"].joinKeys.source, "PROPOSED_BY_KEY_OVERLAP");
    });

    it("keeps canonical, S/4 and M3 Business Partner models side by side (before tagging)", async () => {
        const { data } = await GET(
            "/framework/BusinessObjectModels?$filter=type_code eq 'BUSINESS_PARTNER'&$select=layer,systemId&$orderby=layer"
        );

        assert.deepEqual(
            data.value.map(model => `${model.layer}:${model.systemId || "-"}`).sort(),
            ["CANONICAL:-", "SOURCE:M3_TEST", "SOURCE:S4_TEST"]
        );
    });
});

describe("FrameworkService - semantic tagging and alignment", () => {

    const modelIdOf = async (filter) => {
        const { data } = await GET(`/framework/BusinessObjectModels?$filter=${filter}&$select=ID`);
        return data.value[0].ID;
    };

    it("tags the S/4 and M3 models with the rule engine", async () => {
        for (const systemId of ["S4_TEST", "M3_TEST"]) {
            const modelId = await modelIdOf(`systemId eq '${systemId}'`);
            const { data } = await POST("/framework/tagModelFields", { modelId, engine: "RULES" });

            assert.equal(data.engine, "RULES");
            assert.equal(data.aiUsed, false);
            assert.ok(data.tagged > data.untagged, `${systemId}: ${data.message}`);
            assert.ok(data.highConfidence > 0);
        }
    });

    it("stores origin, confidence and reason on each tagged field", async () => {
        const { data } = await GET(
            "/framework/Fields?$filter=name eq 'TOWN'&$select=semanticTag_code,tagConfidence,tagOrigin,tagReason,tagStatus"
        );

        assert.ok(data.value.length >= 1);

        for (const field of data.value) {
            assert.equal(field.semanticTag_code, "address.city");
            assert.equal(field.tagOrigin, "HEURISTIC");
            assert.equal(field.tagStatus, "SUGGESTED");
            assert.ok(Number(field.tagConfidence) >= 85);
            assert.match(field.tagReason, /City/);
        }
    });

    it("never overwrites approved canonical tags", async () => {
        const modelId = await modelIdOf("layer eq 'CANONICAL'");
        const { data } = await POST("/framework/tagModelFields", { modelId });

        assert.equal(data.skippedApproved, 50);
        assert.equal(data.tagged, 0);
    });

    it("AI engine fails clearly when no AI provider is available", async () => {
        const modelId = await modelIdOf("systemId eq 'M3_TEST'");

        await assert.rejects(
            POST("/framework/tagModelFields", { modelId, engine: "AI" }),
            /502/
        );
    });

    it("AI_WITH_RULES falls back to the rule engine and says so", async () => {
        const modelId = await modelIdOf("systemId eq 'M3_TEST'");
        const { data } = await POST("/framework/tagModelFields", { modelId, engine: "AI_WITH_RULES" });

        assert.equal(data.aiUsed, false);
        assert.match(data.message, /AI unavailable/);
        assert.ok(data.tagged > 0);
    });

    it("aligns canonical, S/4 and M3 fields by meaning", async () => {
        const { data } = await GET("/framework/getSemanticAlignment(businessObjectType='BUSINESS_PARTNER')");
        const alignment = JSON.parse(data.alignment);
        const city = alignment.find(entry => entry.tag === "address.city");

        assert.deepEqual(
            Object.keys(city.byModel).sort(),
            ["CANONICAL", "SOURCE:M3_TEST", "SOURCE:S4_TEST"]
        );
        assert.ok(city.byModel["SOURCE:S4_TEST"].some(f => f.field === "CityName"));
        assert.ok(city.byModel["SOURCE:M3_TEST"].some(f => f.field === "TOWN"));
        assert.ok(city.byModel.CANONICAL.some(f => f.field === "city"));
    });
});

describe("FrameworkService - end-to-end slice: M3 -> canonical BP -> Cockpit Customer", () => {

    let m3ModelId;
    let canonicalModelId;
    let targetModelId;
    let set1;
    let set2;

    const idOf = async (filter) => {
        const { data } = await GET(`/framework/BusinessObjectModels?$filter=${filter}&$select=ID`);
        return data.value[0].ID;
    };

    const structureMapping = async (setId, toStructure, pattern) => {
        const { data } = await GET(
            `/framework/StructureMappings?$filter=mappingSet_ID eq ${setId} and pattern eq '${pattern}'&$expand=toStructure($select=name)`
        );
        return data.value.find(mapping => mapping.toStructure.name === toStructure);
    };

    // What the functional team's UI will call
    const setField = (structureMappingId, toField, rule, fromFields = []) =>
        POST("/framework/upsertFieldMapping", {
            structureMappingId,
            toField,
            rule: JSON.stringify(rule),
            fromFields: JSON.stringify(fromFields)
        });

    const setValues = (domain, pairs, fromSystem = "M3_TEST", toSystem = "CANONICAL") =>
        POST("/framework/upsertValueMappings", {
            domain,
            fromSystem,
            toSystem,
            entries: JSON.stringify(Object.entries(pairs).map(([fromValue, toValue]) => ({ fromValue, toValue })))
        });

    before(async () => {
        m3ModelId = await idOf("systemId eq 'M3_TEST'");
        canonicalModelId = await idOf("layer eq 'CANONICAL'");
    });

    it("imports the Cockpit 'Customer' template as target model (generic import) and tags it", async () => {
        const definition = fs.readFileSync(
            path.join(__dirname, "..", "srv", "mock", "cockpit", "customer-template.json"),
            "utf8"
        );

        const { data } = await POST("/framework/importModel", { definition });

        assert.equal(data.structureCount, 5);
        targetModelId = data.modelId;

        const { data: tagging } = await POST("/framework/tagModelFields", { modelId: targetModelId });

        assert.ok(tagging.tagged >= 30, tagging.message);
    });

    it("suggests M3 -> canonical mappings and lists the open points", async () => {
        const { data } = await POST("/framework/suggestMappings", {
            fromModelId: m3ModelId,
            toModelId: canonicalModelId
        });

        set1 = data.mappingSetId;
        assert.equal(data.hop, "SOURCE_TO_CANONICAL");

        const coverage = JSON.parse(data.coverage);

        assert.ok(coverage.unmappedStructures.some(s => s.structure === "Role"));
        assert.ok(coverage.unmappedFields.some(f => f.structure === "BusinessPartner" && f.field === "category" && f.mandatory));
        assert.ok(coverage.unsupportedStructures.some(s => s.structure === "Communication"));

        const root = await structureMapping(set1, "BusinessPartner", "ONE_TO_ONE");

        assert.deepEqual(JSON.parse(root.patternConfig).groupBy, ["CUNO"]);

        const company = await structureMapping(set1, "CompanyData", "EXPLODE");

        assert.equal(JSON.parse(company.patternConfig).rows, "all");
    });

    it("refuses to run mapping sets that are not approved", async () => {
        await assert.rejects(
            POST("/framework/previewMigration", {
                sourceModelId: m3ModelId,
                sourceToCanonicalSetId: set1,
                canonicalToTargetSetId: set1
            }),
            /409/
        );
    });

    it("functional team completes and approves M3 -> canonical", async () => {
        const root = await structureMapping(set1, "BusinessPartner", "ONE_TO_ONE");
        const headerAddress = await structureMapping(set1, "Address", "EXPLODE");
        const tax = await structureMapping(set1, "TaxNumber", "EXPLODE");

        await setField(root.ID, "category", { type: "CONSTANT", value: "ORGANIZATION" });
        await setField(headerAddress.ID, "addressKey", { type: "CONSTANT", value: "MAIN" });
        await setField(headerAddress.ID, "usage", { type: "CONSTANT", value: "STANDARD" });
        await setField(headerAddress.ID, "isStandard", { type: "CONSTANT", value: true });
        await setField(
            tax.ID,
            "taxCategory",
            { type: "VALUE_MAP", domain: "TAX_CATEGORY_BY_COUNTRY" },
            [{ structure: "CRS610MI.LstByNumber", field: "CSCD" }]
        );

        const { data: role } = await POST("/framework/upsertStructureMapping", {
            mappingSetId: set1,
            toStructure: "Role",
            fromStructures: ["CRS610MI.LstByNumber"],
            pattern: "DERIVE",
            patternConfig: "{}"
        });

        await setField(role.ID, "roleCode", { type: "CONSTANT", value: "CUSTOMER" });

        await setValues("party.status", { 20: "ACTIVE", 90: "INACTIVE" });
        await setValues("address.region", { QL: "QLD", NS: "NSW", WA: "WA" });
        await setValues("address.usage", { 1: "SHIP_TO", 3: "BILL_TO" });
        await setValues("org.companyCode", { 100: "AU01", 200: "AU02" });
        await setValues("finance.paymentTerms", { 30: "0001", 45: "0002" }); // 60 deliberately missing
        await setValues("finance.dunningProcedure", { 1: "Z001", 2: "Z002" });
        await setValues("TAX_CATEGORY_BY_COUNTRY", { AU: "ABN", NZ: "GST" });

        // Open suggestions must be reviewed or explicitly approved
        await assert.rejects(POST("/framework/approveMappingSet", { mappingSetId: set1 }), /409/);

        const { data } = await POST("/framework/approveMappingSet", { mappingSetId: set1, approvePending: true });

        assert.equal(data.status, "APPROVED");
    });

    it("keeps approved mapping sets immutable", async () => {
        const root = await structureMapping(set1, "BusinessPartner", "ONE_TO_ONE");

        await assert.rejects(
            setField(root.ID, "category", { type: "CONSTANT", value: "PERSON" }),
            /409/
        );
    });

    it("suggests, completes and approves canonical -> Cockpit", async () => {
        const { data } = await POST("/framework/suggestMappings", {
            fromModelId: canonicalModelId,
            toModelId: targetModelId
        });

        set2 = data.mappingSetId;
        assert.equal(data.hop, "CANONICAL_TO_TARGET");

        const general = await structureMapping(set2, "GENERAL", "ONE_TO_ONE");
        const company = await structureMapping(set2, "COMPANY", "ONE_TO_ONE");

        await setField(general.ID, "BU_GROUP", { type: "CONSTANT", value: "CUST" });
        await setField(company.ID, "AKONT", { type: "CONSTANT", value: "12100000" });

        const { data: approval } = await POST("/framework/approveMappingSet", { mappingSetId: set2, approvePending: true });

        assert.equal(approval.status, "APPROVED");
    });

    it("previews the migration end to end with issues", async () => {
        const { data } = await POST("/framework/previewMigration", {
            sourceModelId: m3ModelId,
            sourceToCanonicalSetId: set1,
            canonicalToTargetSetId: set2
        });

        assert.equal(data.instanceCount, 4);

        const target = JSON.parse(data.target);
        const canonical = JSON.parse(data.canonical);
        const issues = JSON.parse(data.issues);
        const rowsOf = (structure, customer) => target[structure].filter(row => row.KUNNR === customer);

        // C1001: two M3 company rows + two extra addresses -> one Business Partner
        const general = rowsOf("GENERAL", "C1001")[0];

        assert.equal(general.NAME1, "Northern Quarry Operations Pty Ltd");
        assert.equal(general.CITY1, "Mackay");
        assert.equal(general.REGION, "QLD");
        assert.equal(general.BU_GROUP, "CUST");
        assert.equal(rowsOf("ADDRESS", "C1001").length, 2);
        assert.deepEqual(rowsOf("COMPANY", "C1001").map(row => `${row.BUKRS}/${row.ZTERM}`).sort(), ["AU01/0001", "AU02/0002"]);
        assert.equal(rowsOf("TAX_NUMBERS", "C1001")[0].TAXTYPE, "ABN");

        // C1002 has no VAT number -> no tax row
        assert.equal(rowsOf("TAX_NUMBERS", "C1002").length, 0);

        // C1004 is blocked in M3
        const c1004 = canonical.find(bp => bp.legacyKey === "C1004");

        assert.equal(c1004.status, "INACTIVE");
        assert.equal(c1004.isBlocked, true);
        assert.deepEqual(c1004.Role.map(role => role.roleCode), ["CUSTOMER"]);

        // The only issue: payment terms 60 has no approved value mapping
        assert.equal(data.issueCount, 1);
        assert.equal(issues[0].instance, "C1003");
        assert.equal(issues[0].code, "VALUE_MAPPING_MISSING");
        assert.equal(issues[0].field, "paymentTerms");
    });

    it("keeps preview runs for the UI and runs them from the model page button", async () => {
        const { data } = await POST(`/framework/BusinessObjectModels(${m3ModelId})/FrameworkService.runPreview`, { limit: 10 });

        assert.ok(data.runId);

        // The run is also archived as files (local folder here, Object Store when bound)
        assert.equal(data.archiveStatus, "ARCHIVED");

        const runDir = path.join(STORAGE_DIR, "preview-runs", data.runId);

        assert.deepEqual(fs.readdirSync(runDir).sort(), ["canonical.json", "issues.json", "raw", "summary.json", "target"]);

        // raw source pages as extracted (gzip NDJSON), one folder per source structure
        assert.deepEqual(
            fs.readdirSync(path.join(runDir, "raw")).sort(),
            ["CRS610MI.GetFinancial", "CRS610MI.LstByNumber", "OIS002MI.LstAddress"]
        );

        const rawHeader = require("zlib")
            .gunzipSync(fs.readFileSync(path.join(runDir, "raw", "CRS610MI.LstByNumber", "page-00001.ndjson.gz")))
            .toString("utf8")
            .split("\n")
            .map(line => JSON.parse(line));

        assert.equal(rawHeader.length, 5);
        assert.equal(rawHeader[0].CUNO, "C1001");

        // target rows: one file per Cockpit structure
        assert.deepEqual(
            fs.readdirSync(path.join(runDir, "target")).sort(),
            ["ADDRESS.json", "COMPANY.json", "GENERAL.json", "SALES.json", "TAX_NUMBERS.json"]
        );

        const summary = JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8"));

        assert.equal(summary.instanceCount, 4);
        assert.equal(summary.rawFiles.length, 3);
        assert.deepEqual(summary.rawArchiveErrors, []);

        const { data: run } = await GET(
            `/framework/PreviewRuns(${data.runId})?$expand=issues,rows($filter=structure eq 'GENERAL'),documents`
        );

        assert.equal(run.instanceCount, 4);
        assert.equal(run.issues.length, 1);
        assert.equal(run.rows.length, 4);
        assert.equal(run.documents.length, 4);

        const c1001 = run.rows.find(row => row.instanceKey === "C1001");

        assert.match(c1001.summary, /CITY1=Mackay/);

        const { data: model } = await GET(`/framework/BusinessObjectModels(${m3ModelId})?$expand=previewRuns,mappingSets`);

        assert.ok(model.previewRuns.length >= 2);
        assert.ok(model.mappingSets.some(set => set.ID === set1));
    });

    it("shows storage usage, folders, files and file content (storage browser)", async () => {
        const { data: info } = await GET("/framework/getStorageInfo()");

        assert.equal(info.kind, "LOCAL");
        assert.ok(info.fileCount >= 11);

        const { data: folders } = await GET("/framework/StorageFolders?$count=true");
        const all = folders.value.find(folder => folder.folder === "");
        const run = folders.value.find(folder => folder.folder.startsWith("preview-runs/"));

        assert.equal(all.description, "All files");
        assert.equal(all.fileCount, info.fileCount);
        assert.ok(run.fileCount >= 11);

        const { data: files } = await GET(`/framework/StorageFolders('${run.ID}')/files?$count=true`);

        assert.equal(files["@odata.count"], run.fileCount);
        assert.ok(files.value.every(file => file.folderGroup === run.folder));

        // compressed raw pages are shown unpacked
        const raw = files.value.find(file => file.path.includes("raw/CRS610MI.LstByNumber/"));
        const { data: opened } = await GET(`/framework/StorageFolders('${run.ID}')/files('${raw.ID}')`);

        assert.equal(opened.fileType, "NDJSON (gzip)");
        assert.equal(JSON.parse(opened.content.split("\n")[0]).CUNO, "C1001");

        // filtering and paging work on the in-memory list
        const { data: jsonOnly } = await GET(`/framework/StorageFolders('${run.ID}')/files?$filter=fileType eq 'JSON'&$top=2&$count=true`);

        assert.equal(jsonOnly.value.length, 2);
        assert.ok(jsonOnly["@odata.count"] >= 8);
        assert.ok(jsonOnly.value.every(file => file.fileType === "JSON"));
    });

    it("UI approve / reject buttons follow the same governance rules", async () => {
        const root = await structureMapping(set1, "BusinessPartner", "ONE_TO_ONE");

        await assert.rejects(
            POST(`/framework/StructureMappings(${root.ID})/FrameworkService.rejectMapping`, {}),
            /409/
        );
    });

    it("refuses S/4 sources, which are not part of this slice yet", async () => {
        const s4ModelId = await idOf("systemId eq 'S4_TEST'");

        const { data } = await POST("/framework/suggestMappings", {
            fromModelId: s4ModelId,
            toModelId: canonicalModelId
        });

        await POST("/framework/approveMappingSet", { mappingSetId: data.mappingSetId, approvePending: true });

        await assert.rejects(
            POST("/framework/previewMigration", {
                sourceModelId: s4ModelId,
                sourceToCanonicalSetId: data.mappingSetId,
                canonicalToTargetSetId: set2
            }),
            /422/
        );
    });
});
