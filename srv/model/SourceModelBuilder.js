"use strict";

const crypto = require("crypto");

/**
 * ============================================================
 * SOURCE MODEL BUILDER
 * ============================================================
 *
 * Turns a technical entity graph (from SourceAdapter.getRelationships)
 * into BusinessObjectModel rows:
 *
 *   graph (entity types + navigation)  ->  Structure / Relationship / Field
 *
 * Starting at a root entity set, it follows navigation properties
 * breadth-first up to maxDepth. Each reachable entity set becomes one
 * Structure; each navigation becomes one Relationship with cardinality
 * and join keys.
 *
 * Pure function - no database access. Persistence is done by the caller.
 */

const DEFAULT_MAX_DEPTH = 3;

/**
 * Structural root detection - no name heuristics:
 * 1. entity sets whose type is not the target of any navigation
 * 2. among those, the one reaching the most other entity sets
 */
function detectRootEntitySet(graph) {
    const entitySets = Object.values(graph.entitySets);

    const targetedTypes = new Set();

    for (const entityType of Object.values(graph.entityTypes)) {
        for (const navigation of entityType.navigations) {
            if (navigation.targetType !== entityType.name) {
                targetedTypes.add(navigation.targetType);
            }
        }
    }

    const candidates = entitySets.filter(set => !targetedTypes.has(set.entityType));
    const pool = candidates.length > 0 ? candidates : entitySets;

    let best = null;
    let bestReach = -1;

    for (const entitySet of pool) {
        const reach = countReachable(graph, entitySet.entityType);

        if (reach > bestReach) {
            best = entitySet;
            bestReach = reach;
        }
    }

    return best ? best.name : null;
}

function countReachable(graph, startType) {
    const visited = new Set([startType]);
    const queue = [startType];

    while (queue.length > 0) {
        const type = graph.entityTypes[queue.shift()];

        for (const navigation of type?.navigations || []) {
            if (!visited.has(navigation.targetType)) {
                visited.add(navigation.targetType);
                queue.push(navigation.targetType);
            }
        }
    }

    return visited.size - 1;
}

/**
 * ============================================================
 * BUILD
 * ============================================================
 *
 * @param {Object} graph             Result of SourceAdapter.getRelationships()
 * @param {Object} options
 * @param {string} options.businessObjectType  e.g. BUSINESS_PARTNER
 * @param {string} options.systemId            Source system ID
 * @param {string} options.modelName
 * @param {string} options.version
 * @param {string} [options.rootEntitySet]     Override structural root detection
 * @param {number} [options.maxDepth]
 * @param {string} [options.sourceObjectId]    SourceObject.ID (discovery link)
 * @returns {{ model, structures, relationships, fields, stats }}
 */
