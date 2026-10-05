sap.ui.define([
    "sap/ui/core/UIComponent",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/odata/v4/ODataModel",
    "project1/model/models"
], function (
    UIComponent,
    JSONModel,
    ODataModel,
    models
) {
    "use strict";

    return UIComponent.extend(
        "project1.Component",
        {

            metadata: {
                manifest: "json",
                interfaces: [
                    "sap.ui.core.IAsyncContentCreation"
                ]
            },


            init: function () {

                UIComponent.prototype.init.apply(
                    this,
                    arguments
                );


                // =============================================
                // DEVICE MODEL
                // =============================================

                this.setModel(
                    models.createDeviceModel(),
                    "device"
                );


                // =============================================
                // MIGRATION ODATA MODEL
                // =============================================

                var oMigrationModel =
                    new ODataModel({

                        serviceUrl:
                            "/migration/",

                        synchronizationMode:
                            "None",

                        operationMode:
                            "Server",

                        autoExpandSelect:
                            true,

                        earlyRequests:
                            true

                    });

                this.setModel(
                    oMigrationModel
                );


                // =============================================
                // SHARED MIGRATION CONTEXT
                // =============================================

                this.setModel(
                    new JSONModel({

                        runId: "",

                        sourceSystemId: "",
                        sourceSystemUUID: "",
                        sourceSystemName: "",

                        sourceConnectionId: "",
                        connectionName: "",

                        targetSystemId: "",
                        targetSystemUUID: "",
                        targetSystemName: "",

                        businessObject: "",

                        sourceDiscoveryStatus:
                            "NOT_STARTED",

                        targetDiscoveryStatus:
                            "NOT_STARTED"

                    }),
                    "migrationContext"
                );


                // =============================================
                // ROUTER
                // =============================================

                this.getRouter().initialize();
            }
        }
    );
});