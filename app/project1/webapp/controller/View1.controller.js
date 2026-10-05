sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/Text",
    "sap/m/Label",
    "sap/m/ObjectStatus",
    "sap/m/VBox"
], function (
    Controller,
    JSONModel,
    MessageBox,
    MessageToast,
    Dialog,
    Button,
    Text,
    Label,
    ObjectStatus,
    VBox
) {
    "use strict";

    return Controller.extend("project1.controller.View1", {

        onInit: function () {
            var oViewModel = new JSONModel({
                busy: false,

                sourceSystems: [],
                sourceConnections: [],
                sourceObjects: [],

                targetSystems: [],
                migrationRuns: [],

                selectedSourceSystemUUID: "",
                selectedSourceSystem: "",
                selectedSourceConnection: "",

                connection: {
                    statusText: "Select a connection",
                    state: "None",
                    details: "",
                    message: "",
                    messageType: "Information",
                    busy: false
                },

                selectedTargetSystemUUID: "",
                selectedTargetSystem: "",
                selectedBusinessObject: "",

                sourceCount: 0,
                targetCount: 0,
                runCount: 0,

                selectedRun: null
            });

            this.getView().setModel(oViewModel, "view");
            this._loadDashboardData();
        },

        onNavigateAssessment: function () {

    var oContext =
        this
            .getOwnerComponent()
            .getModel("migrationContext");

    var oData =
        oContext
            ? oContext.getData()
            : null;

    console.log(
        "[Business Object Assessment] Migration Context:",
        oData
    );

    if (
        !oData ||
        !oData.sourceSystemId
    ) {

        MessageToast.show(
            "Complete Source Discovery first."
        );

        return;
    }

    this
        .getOwnerComponent()
        .getRouter()
        .navTo(
            "BusinessObjectAssessment"
        );
},

        _loadDashboardData: async function () {
            try {
                this.getView().getModel("view").setProperty("/busy", true);

                await Promise.all([
                    this._loadSourceSystems(),
                    this._loadTargetSystems(),
                    this._loadMigrationRuns()
                ]);

            } catch (oError) {
                console.error("Dashboard loading failed:", oError);
                MessageBox.error("Unable to load Migration Framework data.");
            } finally {
                this.getView().getModel("view").setProperty("/busy", false);
            }
        },

        _loadSourceSystems: async function () {
            var oModel = this.getOwnerComponent().getModel();
            if (!oModel) {
                throw new Error("Migration OData model is not available.");
            }

            var oBinding = oModel.bindList("/SourceSystems");
            var aContexts = await oBinding.requestContexts(0, 100);
            var aSourceSystems = aContexts.map(function (ctx) {
                return ctx.getObject();
            });

            // De-duplicate systems by systemId
            var mUniqueSystems = new Map();
            aSourceSystems.forEach(function (sys) {
                if (!mUniqueSystems.has(sys.systemId)) {
                    mUniqueSystems.set(sys.systemId, sys);
                }
            });

            var aDistinctSystems = Array.from(mUniqueSystems.values());

            var aList = [
                { ID: "", systemId: "", systemName: "-- Select Source System --" }
            ].concat(aDistinctSystems);

            var oViewModel = this.getView().getModel("view");
            oViewModel.setProperty("/sourceSystems", aList);
            oViewModel.setProperty("/sourceCount", aDistinctSystems.length);
            oViewModel.setProperty("/selectedSourceSystemUUID", "");
            oViewModel.setProperty("/selectedSourceSystem", "");
        },

        _loadTargetSystems: async function () {
            var oModel = this.getOwnerComponent().getModel();
            if (!oModel) {
                throw new Error("Migration OData model is not available.");
            }

            var oBinding = oModel.bindList("/TargetSystems");
            var aContexts = await oBinding.requestContexts(0, 100);
            var aTargetSystems = aContexts.map(function (ctx) {
                return ctx.getObject();
            });

            var mUniqueTargets = new Map();
            aTargetSystems.forEach(function (tgt) {
                if (!mUniqueTargets.has(tgt.systemId)) {
                    mUniqueTargets.set(tgt.systemId, tgt);
                }
            });

            var aDistinctTargets = Array.from(mUniqueTargets.values());

            var aList = [
                { ID: "", systemId: "", systemName: "-- Select Target System --" }
            ].concat(aDistinctTargets);

            var oViewModel = this.getView().getModel("view");
            oViewModel.setProperty("/targetSystems", aList);
            oViewModel.setProperty("/targetCount", aDistinctTargets.length);
            oViewModel.setProperty("/selectedTargetSystemUUID", "");
            oViewModel.setProperty("/selectedTargetSystem", "");
        },

        _loadMigrationRuns: async function () {
            var oModel = this.getOwnerComponent().getModel();
            if (!oModel) {
                throw new Error("Migration OData model is not available.");
            }

            var oBinding = oModel.bindList("/MigrationRuns");
            var aContexts = await oBinding.requestContexts(0, 50);
            var aMigrationRuns = aContexts.map(function (ctx) {
                return ctx.getObject();
            });

            var oViewModel = this.getView().getModel("view");
            oViewModel.setProperty("/migrationRuns", aMigrationRuns);
            oViewModel.setProperty("/runCount", aMigrationRuns.length);
        },

        onSourceSystemChange: async function (oEvent) {
            var sSourceSystemUUID = oEvent.getSource().getSelectedKey();
            var oViewModel = this.getView().getModel("view");

            oViewModel.setProperty("/selectedSourceSystemUUID", sSourceSystemUUID);
            oViewModel.setProperty("/selectedSourceSystem", "");
            oViewModel.setProperty("/selectedSourceConnection", "");
            oViewModel.setProperty("/selectedBusinessObject", "");
            oViewModel.setProperty("/sourceConnections", []);
            oViewModel.setProperty("/sourceObjects", []);

            if (!sSourceSystemUUID) {
                return;
            }

            try {
                var oModel = this.getOwnerComponent().getModel();
                var aSourceSystems = oViewModel.getProperty("/sourceSystems") || [];

                var oSelectedSourceSystem = aSourceSystems.find(function (sys) {
                    return sys.ID === sSourceSystemUUID;
                });

                if (!oSelectedSourceSystem) {
                    MessageBox.error("Selected Source System could not be resolved.");
                    return;
                }

                var sSelectedSystemId = oSelectedSourceSystem.systemId;
                oViewModel.setProperty("/selectedSourceSystem", sSelectedSystemId);

                // 1. Fetch connections matching UUID or systemId
                var oConnectionBinding = oModel.bindList("/SourceConnections");
                var aConnContexts = await oConnectionBinding.requestContexts(0, 100);
                var aAllConnections = aConnContexts.map(function (ctx) {
                    return ctx.getObject();
                });

                var aConnections = aAllConnections.filter(function (conn) {
                    return conn.sourceSystem_ID === sSourceSystemUUID ||
                           conn.sourceSystem === sSelectedSystemId ||
                           (conn.connectionId && conn.connectionId.includes("S4"));
                });

                var aConnList = [
                    { connectionId: "", connectionName: "-- Select Connection --" }
                ].concat(aConnections);

                oViewModel.setProperty("/sourceConnections", aConnList);
                if (aConnections.length > 0) {
                    oViewModel.setProperty("/selectedSourceConnection", aConnections[0].connectionId);
                }
                this._showConnectionStatus();

                // 2. Fetch objects matching UUID or starting with systemId and clean suffix _0001
                var oObjectBinding = oModel.bindList("/SourceObjects");
                var aObjContexts = await oObjectBinding.requestContexts(0, 300);
                var aAllObjects = aObjContexts.map(function (ctx) {
                    return ctx.getObject();
                });

                var aObjects = aAllObjects.filter(function (obj) {
                    return obj.sourceSystem_ID === sSourceSystemUUID ||
                           (obj.objectId && obj.objectId.startsWith(sSelectedSystemId));
                }).map(function (obj) {
                    var sClean = String(obj.objectName || "").replace(/_0001$/, "");
                    return {
                        ...obj,
                        cleanObjectName: sClean,
                        displayName: sClean
                    };
                });

                var mUniqueObjs = new Map();
                aObjects.forEach(function (o) {
                    if (!mUniqueObjs.has(o.cleanObjectName)) {
                        mUniqueObjs.set(o.cleanObjectName, o);
                    }
                });

                var aDistinctObjects = Array.from(mUniqueObjs.values());

                var aObjList = [
                    { cleanObjectName: "", displayName: "-- Select Business Object --" }
                ].concat(aDistinctObjects);

                oViewModel.setProperty("/sourceObjects", aObjList);
                if (aDistinctObjects.length > 0) {
                    var oDefaultObj = aDistinctObjects.find(function (o) {
                        return o.cleanObjectName === "API_BUSINESS_PARTNER";
                    });
                    oViewModel.setProperty("/selectedBusinessObject", oDefaultObj ? oDefaultObj.cleanObjectName : aDistinctObjects[0].cleanObjectName);
                }

            } catch (oError) {
                console.error("Failed to load source details:", oError);
                MessageBox.error("Unable to load source connection details.");
            }
        },

        onSourceConnectionChange: function (oEvent) {
            this.getView()
                .getModel("view")
                .setProperty("/selectedSourceConnection", oEvent.getSource().getSelectedKey());

            this._showConnectionStatus();
        },

        // =========================================================
        // STEP 1: SOURCE CONNECTION - status and test
        // =========================================================

        /**
         * Shows the stored status of the selected connection (what the last
         * test found), or the result of a test that was just run.
         */
        _showConnectionStatus: function (oTestResult) {
            var oViewModel = this.getView().getModel("view");
            var sConnectionId = oViewModel.getProperty("/selectedSourceConnection");
            var aConnections = oViewModel.getProperty("/sourceConnections") || [];
            var oConnection = aConnections.find(function (c) {
                return c.connectionId === sConnectionId;
            });

            if (!oConnection || !sConnectionId) {
                oViewModel.setProperty("/connection/statusText", "Select a connection");
                oViewModel.setProperty("/connection/state", "None");
                oViewModel.setProperty("/connection/details", "");
                oViewModel.setProperty("/connection/message", "");
                return;
            }

            var sStatus = (oTestResult && oTestResult.status) || oConnection.status || "UNKNOWN";
            var bConnected = sStatus === "CONNECTED";
            var bFailed = sStatus === "FAILED";
            var sTestedAt = (oTestResult && oTestResult.testedAt) || oConnection.lastTestedAt;

            var aDetails = [];
            if (oConnection.adapterType) { aDetails.push("Adapter " + oConnection.adapterType); }
            if (oTestResult && oTestResult.mode) { aDetails.push(oTestResult.mode + " mode"); }
            if (oConnection.interfaceType) { aDetails.push(oConnection.interfaceType); }
            aDetails.push(sTestedAt ? "last tested " + new Date(sTestedAt).toLocaleString() : "never tested");

            oViewModel.setProperty("/connection/statusText", bConnected ? "Connected" : bFailed ? "Failed" : "Not tested");
            oViewModel.setProperty("/connection/state", bConnected ? "Success" : bFailed ? "Error" : "Warning");
            oViewModel.setProperty("/connection/details", aDetails.join(" · "));

            var sMessage = oTestResult ? oTestResult.message : (bFailed ? oConnection.errorMessage : "");
            oViewModel.setProperty("/connection/message", sMessage || "");
            oViewModel.setProperty("/connection/messageType", bFailed ? "Error" : "Success");
        },

        onTestConnection: async function () {
            var oViewModel = this.getView().getModel("view");
            var sConnectionId = oViewModel.getProperty("/selectedSourceConnection");
            var oModel = this.getOwnerComponent().getModel();

            if (!sConnectionId) {
                MessageBox.warning("Please select a Source Connection.");
                return;
            }

            oViewModel.setProperty("/connection/busy", true);
            oViewModel.setProperty("/connection/statusText", "Testing...");
            oViewModel.setProperty("/connection/state", "Information");
            oViewModel.setProperty("/connection/message", "");

            try {
                var oAction = oModel.bindContext("/testSourceConnection(...)");
                oAction.setParameter("connectionId", sConnectionId);
                await oAction.execute();

                var oResult = oAction.getBoundContext().getObject();

                // keep the loaded connection records in step with the test
                var aConnections = oViewModel.getProperty("/sourceConnections") || [];
                aConnections.forEach(function (c) {
                    if (c.connectionId === sConnectionId) {
                        c.status = oResult.status;
                        c.lastTestedAt = oResult.testedAt;
                    }
                });
                oViewModel.setProperty("/sourceConnections", aConnections);

                this._showConnectionStatus(oResult);
            } catch (oError) {
                oViewModel.setProperty("/connection/statusText", "Failed");
                oViewModel.setProperty("/connection/state", "Error");
                oViewModel.setProperty("/connection/message", oError.message || String(oError));
                oViewModel.setProperty("/connection/messageType", "Error");
            } finally {
                oViewModel.setProperty("/connection/busy", false);
            }
        },

        onTargetSystemChange: function (oEvent) {
            var sTargetSystemUUID = oEvent.getSource().getSelectedKey();
            var oViewModel = this.getView().getModel("view");
            oViewModel.setProperty("/selectedTargetSystemUUID", sTargetSystemUUID);

            var aTargets = oViewModel.getProperty("/targetSystems") || [];
            var oSelectedTarget = aTargets.find(function (t) {
                return t.ID === sTargetSystemUUID;
            });

            oViewModel.setProperty("/selectedTargetSystem", oSelectedTarget ? oSelectedTarget.systemId : "");
        },

        onBusinessObjectChange: function (oEvent) {
            this.getView()
                .getModel("view")
                .setProperty("/selectedBusinessObject", oEvent.getSource().getSelectedKey());
        },

        onDiscoverAnalyze: function () {
            var oViewModel = this.getView().getModel("view");

            var sSourceSystemUUID = oViewModel.getProperty("/selectedSourceSystemUUID");
            var sConnectionId = oViewModel.getProperty("/selectedSourceConnection");
            var sTargetSystemUUID = oViewModel.getProperty("/selectedTargetSystemUUID");

            if (!sSourceSystemUUID) {
                MessageBox.warning("Please select a Source System.");
                return;
            }
            if (!sConnectionId) {
                MessageBox.warning("Please select a Source Connection.");
                return;
            }
            if (!sTargetSystemUUID) {
                MessageBox.warning("Please select a Target System.");
                return;
            }
            var aSourceSystems = oViewModel.getProperty("/sourceSystems") || [];
            var oSourceSystem = aSourceSystems.find(function (s) {
                return s.ID === sSourceSystemUUID;
            });

            var aConnections = oViewModel.getProperty("/sourceConnections") || [];
            var oConnection = aConnections.find(function (c) {
                return c.connectionId === sConnectionId;
            });

            var aTargets = oViewModel.getProperty("/targetSystems") || [];
            var oTarget = aTargets.find(function (t) {
                return t.ID === sTargetSystemUUID;
            });

            if (!oSourceSystem || !oConnection || !oTarget) {
                MessageBox.error("Selection could not be resolved from loaded records.");
                return;
            }

            // the business object is chosen on the next page, from the identified business objects
            var oMigrationContext = this.getOwnerComponent().getModel("migrationContext");
            oMigrationContext.setData({
                runId: "RUN-2026-BP-001",
                sourceSystemId: oSourceSystem.systemId,
                sourceSystemUUID: oSourceSystem.ID,
                sourceSystemName: oSourceSystem.systemName,
                sourceConnectionId: sConnectionId,
                connectionName: oConnection.connectionName,
                targetSystemId: oTarget.systemId,
                targetSystemUUID: oTarget.ID,
                targetSystemName: oTarget.systemName,
                businessObject: null,
                sourceDiscoveryStatus: "DISCOVERED",
                targetDiscoveryStatus: "DISCOVERED"
            });

            this.getOwnerComponent().getRouter().navTo("BusinessObjectAssessment");
        },

        onRefresh: function () {
            this._loadDashboardData();
            MessageToast.show("Dashboard data refreshed.");
        },

        onJoule: function () {
            MessageToast.show("Joule integration will be connected here.");
        },

        onMigrationRunsKpiPress: function () {
            var oTable = this.byId("migrationRunsTable");
            if (oTable && oTable.getDomRef()) {
                oTable.getDomRef().scrollIntoView({ behavior: "smooth", block: "center" });
            }
        },

        onSourceSystemsKpiPress: function () {
            var oSelect = this.byId("sourceSystemSelect");
            if (oSelect && oSelect.getDomRef()) {
                oSelect.getDomRef().scrollIntoView({ behavior: "smooth", block: "center" });
                setTimeout(function () { oSelect.focus(); }, 300);
            }
        },

        onTargetSystemsKpiPress: function () {
            var oSelect = this.byId("targetSystemSelect");
            if (oSelect && oSelect.getDomRef()) {
                oSelect.getDomRef().scrollIntoView({ behavior: "smooth", block: "center" });
                setTimeout(function () { oSelect.focus(); }, 300);
            }
        },

        onRunPress: function (oEvent) {
            var oContext = oEvent.getSource().getBindingContext("view");
            if (!oContext) return;

            var oRun = oContext.getObject();
            this.getView().getModel("view").setProperty("/selectedRun", oRun);
            this._openMigrationRunDialog(oRun);
        },

        _openMigrationRunDialog: function (oRun) {
            if (this._oRunDialog) {
                this._oRunDialog.destroy();
                this._oRunDialog = null;
            }

            var oContent = new VBox({
                width: "100%",
                class: "migrationRunDialogContent",
                items: [
                    new Label({ text: "Run ID" }),
                    new Text({ text: oRun.runId || "-" }),
                    new Label({ text: "Business Object" }),
                    new Text({ text: oRun.businessObject || "-" }),
                    new Label({ text: "Source System" }),
                    new Text({ text: oRun.sourceSystem || "-" }),
                    new Label({ text: "Target System" }),
                    new Text({ text: oRun.targetSystem || "-" }),
                    new Label({ text: "Status" }),
                    new ObjectStatus({
                        text: oRun.status || "Unknown",
                        state: this._getRunStatusState(oRun.status)
                    })
                ]
            });

            this._oRunDialog = new Dialog({
                title: "Migration Run Details",
                contentWidth: "420px",
                content: [oContent],
                beginButton: new Button({
                    text: "Close",
                    press: function () {
                        this._oRunDialog.close();
                    }.bind(this)
                })
            });

            this.getView().addDependent(this._oRunDialog);
            this._oRunDialog.open();
        },

        _getRunStatusState: function (sStatus) {
            switch (String(sStatus || "").toUpperCase()) {
                case "SUCCESS":
                case "COMPLETED":
                case "RECONCILED":
                    return "Success";
                case "FAILED":
                case "ERROR":
                    return "Error";
                case "PARTIAL":
                case "WARNING":
                    return "Warning";
                case "PENDING":
                case "RUNNING":
                case "PROCESSING":
                    return "Information";
                default:
                    return "None";
            }
        },

        onExit: function () {
            if (this._oRunDialog) {
                this._oRunDialog.destroy();
                this._oRunDialog = null;
            }
        },

        onNavigateDiscovery: function () {
            this.getOwnerComponent().getRouter().navTo("RouteView1");
        },

        onNavigateSource: function () {
            var oContext = this.getOwnerComponent().getModel("migrationContext");
            var oData = oContext ? oContext.getData() : null;
            if (!oData || !oData.sourceSystemUUID) {
                MessageToast.show("Start a migration and complete Discovery first.");
                return;
            }
            this.getOwnerComponent().getRouter().navTo("SourceUnderstanding");
        },

        onNavigateMapping: function () {
            var oContext = this.getOwnerComponent().getModel("migrationContext");
            var oData = oContext ? oContext.getData() : null;
            if (!oData || !oData.sourceSystemUUID) {
                MessageToast.show("Complete Source Discovery first.");
                return;
            }
            this.getOwnerComponent().getRouter().navTo("TargetMapping");
        },
           onNavigateData: function () {
            var oContext = this.getOwnerComponent().getModel("migrationContext");
            var oData = oContext ? oContext.getData() : null;
            // if (!oData || !oData.sourceSystemUUID) {
            //     MessageToast.show("Complete Source Discovery first 2.");
            //     return;
            // }
            this.getOwnerComponent().getRouter().navTo("DataProfiling");
        },

        onNavigateRun: function () {
            var oContext = this.getOwnerComponent().getModel("migrationContext");
            var oData = oContext ? oContext.getData() : null;
            if (!oData || !oData.runId) {
                MessageToast.show("No migration run is currently selected.");
                return;
            }
            this.getOwnerComponent().getRouter().navTo("RunDetails");
        },

        // =========================================================
        // ADMIN / DIAGNOSTICS CONTROL
        // =========================================================
        onOpenAdminDialog: function () {
            var oModel = this.getOwnerComponent().getModel();
            var that = this;

            var oAdminDialog = new sap.m.Dialog({
                title: "Migration Framework Administration",
                contentWidth: "460px",
                content: [
                    new sap.m.VBox({
                        class: "sapUiSmallMargin",
                        items: [
                            new sap.m.Text({
                                text: "Execute administrative operations directly on SAP HANA Cloud without test scripts."
                            }),
                            new sap.m.Button({
                                text: "Reset Discovered Catalog",
                                icon: "sap-icon://delete",
                                type: "Reject",
                                width: "100%",
                                class: "sapUiTinyMarginTop",
                                press: async function () {
                                    sap.ui.core.BusyIndicator.show(0);
                                    try {
                                        var oAction = oModel.bindContext("/resetDiscoveredCatalog(...)");
                                        oAction.setParameter("sourceSystemId", "S4SOURCE01");
                                        await oAction.execute();
                                        sap.m.MessageToast.show("Catalog wiped successfully!");
                                        await that._loadDashboardData();
                                        oAdminDialog.close();
                                    } catch (err) {
                                        sap.m.MessageBox.error("Reset failed: " + (err.message || err));
                                    } finally {
                                        sap.ui.core.BusyIndicator.hide();
                                    }
                                }
                            }),
                            new sap.m.Button({
                                text: "Discover APIs of the selected source system",
                                icon: "sap-icon://synchronize",
                                type: "Emphasized",
                                width: "100%",
                                class: "sapUiTinyMarginTop",
                                press: async function () {
                                    // the source system selected on the landing page, not a fixed one
                                    var oViewModel = that.getView().getModel("view");
                                    var sUUID = oViewModel.getProperty("/selectedSourceSystemUUID");
                                    var oSystem = (oViewModel.getProperty("/sourceSystems") || []).find(function (s) {
                                        return s.ID === sUUID;
                                    });

                                    if (!oSystem) {
                                        sap.m.MessageBox.warning("Select a source system on the landing page first.");
                                        return;
                                    }

                                    sap.ui.core.BusyIndicator.show(0);
                                    try {
                                        var oAction = oModel.bindContext("/discoverSourceMetadata(...)");
                                        oAction.setParameter("sourceSystemId", oSystem.systemId);
                                        await oAction.execute();
                                        var oResult = oAction.getBoundContext().getObject() || {};
                                        sap.m.MessageBox.success(
                                            (oResult.objectsDiscovered || 0) + " API(s) discovered in " + oSystem.systemName + ". " +
                                            (oResult.message || ""));
                                        await that._loadDashboardData();
                                        oAdminDialog.close();
                                    } catch (err) {
                                        sap.m.MessageBox.error("Sync failed: " + (err.message || err));
                                    } finally {
                                        sap.ui.core.BusyIndicator.hide();
                                    }
                                }
                            }),
                            new sap.m.Button({
                                text: "Initialize Target System Metadata",
                                icon: "sap-icon://dimension",
                                width: "100%",
                                class: "sapUiTinyMarginTop",
                                press: async function () {
                                    sap.ui.core.BusyIndicator.show(0);
                                    try {
                                        var oAction = oModel.bindContext("/discoverTargetMetadata(...)");
                                        oAction.setParameter("runId", "RUN-2026-BP-001");
                                        await oAction.execute();
                                        sap.m.MessageToast.show("Target metadata initialized!");
                                        oAdminDialog.close();
                                    } catch (err) {
                                        sap.m.MessageBox.error("Target discovery failed: " + (err.message || err));
                                    } finally {
                                        sap.ui.core.BusyIndicator.hide();
                                    }
                                }
                            })
                        ]
                    })
                ],
                endButton: new sap.m.Button({
                    text: "Close",
                    press: function () {
                        oAdminDialog.close();
                    }
                }),
                afterClose: function () {
                    oAdminDialog.destroy();
                }
            });

            this.getView().addDependent(oAdminDialog);
            oAdminDialog.open();
        }
    });
});