"use strict";

/**
 * ============================================================
 * FRAMEWORK SEED GENERATOR
 * ============================================================
 *
 * Generates CSV seed data for the migration.framework namespace:
 *   - BusinessObjectType   (catalog)
 *   - SemanticTag          (shared vocabulary)
 *   - Canonical Business Partner v1 model
 *       BusinessObjectModel, Structure, Relationship, Field
 *
 * The canonical model is defined once, below, in readable form.
 * IDs are derived deterministically from names, so re-running the
 * generator keeps all IDs stable.
 *
 * Usage:
 *   node scripts/seed/generate-framework-seed.js
 *
 * Output:
 *   db/data/migration.framework-*.csv
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "..", "..", "db", "data");
const NAMESPACE = "migration.framework";


/*
 * ============================================================
 * SEMANTIC TAG VOCABULARY
 * ============================================================
 * [code, description, dataClass, isPersonal]
 */
const SEMANTIC_TAGS = [
    // Meta
    ["meta.sourceSystem", "System the record originates from", "CODE", false],

    // Party
    ["party.legacyId", "Business key of the party in the source system", "ID", false],
    ["party.category", "Party category (organization, person, group)", "CODE", false],
    ["party.name", "Primary name of the party", "TEXT", true],
    ["party.nameAdditional", "Additional name line of the party", "TEXT", true],
    ["party.searchTerm", "Short search term / alias", "TEXT", false],
    ["party.language", "Correspondence language", "CODE", false],
    ["party.status", "Lifecycle status in the source system", "CODE", false],
    ["party.blocked", "Party is blocked / inactive", "FLAG", false],
    ["party.role", "Role of the party (customer, supplier, contact)", "CODE", false],
    ["party.roleValidFrom", "Start of validity of a party role", "DATE", false],

    // Address
    ["address.id", "Identifier of an address within a party", "ID", false],
    ["address.usage", "Usage of the address (standard, bill-to, ship-to)", "CODE", false],
    ["address.street", "Street name", "TEXT", true],
    ["address.houseNumber", "House number", "TEXT", true],
    ["address.line", "Additional free address line", "TEXT", true],
    ["address.city", "City / town", "TEXT", false],
    ["address.postalCode", "Postal code", "TEXT", false],
    ["address.region", "Region / state / province", "CODE", false],
    ["address.country", "Country (ISO code)", "CODE", false],
    ["address.isStandard", "Address is the standard address of the party", "FLAG", false],

    // Communication
    ["comm.type", "Communication type (phone, mobile, fax, email)", "CODE", false],
    ["comm.value", "Phone number, fax number or email address", "TEXT", true],
    ["comm.isDefault", "Communication entry is the default of its type", "FLAG", false],

    // Tax
    ["tax.category", "Tax number category (VAT, ABN, GST ...)", "CODE", false],
    ["tax.number", "Tax registration number", "TEXT", false],
    ["tax.country", "Country issuing the tax number", "CODE", false],

    // Bank
    ["bank.accountId", "Identifier of a bank account within a party", "ID", false],
    ["bank.country", "Country of the bank", "CODE", false],
    ["bank.key", "Bank key / routing / BSB number", "TEXT", false],
    ["bank.account", "Bank account number", "TEXT", true],
    ["bank.iban", "IBAN", "TEXT", true],
    ["bank.holder", "Account holder name", "TEXT", true],

    // Organizational units
    ["org.companyCode", "Company / legal entity", "CODE", false],
    ["org.salesOrg", "Sales organization", "CODE", false],
    ["org.distributionChannel", "Distribution channel", "CODE", false],
    ["org.division", "Division", "CODE", false],

    // Finance
    ["finance.paymentTerms", "Payment terms (financial accounting)", "CODE", false],
    ["finance.reconciliationAccount", "Reconciliation account / account group", "CODE", false],
    ["finance.dunningProcedure", "Dunning procedure", "CODE", false],
    ["finance.creditLimit", "Credit limit", "AMOUNT", false],
    ["finance.currency", "Currency of financial data", "CODE", false],

    // Sales
    ["sales.currency", "Sales currency", "CODE", false],
    ["sales.paymentTerms", "Payment terms (sales)", "CODE", false],
    ["sales.incoterms", "Incoterms", "CODE", false],
    ["sales.customerGroup", "Customer group / classification", "CODE", false]
];


/*
 * ============================================================
 * BUSINESS OBJECT CATALOG
 * ============================================================
 */
