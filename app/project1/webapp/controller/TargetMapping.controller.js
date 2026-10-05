sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/m/Dialog",
    "sap/m/VBox",
    "sap/m/Label",
    "sap/m/Text",
    "sap/m/ObjectStatus",
    "sap/m/Select",
    "sap/m/TextArea",
    "sap/ui/core/Item",
    "sap/m/Button"
], function (
    Controller,
    JSONModel,
    MessageBox,
    MessageToast,
    Dialog,
    VBox,
    Label,
    Text,
    ObjectStatus,
    Select,
    TextArea,
    Item,
    Button
) {
    "use strict";

    return Controller.extend(
        "project1.controller.TargetMapping",
        {

            // =========================================================
            // INIT
            // =========================================================

            onInit: function () {

                this.getView().setModel(
                    new JSONModel({
                        targetObject: "-",
                        targetStatus: "DISCOVERED",
                        targetFields: [],
                        mappings: [],
                        explanation:
                            "Mapping recommendations are generated from the migration intelligence layer.",
                        mappingCount: 0,
                        highConfidenceCount: 0,
                        approvalRequiredCount: 0,
                        correctionCount: 0,
                        analyzedAt: null,
                        busy: false
                    }),
                    "targetMapping"
                );

                this.getOwnerComponent()
                    .getRouter()
                    .getRoute("TargetMapping")
                    .attachPatternMatched(
                        this._onRouteMatched,
                        this
                    );
            },


            // =========================================================
            // ROUTE
            // =========================================================

            _onRouteMatched: async function () {

                await this._loadTargetMapping();
            },


            // =========================================================
            // LOAD TARGET MAPPING PAGE
            // =========================================================

            // Inside _loadTargetMapping in TargetMapping.controller.js:
            _loadTargetMapping: async function () {
                var oViewModel = this.getView().getModel("targetMapping");
                oViewModel.setProperty("/busy", true);

                try {
                    var oMigrationModel = this.getOwnerComponent().getModel("migrationContext");
                    if (!oMigrationModel) throw new Error("Migration context model is not available.");
                    var oMigration = oMigrationModel.getData();
                    if (!oMigration) throw new Error("Migration context is empty.");

                    var oModel = this.getOwnerComponent().getModel();
                    var sRunId = oMigration.runId || "RUN-2026-BP-001";

                    // 1. Ensure Target Metadata is cataloged in HANA
                    var oTargetObjBinding = oModel.bindList("/TargetObjects");
                    var aExistingTargets = await oTargetObjBinding.requestContexts(0, 5);
                    if (aExistingTargets.length === 0) {
                        var oTargetDiscoveryAction = oModel.bindContext("/discoverTargetMetadata(...)");
                        oTargetDiscoveryAction.setParameter("runId", sRunId);
                        await oTargetDiscoveryAction.execute();
                    }

                    // 2. Load Target Objects and Target Metadata (Original code)
                    var aObjectContexts = await oTargetObjBinding.requestContexts(0, 100);
                    var aTargetObjects = aObjectContexts.map(ctx => ctx.getObject());
                    var oTargetObject = aTargetObjects[0];

                    var oMetadataBinding = oModel.bindList("/TargetMetadata");
                    var aMetadataContexts = await oMetadataBinding.requestContexts(0, 100);
                    var aMetadata = aMetadataContexts.map(ctx => ctx.getObject());
                    var oTargetMetadata = aMetadata.length > 0 ? aMetadata[0] : null;

                    var oFieldBinding = oModel.bindList("/TargetFields");
                    var aFieldContexts = await oFieldBinding.requestContexts(0, 500);
                    var aAllTargetFields = aFieldContexts.map(ctx => ctx.getObject());

                    var aTargetFields = [];
                    if (oTargetMetadata) {
                        aTargetFields = aAllTargetFields.filter(f => f.metadata_ID === oTargetMetadata.ID);
                    }

                    oViewModel.setProperty("/targetObject", oTargetObject ? oTargetObject.objectName : "BusinessPartnerCustomer");
                    oViewModel.setProperty("/targetStatus", oTargetMetadata ? oTargetMetadata.metadataStatus : "DISCOVERED");
                    oViewModel.setProperty("/targetFields", aTargetFields);

                    // 3. Analyze Mapping automatically
                    await this._analyzeMapping(oMigration);

                } catch (oError) {
                    console.error("Target mapping loading failed:", oError);
                    MessageBox.error(oError.message || "Unable to load target mapping.");
                } finally {
                    oViewModel.setProperty("/busy", false);
                }
            },


            // =========================================================
            // ANALYZE MAPPING
            //
            // Fiori
            //   ↓
            // CAP analyzeMapping
            //   ↓
            // Mapping intelligence
            //   ↓
            // Joule semantic decision
            // =========================================================

            _analyzeMapping: async function (
                oMigration
            ) {

                var oModel =
                    this.getOwnerComponent()
                        .getModel();

                var oViewModel =
                    this.getView()
                        .getModel("targetMapping");


                try {

                    oViewModel.setProperty(
                        "/busy",
                        true
                    );


                    // -------------------------------------------------
                    // BUILD ACTION CONTEXT
                    // -------------------------------------------------

                    var oActionContext =
                        oModel.bindContext(
                            "/analyzeMapping(...)"
                        );


                    oActionContext.setParameter(
                        "runId",
                        oMigration.runId
                    );

                    oActionContext.setParameter(
                        "batchId",
                        oMigration.batchId ||
                        "BATCH-" + oMigration.runId
                    );

                    oActionContext.setParameter(
                        "sourceObject",
                        oMigration.businessObject
                    );
                    
                    // Pass sourceSystem if declared on the CAP action
                    if (oMigration.sourceSystemId) {
                        try {
                            oActionContext.setParameter("sourceSystem", oMigration.sourceSystemId);
                        } catch (e) {
                            // Ignored if action signature does not declare sourceSystem
                        }
                    }

                    // -------------------------------------------------
                    // EXECUTE CAP ACTION
                    // -------------------------------------------------

                    await oActionContext.execute();


                    // -------------------------------------------------
                    // GET ACTION RESULT
                    // -------------------------------------------------

                    var oResult =
                        oActionContext.getBoundContext()
                            .getObject();


                    if (!oResult) {

                        throw new Error(
                            "Mapping analysis returned no result."
                        );
                    }


                    console.log(
                        "Mapping analysis result:",
                        oResult
                    );


                    // -------------------------------------------------
                    // PARSE MAPPINGS
                    //
                    // Backend currently returns mappings as
                    // LargeString.
                    // -------------------------------------------------

                    var aMappings = [];


                    if (oResult.mappings) {

                        try {

                            if (
                                typeof oResult.mappings ===
                                "string"
                            ) {

                                aMappings =
                                    JSON.parse(
                                        oResult.mappings
                                    );

                            } else if (
                                Array.isArray(
                                    oResult.mappings
                                )
                            ) {

                                aMappings =
                                    oResult.mappings;

                            }

                        } catch (oParseError) {

                            console.error(
                                "Unable to parse mapping result:",
                                oParseError
                            );

                            throw new Error(
                                "Mapping analysis returned an invalid mapping response."
                            );
                        }
                    }


                    // -------------------------------------------------
                    // NORMALIZE RESULT FOR UI
                    //
                    // No semantic decisions are made here.
                    // We only prepare the backend response
                    // for display.
                    // -------------------------------------------------

                    oViewModel.setData({

                        targetObject:
                            oViewModel.getProperty(
                                "/targetObject"
                            ) || "-",

                        targetStatus:
                            oViewModel.getProperty(
                                "/targetStatus"
                            ) || "DISCOVERED",

                        targetFields:
                            oViewModel.getProperty(
                                "/targetFields"
                            ) || [],

                        mappings:
                            aMappings,

                        mappingCount:
                            Number(
                                oResult.mappingCount ||
                                aMappings.length ||
                                0
                            ),

                        highConfidenceCount:
                            Number(
                                oResult.highConfidenceCount ||
                                0
                            ),

                        approvalRequiredCount:
                            Number(
                                oResult.approvalRequiredCount ||
                                0
                            ),

                        correctionCount: 0,

                        analyzedAt:
                            oResult.analyzedAt ||
                            null,

                        explanation:
                            oResult.message ||
                            (
                                aMappings.length +
                                " mapping recommendation(s) returned by the migration intelligence layer."
                            ),

                        busy: false
                    });


                    // -------------------------------------------------
                    // STATUS MESSAGE
                    // -------------------------------------------------

                    if (
                        oResult.status &&
                        String(
                            oResult.status
                        ).toUpperCase() === "ERROR"
                    ) {

                        MessageBox.warning(
                            oResult.message ||
                            "Mapping analysis completed with an error status."
                        );

                    } else {

                        MessageToast.show(
                            "Mapping analysis completed."
                        );
                    }


                } catch (oError) {

                    console.error(
                        "Mapping analysis failed:",
                        oError
                    );

                    MessageBox.error(
                        oError.message ||
                        "Unable to analyze mapping."
                    );

                    throw oError;

                } finally {

                    oViewModel.setProperty(
                        "/busy",
                        false
                    );
                }
            },


            // =========================================================
            // REVIEW / CORRECT MAPPING
            // POC: correction is captured in the UI model.
            // Production: persist feedback through governed CAP action.
            // =========================================================

            onReviewMapping: function (oEvent) {

                var oContext =
                    oEvent.getSource().getBindingContext("targetMapping");

                if (!oContext) {
                    return;
                }

                var oMapping = oContext.getObject();
                var oView = this.getView();
                var oViewModel = oView.getModel("targetMapping");

                var oSelect = new Select({
                    width: "100%",
                    selectedKey: oMapping.targetField || "",
                    items: {
                        path: "targetMapping>/targetFields",
                        template: new Item({
                            key: "{targetMapping>fieldName}",
                            text: "{targetMapping>fieldName}"
                        })
                    }
                });

                var oReason = new TextArea({
                    width: "100%",
                    rows: 3,
                    placeholder: "Optional: explain why the mapping needs to be corrected."
                });

                var oDialog = new Dialog({
                    title: "Review Mapping",
                    contentWidth: "520px",
                    content: [
                        new VBox({
                            class: "mappingReviewDialog",
                            items: [
                                new Label({text: "Source Field"}),
                                new Text({text: oMapping.sourceField || "-"}),
                                new Label({text: "Canonical Field"}),
                                new Text({text: oMapping.canonicalField || "-"}),
                                new Label({text: "AI Suggested Target"}),
                                new Text({text: oMapping.targetField || "-"}),
                                new Label({text: "Confidence"}),
                                new ObjectStatus({
                                    text: this.formatConfidence(oMapping.confidence),
                                    state: this.formatConfidenceState(oMapping.confidence)
                                }),
                                new Label({text: "Correct Target"}),
                                oSelect,
                                new Label({text: "Correction Reason"}),
                                oReason
                            ]
                        })
                    ],
                    beginButton: new Button({
                        text: "Save Correction",
                        type: "Emphasized",
                        icon: "sap-icon://save",
                        press: function () {
                            var sNewTarget = oSelect.getSelectedKey();
                            if (!sNewTarget) {
                                MessageBox.warning("Please select a target field.");
                                return;
                            }

                            var aMappings = oViewModel.getProperty("/mappings") || [];
                            var iIndex = aMappings.indexOf(oMapping);
                            if (iIndex > -1) {
                                var sOldTarget = aMappings[iIndex].targetField;
                                aMappings[iIndex].targetField = sNewTarget;
                                aMappings[iIndex].reviewStatus =
                                    sOldTarget === sNewTarget ? "REVIEWED" : "CORRECTED";
                                aMappings[iIndex].feedbackCaptured = true;
                                aMappings[iIndex].correctionReason = oReason.getValue();
                                oViewModel.setProperty("/mappings", aMappings);
                                oViewModel.setProperty(
                                    "/correctionCount",
                                    Number(oViewModel.getProperty("/correctionCount") || 0) +
                                    (sOldTarget === sNewTarget ? 0 : 1)
                                );
                            }

                            oDialog.close();
                            MessageToast.show(
                                sOldTarget === sNewTarget
                                    ? "Mapping reviewed successfully."
                                    : "Mapping correction captured for this POC run."
                            );
                        }
                    }),
                    endButton: new Button({
                        text: "Cancel",
                        press: function () {
                            oDialog.close();
                        }
                    }),
                    afterClose: function () {
                        oDialog.destroy();
                    }
                });

                oView.addDependent(oDialog);
                oDialog.open();
            },


            // =========================================================
            // APPROVE MAPPING
            // =========================================================

            onApproveMapping: async function () {

                var oViewModel =
                    this.getView()
                        .getModel("targetMapping");

                var aMappings =
                    oViewModel.getProperty(
                        "/mappings"
                    ) || [];


                if (!aMappings.length) {

                    MessageBox.warning(
                        "There are no mapping recommendations to approve."
                    );

                    return;
                }


                /*
                 * POC:
                 * Approval UI is retained.
                 *
                 * The actual persistence of approved mappings
                 * will be connected to the backend approval action.
                 */

                MessageToast.show(
                    "Mapping approval captured for POC."
                );
            },


            // =========================================================
            // CONTINUE TO RUN
            // =========================================================

            onContinueToRun: function () {

                this.getOwnerComponent()
                    .getRouter()
                    .navTo(
                        "RunDetails"
                    );
            },


            // =========================================================
            // BACK
            // =========================================================

            onBack: function () {

                window.history.back();
            },


            // =========================================================
            // JOULE
            // =========================================================

            onJoule: function () {

                MessageToast.show(
                    "Joule assistant"
                );
            },


            // =========================================================
            // FORMATTERS
            // =========================================================

            formatMandatory: function (
                bMandatory
            ) {

                return bMandatory ?
                    "Mandatory" :
                    "Optional";
            },


            formatMandatoryState: function (
                bMandatory
            ) {

                return bMandatory ?
                    "Warning" :
                    "None";
            },


            formatConfidence: function (
                iConfidence
            ) {

                return String(
                    iConfidence || 0
                ) + "%";
            },


            formatConfidenceState: function (
                iConfidence
            ) {

                if (iConfidence >= 90) {
                    return "Success";
                }

                if (iConfidence >= 80) {
                    return "Warning";
                }

                return "Error";
            },


            formatTransformation: function (
                bRequired
            ) {

                return bRequired ?
                    "Required" :
                    "Direct";
            },


            formatTransformationState: function (
                bRequired
            ) {

                return bRequired ?
                    "Warning" :
                    "Success";
            },


            formatApproval: function (
                bRequired
            ) {

                return bRequired ?
                    "Required" :
                    "Not Required";
            },


            formatApprovalState: function (
                bRequired
            ) {

                return bRequired ?
                    "Warning" :
                    "Success";
            }

        }
    );
});