"use strict";

/**
 * ============================================================
 * MODEL VIEW
 * ============================================================
 *
 * In-memory tree of one BusinessObjectModel, built from its
 * Structure / Relationship / Field rows. Shared by the mapping
 * suggester and the transformation engine.
 */

/**
 * Relationship.joinKeys is stored as
 *   { source, navigation, keys: [{ parent, child }], reason }   (source models)
 *   [{ parent, child }]                                         (imported)
 *   null                                                        (embedded / canonical)
 */
function parseJoinKeys(value) {
    if (!value) {
        return [];
    }

    const parsed = typeof value === "string" ? JSON.parse(value) : value;

    if (Array.isArray(parsed)) {
        return parsed;
    }

    return Array.isArray(parsed?.keys) ? parsed.keys : [];
}

function isSingle(structure) {
    return structure.isRoot || structure.cardinality === "1" || structure.cardinality === "0..1";
}

/**
 * @param {{ model?, structures, relationships, fields }} rows
 */
function buildModelView({ model = null, structures, relationships, fields }) {
    const byId = new Map(
        structures.map(structure => [structure.ID, {
            ID: structure.ID,
            name: structure.name,
            isRoot: structure.isRoot === true,
            sortOrder: structure.sortOrder || 0,
            parentId: null,
            cardinality: structure.isRoot ? "1" : null,
            joinKeys: [],
            depth: 0,
            fields: []
        }])
    );

    for (const relationship of relationships) {
        const child = byId.get(relationship.child_ID);

        if (child) {
            child.parentId = relationship.parent_ID;
            child.cardinality = relationship.cardinality;
            child.joinKeys = parseJoinKeys(relationship.joinKeys);
        }
    }

    for (const field of fields) {
        byId.get(field.structure_ID)?.fields.push({
            ID: field.ID,
            name: field.name,
            sortOrder: field.sortOrder || 0,
            description: field.description || null,
            dataType: field.dataType || null,
            length: field.length ?? null,
            isKey: field.isKey === true,
            mandatory: field.mandatory === true,
            tag: field.semanticTag_code || null,
            tagConfidence: field.tagConfidence === null || field.tagConfidence === undefined
                ? null
                : Number(field.tagConfidence)
        });
    }

    const all = [...byId.values()];

    for (const structure of all) {
        structure.fields.sort((left, right) => left.sortOrder - right.sortOrder);

        let depth = 0;
        let cursor = structure;

        while (cursor.parentId && byId.has(cursor.parentId) && depth < 20) {
            depth++;
            cursor = byId.get(cursor.parentId);
        }

        structure.depth = depth;
        structure.single = isSingle(structure);
    }

    const root = all.find(structure => structure.isRoot) || all.find(structure => !structure.parentId);

    all.sort((left, right) => left.depth - right.depth || left.sortOrder - right.sortOrder);

    return {
        model,
        root,
        structures: all,
        byId,
        byName: new Map(all.map(structure => [structure.name, structure])),
        parentOf: (structure) => (structure.parentId ? byId.get(structure.parentId) : null)
    };
}

module.exports = {
    buildModelView,
    parseJoinKeys,
    isSingle
};