const BUSINESS_OBJECT_TYPES = [
    {
        code: "BUSINESS_PARTNER",
        name: "Business Partner",
        description:
            "Organization or person with which the company has a business relationship " +
            "(customer, supplier, contact), including addresses, roles, tax numbers, " +
            "bank accounts, company code and sales area data.",
        signature: [
            "party.legacyId",
            "party.name",
            "address.city",
            "address.country",
            "tax.number",
            "org.companyCode"
        ]
    }
];


/*
 * ============================================================
 * CANONICAL BUSINESS PARTNER v1
 * ============================================================
 *
 * Field: [name, dataType, length, isKey, mandatory, semanticTag, description]
 *
 * Canonical instances are nested JSON documents, so child structures
 * are EMBEDDED in their parent and carry only their own keys.
 * All code values are canonical codes (see ValueMapping).
 */
const CANONICAL_BP = {
    typeCode: "BUSINESS_PARTNER",
    name: "Canonical Business Partner",
    version: "1",
    status: "DRAFT",
    description:
        "Source- and target-independent Business Partner used as the hub between " +
        "all source systems and all targets. Code values are canonical codes.",
    structures: [
        {
            name: "BusinessPartner",
            isRoot: true,
            description: "Root of the Business Partner",
            fields: [
                ["legacyKey", "String", 60, true, true, "party.legacyId", "Business key in the source system"],
                ["sourceSystem", "String", 100, true, true, "meta.sourceSystem", "Source system ID"],
                ["category", "String", 20, false, true, "party.category", "ORGANIZATION | PERSON | GROUP"],
                ["name1", "String", 40, false, true, "party.name", "Name line 1"],
                ["name2", "String", 40, false, false, "party.nameAdditional", "Name line 2"],
                ["name3", "String", 40, false, false, "party.nameAdditional", "Name line 3"],
                ["name4", "String", 40, false, false, "party.nameAdditional", "Name line 4"],
                ["searchTerm", "String", 20, false, false, "party.searchTerm", "Search term"],
                ["language", "String", 2, false, false, "party.language", "Correspondence language (ISO 639-1)"],
                ["status", "String", 20, false, false, "party.status", "Canonical lifecycle status"],
                ["isBlocked", "Boolean", null, false, false, "party.blocked", "Party is blocked"]
            ]
        },
        {
            name: "Address",
            parent: "BusinessPartner",
            cardinality: "0..N",
            description: "Postal addresses of the Business Partner",
            fields: [
                ["addressKey", "String", 40, true, true, "address.id", "Address identifier within the partner"],
                ["usage", "String", 20, false, true, "address.usage", "STANDARD | BILL_TO | SHIP_TO | OTHER"],
                ["street", "String", 60, false, false, "address.street", "Street"],
                ["houseNumber", "String", 10, false, false, "address.houseNumber", "House number"],
                ["addressLine2", "String", 60, false, false, "address.line", "Additional address line 2"],
                ["addressLine3", "String", 60, false, false, "address.line", "Additional address line 3"],
                ["addressLine4", "String", 60, false, false, "address.line", "Additional address line 4"],
                ["city", "String", 40, false, true, "address.city", "City"],
                ["postalCode", "String", 10, false, false, "address.postalCode", "Postal code"],
                ["region", "String", 3, false, false, "address.region", "Region"],
                ["country", "String", 3, false, true, "address.country", "Country (ISO 3166-1 alpha-2)"],
                ["isStandard", "Boolean", null, false, true, "address.isStandard", "Standard address of the partner"]
            ]
        },
        {
            name: "Communication",
            parent: "Address",
            cardinality: "0..N",
            description: "Phone, fax and email entries of an address",
            fields: [
                ["type", "String", 10, true, true, "comm.type", "PHONE | MOBILE | FAX | EMAIL"],
                ["value", "String", 241, true, true, "comm.value", "Number or email address"],
                ["isDefault", "Boolean", null, false, false, "comm.isDefault", "Default entry of its type"]
            ]
        },
        {
            name: "Role",
            parent: "BusinessPartner",
            cardinality: "0..N",
            description: "Business roles of the partner",
            fields: [
                ["roleCode", "String", 20, true, true, "party.role", "CUSTOMER | SUPPLIER | CONTACT | ..."],
                ["validFrom", "Date", null, false, false, "party.roleValidFrom", "Role valid from"]
            ]
        },
        {
            name: "TaxNumber",
            parent: "BusinessPartner",
            cardinality: "0..N",
            description: "Tax registration numbers",
            fields: [
                ["taxCategory", "String", 10, true, true, "tax.category", "VAT | ABN | GST | ..."],
                ["number", "String", 60, false, true, "tax.number", "Tax number"],
                ["country", "String", 3, false, false, "tax.country", "Issuing country"]
            ]
        },
        {
            name: "BankAccount",
            parent: "BusinessPartner",
            cardinality: "0..N",
            description: "Bank accounts of the partner",
            fields: [
                ["accountId", "String", 10, true, true, "bank.accountId", "Account identifier within the partner"],
                ["bankCountry", "String", 3, false, true, "bank.country", "Bank country"],
                ["bankKey", "String", 15, false, false, "bank.key", "Bank key / BSB / routing number"],
                ["accountNumber", "String", 35, false, false, "bank.account", "Account number"],
                ["iban", "String", 34, false, false, "bank.iban", "IBAN"],
                ["accountHolder", "String", 60, false, false, "bank.holder", "Account holder"]
            ]
        },
        {
            name: "CompanyData",
            parent: "BusinessPartner",
            cardinality: "0..N",
            description: "Company / legal entity specific financial data",
            fields: [
                ["companyCode", "String", 10, true, true, "org.companyCode", "Canonical company code"],
                ["paymentTerms", "String", 10, false, false, "finance.paymentTerms", "Canonical payment terms"],
                ["reconAccountGroup", "String", 20, false, false, "finance.reconciliationAccount", "Reconciliation account group"],
                ["dunningProcedure", "String", 10, false, false, "finance.dunningProcedure", "Dunning procedure"],
                ["creditLimit", "Decimal", null, false, false, "finance.creditLimit", "Credit limit"],
                ["currency", "String", 5, false, false, "finance.currency", "Currency (ISO 4217)"]
            ]
        },
        {
            name: "SalesAreaData",
            parent: "BusinessPartner",
            cardinality: "0..N",
            description: "Sales area specific data",
            fields: [
                ["salesOrg", "String", 10, true, true, "org.salesOrg", "Canonical sales organization"],
                ["distributionChannel", "String", 10, true, true, "org.distributionChannel", "Canonical distribution channel"],
                ["division", "String", 10, true, true, "org.division", "Canonical division"],
                ["currency", "String", 5, false, false, "sales.currency", "Currency (ISO 4217)"],
                ["paymentTerms", "String", 10, false, false, "sales.paymentTerms", "Canonical payment terms"],
                ["incoterms", "String", 10, false, false, "sales.incoterms", "Incoterms"],
                ["customerGroup", "String", 10, false, false, "sales.customerGroup", "Canonical customer group"]
            ]
        }
    ]
};


