"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { parseEdmx } = require("../srv/adapters/odata/EdmxGraphParser");
const { buildSourceModel, detectRootEntitySet } = require("../srv/model/SourceModelBuilder");

const BP_FIXTURE = fs.readFileSync(
    path.join(__dirname, "..", "srv", "mock", "metadata", "API_BUSINESS_PARTNER.xml"),
    "utf8"
);

const V4_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="demo" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="OrderType">
        <Key><PropertyRef Name="OrderID"/></Key>
        <Property Name="OrderID" Type="Edm.String" Nullable="false" MaxLength="10">
          <Annotation Term="Common.Label" String="Order"/>
        </Property>
        <NavigationProperty Name="_Items" Type="Collection(demo.ItemType)">
          <ReferentialConstraint Property="OrderID" ReferencedProperty="ParentOrder"/>
        </NavigationProperty>
      </EntityType>
      <EntityType Name="ItemType">
        <Key><PropertyRef Name="ParentOrder"/><PropertyRef Name="ItemNo"/></Key>
        <Property Name="ParentOrder" Type="Edm.String" Nullable="false"/>
        <Property Name="ItemNo" Type="Edm.String" Nullable="false"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Orders" EntityType="demo.OrderType">
          <NavigationPropertyBinding Path="_Items" Target="OrderItems"/>
        </EntitySet>
        <EntitySet Name="OrderItems" EntityType="demo.ItemType"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

function graphFrom(xml, objectName) {
    return { objectName, protocol: "OData", ...parseEdmx(xml) };
}

describe("EdmxGraphParser - OData V2 (API_BUSINESS_PARTNER fixture)", () => {

    const graph = parseEdmx(BP_FIXTURE);

    it("reads entity types with keys and labels", () => {
        assert.equal(graph.odataVersion, "V2");
        assert.equal(Object.keys(graph.entityTypes).length, 10);

        const address = graph.entityTypes.A_BusinessPartnerAddressType;

        assert.deepEqual(address.keys, ["BusinessPartner", "AddressID"]);
        assert.equal(
            address.properties.find(p => p.name === "CityName").label,
            "City"
        );
    });

    it("resolves navigation cardinality from association multiplicity", () => {
        const bp = graph.entityTypes.A_BusinessPartnerType;
        const byName = Object.fromEntries(bp.navigations.map(n => [n.name, n]));

        assert.equal(byName.to_BusinessPartnerAddress.cardinality, "0..N");
        assert.equal(byName.to_Customer.cardinality, "0..1");
        assert.equal(byName.to_Customer.targetEntitySet, "A_Customer");
    });

    it("infers join keys by name when there is no ReferentialConstraint", () => {
        const bp = graph.entityTypes.A_BusinessPartnerType;
        const toAddress = bp.navigations.find(n => n.name === "to_BusinessPartnerAddress");
        const toCustomer = bp.navigations.find(n => n.name === "to_Customer");

        assert.equal(toAddress.joinKeySource, "INFERRED_BY_NAME");
        assert.deepEqual(toAddress.joinKeys, [{ parent: "BusinessPartner", child: "BusinessPartner" }]);

        // BP key does not exist on A_Customer; child key 'Customer' exists on BP
        assert.deepEqual(toCustomer.joinKeys, [{ parent: "Customer", child: "Customer" }]);

        const toEmail = graph.entityTypes.A_BusinessPartnerAddressType.navigations
            .find(n => n.name === "to_EmailAddress");

        assert.deepEqual(toEmail.joinKeys, [{ parent: "AddressID", child: "AddressID" }]);
    });
});

describe("EdmxGraphParser - OData V4", () => {

    it("reads collection navigation, referential constraints and bindings", () => {
        const graph = parseEdmx(V4_SAMPLE);
        const items = graph.entityTypes.OrderType.navigations[0];

        assert.equal(graph.odataVersion, "V4");
        assert.equal(items.cardinality, "0..N");
        assert.equal(items.joinKeySource, "METADATA");
        assert.deepEqual(items.joinKeys, [{ parent: "OrderID", child: "ParentOrder" }]);
        assert.equal(graph.entitySets.Orders.navigationBindings._Items, "OrderItems");
        assert.equal(graph.entityTypes.OrderType.properties[0].label, "Order");
    });
});

describe("SourceModelBuilder", () => {

    const options = {
        businessObjectType: "BUSINESS_PARTNER",
        systemId: "S4_TEST",
        modelName: "S4 Business Partner",
        version: "1"
    };

    it("detects the root structurally (no name heuristics)", () => {
        assert.equal(detectRootEntitySet(graphFrom(BP_FIXTURE, "API_BUSINESS_PARTNER")), "A_BusinessPartner");
        assert.equal(detectRootEntitySet(graphFrom(V4_SAMPLE, "demo")), "Orders");
    });

    it("builds the full Business Partner tree", () => {
        const built = buildSourceModel(graphFrom(BP_FIXTURE, "API_BUSINESS_PARTNER"), options);

        assert.equal(built.model.layer, "SOURCE");
        assert.equal(built.stats.rootEntitySet, "A_BusinessPartner");
        assert.equal(built.structures.length, 10);
        assert.equal(built.relationships.length, 9);
        assert.equal(built.stats.missingJoins, 0);

        const structureName = new Map(built.structures.map(s => [s.ID, s.name]));
        const edges = built.relationships.map(
            r => `${structureName.get(r.parent_ID)} > ${structureName.get(r.child_ID)} (${r.cardinality})`
        );

        assert.ok(edges.includes("A_BusinessPartner > A_Customer (0..1)"));
        assert.ok(edges.includes("A_Customer > A_CustomerSalesArea (0..N)"));
        assert.ok(edges.includes("A_BusinessPartnerAddress > A_AddressEmailAddress (0..N)"));

        const salesArea = built.structures.find(s => s.name === "A_CustomerSalesArea");

        assert.equal(JSON.parse(salesArea.accessPath).navigationPath, "to_Customer/to_CustomerSalesArea");
    });

    it("respects maxDepth", () => {
        const built = buildSourceModel(
            graphFrom(BP_FIXTURE, "API_BUSINESS_PARTNER"),
            { ...options, maxDepth: 1 }
        );

        // root + 5 direct children, no grandchildren
        assert.equal(built.structures.length, 6);
    });

    it("rejects an unknown root entity", () => {
        assert.throws(
            () => buildSourceModel(
                graphFrom(BP_FIXTURE, "API_BUSINESS_PARTNER"),
                { ...options, rootEntitySet: "DoesNotExist" }
            ),
            /was not found/
        );
    });
});
