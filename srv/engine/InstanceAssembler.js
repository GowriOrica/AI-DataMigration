"use strict";

const { clean } = require("./FieldRules");

/**
 * ============================================================
 * INSTANCE ASSEMBLER
 * ============================================================
 *
 * Reads every structure of a source model through its adapter and
 * assembles one instance per business key:
 *
 *   root records (grouped by groupBy, e.g. CUNO)  +  child records
 *   linked by the relationship join keys (e.g. CONO + CUNO)
 *
 * Scope of this version: root + direct children (depth 1), sources
 * whose structures can be extracted by name (e.g. M3 MI transactions).
 */

const PAGE_SIZE = 500;

/**
 * Reads all pages of one structure.
 * fetchPage(structureName, { pageSize, pageToken }) -> { records, nextPageToken }
 */
async function readAll(fetchPage, structureName, maxRecords = Infinity) {
    const records = [];
    let pageToken = null;

    do {
        const page = await fetchPage(structureName, { pageSize: PAGE_SIZE, pageToken });

        records.push(...(page.records || []));
        pageToken = page.nextPageToken || null;
    } while (pageToken && records.length < maxRecords);

    return records;
}

function keyOf(record, fields) {
    return fields.map(field => clean(record[field]) ?? "").join("|");
}

/**
 * @param {Object}   args
 * @param {Object}   args.view        ModelView of the source model
 * @param {Function} args.fetchPage   adapter paging function
 * @param {string[]} [args.groupBy]   root fields forming the business key (default: root key fields)
 * @param {number}   [args.limit]     max number of instances
 * @returns {Promise<Object[]>} instances
 */
async function assembleInstances({ view, fetchPage, groupBy, limit = Infinity }) {
    const root = view.root;
    const keyFields = groupBy && groupBy.length > 0
        ? groupBy
        : root.fields.filter(field => field.isKey).map(field => field.name);

    const rootRecords = await readAll(fetchPage, root.name);

    const groups = new Map();

    for (const record of rootRecords) {
        const key = keyOf(record, keyFields);

        if (!groups.has(key)) {
            if (groups.size >= limit) {
                continue;
            }

            groups.set(key, []);
        }

        groups.get(key).push(record);
    }

    const children = view.structures.filter(structure => structure.depth === 1);
    const childRecords = new Map();

    for (const child of children) {
        childRecords.set(child.name, await readAll(fetchPage, child.name));
    }

    return [...groups.entries()].map(([key, records]) => ({
        key,
        rootStructure: root.name,
        rootRecords: records,
        children: Object.fromEntries(
            children.map(child => [
                child.name,
                childRecords.get(child.name).filter(candidate =>
                    records.some(parent =>
                        child.joinKeys.length > 0 &&
                        child.joinKeys.every(join => (clean(candidate[join.child]) ?? "") === (clean(parent[join.parent]) ?? ""))
                    )
                )
            ])
        )
    }));
}

module.exports = {
    assembleInstances,
    readAll
};