/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

/**
 * Deterministic UUID (version 5 layout) from a name.
 */
function stableId(name) {
    const hash = crypto
        .createHash("sha1")
        .update(`${NAMESPACE}:${name}`)
        .digest("hex");

    const variant = ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);

    return [
        hash.substring(0, 8),
        hash.substring(8, 12),
        "5" + hash.substring(13, 16),
        variant + hash.substring(17, 20),
        hash.substring(20, 32)
    ].join("-");
}

function csvValue(value) {
    if (value === null || value === undefined) {
        return "";
    }

    const text = String(value);

    return /[;"\n\r]/.test(text)
        ? `"${text.replace(/"/g, '""')}"`
        : text;
}

function writeCsv(entityName, columns, rows) {
    const fileName = `${NAMESPACE}-${entityName}.csv`;

    const lines = [
        columns.join(";"),
        ...rows.map(row => columns.map(column => csvValue(row[column])).join(";"))
    ];

    fs.writeFileSync(
        path.join(OUTPUT_DIR, fileName),
        lines.join("\n") + "\n",
        "utf8"
    );

    console.log(`  ${fileName}: ${rows.length} row(s)`);
}


/*
 * ============================================================
 * BUILD ROWS
 * ============================================================
 */
function buildModelRows(model) {
    const modelKey = `${model.layer}|${model.systemId || ""}|${model.typeCode}|${model.version}`;
    const modelId = stableId(`model:${modelKey}`);

    const modelRow = {
        ID: modelId,
        type_code: model.typeCode,
        layer: model.layer,
        systemId: model.systemId || null,
        name: model.name,
        version: model.version,
        status: model.status,
        origin: model.origin,
        description: model.description
    };

    const structureIds = {};
    const structureRows = [];
    const fieldRows = [];
    const relationshipRows = [];

    model.structures.forEach((structure, structureIndex) => {
        const structureId = stableId(`structure:${modelKey}:${structure.name}`);
        structureIds[structure.name] = structureId;

        structureRows.push({
            ID: structureId,
            model_ID: modelId,
            name: structure.name,
            isRoot: structure.isRoot === true,
            sortOrder: structureIndex + 1,
            description: structure.description
        });

        structure.fields.forEach(
            ([name, dataType, length, isKey, mandatory, semanticTag, description], fieldIndex) => {
                fieldRows.push({
                    ID: stableId(`field:${modelKey}:${structure.name}.${name}`),
                    structure_ID: structureId,
                    name,
                    sortOrder: fieldIndex + 1,
                    description,
                    dataType,
                    length,
                    isKey,
                    mandatory,
                    semanticTag_code: semanticTag,
                    tagConfidence: 100,
                    tagOrigin: "MANUAL",
                    tagReason: "Defined in the canonical model",
                    tagStatus: "APPROVED"
                });
            }
        );
    });

    for (const structure of model.structures) {
        if (!structure.parent) {
            continue;
        }

        const parentId = structureIds[structure.parent];

        if (!parentId) {
            throw new Error(
                `Structure '${structure.name}' references unknown parent '${structure.parent}'`
            );
        }

        relationshipRows.push({
            ID: stableId(`relationship:${modelKey}:${structure.parent}>${structure.name}`),
            model_ID: modelId,
            parent_ID: parentId,
            child_ID: structureIds[structure.name],
            cardinality: structure.cardinality,
            kind: model.relationshipKind,
            joinKeys: structure.joinKeys ? JSON.stringify(structure.joinKeys) : null
        });
    }

    return { modelRow, structureRows, fieldRows, relationshipRows };
}

function validate() {
    const tagCodes = new Set(SEMANTIC_TAGS.map(([code]) => code));

    for (const structure of CANONICAL_BP.structures) {
        for (const [fieldName, , , , , semanticTag] of structure.fields) {
            if (!tagCodes.has(semanticTag)) {
                throw new Error(
                    `Field '${structure.name}.${fieldName}' uses unknown semantic tag '${semanticTag}'`
                );
            }
        }
    }

    for (const type of BUSINESS_OBJECT_TYPES) {
        for (const tag of type.signature) {
            if (!tagCodes.has(tag)) {
                throw new Error(
                    `Signature of '${type.code}' uses unknown semantic tag '${tag}'`
                );
            }
        }
    }
}


/*
 * ============================================================
 * MAIN
 * ============================================================
 */
function main() {
    validate();

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    console.log(`Writing framework seed data to ${OUTPUT_DIR}`);

    writeCsv(
        "SemanticTag",
        ["code", "domain", "description", "dataClass", "isPersonal"],
        SEMANTIC_TAGS.map(([code, description, dataClass, isPersonal]) => ({
            code,
            domain: code.split(".")[0],
            description,
            dataClass,
            isPersonal
        }))
    );

    writeCsv(
        "BusinessObjectType",
        ["code", "name", "description", "signature"],
        BUSINESS_OBJECT_TYPES.map(type => ({
            ...type,
            signature: JSON.stringify(type.signature)
        }))
    );

    const canonical = buildModelRows({
        ...CANONICAL_BP,
        layer: "CANONICAL",
        systemId: null,
        origin: "MANUAL",
        relationshipKind: "EMBEDDED"
    });

    writeCsv(
        "BusinessObjectModel",
        ["ID", "type_code", "layer", "systemId", "name", "version", "status", "origin", "description"],
        [canonical.modelRow]
    );

    writeCsv(
        "Structure",
        ["ID", "model_ID", "name", "isRoot", "sortOrder", "description"],
        canonical.structureRows
    );

    writeCsv(
        "Relationship",
        ["ID", "model_ID", "parent_ID", "child_ID", "cardinality", "kind", "joinKeys"],
        canonical.relationshipRows
    );

    writeCsv(
        "Field",
        [
            "ID", "structure_ID", "name", "sortOrder", "description", "dataType",
            "length", "isKey", "mandatory", "semanticTag_code", "tagConfidence",
            "tagOrigin", "tagReason", "tagStatus"
        ],
        canonical.fieldRows
    );
}

main();
