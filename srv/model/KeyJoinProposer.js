"use strict";

/**
 * ============================================================
 * KEY JOIN PROPOSER
 * ============================================================
 *
 * For sources that do not declare relationships (e.g. M3 MI
 * transactions), proposes parent -> child links from key overlap.
 * Deterministic and explainable; stands in for AI model assembly
 * until increment 4, and every proposal needs human confirmation.
 *
 * Rules (P = candidate parent, C = candidate child):
 *   1. keys(C) == keys(P)            -> 1:1 extension, cardinality 0..1
 *                                        parent = entity with more properties
 *   2. keys(C) strictly contains
 *      keys(P)                       -> child collection, cardinality 0..N
 *                                        parent = candidate with the most
 *                                        matching keys that is not itself
 *                                        an extension (rule 1 child)
 *   3. anything else                 -> no proposal (reference / unrelated)
 *
 * Proposed navigations carry:
 *   kind          = KEY_JOIN
 *   joinKeySource = PROPOSED_BY_KEY_OVERLAP
 */

function sameKeys(left, right) {
    return left.length === right.length && left.every(key => right.includes(key));
}

function containsAll(superset, subset) {
    return subset.every(key => superset.includes(key));
}

function makeNavigation(parent, child, cardinality) {
    return {
        name: `key_${child.name}`,
        targetType: child.name,
        targetEntitySet: child.name,
        cardinality,
        kind: "KEY_JOIN",
        joinKeys: parent.keys.map(key => ({ parent: key, child: key })),
        joinKeySource: "PROPOSED_BY_KEY_OVERLAP",
        reason:
            cardinality === "0..1"
                ? `'${child.name}' has the same key (${parent.keys.join(", ")}) as '${parent.name}' - treated as a 1:1 extension`
                : `'${child.name}' key (${child.keys.join(", ")}) contains the key of '${parent.name}' (${parent.keys.join(", ")}) - treated as a child collection`
    };
}

/**
 * @param {Object} graph  entity graph with empty navigations
 * @returns {{ graph: Object, proposals: Object[] }}
 *          a copy of the graph with proposed navigations added
 */
function proposeKeyJoins(graph) {
    const entities = Object.values(graph.entityTypes)
        .filter(entity => entity.keys && entity.keys.length > 0);

    const order = new Map(entities.map((entity, index) => [entity.name, index]));
    const navigations = new Map(entities.map(entity => [entity.name, []]));
    const proposals = [];
    const extensionChildren = new Set();
    const assignedChildren = new Set();

    const richer = (left, right) =>
        left.properties.length !== right.properties.length
            ? left.properties.length > right.properties.length
            : order.get(left.name) < order.get(right.name);

    /*
     * ---------- Rule 1: same keys -> 1:1 extension ----------
     */
    for (const child of entities) {
        const peers = entities.filter(
            other => other !== child && sameKeys(other.keys, child.keys)
        );

        if (peers.length === 0) {
            continue;
        }

        // The richest entity of the group is the parent of all others
        const group = [child, ...peers];
        const parent = group.reduce((best, entity) => (richer(entity, best) ? entity : best));

        if (parent === child) {
            continue;
        }

        const navigation = makeNavigation(parent, child, "0..1");

        navigations.get(parent.name).push(navigation);
        proposals.push({ parent: parent.name, child: child.name, ...navigation });
        extensionChildren.add(child.name);
        assignedChildren.add(child.name);
    }

    /*
     * ---------- Rule 2: key superset -> child collection ----------
     */
    for (const child of entities) {
        if (assignedChildren.has(child.name)) {
            continue;
        }

        const candidates = entities.filter(parent =>
            parent !== child &&
            !extensionChildren.has(parent.name) &&
            parent.keys.length < child.keys.length &&
            containsAll(child.keys, parent.keys)
        );

        if (candidates.length === 0) {
            continue;
        }

        const parent = candidates.reduce((best, entity) => {
            if (entity.keys.length !== best.keys.length) {
                return entity.keys.length > best.keys.length ? entity : best;
            }

            return richer(entity, best) ? entity : best;
        });

        const navigation = makeNavigation(parent, child, "0..N");

        navigations.get(parent.name).push(navigation);
        proposals.push({ parent: parent.name, child: child.name, ...navigation });
        assignedChildren.add(child.name);
    }

    const entityTypes = Object.fromEntries(
        Object.entries(graph.entityTypes).map(([name, entity]) => [
            name,
            {
                ...entity,
                navigations: [...(entity.navigations || []), ...(navigations.get(name) || [])]
            }
        ])
    );

    return {
        graph: { ...graph, entityTypes },
        proposals
    };
}

module.exports = {
    proposeKeyJoins
};
