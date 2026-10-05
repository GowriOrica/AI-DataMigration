"use strict";

const fs = require("fs");
const path = require("path");
const SourceAdapter = require("./SourceAdapter");
const { getDestination } = require("@sap-cloud-sdk/connectivity");
const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");

/**
 * ============================================================
 * INFOR M3 SOURCE ADAPTER
 * ============================================================
 *
 * Objects are M3 MI transactions, named "PROGRAM.TRANSACTION"
 * (e.g. "CRS610MI.LstByNumber"). A program name alone
 * ("CRS610MI") stands for all of its transactions.
 *
 * Modes (M3_MODE):
 *   MOCK - reads srv/mock/m3/metadata.json and data.json (default)
 *   LIVE - Infor ION API -> M3 API REST, through a BTP destination (see "LIVE MODE" below). Read only.
 *
 * M3 metadata describes flat transactions only. It does not declare
 * relationships between them, so getRelationships() returns the
 * entities without navigations (relationshipsDeclared = false).
 * Relationships are proposed afterwards (key overlap / AI) and
 * confirmed by a person.
 */

const MOCK_DIR = path.join(__dirname, "..", "mock", "m3");

// ION API gateway path of the M3 API REST service, and the only kind of M3 transaction that is ever called
const ION_BASE = "/M3/m3api-rest/v2";
const READ_ONLY_TRANSACTION = /^(Lst|Get|Search)/i;

const M3_TYPE_MAP = {
    A: "String",
    D: "Date"
};

class M3SourceAdapter extends SourceAdapter {

