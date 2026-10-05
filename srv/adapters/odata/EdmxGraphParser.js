"use strict";

const { XMLParser } = require("fast-xml-parser");

/**
 * ============================================================
 * EDMX GRAPH PARSER (OData V2 + V4)
 * ============================================================
 *
 * Parses an OData $metadata document into a technical entity graph:
 *
 *   entityTypes : name -> { keys, properties, navigations }
 *   entitySets  : name -> { entityType, navigationBindings }
 *
 * Navigation properties are resolved into:
 *   { name, targetType, targetEntitySet, cardinality, joinKeys, joinKeySource }
 *
 * joinKeySource:
 *   METADATA          - taken from a ReferentialConstraint
 *   INFERRED_BY_NAME  - no constraint in metadata; keys matched by property name
 *   NONE              - no join keys could be determined
 *
 * The parser only reports technical facts. It does not decide which
 * business object an entity belongs to.
 */

const ARRAY_TAGS = new Set([
    "Schema",
    "EntityType",
    "ComplexType",
    "Property",
    "NavigationProperty",
    "PropertyRef",
    "Association",
    "End",
    "AssociationSet",
    "EntitySet",
    "EntityContainer",
    "ReferentialConstraint",
    "NavigationPropertyBinding",
    "Annotation"
]);

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
    parseAttributeValue: false,
    // Only elements - V4 ReferentialConstraint has an attribute named "Property"
    isArray: (tagName, jPath, isLeafNode, isAttribute) =>
        !isAttribute && ARRAY_TAGS.has(tagName)
});

/**
 * "API_BUSINESS_PARTNER.A_BusinessPartnerType" -> "A_BusinessPartnerType"
 * "Collection(ns.A_AddressType)"               -> "A_AddressType"
 */
function localName(qualifiedName) {
    if (!qualifiedName) {
        return null;
    }

    const unwrapped = String(qualifiedName)
        .replace(/^Collection\((.*)\)$/, "$1");

    const parts = unwrapped.split(".");

    return parts[parts.length - 1];
}

function toInteger(value) {
    if (value === undefined || value === null || value === "" || value === "max") {
        return null;
    }

    const number = Number.parseInt(value, 10);

    return Number.isFinite(number) ? number : null;
}

function v2MultiplicityToCardinality(multiplicity) {
    switch (String(multiplicity || "").trim()) {
        case "*":
            return "0..N";
        case "1":
            return "1";
        case "0..1":
            return "0..1";
        default:
            return "0..N";
    }
}

function inlineLabel(node) {
    const annotations = node.Annotation || [];

    const label = annotations.find(
        (annotation) => /(^|\.)Label$/.test(annotation.Term || "")
    );

    return label ? label.String || null : null;
}

function parseProperty(property, keys) {
    return {
        name: property.Name,
        dataType: property.Type || null,
        length: toInteger(property.MaxLength),
        precision: toInteger(property.Precision),
        scale: toInteger(property.Scale),
        nullable: property.Nullable !== "false",
        isKey: keys.includes(property.Name),
        mandatory: property.Nullable === "false",
        label:
            property.label ||              // V2 sap:label
            inlineLabel(property) ||       // V4 inline Common.Label
            null,
        description:
            property.quickinfo ||          // V2 sap:quickinfo
            property.label ||
            inlineLabel(property) ||
            null
    };
}

/**
 * Infer join keys when the metadata has no ReferentialConstraint.
 *
 * 1. Parent keys that also exist as properties of the child
 *    (A_BusinessPartner.BusinessPartner -> A_BusinessPartnerAddress.BusinessPartner)
 * 2. Otherwise child keys that also exist as properties of the parent
 *    (A_BusinessPartner.Customer -> A_Customer.Customer)
 */
function inferJoinKeys(parentType, childType) {
    const childNames = new Set(childType.properties.map(p => p.name));
    const parentNames = new Set(parentType.properties.map(p => p.name));

    const fromParentKeys = parentType.keys
        .filter(key => childNames.has(key))
        .map(key => ({ parent: key, child: key }));

    if (fromParentKeys.length > 0) {
        return fromParentKeys;
    }

    return childType.keys
        .filter(key => parentNames.has(key))
        .map(key => ({ parent: key, child: key }));
}

/**
 * ============================================================
 * PARSE
 * ============================================================
 */
