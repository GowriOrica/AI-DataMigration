sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast"
], function (
    Controller,
    JSONModel,
    MessageBox,
    MessageToast
) {
    "use strict";

    return Controller.extend(
        "project1.controller.RunDetails",
        {

            onInit: function () {

                this.getView().setModel(
                    new JSONModel({
                        runId: "-",
                        businessObject: "-",
                        sourceSystem: "-",
                        targetSystem: "-",

                        sourceRecords: 0,
                        processedRecords: 0,
                        validationPassed: 0,
                        targetSuccess: 0,

                        status: "CREATED",
                        statusState: "Information",

                        currentStage: "Discovery",

                        reconciliationStatus:
                            "Not Started",

                        reconciliationState:
                            "None"
                    }),
                    "runDetails"
                );


                this.getOwnerComponent()
                    .getRouter()
                    .getRoute("RunDetails")
                    .attachPatternMatched(
                        this._onRouteMatched,
                        this
                    );
            },


            _onRouteMatched: async function () {

                await this._loadRunDetails();
            },


            _loadRunDetails: async function () {

                try {

                    var oMigrationModel =
                        this.getOwnerComponent()
                            .getModel(
                                "migrationContext"
                            );

                    var oMigration =
                        oMigrationModel.getData();

                    var oModel =
                        this.getOwnerComponent()
                            .getModel();

                    var oViewModel =
                        this.getView()
                            .getModel(
                                "runDetails"
                            );


                    var oBinding =
                        oModel.bindList(
                            "/MigrationRuns"
                        );

                    var aContexts =
                        await oBinding.requestContexts();

                    var aRuns =
                        aContexts.map(function (oContext) {
                            return oContext.getObject();
                        });


                    var oRun =
                        aRuns.find(function (oRecord) {

                            return oRecord.runId ===
                                oMigration.runId;

                        });


                    if (!oRun) {

                        oRun =
                            aRuns.length ?
                                aRuns[0] :
                                null;
                    }


                    if (!oRun) {

                        MessageBox.warning(
                            "No migration run is available."
                        );

                        return;
                    }


                    var sStatus =
                        oRun.status || "CREATED";


                    oViewModel.setData({

                        runId:
                            oRun.runId,

                        businessObject:
                            oRun.businessObject ||
                            oMigration.businessObject,

                        sourceSystem:
                            oRun.sourceSystem ||
                            oMigration.sourceSystemName,

                        targetSystem:
                            oRun.targetSystem ||
                            oMigration.targetSystemName,

                        sourceRecords:
                            2,

                        processedRecords:
                            2,

                        validationPassed:
                            0,

                        targetSuccess:
                            0,

                        status:
                            sStatus,

                        statusState:
                            this._getStatusState(
                                sStatus
                            ),

                        currentStage:
                            oRun.currentStage ||
                            "Discovery",

                        reconciliationStatus:
                            "Not Started",

                        reconciliationState:
                            "None"

                    });

                } catch (oError) {

                    console.error(
                        "Run details loading failed:",
                        oError
                    );

                    MessageBox.error(
                        "Unable to load migration run details."
                    );
                }
            },


            _getStatusState: function (sStatus) {

                switch (
                    String(
                        sStatus || ""
                    ).toUpperCase()
                ) {

                    case "SUCCESS":
                    case "COMPLETED":
                    case "RECONCILED":
                        return "Success";

                    case "FAILED":
                    case "ERROR":
                        return "Error";

                    case "PARTIAL":
                        return "Warning";

                    default:
                        return "Information";
                }
            },


            onRefresh: function () {

                this._loadRunDetails();

                MessageToast.show(
                    "Migration status refreshed."
                );
            },


            onBackToMapping: function () {

                this.getOwnerComponent()
                    .getRouter()
                    .navTo(
                        "TargetMapping"
                    );
            },


            onBack: function () {

                window.history.back();
            },


            onJoule: function () {

                MessageToast.show(
                    "Joule assistant"
                );
            },

            onBackToDiscovery: function () {

    this.getOwnerComponent()
        .getRouter()
        .navTo("RouteView1");
},


onBackToSource: function () {

    this.getOwnerComponent()
        .getRouter()
        .navTo("SourceUnderstanding");
}

        }
    );
});