    constructor(connection) {
        super(connection);

        this.adapterType = "M3";
        // LIVE when M3_MODE says so, or when the connection names a destination; otherwise the local mock
        this.mode = (process.env.M3_MODE || (connection && connection.endpointReference ? "LIVE" : "MOCK")).toUpperCase();
        this._metadata = null;
        this._data = null;
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
            mode: this.mode,
            status: "AVAILABLE"
        };
    }

    async authenticate() {
        if (this._isLive()) return this._liveAuthenticate();

        this._assertMockMode();

        return {
            authenticated: true,
            mode: this.mode,
            message: "M3 authentication simulated in MOCK mode"
        };
    }

    async getStatus() {
        if (this._isLive()) return this._liveStatus();

        this._assertMockMode();

        return {
            status: "CONNECTED",
            mode: this.mode
        };
    }

    async getMetadata() {
        if (this._isLive()) return this._liveMetadata();

        const metadata = this._loadMetadata();

        return {
            systemId: this.connection.systemId,
            systemName: this.connection.systemName,
            systemType: this.connection.systemType,
            adapterType: this.adapterType,
            sourceType: "M3",
            metadataVersion: metadata.system?.metadataVersion || "1.0",
            metadataStatus: "AVAILABLE",
            programCount: metadata.programs.length
        };
    }

    /**
     * ============================================================
     * DISCOVERY
     * ============================================================
     */
    /**
     * options (used by the scope step; the plain discovery passes none):
     *   forScope, scopePrefixes, includeCustom, maxPrograms
     */
    async discoverObjects(options = {}) {
        if (this._isLive()) return this._liveDiscoverObjects(options);

        return this._allTransactions().map(({ program, transaction }) => ({
            objectId: `${this.connection.systemId}_${program.program}.${transaction.transaction}`,
            objectName: `${program.program}.${transaction.transaction}`,
            objectType: `M3_MI_${transaction.type}`,
            schemaVersion: this._metadataVersion(),
            description: `${program.description} - ${transaction.description}`,
            protocol: "M3_MI"
        }));
    }

    async getSchema(objectName) {
        if (this._isLive() && !String(objectName).includes(".")) return this._liveProgramSchema(objectName);

        const [entry] = await this._entries(objectName);

        if (!entry) {
            throw new Error(`M3 transaction '${objectName}' was not found in the MI catalog`);
        }

        return {
            objectName: this._objectName(entry),
            objectId: `${this.connection.systemId}_${this._objectName(entry)}`,
            schemaVersion: this._metadataVersion(),
            fields: this._fields(entry.transaction).map(field => ({
                fieldName: field.name,
                dataType: field.dataType,
                length: field.length,
                precision: field.precision,
                scale: field.scale,
                nullable: field.nullable,
                isKey: field.isKey,
                mandatory: field.mandatory,
                description: field.description
            })),
            entitySets: [],
            metadata: {
                protocol: "M3_MI",
                program: entry.program.program,
                transaction: entry.transaction.transaction,
                discoveryMode: this.mode
            }
        };
    }

    /**
     * Entity graph for one or more M3 objects. No navigations:
     * M3 does not declare relationships between transactions.
     *
     * @param {string}   objectName      "CRS610MI" or "CRS610MI.LstByNumber"
     * @param {string[]} relatedObjects  further programs / transactions to include
     */
    async getRelationships(objectName, relatedObjects = []) {
        const names = [objectName, ...(relatedObjects || [])].filter(Boolean);
        const entries = [];

        for (const name of names) {
            const resolved = await this._entries(name);

            if (resolved.length === 0) {
                throw new Error(`M3 object '${name}' was not found in the MI catalog`);
            }

            entries.push(...resolved);
        }

        const entityTypes = {};
        const entitySets = {};

        for (const entry of entries) {
            const name = this._objectName(entry);

            if (entityTypes[name]) {
                continue;
            }

            const properties = this._fields(entry.transaction);

            entityTypes[name] = {
                name,
                label: entry.transaction.description,
                keys: properties.filter(p => p.isKey).map(p => p.name),
                properties,
                navigations: []
            };

            entitySets[name] = {
                name,
                entityType: name,
                label: `${entry.program.description} - ${entry.transaction.description}`,
                navigationBindings: {},
                accessPath: {
                    kind: "M3_MI",
                    program: entry.program.program,
                    transaction: entry.transaction.transaction,
                    transactionType: entry.transaction.type,
                    inputs: entry.transaction.inputs || []
                }
            };
        }

        return {
            objectName: names.join(","),
            protocol: "M3_MI",
            discoveryMode: this.mode,
            relationshipsDeclared: false,
            entityTypes,
            entitySets
        };
    }

    /**
     * ============================================================
     * EXTRACTION (paged)
     * ============================================================
     *
     * options:
     *   pageSize  (or top / limit)   default 100
     *   pageToken (offset as string)
     *   filter    { FIELD: value }   equality filter
     */
    async extract(objectName, options = {}) {
        if (this._isLive()) return this._liveExtract(objectName, options);

        const [entry] = this._resolveTransactions(objectName);

        if (!entry) {
            throw new Error(`M3 transaction '${objectName}' was not found in the MI catalog`);
        }

        const name = this._objectName(entry);
        const keyFields = entry.transaction.keyFields || entry.transaction.inputs || [];
        const filter = options.filter || {};

        const all = (this._loadData()[name] || []).filter(record =>
            Object.entries(filter).every(([field, value]) => String(record[field]) === String(value))
        );

        const pageSize = Math.max(
            1,
            Number(options.pageSize || options.top || options.limit) || 100
        );
        const offset = Math.max(0, Number(options.pageToken || options.skip) || 0);
        const page = all.slice(offset, offset + pageSize);

        const records = page.map(record => ({
            ...record,
            sourceKey: keyFields.map(field => record[field]).join("|")
        }));

        return {
            records,
            totalCount: all.length,
            nextPageToken: offset + pageSize < all.length ? String(offset + pageSize) : null,
            metadata: {
                extractedAt: new Date().toISOString(),
                recordCount: records.length,
                entityPath: name
            }
        };
    }

    async count(objectName, filter = {}) {
        const result = await this.extract(objectName, { filter, pageSize: Number.MAX_SAFE_INTEGER });

        return { count: result.totalCount, exact: true };
    }

    async getDelta() {
        throw new Error("M3 delta extraction is not implemented yet");
    }

    handleError(error) {
        return {
            errorCode: "M3_ADAPTER_ERROR",
            message: error?.message || "Unknown M3 adapter error",
            retryable: false
        };
    }

    /**
     * ============================================================
     * LIVE MODE (ION API -> M3 API REST)
     * ============================================================
     *
     * The connection reference is the name of a BTP destination (type HTTP, OAuth2Password) that points to the
     * ION API of the tenant, e.g. https://mingle-ionapi.inforcloudsuite.com/<TENANT>. The destination service
     * fetches the token; no credential is ever read or stored by this code.
     *
     * The catalog comes from M3 itself (program MRS001MI): programs, transactions and fields. Names are
     * discovered, never assumed: a program of one tenant may not exist in another.
     *
     * READ ONLY: only transactions named Lst*, Get* or Search* are ever called. M3 programs also contain
     * Add*, Chg*, Delete, Copy ... which change data; they are refused before any call is made.
     */
    _isLive() {
        return this.mode === "LIVE";
    }

    _destinationName() {
        return this.connection.endpointReference || process.env.M3_DESTINATION || "M3_ION_API";
    }

    /** Calls one M3 transaction and answers its records. */
    async _ion(program, transaction, params = {}) {
        if (!READ_ONLY_TRANSACTION.test(String(transaction))) {
            throw new Error(
                `M3 transaction '${program}.${transaction}' is not read only. ` +
                `The migration only calls Lst*, Get* and Search* transactions.`
            );
        }

        const destinationName = this._destinationName();
        const destination = await M3SourceAdapter.deps.getDestination({ destinationName });

        if (!destination) {
            throw new Error(`BTP destination '${destinationName}' could not be resolved`);
        }

        const query = new URLSearchParams(
            Object.entries(params)
                .filter(([, value]) => value !== undefined && value !== null && value !== "")
                .map(([key, value]) => [key, String(value)])
        ).toString();

        let response;

        try {
            response = await M3SourceAdapter.deps.executeHttpRequest(
                destination,
                {
                    method: "GET",
                    url: `${ION_BASE}/execute/${encodeURIComponent(program)}/${encodeURIComponent(transaction)}${query ? "?" + query : ""}`,
                    headers: { Accept: "application/json" }
                },
                { fetchCsrfToken: false }
            );
        } catch (error) {
            const status = error.response && error.response.status;

            throw new Error(
                `M3 ${program}.${transaction} failed` + (status ? ` with status code ${status}` : `: ${error.message}`)
            );
        }

        const result = (response.data && response.data.results && response.data.results[0]) || {};

        if (result.errorMessage) {
            const error = new Error(`M3 ${program}.${transaction}: ${String(result.errorMessage).trim()}`);

            error.m3Code = result.errorCode;
            throw error;
        }

        return result.records || [];
    }

    _cache() {
        if (!this._live) {
            this._live = { programs: null, transactions: new Map(), entries: new Map(), cursor: null };
        }

        return this._live;
    }

    async _programs() {
        const cache = this._cache();

        if (!cache.programs) {
            cache.programs = await this._ion("MRS001MI", "LstPrograms", { maxrecs: 10000 });
        }

        return cache.programs;
    }

    async _transactions(program) {
        const cache = this._cache();

        if (!cache.transactions.has(program)) {
            cache.transactions.set(program, await this._ion("MRS001MI", "LstTransactions", { MINM: program }));
        }

        return cache.transactions.get(program);
    }

    async _liveAuthenticate() {
        await this._ion("MRS001MI", "LstPrograms", { maxrecs: 1 });

        return {
            authenticated: true,
            mode: this.mode,
            message: `Connected to M3 through the destination '${this._destinationName()}'`
        };
    }

    async _liveStatus() {
        await this._ion("MRS001MI", "LstPrograms", { maxrecs: 1 });

        return { status: "CONNECTED", mode: this.mode };
    }

    async _liveMetadata() {
        const programs = await this._programs();

        return {
            systemId: this.connection.systemId,
            systemName: this.connection.systemName,
            systemType: this.connection.systemType,
            adapterType: this.adapterType,
            sourceType: "M3",
            metadataVersion: "live",
            metadataStatus: "AVAILABLE",
            programCount: programs.length
        };
    }

    /**
     * Every API program of the tenant, from the catalog of M3 itself (one call). Transactions and fields are not
     * read here: that would be thousands of calls. They are read when a program is selected (listTransactions,
     * getSchema "PROGRAM.TRANSACTION").
     */
    async _liveDiscoverObjects(options = {}) {
        const programs = await this._programs();
        let list = programs;

        if (options.forScope) {
            // scope: API programs only (MI); custom (EXT) programs only when asked; optionally only some areas
            const prefixes = (Array.isArray(options.scopePrefixes) ? options.scopePrefixes : String(options.scopePrefixes || "").split(/[\s,;]+/))
                .map(p => String(p || "").trim().toUpperCase())
                .filter(Boolean);

            list = programs.filter(p =>
                /MI$/i.test(p.MINM) &&
                (options.includeCustom === true || !/^EXT/i.test(p.MINM)) &&
                (prefixes.length === 0 || prefixes.some(prefix => String(p.MINM).toUpperCase().startsWith(prefix)))
            );
        }

        // programs, not transactions: the AI groups them into business objects by name and description
        return list.map(program => ({
            objectId: `${this.connection.systemId}_${program.MINM}`,
            objectName: program.MINM,
            objectType: "M3_MI_PROGRAM",
            schemaVersion: "live",
            description: [program.OBNM, program.MIDS].filter(Boolean).join(" - ") || program.MINM,
            protocol: "M3_MI"
        }));
    }

    /** A program on its own cannot be extracted; a transaction (PROGRAM.TRANSACTION) can. */
    isExtractable(objectName) {
        return !this._isLive() || String(objectName || "").includes(".");
    }

    /**
     * The list transactions of a program that can be read as a whole list, to be extracted. A list that needs a
     * value in every call (a customer number) is not offered: it is a child list, read per record.
     */
    async listExtractableObjects(program) {
        const lists = (await this.listTransactions(program)).filter(t => t.kind === "LIST");
        const items = [];
        const skipped = [];

        for (const list of lists) {
            if (!this._isLive()) {
                items.push({ objectName: list.objectName, description: list.description });
                continue;
            }

            const [entry] = await this._liveEntries(list.objectName);
            const mandatory = entry.transaction.mandatoryInputs || [];

            if (mandatory.length === 0) {
                items.push({ objectName: list.objectName, description: list.description });
            } else {
                skipped.push({ objectName: list.objectName, reason: `needs ${mandatory.join(", ")} in every call (a list per record)` });
            }
        }

        return { items, skipped };
    }

    /**
     * The read-only transactions of one program, as objects "PROGRAM.TRANSACTION": the lists (Lst*, can be read
     * as a whole), the single reads (Get*) and the searches (Search*). Transactions that change data are not shown.
     */
    async listTransactions(program) {
        if (!this._isLive()) {
            return this._resolveTransactions(program).map(entry => ({
                objectName: this._objectName(entry), description: entry.transaction.description, kind: "LIST"
            }));
        }

        const info = (await this._programs()).find(p => String(p.MINM).toUpperCase() === String(program).toUpperCase());

        if (!info) {
            throw new Error(`M3 program '${program}' does not exist in this M3 tenant`);
        }

        return (await this._transactions(info.MINM))
            .filter(t => READ_ONLY_TRANSACTION.test(String(t.TRNM)))
            .map(t => ({
                objectName: `${info.MINM}.${t.TRNM}`,
                description: t.TRDS || t.TRNM,
                kind: /^Lst/i.test(t.TRNM) ? "LIST" : /^Get/i.test(t.TRNM) ? "GET" : "SEARCH"
            }));
    }

    /**
     * What a functional person wants to know about one discovered object: what does it offer?
     * M3: the transactions of a program that READ data. The ones that change data are counted, not listed.
     * Same answer shape for every source (see describeSourceObject).
     */
    async describeObject(objectName) {
        const program = String(objectName || "").trim().split(".")[0];

        if (!this._isLive()) {
            const entries = this._resolveTransactions(program);

            if (entries.length === 0) {
                throw new Error(`M3 program '${program}' does not exist in this M3 tenant`);
            }

            return {
                title: program,
                description: entries[0].program.description || "",
                itemLabel: "Transactions of this program (read only)",
                items: entries.map(entry => ({ name: this._objectName(entry), description: entry.transaction.description || "", kind: "LIST" })),
                hiddenCount: 0,
                note: ""
            };
        }

        const info = (await this._programs()).find(p => String(p.MINM).toUpperCase() === program.toUpperCase());

        if (!info) {
            throw new Error(`M3 program '${program}' does not exist in this M3 tenant`);
        }

        const all = await this._transactions(info.MINM);
        const items = (await this.listTransactions(info.MINM)).map(t => ({ name: t.objectName, description: t.description, kind: t.kind }));

        return {
            title: info.MINM,
            description: [info.OBNM, info.MIDS].filter(Boolean).join(" - "),
            itemLabel: "Transactions of this program that read data",
            items,
            hiddenCount: all.length - items.length,
            note: "LIST reads many records, GET reads one record by its key, SEARCH looks records up. " +
                "Transactions that change data (Add, Change, Delete ...) are not shown: the migration never calls them."
        };
    }

    /** A program on its own has no fields; its transactions have (see getSchema "PROGRAM.TRANSACTION"). */
    async _liveProgramSchema(program) {
        const info = (await this._programs()).find(p => String(p.MINM).toUpperCase() === String(program).toUpperCase());

        if (!info) {
            throw new Error(`M3 program '${program}' does not exist in this M3 tenant`);
        }

        return {
            objectName: info.MINM,
            objectId: `${this.connection.systemId}_${info.MINM}`,
            schemaVersion: "live",
            fields: [],
            entitySets: [],
            metadata: { protocol: "M3_MI", program: info.MINM, level: "PROGRAM", discoveryMode: this.mode }
        };
    }

    /** One entry in the shape of the mock catalog, built from the field definitions of M3. */
    async _liveEntry(program, transactionName) {
        const cache = this._cache();
        const key = `${program}.${transactionName}`.toUpperCase();

        if (cache.entries.has(key)) {
            return cache.entries.get(key);
        }

        const programs = await this._programs();
        const info = programs.find(p => String(p.MINM).toUpperCase() === program.toUpperCase());

        if (!info) {
            throw new Error(`M3 program '${program}' does not exist in this M3 tenant`);
        }

        const transaction = (await this._transactions(info.MINM)).find(t => String(t.TRNM).toUpperCase() === transactionName.toUpperCase());

        if (!transaction) {
            throw new Error(`M3 transaction '${program}.${transactionName}' was not found in the MI catalog`);
        }

        const fields = async (type) => this._ion("MRS001MI", "LstFields", { MINM: info.MINM, TRNM: transaction.TRNM, TRTP: type });
        const outputs = (await fields("O")).map(f => ({
            field: f.FLNM,
            type: f.TYPE,
            length: Number(f.LENG) || null,
            decimals: null,
            description: f.FLDS
        }));
        const inputs = await fields("I");
        const outputNames = outputs.map(o => o.field);
        const entry = {
            program: { program: info.MINM, description: info.OBNM || info.MINM },
            transaction: {
                transaction: transaction.TRNM,
                description: transaction.TRDS || transaction.TRNM,
                type: "LIST",
                inputs: inputs.map(f => f.FLNM),
                mandatoryInputs: inputs.filter(f => String(f.MAND) === "1").map(f => f.FLNM),
                // inputs that are also output fields identify a record; the last one is the start key for paging
                keyFields: inputs.map(f => f.FLNM).filter(name => outputNames.includes(name)),
                outputs
            }
        };

        cache.entries.set(key, entry);

        return entry;
    }

    async _liveEntries(name) {
        const [program, transaction] = String(name || "").trim().split(".");

        if (!program || !transaction) {
            throw new Error(`Name the M3 transaction, for example 'CRS610MI.LstByNumber' (got '${name}')`);
        }

        return [await this._liveEntry(program, transaction)];
    }

    /**
     * Extraction of a list transaction, page by page. M3 pages by a start key: the next page starts at the last
     * key of the page before (that record is returned again and dropped here). The runner asks for pages in
     * order (skip = records read so far), so the cursor is kept in this adapter.
     */
    async _liveExtract(objectName, options = {}) {
        const [entry] = await this._liveEntries(objectName);
        const name = this._objectName(entry);
        const { transaction } = entry;
        const filter = options.filter || {};
        const missing = (transaction.mandatoryInputs || []).filter(field => filter[field] === undefined);

        if (missing.length > 0) {
            throw new Error(
                `M3 ${name} needs a value for ${missing.join(", ")} in every call, so it cannot be extracted as one list. ` +
                `Extract the list that holds those records instead.`
            );
        }

        const pageSize = Math.min(Math.max(1, Number(options.pageSize || options.top || options.limit) || 100), 10000);
        const skip = Math.max(0, Number(options.skip) || 0);
        const keyField = (transaction.keyFields || []).slice(-1)[0];
        const cache = this._cache();
        const params = { ...filter };
        let startKey = null;

        if (skip > 0) {
            if (!cache.cursor || cache.cursor.name !== name || cache.cursor.skip !== skip) {
                throw new Error(`M3 ${name}: pages must be read in order (asked for record ${skip}, expected ${cache.cursor ? cache.cursor.skip : 0})`);
            }

            startKey = cache.cursor.key;
            params[keyField] = startKey;
        }

        // one more than asked: on a follow-up page the first record is the last one of the page before
        params.maxrecs = pageSize + (startKey === null ? 0 : 1);

        let records = await this._ion(entry.program.program, transaction.transaction, params);

        // a full page from M3 means there may be more
        const full = records.length >= params.maxrecs;

        if (startKey !== null && records.length > 0 && String(records[0][keyField]) === String(startKey)) {
            records = records.slice(1);
        }

        records = records.slice(0, pageSize);

        const last = records[records.length - 1];
        const more = !!keyField && full && records.length > 0;

        cache.cursor = more ? { name, skip: skip + records.length, key: last[keyField] } : null;

        const keyFields = transaction.keyFields || [];

        return {
            records: records.map(record => ({ ...record, sourceKey: keyFields.map(field => record[field]).join("|") })),
            nextPageToken: more ? String(skip + records.length) : null,
            metadata: {
                extractedAt: new Date().toISOString(),
                recordCount: records.length,
                entityPath: name
            }
        };
    }

    _metadataVersion() {
        return this._isLive() ? "live" : (this._loadMetadata().system?.metadataVersion || "1.0");
    }

    /** Mock: the entries of the local catalog. Live: the entry built from the M3 catalog. */
    async _entries(name) {
        return this._isLive() ? this._liveEntries(name) : this._resolveTransactions(name);
    }

    /**
     * ============================================================
     * INTERNALS
     * ============================================================
     */
    _assertMockMode() {
        if (this.mode !== "MOCK") {
            throw new Error(
                `M3 LIVE mode is not implemented yet. The connection channel (ION API Gateway, Data Lake or CPI) ` +
                `is still to be confirmed. Set M3_MODE=MOCK to use the local fixtures.`
            );
        }
    }

    _loadMetadata() {
        this._assertMockMode();

        if (!this._metadata) {
            this._metadata = JSON.parse(
                fs.readFileSync(path.join(MOCK_DIR, "metadata.json"), "utf8")
            );
        }

        return this._metadata;
    }

    _loadData() {
        this._assertMockMode();

        if (!this._data) {
            this._data = JSON.parse(
                fs.readFileSync(path.join(MOCK_DIR, "data.json"), "utf8")
            );
        }

        return this._data;
    }

    _allTransactions() {
        return this._loadMetadata().programs.flatMap(program =>
            program.transactions.map(transaction => ({ program, transaction }))
        );
    }

    _resolveTransactions(name) {
        const [programName, transactionName] = String(name || "").trim().split(".");

        return this._allTransactions().filter(({ program, transaction }) =>
            program.program.toUpperCase() === programName.toUpperCase() &&
            (!transactionName || transaction.transaction.toUpperCase() === transactionName.toUpperCase())
        );
    }

    _objectName({ program, transaction }) {
        return `${program.program}.${transaction.transaction}`;
    }

    _fields(transaction) {
        const keyFields = transaction.keyFields || transaction.inputs || [];

        return (transaction.outputs || []).map(output => {
            const isKey = keyFields.includes(output.field);

            return {
                name: output.field,
                dataType:
                    M3_TYPE_MAP[output.type] ||
                    (output.decimals ? "Decimal" : "Integer"),
                length: output.length || null,
                precision: output.type === "N" && output.decimals ? output.length : null,
                scale: output.decimals || null,
                nullable: !isKey,
                isKey,
                mandatory: isKey,
                label: output.description,
                description: output.description,
                sourceType: output.type
            };
        });
    }
}

// replaced by the tests (no network)
M3SourceAdapter.deps = { getDestination, executeHttpRequest };

module.exports = M3SourceAdapter;