function buildSourceModel(graph, options) {
    if (!graph || !graph.entitySets || !graph.entityTypes) {
        throw new Error("A valid entity graph is required");
    }

    const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth > 0
        ? options.maxDepth
        : DEFAULT_MAX_DEPTH;

    const rootEntitySetName = options.rootEntitySet || detectRootEntitySet(graph);
    const rootEntitySet = graph.entitySets[rootEntitySetName];

    if (!rootEntitySet) {
        throw new Error(
            `Root entity set '${rootEntitySetName}' was not found in the metadata of '${graph.objectName}'`
        );
    }

    const modelId = crypto.randomUUID();

    const model = {
        ID: modelId,
        type_code: options.businessObjectType,
        layer: "SOURCE",
        systemId: options.systemId,
        name: options.modelName,
        version: options.version,
        status: "DRAFT",
        origin: "IMPORTED",
        description:
            `Built from ${graph.protocol || "source"} metadata of '${graph.objectName}' ` +
            `(root '${rootEntitySetName}', depth ${maxDepth}).`
    };

    const structures = [];
    const relationships = [];
    const fields = [];
    const stats = {
        inferredJoins: 0,
        proposedJoins: 0,
        missingJoins: 0,
        skippedNavigations: 0
    };

    // Each entity set appears once, at the shallowest path it is reached by
    const structureByEntitySet = new Map();

    const addStructure = (entitySet, navigationPath, structurePath, depth) => {
        const entityType = graph.entityTypes[entitySet.entityType];
        const structureId = crypto.randomUUID();

        // Adapters may supply their own access path (e.g. M3 program/transaction);
        // otherwise the structure is reached by OData navigation from the root
        const accessPath = entitySet.accessPath
            ? {
                ...entitySet.accessPath,
                pathFromRoot: structurePath.length > 0 ? structurePath.join("/") : null
            }
            : {
                kind: "ODATA_NAV",
                service: graph.objectName,
                odataVersion: graph.odataVersion || null,
                rootEntitySet: rootEntitySetName,
                entitySet: entitySet.name,
                navigationPath: navigationPath.length > 0 ? navigationPath.join("/") : null
            };

        structures.push({
            ID: structureId,
            model_ID: modelId,
            name: entitySet.name,
            isRoot: depth === 0,
            sortOrder: structures.length + 1,
            description: entitySet.label || entityType?.label || null,
            sourceObject_ID: options.sourceObjectId || null,
            accessPath: JSON.stringify(accessPath)
        });

        (entityType?.properties || []).forEach((property, index) => {
            fields.push({
                ID: crypto.randomUUID(),
                structure_ID: structureId,
                name: property.name,
                sortOrder: index + 1,
                description: property.description || property.label || null,
                dataType: property.dataType,
                length: property.length,
                precision: property.precision,
                scale: property.scale,
                isKey: property.isKey,
                mandatory: property.isKey || property.mandatory
            });
        });

        structureByEntitySet.set(entitySet.name, structureId);

        return structureId;
    };

    addStructure(rootEntitySet, [], [], 0);

    const queue = [{ entitySet: rootEntitySet, path: [], structurePath: [], depth: 0 }];

    while (queue.length > 0) {
        const { entitySet, path, structurePath, depth } = queue.shift();

        if (depth >= maxDepth) {
            continue;
        }

        const entityType = graph.entityTypes[entitySet.entityType];
        const parentStructureId = structureByEntitySet.get(entitySet.name);

        if (!entityType) {
            continue;
        }

        for (const navigation of entityType?.navigations || []) {
            const targetSetName =
                entitySet.navigationBindings?.[navigation.name] ||
                navigation.targetEntitySet;

            const targetSet = targetSetName && graph.entitySets[targetSetName];

            // Contained / unbound targets and already modelled sets are skipped
            if (!targetSet || structureByEntitySet.has(targetSet.name)) {
                stats.skippedNavigations++;
                continue;
            }

            const childPath = [...path, navigation.name];
            const childStructurePath = [...structurePath, targetSet.name];
            const childStructureId = addStructure(targetSet, childPath, childStructurePath, depth + 1);

            if (navigation.joinKeySource === "INFERRED_BY_NAME") {
                stats.inferredJoins++;
            } else if (navigation.joinKeySource === "PROPOSED_BY_KEY_OVERLAP") {
                stats.proposedJoins++;
            } else if (navigation.joinKeySource === "NONE") {
                stats.missingJoins++;
            }

            relationships.push({
                ID: crypto.randomUUID(),
                model_ID: modelId,
                parent_ID: parentStructureId,
                child_ID: childStructureId,
                cardinality: navigation.cardinality,
                kind: navigation.kind || "NAVIGATION",
                joinKeys: JSON.stringify({
                    source: navigation.joinKeySource,
                    navigation: navigation.kind === "KEY_JOIN" ? null : navigation.name,
                    keys: navigation.joinKeys,
                    reason: navigation.reason || null
                })
            });

            queue.push({
                entitySet: targetSet,
                path: childPath,
                structurePath: childStructurePath,
                depth: depth + 1
            });
        }
    }

    return {
        model,
        structures,
        relationships,
        fields,
        stats: {
            ...stats,
            rootEntitySet: rootEntitySetName,
            structureCount: structures.length,
            relationshipCount: relationships.length,
            fieldCount: fields.length
        }
    };
}

module.exports = {
    buildSourceModel,
    detectRootEntitySet
};
