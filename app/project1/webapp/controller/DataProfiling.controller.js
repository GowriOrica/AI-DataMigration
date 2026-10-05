sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "project1/util/ProfileView"
], function (Controller, JSONModel, MessageToast, ProfileView) {
    "use strict";

    /**
     * Data Profiling of the extracted data of one business object.
     * The server action profileExtraction reads the files of the extraction from the Object Store
     * and counts (no AI, nothing is changed). Joule uses the same action.
     */
    return Controller.extend("project1.controller.DataProfiling", {

        onInit: function () {
            this.getView().setModel(new JSONModel({
                busy: false,
                ready: false,
                message: "",
                messageType: "Information",
                extractions: [],
                selectedExtractionId: "",
                apiRows: [],
                selectedApi: "",
                summary: {},
                detail: { ready: false }
            }), "dataProfiling");

            this._mProfiles = {};

            this.getOwnerComponent()
                .getRouter()
                .getRoute("DataProfiling")
                .attachPatternMatched(this._onRouteMatched, this);
        },

        _model: function () {
            return this.getView().getModel("dataProfiling");
        },

        _callAction: async function (sName, mParameters) {
            var oAction = this.getOwnerComponent().getModel().bindContext("/" + sName + "(...)");

            Object.keys(mParameters).forEach(function (sKey) {
                if (mParameters[sKey] !== undefined && mParameters[sKey] !== null && mParameters[sKey] !== "") {
                    oAction.setParameter(sKey, mParameters[sKey]);
                }
            });

            await oAction.execute();

            return oAction.getBoundContext().getObject();
        },

        // =========================================================
        // LOAD
        // =========================================================
        _onRouteMatched: async function () {
            var oModel = this._model();
            var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};

            oModel.setProperty("/ready", false);
            oModel.setProperty("/detail", { ready: false });

            if (!oMigration.assessedBusinessObject) {
                oModel.setProperty("/extractions", []);
                oModel.setProperty("/message", "Select a business object on step 2 (Business Objects) first. Data profiling works on its extracted data.");
                oModel.setProperty("/messageType", "Information");
                return;
            }

            oModel.setProperty("/message", "");

            try {
                var oResult = await this._callAction("listExtractions", {
                    sourceSystemId: oMigration.sourceSystemId,
                    businessObject: oMigration.assessedBusinessObject
                });

                var aExtractions = (oResult.value || []).map(function (oExtraction) {
                    return Object.assign({}, oExtraction, {
                        startedAtText: oExtraction.startedAt ? new Date(oExtraction.startedAt).toLocaleString() : ""
                    });
                });

                oModel.setProperty("/extractions", aExtractions);

                if (aExtractions.length === 0) {
                    oModel.setProperty("/selectedExtractionId", "");
                    oModel.setProperty("/messageType", "Information");
                    oModel.setProperty("/message", "No extraction found for '" + oMigration.assessedBusinessObject +
                        "'. On step 2, select the business object and press 'Extract to Object Store' in tab 2.");
                    return;
                }

                var oUsable = aExtractions.find(function (e) { return e.extractionId === oMigration.lastExtractionId; }) ||
                    aExtractions.find(function (e) { return e.status === "COMPLETED" || e.status === "PARTIAL"; }) || aExtractions[0];

                oModel.setProperty("/selectedExtractionId", oUsable.extractionId);
                await this._profile(false);
            } catch (oError) {
                oModel.setProperty("/messageType", "Error");
                oModel.setProperty("/message", "Could not read the extractions from the Object Store: " + (oError.message || oError));
            }
        },

        /** Profiles all APIs of the selected extraction (cached per extraction unless forced). */
        _profile: async function (bForce) {
            var oModel = this._model();
            var sExtractionId = oModel.getProperty("/selectedExtractionId");

            if (!sExtractionId) {
                return;
            }

            if (bForce || !this._mProfiles[sExtractionId]) {
                oModel.setProperty("/busy", true);
                oModel.setProperty("/ready", false);
                oModel.setProperty("/messageType", "Information");
                oModel.setProperty("/message", "Profiling - reading the records of the extraction from the Object Store and counting...");

                try {
                    var oResult = await this._callAction("profileExtraction", { extractionId: sExtractionId });

                    this._mProfiles[sExtractionId] = JSON.parse(oResult.objects || "[]");
                } catch (oError) {
                    oModel.setProperty("/busy", false);
                    oModel.setProperty("/messageType", "Error");
                    oModel.setProperty("/message", "Profiling failed: " + (oError.message || oError));
                    return;
                }

                oModel.setProperty("/busy", false);
            }

            oModel.setProperty("/message", "");
            this._showExtraction(this._mProfiles[sExtractionId]);
        },

        _showExtraction: function (aProfiles) {
            var oModel = this._model();

            var aRows = aProfiles.map(function (o) {
                if (o.error) {
                    return { api: o.objectName, note: "extraction failed", records: 0, fieldCount: 0, alwaysEmpty: 0, probableDuplicates: 0, scoreText: "–", scoreState: "Error" };
                }

                var oScore = ProfileView.score(o);

                return {
                    api: o.objectName,
                    note: o.truncated ? "stopped at the record limit" : "",
                    records: o.records,
                    fieldCount: o.fieldCount,
                    alwaysEmpty: o.alwaysEmpty.length,
                    probableDuplicates: o.probableDuplicates ? o.probableDuplicates.extraRecords : 0,
                    scoreText: oScore.scoreText,
                    scoreState: oScore.scoreState
                };
            });

            var aOk = aProfiles.filter(function (o) { return !o.error; });
            var oLowest = aOk.slice().sort(function (a, b) { return a.score.value - b.score.value; })[0];
            var oLowestScore = oLowest ? ProfileView.score(oLowest) : { scoreText: "–", scoreState: "None" };

            oModel.setProperty("/apiRows", aRows);
            oModel.setProperty("/summary", {
                records: aOk.reduce(function (n, o) { return n + o.records; }, 0),
                apis: aProfiles.length,
                alwaysEmpty: aOk.reduce(function (n, o) { return n + o.alwaysEmpty.length; }, 0),
                probableDuplicates: aOk.reduce(function (n, o) { return n + (o.probableDuplicates ? o.probableDuplicates.extraRecords : 0); }, 0),
                lowestScoreText: oLowestScore.scoreText,
                lowestScoreState: oLowestScore.scoreState
            });
            oModel.setProperty("/ready", true);

            var sCurrent = oModel.getProperty("/selectedApi");
            var oFirst = aRows.find(function (r) { return r.api === sCurrent; }) || aRows[0];

            this._showApi(oFirst ? oFirst.api : "");
        },

        _showApi: function (sApi) {
            var oModel = this._model();
            var aProfiles = this._mProfiles[oModel.getProperty("/selectedExtractionId")] || [];
            var oProfile = aProfiles.find(function (o) { return o.objectName === sApi; });

            oModel.setProperty("/selectedApi", sApi);

            if (!oProfile || oProfile.error) {
                oModel.setProperty("/detail", { ready: false });
            } else {
                oModel.setProperty("/detail", ProfileView.detail(oProfile, sApi));
            }

            // highlight the row of the selected API
            var oTable = this.byId("profileApiTable");

            setTimeout(function () {
                oTable.getItems().forEach(function (oItem) {
                    var oContext = oItem.getBindingContext("dataProfiling");
                    oItem.setSelected(!!oContext && oContext.getObject().api === sApi);
                });
            }, 0);
        },

        // =========================================================
        // EVENTS
        // =========================================================
        onExtractionChange: async function (oEvent) {
            this._model().setProperty("/selectedExtractionId", oEvent.getParameter("selectedItem").getKey());
            await this._profile(false);
        },

        onRunProfiling: async function () {
            await this._profile(true);
            MessageToast.show("Profiling finished.");
        },

        onApiSelect: function (oEvent) {
            var oContext = oEvent.getParameter("listItem").getBindingContext("dataProfiling");

            if (oContext) {
                this._showApi(oContext.getObject().api);
            }
        },

        onProfileFilter: function (oEvent) {
            var oModel = this._model();

            oModel.setProperty("/detail/fields", ProfileView.filterFields(oModel.getProperty("/detail/allFields"), oEvent.getParameter("item").getKey()));
        },

        // =========================================================
        // NAVIGATION
        // =========================================================
        onBackToSourceData: function () {
            this.getOwnerComponent().getRouter().navTo("SourceUnderstanding");
        },

        onContinueToTarget: function () {
            this.getOwnerComponent().getRouter().navTo("TargetMapping");
        }
    });
});