function parseEdmx(xml) {
    if (!xml || typeof xml !== "string") {
        throw new Error("EDMX document is empty or not text");
    }

    const document = xmlParser.parse(xml);
    const dataServices = document?.Edmx?.DataServices;

    if (!dataServices) {
        throw new Error("Document is not a valid EDMX $metadata document");
    }

    const schemas = dataServices.Schema || [];
    const odataVersion = String(document.Edmx.Version || "").startsWith("4") ? "V4" : "V2";

    const entityTypes = new Map();
    const associations = new Map();
    const entitySets = new Map();

    /*
     * ---------- Entity types and associations ----------
     */
    for (const schema of schemas) {
        for (const entityType of schema.EntityType || []) {
            const keys = (entityType.Key?.PropertyRef || []).map(ref => ref.Name);

            entityTypes.set(entityType.Name, {
                name: entityType.Name,
                label: entityType.label || inlineLabel(entityType) || null,
                keys,
                properties: (entityType.Property || []).map(p => parseProperty(p, keys)),
                rawNavigations: entityType.NavigationProperty || []
            });
        }

        for (const association of schema.Association || []) {
            associations.set(association.Name, association);
        }
    }

    /*
     * ---------- Entity sets ----------
     */
    for (const schema of schemas) {
        for (const container of schema.EntityContainer || []) {
            for (const entitySet of container.EntitySet || []) {
                entitySets.set(entitySet.Name, {
                    name: entitySet.Name,
                    entityType: localName(entitySet.EntityType),
                    label: entitySet.label || null,
                    navigationBindings: new Map(
                        (entitySet.NavigationPropertyBinding || []).map(
                            binding => [binding.Path, localName(binding.Target)]
                        )
                    )
                });
            }
        }
    }

    const entitySetByType = new Map();

    for (const entitySet of entitySets.values()) {
        if (!entitySetByType.has(entitySet.entityType)) {
            entitySetByType.set(entitySet.entityType, entitySet.name);
        }
    }

    /*
     * ---------- Resolve navigation properties ----------
     */
    for (const entityType of entityTypes.values()) {
        entityType.navigations = entityType.rawNavigations
            .map(navigation => resolveNavigation(navigation, entityType))
            .filter(Boolean);

        delete entityType.rawNavigations;
    }

    function resolveNavigation(navigation, sourceType) {
        let targetTypeName = null;
        let cardinality = "0..N";
        let joinKeys = [];

        if (navigation.Relationship) {
            // ---------- OData V2 ----------
            const association = associations.get(localName(navigation.Relationship));

            if (!association) {
                return null;
            }

            const ends = association.End || [];
            const toEnd = ends.find(end => end.Role === navigation.ToRole);

            if (!toEnd) {
                return null;
            }

            targetTypeName = localName(toEnd.Type);
            cardinality = v2MultiplicityToCardinality(toEnd.Multiplicity);

            const constraint = (association.ReferentialConstraint || [])[0];

            if (constraint?.Principal && constraint?.Dependent) {
                const principalRefs = (constraint.Principal.PropertyRef || []).map(r => r.Name);
                const dependentRefs = (constraint.Dependent.PropertyRef || []).map(r => r.Name);

                const sourceIsPrincipal = constraint.Principal.Role === navigation.FromRole;
                const parentRefs = sourceIsPrincipal ? principalRefs : dependentRefs;
                const childRefs = sourceIsPrincipal ? dependentRefs : principalRefs;

                joinKeys = parentRefs.map((parent, index) => ({
                    parent,
                    child: childRefs[index]
                }));
            }
        } else if (navigation.Type) {
            // ---------- OData V4 ----------
            targetTypeName = localName(navigation.Type);

            const isCollection = /^Collection\(/.test(navigation.Type);

            cardinality = isCollection
                ? "0..N"
                : (navigation.Nullable === "false" ? "1" : "0..1");

            // V4: Property is on the declaring (source) type,
            //     ReferencedProperty on the target type
            joinKeys = (navigation.ReferentialConstraint || []).map(constraint => ({
                parent: constraint.Property,
                child: constraint.ReferencedProperty
            }));
        }

        const targetType = entityTypes.get(targetTypeName);

        if (!targetType) {
            return null;
        }

        let joinKeySource = joinKeys.length > 0 ? "METADATA" : "NONE";

        if (joinKeys.length === 0) {
            joinKeys = inferJoinKeys(sourceType, targetType);

            if (joinKeys.length > 0) {
                joinKeySource = "INFERRED_BY_NAME";
            }
        }

        return {
            name: navigation.Name,
            targetType: targetTypeName,
            targetEntitySet: entitySetByType.get(targetTypeName) || null,
            cardinality,
            joinKeys,
            joinKeySource
        };
    }

    return {
        odataVersion,
        entityTypes: Object.fromEntries(entityTypes),
        entitySets: Object.fromEntries(
            [...entitySets.values()].map(entitySet => [
                entitySet.name,
                {
                    name: entitySet.name,
                    entityType: entitySet.entityType,
                    label: entitySet.label,
                    navigationBindings: Object.fromEntries(entitySet.navigationBindings)
                }
            ])
        )
    };
}

module.exports = {
    parseEdmx,
    localName
};
