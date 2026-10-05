"use strict";

/**
 * ============================================================
 * DEMO SETUP - MIGRATION WORKBENCH
 * ============================================================
 *
 * Fills a RUNNING local app (mock data only) with the end-to-end
 * slice, using the same API the functional team's UI calls:
 *
 *   M3 + S/4 mock source systems -> source models -> meaning tags
 *   -> Cockpit 'Customer' target model -> mapping suggestions
 *   -> functional team decisions -> approval -> preview run
 *
 * The S/4 -> canonical mapping set is left OPEN, so approve / reject
 * can be tried in the UI.
 *
 * Usage, in the project folder:
 *   npm run demo:start             terminal 1 - demo profile (demo.sqlite, mock adapters, port 4010)
 *   npm run demo:setup             terminal 2 - once; data stays in demo.sqlite across restarts
 *
 * To start over: stop the server, then  npm run demo:start -- --reset  and run the setup again.
 *
 * Optional: DEMO_BASE_URL (default http://localhost:4010)
 */

const fs = require("fs");
const path = require("path");

const BASE_URL = (process.env.DEMO_BASE_URL || "http://localhost:4010").replace(/\/$/, "");

async function call(method, url, body) {
    const response = await fetch(`${BASE_URL}${url}`, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;

    if (!response.ok) {
        throw new Error(`${method} ${url} -> ${response.status}: ${data?.error?.message || text}`);
    }

    return data;
}

const get = (url) => call("GET", url);
const post = (url, body) => call("POST", url, body);

const step = (text) => console.log(`\n▶ ${text}`);
const done = (text) => console.log(`  ✓ ${text}`);

async function ensureSourceSystem(systemId, systemName, systemType, adapterType, interfaceType) {
    const existing = await get(`/migration/SourceSystems?$filter=systemId eq '${systemId}'`);

    if (existing.value.length > 0) {
        done(`${systemId} already exists`);
        return;
    }

    await post("/migration/SourceSystems", {
        systemId,
        systemName,
        systemType,
        active: true,
        description: "Mock system for the workbench demo",
        connections: [{
            connectionId: `${systemId}_CONN`,
            connectionName: `${systemName} (mock)`,
            interfaceType,
            adapterType,
            authenticationType: "MOCK",
            status: "CONNECTED"
        }]
    });

    done(`${systemId} created`);
}

const modelId = async (filter) =>
    (await get(`/framework/BusinessObjectModels?$filter=${encodeURIComponent(filter)}&$select=ID&$orderby=version desc`)).value[0]?.ID;

const structureMapping = async (setId, toStructure, pattern) =>
    (await get(
        `/framework/StructureMappings?$filter=${encodeURIComponent(`mappingSet_ID eq ${setId} and pattern eq '${pattern}'`)}&$expand=toStructure($select=name)`
    )).value.find(mapping => mapping.toStructure.name === toStructure);

const setField = (structureMappingId, toField, rule, fromFields = []) =>
    post("/framework/upsertFieldMapping", {
        structureMappingId,
        toField,
        rule: JSON.stringify(rule),
        fromFields: JSON.stringify(fromFields)
    });

const setValues = (domain, pairs, fromSystem, toSystem = "CANONICAL") =>
    post("/framework/upsertValueMappings", {
        domain,
        fromSystem,
        toSystem,
        entries: JSON.stringify(Object.entries(pairs).map(([fromValue, toValue]) => ({ fromValue, toValue })))
    });

async function main() {
    console.log(`Migration Workbench demo setup against ${BASE_URL}`);

    step("Source systems (mock)");
    await ensureSourceSystem("M3_DEMO", "Infor M3 (mock)", "M3", "M3", "M3_MI");
    await ensureSourceSystem("S4_DEMO", "S/4HANA source (mock)", "S4HANA", "S4", "ODATA");

    step("Source models built from metadata");
    const m3 = await post("/framework/buildSourceModel", {
        sourceSystemId: "M3_DEMO",
        sourceObject: "CRS610MI",
        relatedObjects: ["OIS002MI"],
        businessObjectType: "BUSINESS_PARTNER"
    });
    done(m3.message);

    let s4 = null;

    try {
        s4 = await post("/framework/buildSourceModel", {
            sourceSystemId: "S4_DEMO",
            sourceObject: "API_BUSINESS_PARTNER",
            businessObjectType: "BUSINESS_PARTNER"
        });
        done(s4.message);
    } catch (error) {
        console.log(`  ! S/4 model skipped (start the server with S4_DISCOVERY_MODE=MOCK): ${error.message}`);
    }

    step("Meaning tags (rule-based)");
    for (const model of [m3, s4].filter(Boolean)) {
        done((await post("/framework/tagModelFields", { modelId: model.modelId })).message);
    }

    step("Target model: Migration Cockpit 'Customer' (indicative template)");
    const target = await post("/framework/importModel", {
        definition: fs.readFileSync(path.join(__dirname, "..", "..", "srv", "mock", "cockpit", "customer-template.json"), "utf8")
    });
    done(target.message);
    done((await post("/framework/tagModelFields", { modelId: target.modelId })).message);

    const canonicalId = await modelId("layer eq 'CANONICAL' and type_code eq 'BUSINESS_PARTNER'");

    step("M3 -> canonical: suggestions + functional team decisions");
    const set1 = await post("/framework/suggestMappings", { fromModelId: m3.modelId, toModelId: canonicalId });
    done(set1.message);

    const root = await structureMapping(set1.mappingSetId, "BusinessPartner", "ONE_TO_ONE");
    const headerAddress = await structureMapping(set1.mappingSetId, "Address", "EXPLODE");
    const tax = await structureMapping(set1.mappingSetId, "TaxNumber", "EXPLODE");

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

    const role = await post("/framework/upsertStructureMapping", {
        mappingSetId: set1.mappingSetId,
        toStructure: "Role",
        fromStructures: ["CRS610MI.LstByNumber"],
        pattern: "DERIVE",
        patternConfig: "{}"
    });
    await setField(role.ID, "roleCode", { type: "CONSTANT", value: "CUSTOMER" });
    done("category, header address, tax category and role decided");

    await setValues("party.status", { 20: "ACTIVE", 90: "INACTIVE" }, "M3_DEMO");
    await setValues("address.region", { QL: "QLD", NS: "NSW", WA: "WA" }, "M3_DEMO");
    await setValues("address.usage", { 1: "SHIP_TO", 3: "BILL_TO" }, "M3_DEMO");
    await setValues("org.companyCode", { 100: "AU01", 200: "AU02" }, "M3_DEMO");
    await setValues("finance.paymentTerms", { 30: "0001", 45: "0002" }, "M3_DEMO"); // 60 deliberately missing
    await setValues("finance.dunningProcedure", { 1: "Z001", 2: "Z002" }, "M3_DEMO");
    await setValues("TAX_CATEGORY_BY_COUNTRY", { AU: "ABN", NZ: "GST" }, "M3_DEMO");
    done("value mappings maintained (payment terms 60 left open on purpose)");

    done((await post("/framework/approveMappingSet", { mappingSetId: set1.mappingSetId, approvePending: true })).message);

    step("Canonical -> Cockpit: suggestions + decisions");
    const set2 = await post("/framework/suggestMappings", { fromModelId: canonicalId, toModelId: target.modelId });
    done(set2.message);

    await setField((await structureMapping(set2.mappingSetId, "GENERAL", "ONE_TO_ONE")).ID, "BU_GROUP", { type: "CONSTANT", value: "CUST" });
    await setField((await structureMapping(set2.mappingSetId, "COMPANY", "ONE_TO_ONE")).ID, "AKONT", { type: "CONSTANT", value: "12100000" });
    done((await post("/framework/approveMappingSet", { mappingSetId: set2.mappingSetId, approvePending: true })).message);

    if (s4) {
        step("S/4 -> canonical: suggestions left OPEN for review in the UI");
        done((await post("/framework/suggestMappings", { fromModelId: s4.modelId, toModelId: canonicalId })).message);
    }

    step("Preview migration");
    const preview = await post(`/framework/BusinessObjectModels(${m3.modelId})/FrameworkService.runPreview`, { limit: 100 });
    done(preview.message);

    console.log(`\nDone. Open:
  Migration Workbench : ${BASE_URL}/workbench/webapp/index.html
  Value Mappings      : ${BASE_URL}/value-mappings/webapp/index.html`);
}

main().catch(error => {
    console.error(`\n✗ Demo setup failed: ${error.message}`);
    process.exitCode = 1;
});
