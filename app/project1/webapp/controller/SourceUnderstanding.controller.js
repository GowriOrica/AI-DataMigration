
sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/m/Dialog",
    "sap/m/Table",
    "sap/m/Column",
    "sap/m/ColumnListItem",
    "sap/m/Text",
    "sap/m/ObjectStatus",
    "sap/m/Button",
    "sap/ui/export/Spreadsheet",
    "sap/ui/export/library",
    "project1/util/ProfileView"
], function (
    Controller,
    JSONModel,
    Filter,
    FilterOperator,
    MessageBox,
    MessageToast,
    Dialog,
    Table,
    Column,
    ColumnListItem,
    Text,
    ObjectStatus,
    Button,
    Spreadsheet,
    exportLibrary,
    ProfileView
) {
    "use strict";

    var EdmType = exportLibrary.EdmType;

    return Controller.extend("project1.controller.SourceUnderstanding", {

        // =========================================================
        // INITIALIZATION & LIFECYCLE
        // =========================================================
        onInit: function () {
            this.getView().setModel(
                new JSONModel({
                    objectsCount: 0,
                    fieldsCount: 0,
                    recordCount: 0,
                    stagedRecordsCount: 0,
                    schemaVersion: "-",
                    selectedObjectName: "-",
                    selectedObjectType: "-",
                    selectedObjectDescription: "-",
                    sourceObjects: [],
                    sourceFields: [],
                    rawRecords: [],
                    extractions: [],
                    selectedExtractionId: "",
                    osObjects: [],
                    selectedOsObject: "",
                    osSkip: 0,
                    osTop: 50,
                    osTotal: 0,
                    osRangeText: "",
                    osMessage: "",
                    osMessageType: "Information"
                }),
                "sourceUnderstanding"
            );

            this._aAllMetadata = [];
            this._aAllFields = [];

            this.getOwnerComponent()
                .getRouter()
                .getRoute("SourceUnderstanding")
                .attachPatternMatched(this._onRouteMatched, this);
        },

        _onRouteMatched: async function () {
            // the Object Store part does not depend on the database, so it loads first
            await this._loadExtractions();
            await this._loadSourceUnderstanding();

            // one selection drives both tabs: records and fields of the selected API
            this._buildApiRows();
            await this._selectApi(this._currentOrFirstApi());
        },

        // =========================================================
        // EXTRACTED RECORDS (OBJECT STORE)
        // =========================================================
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

        _loadExtractions: async function () {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};

            oViewModel.setProperty("/osMessage", "");

            try {
                var oResult = await this._callAction("listExtractions", {
                    sourceSystemId: oMigration.sourceSystemId,
                    businessObject: oMigration.assessedBusinessObject
                });

                var aExtractions = (oResult.value || []).map(function (oExtraction) {
                    return Object.assign({}, oExtraction, {
                        startedAtText: oExtraction.startedAt ? new Date(oExtraction.startedAt).toLocaleString() : "",
                        objectList: JSON.parse(oExtraction.objects || "[]")
                    });
                });

                oViewModel.setProperty("/extractions", aExtractions);

                if (aExtractions.length === 0) {
                    oViewModel.setProperty("/selectedExtractionId", "");
                    oViewModel.setProperty("/osObjects", []);
                    oViewModel.setProperty("/report", {});
                    oViewModel.setProperty("/osTotal", 0);
                    oViewModel.setProperty("/osRangeText", "");
                    this._renderOsRecords([]);
                    oViewModel.setProperty("/osMessageType", "Information");
                    oViewModel.setProperty("/osMessage",
                        "No extraction found" +
                        (oMigration.assessedBusinessObject ? " for '" + oMigration.assessedBusinessObject + "'" : "") +
                        ". On the Business Objects page, select the business object and press 'Extract to Object Store' in tab 2.");
                    return;
                }

                // newest first; prefer the one just made on the Business Objects page
                var sWanted = oMigration.lastExtractionId;
                var oSelected = aExtractions.find(function (e) { return e.extractionId === sWanted; }) || aExtractions[0];

                this._applyExtraction(oSelected.extractionId);
            } catch (oError) {
                oViewModel.setProperty("/osMessageType", "Error");
                oViewModel.setProperty("/osMessage", "Could not read the extractions from the Object Store: " + (oError.message || oError));
            }
        },

        /** Makes an extraction the current one: its APIs and its report (records are loaded per API). */
        _applyExtraction: function (sExtractionId) {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            var oExtraction = (oViewModel.getProperty("/extractions") || []).find(function (e) {
                return e.extractionId === sExtractionId;
            });

            if (!oExtraction) {
                return;
            }

            oViewModel.setProperty("/selectedExtractionId", sExtractionId);
            oViewModel.setProperty("/osObjects", oExtraction.objectList || []);
            oViewModel.setProperty("/report", this._buildReport(oExtraction));
        },

        /** The extraction report in plain words (what the manifest knows today). */
        _buildReport: function (oExtraction) {
            var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};
            var aObjects = oExtraction.objectList || [];
            var iFiles = aObjects.reduce(function (n, o) { return n + (o.pages || 0); }, 0);

            var aParts = aObjects.map(function (o) {
                return o.objectName + ": " + (o.error ? "failed (" + o.error + ")" :
                    o.records + " records" + (o.truncated ? ", stopped at the limit" : ", complete"));
            });

            var aConfirmed = oMigration.confirmedApis || [];
            var aNotIncluded = aConfirmed.filter(function (s) {
                return !aObjects.some(function (o) { return o.objectName === s; });
            });

            return {
                summary: (oMigration.assessedBusinessObject || oExtraction.businessObject || "") +
                    " · extracted " + (oExtraction.startedAtText || "") + " · status " + oExtraction.status +
                    " · " + oExtraction.totalRecords + " records from " + aObjects.length + " API(s) in " + iFiles + " file(s)",
                source: "From " + (oMigration.sourceSystemName || oExtraction.sourceSystem || "") + " (" +
                    (oExtraction.sourceSystem || "") + "), live. " + aParts.join(" · "),
                notIncluded: aNotIncluded.length
                    ? "Confirmed now but not in this extraction: " + aNotIncluded.join(", ") + ". Extract again on the Business Objects page to include it."
                    : "",
                checksums: "Checksums not verified yet - press 'Verify checksums'.",
                checksumState: "None"
            };
        },

        /** API list on the left: the APIs of the extraction plus confirmed APIs that are not in it. */
        _buildApiRows: function () {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};
            var aObjects = oViewModel.getProperty("/osObjects") || [];

            var aRows = aObjects.map(function (o) {
                return {
                    api: o.objectName,
                    inExtraction: true,
                    statusText: o.error ? "failed" : o.records + (o.truncated ? " · limit" : " ✓"),
                    statusState: o.error ? "Error" : o.truncated ? "Warning" : "Success"
                };
            });

            (oMigration.confirmedApis || []).forEach(function (sApi) {
                if (!aRows.some(function (r) { return r.api === sApi; })) {
                    aRows.push({ api: sApi, inExtraction: false, statusText: "not extracted", statusState: "None" });
                }
            });

            oViewModel.setProperty("/apiRows", aRows);
        },

        _currentOrFirstApi: function () {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            var aRows = oViewModel.getProperty("/apiRows") || [];
            var sCurrent = oViewModel.getProperty("/selectedApi");
            var oRow = aRows.find(function (r) { return r.api === sCurrent; }) ||
                aRows.find(function (r) { return r.inExtraction; }) || aRows[0];

            return oRow ? oRow.api : "";
        },

        onApiSelect: async function (oEvent) {
            var oItem = oEvent.getParameter("listItem");
            var oContext = oItem && oItem.getBindingContext("sourceUnderstanding");

            if (oContext) {
                await this._selectApi(oContext.getObject().api);
            }
        },

        /** Shows records and fields of one API, and highlights it in the list. */
        _selectApi: async function (sApi) {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            var oRow = (oViewModel.getProperty("/apiRows") || []).find(function (r) { return r.api === sApi; });

            oViewModel.setProperty("/selectedApi", sApi || "");

            var oTable = this.byId("apiTable");
            oTable.getItems().forEach(function (oItem) {
                var oContext = oItem.getBindingContext("sourceUnderstanding");
                oItem.setSelected(!!oContext && oContext.getObject().api === sApi);
            });

            if (!sApi) {
                return;
            }

            // fields: from the discovered metadata of this API
            var oObject = (oViewModel.getProperty("/sourceObjects") || []).find(function (o) {
                return String(o.cleanName || "").toUpperCase() === String(sApi).replace(/_0001$/, "").toUpperCase();
            });

            if (oObject) {
                await this._displayObjectFields(oObject);
            } else {
                oViewModel.setProperty("/selectedObjectName", sApi);
                oViewModel.setProperty("/sourceFields", []);
                oViewModel.setProperty("/fieldsCount", 0);
            }

            // records: from the Object Store, only if the API is in this extraction
            oViewModel.setProperty("/osSkip", 0);

            if (oRow && oRow.inExtraction) {
                oViewModel.setProperty("/selectedOsObject", sApi);
                await this._loadOsRecords();
            } else {
                oViewModel.setProperty("/selectedOsObject", "");
                oViewModel.setProperty("/osTotal", 0);
                oViewModel.setProperty("/osRangeText", sApi + " is not in this extraction. Extract again on the Business Objects page to include it.");
                this._renderOsRecords([]);
            }

            // the profile belongs to one API of one extraction: load it if its tab is open, otherwise when it is opened
            oViewModel.setProperty("/profile", { ready: false, message: "", messageType: "Information", filter: "ALL", forKey: "" });

            if (this.byId("sourceDetailTabBar").getSelectedKey() === "profiling") {
                await this._loadProfile();
            }
        },

        // =========================================================
        // PROFILING (calculated by the server from the Object Store files; no AI)
        // =========================================================
        onDetailTabSelect: async function (oEvent) {
            if (oEvent.getParameter("key") === "profiling") {
                await this._loadProfile();
            }
        },

        _loadProfile: async function () {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            var sExtractionId = oViewModel.getProperty("/selectedExtractionId");
            var sApi = oViewModel.getProperty("/selectedOsObject");
            var sKey = sExtractionId + "|" + sApi;

            if (!sExtractionId || !sApi) {
                oViewModel.setProperty("/profile", {
                    ready: false, filter: "ALL", forKey: "", messageType: "Information",
                    message: "This API is not in the selected extraction, so there is nothing to profile. Extract again on the Business Objects page."
                });
                return;
            }

            if (oViewModel.getProperty("/profile/forKey") === sKey && oViewModel.getProperty("/profile/ready")) {
                return;
            }

            oViewModel.setProperty("/profile", { ready: false, filter: "ALL", forKey: sKey, messageType: "Information", message: "Profiling " + sApi + " - reading the records from the Object Store and counting..." });

            try {
                var oResult = await this._callAction("profileExtraction", { extractionId: sExtractionId, objectName: sApi });
                var oProfile = (JSON.parse(oResult.objects || "[]"))[0];

                if (!oProfile || oProfile.error) {
                    oViewModel.setProperty("/profile", { ready: false, filter: "ALL", forKey: sKey, messageType: "Error", message: oProfile ? "The extraction of this API failed: " + oProfile.error : "No profile was returned." });
                    return;
                }

                // the same formatting as the page "4. Data Profiling"
                oViewModel.setProperty("/profile", ProfileView.detail(oProfile, sKey));
            } catch (oError) {
                oViewModel.setProperty("/profile", { ready: false, filter: "ALL", forKey: sKey, messageType: "Error", message: "Profiling failed: " + (oError.message || oError) });
            }
        },

        onProfileFilter: function (oEvent) {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            var sKey = oEvent.getParameter("item").getKey();
            var aAll = oViewModel.getProperty("/profile/allFields") || [];

            oViewModel.setProperty("/profile/fields", ProfileView.filterFields(aAll, sKey));
        },

        /**
         * Excel export: built by the server from the files in the Object Store,
         * stored there under exports/, then downloaded by the browser.
         * Joule uses the same action (exportExtractionToExcel).
         */
        onExportToExcel: async function (oEvent) {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            var bOnlyApi = oEvent.getParameter("item").getKey() === "API";
            var sApi = oViewModel.getProperty("/selectedOsObject");

            oViewModel.setProperty("/exportBusy", true);
            oViewModel.setProperty("/exportMessageType", "Information");
            oViewModel.setProperty("/exportMessage", "Creating the Excel file from the Object Store" + (bOnlyApi ? " for " + sApi : "") + "...");
            sap.ui.core.BusyIndicator.show(0);

            try {
                var oResult = await this._callAction("exportExtractionToExcel", {
                    extractionId: oViewModel.getProperty("/selectedExtractionId"),
                    objectName: bOnlyApi ? sApi : null
                });

                // download through the same OData service (works locally and behind the app router)
                var sUrl = this.getOwnerComponent().getModel().getServiceUrl() +
                    "downloadExport(exportKey='" + encodeURIComponent(oResult.exportKey) + "')";
                var oLink = document.createElement("a");
                oLink.href = sUrl;
                oLink.download = oResult.fileName;
                document.body.appendChild(oLink);
                oLink.click();
                document.body.removeChild(oLink);

                oViewModel.setProperty("/exportMessageType", oResult.checksums === "OK" ? "Success" : "Warning");
                oViewModel.setProperty("/exportMessage", oResult.message);
            } catch (oError) {
                oViewModel.setProperty("/exportMessageType", "Error");
                oViewModel.setProperty("/exportMessage", "Excel export failed: " + (oError.message || oError));
            } finally {
                oViewModel.setProperty("/exportBusy", false);
                sap.ui.core.BusyIndicator.hide();
            }
        },

        onVerifyExtraction: async function () {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            var sExtractionId = oViewModel.getProperty("/selectedExtractionId");

            oViewModel.setProperty("/report/checksums", "Verifying - reading the files back from the Object Store...");
            oViewModel.setProperty("/report/checksumState", "Information");

            try {
                var oResult = await this._callAction("verifyExtraction", { extractionId: sExtractionId });

                oViewModel.setProperty("/report/checksums", "Checksums: " + oResult.message + " (verified " + new Date().toLocaleString() + ")");
                oViewModel.setProperty("/report/checksumState", oResult.status === "OK" ? "Success" : "Error");
            } catch (oError) {
                oViewModel.setProperty("/report/checksums", "Verification failed: " + (oError.message || oError));
                oViewModel.setProperty("/report/checksumState", "Error");
            }
        },

        _loadOsRecords: async function () {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            var sExtractionId = oViewModel.getProperty("/selectedExtractionId");
            var sObjectName = oViewModel.getProperty("/selectedOsObject");

            if (!sExtractionId || !sObjectName) {
                this._renderOsRecords([]);
                return;
            }

            var oObject = (oViewModel.getProperty("/osObjects") || []).find(function (o) { return o.objectName === sObjectName; }) || {};

            if (oObject.error) {
                oViewModel.setProperty("/osMessageType", "Error");
                oViewModel.setProperty("/osMessage", sObjectName + " failed during extraction: " + oObject.error);
            } else {
                oViewModel.setProperty("/osMessage", "");
            }

            try {
                var oResult = await this._callAction("readExtractionRecords", {
                    extractionId: sExtractionId,
                    objectName: sObjectName,
                    skip: oViewModel.getProperty("/osSkip"),
                    top: oViewModel.getProperty("/osTop")
                });

                var aRecords = JSON.parse(oResult.records || "[]");
                var iFrom = aRecords.length ? oResult.skip + 1 : 0;

                oViewModel.setProperty("/osTotal", oResult.totalRecords);
                oViewModel.setProperty("/osRangeText",
                    "Records " + iFrom + " - " + (oResult.skip + aRecords.length) + " of " + oResult.totalRecords +
                    (oObject.truncated ? " (extraction stopped at the record limit - the source has more)" : ""));

                this._renderOsRecords(aRecords);
            } catch (oError) {
                this._renderOsRecords([]);
                oViewModel.setProperty("/osMessageType", "Error");
                oViewModel.setProperty("/osMessage", "Could not read the records: " + (oError.message || oError));
            }
        },

        /**
         * The columns are not known in advance (every API has its own fields),
         * so the table is built from the records: one column per simple field.
         * Nested values (navigation links, metadata) are left out.
         */
        _renderOsRecords: function (aRecords) {
            var oHolder = this.byId("osRecordsHolder");

            if (!oHolder) {
                return;
            }

            oHolder.destroyItems();

            if (!aRecords.length) {
                return;
            }

            var aColumns = [];

            aRecords.forEach(function (oRecord) {
                Object.keys(oRecord).forEach(function (sKey) {
                    var vValue = oRecord[sKey];
                    var bSimple = vValue === null || typeof vValue !== "object";

                    if (bSimple && sKey.indexOf("__") !== 0 && aColumns.indexOf(sKey) < 0) {
                        aColumns.push(sKey);
                    }
                });
            });

            var oTable = new Table({
                fixedLayout: false,
                growing: false,
                columns: aColumns.map(function (sKey) {
                    return new Column({ header: new Text({ text: sKey, wrapping: false }) });
                })
            });

            aRecords.forEach(function (oRecord) {
                oTable.addItem(new ColumnListItem({
                    cells: aColumns.map(function (sKey) {
                        var vValue = oRecord[sKey];
                        return new Text({ text: vValue === null || vValue === undefined ? "" : String(vValue), wrapping: false });
                    })
                }));
            });

            oHolder.addItem(oTable);
        },

        onRefreshExtractions: async function () {
            await this._loadExtractions();
            this._buildApiRows();
            await this._selectApi(this._currentOrFirstApi());
            MessageToast.show("Extractions refreshed.");
        },

        onExtractionChange: async function (oEvent) {
            this._applyExtraction(oEvent.getParameter("selectedItem").getKey());
            this._buildApiRows();
            await this._selectApi(this._currentOrFirstApi());
        },

        onOsObjectChange: async function () {
            this.getView().getModel("sourceUnderstanding").setProperty("/osSkip", 0);
            await this._loadOsRecords();
        },

        onOsPrevious: async function () {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            oViewModel.setProperty("/osSkip", Math.max(0, oViewModel.getProperty("/osSkip") - oViewModel.getProperty("/osTop")));
            await this._loadOsRecords();
        },

        onOsNext: async function () {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            oViewModel.setProperty("/osSkip", oViewModel.getProperty("/osSkip") + oViewModel.getProperty("/osTop"));
            await this._loadOsRecords();
        },

        // =========================================================
        // LOAD DATA & RUN DYNAMIC RESOLUTION
        // =========================================================
        _loadSourceUnderstanding: async function () {
            try {
                var oContext = this.getOwnerComponent().getModel("migrationContext");
                if (!oContext) {
                    throw new Error("Migration context is not available.");
                }

                var oMigration = oContext.getData();
                var oModel = this.getOwnerComponent().getModel();
                var oViewModel = this.getView().getModel("sourceUnderstanding");

                if (!oMigration.sourceSystemUUID && !oMigration.sourceSystemId) {
                    MessageBox.error("Source system context is missing. Please start Discovery from the landing page.");
                    return;
                }

                sap.ui.core.BusyIndicator.show(0);

                // 1. Source objects of this system only (the unfiltered list does not answer)
                var oObjectBinding = oModel.bindList("/SourceObjects", null, null,
                    oMigration.sourceSystemUUID ? [new Filter("sourceSystem_ID", FilterOperator.EQ, oMigration.sourceSystemUUID)] : []);
                var aObjectContexts = await oObjectBinding.requestContexts(0, 500);
                var aAllObjects = aObjectContexts.map(function (ctx) {
                    return ctx.getObject();
                });

                var sTargetClean = String(oMigration.businessObject || "API_BUSINESS_PARTNER")
                    .replace(/_0001$/, "")
                    .trim();

                var aObjects = aAllObjects.filter(function (oObj) {
                    return oObj.sourceSystem_ID === oMigration.sourceSystemUUID ||
                           (oObj.objectId && oObj.objectId.startsWith(oMigration.sourceSystemId));
                }).map(function (oObj) {
                    var sClean = String(oObj.objectName || "").replace(/_0001$/, "");
                    return {
                        ...oObj,
                        cleanName: sClean,
                        displayName: sClean
                    };
                });

                if (aObjects.length === 0) {
                    MessageBox.warning("No source objects were found for this system. Please run Discovery.");
                    return;
                }

                // De-duplicate list by cleanName
                var mUnique = new Map();
                aObjects.forEach(function (o) {
                    if (!mUnique.has(o.cleanName)) {
                        mUnique.set(o.cleanName, o);
                    }
                });
                var aDistinctObjects = Array.from(mUnique.values());

                var aConfirmed = (oMigration.confirmedApis || []).map(function (sName) {
                    return String(sName).replace(/_0001$/, "").toUpperCase();
                });

                if (aConfirmed.length > 0) {
                    aDistinctObjects = aDistinctObjects.filter(function (o) {
                        return aConfirmed.indexOf(o.cleanName.toUpperCase()) >= 0;
                    });

                    if (aDistinctObjects.length === 0) {
                        MessageBox.warning("The confirmed APIs of '" + oMigration.assessedBusinessObject +
                            "' have no discovered metadata yet. The admin can discover them in System Administration.");
                        return;
                    }
                }

                // Bring selected object to top
                aDistinctObjects.sort(function (a, b) {
                    if (a.cleanName.toUpperCase() === sTargetClean.toUpperCase()) return -1;
                    if (b.cleanName.toUpperCase() === sTargetClean.toUpperCase()) return 1;
                    return a.cleanName.localeCompare(b.cleanName);
                });

                oViewModel.setProperty("/sourceObjects", aDistinctObjects);
                oViewModel.setProperty("/objectsCount", aDistinctObjects.length);

                // 2./3. No download of all metadata and all fields any more: the fields of the
                // selected API are read directly by name (see _displayObjectFields)
                this._aAllMetadata = [];
                this._aAllFields = [];

                // the API to show is selected afterwards in _onRouteMatched (_selectApi)

            } catch (oError) {
                console.error("Source understanding failed:", oError);
                MessageBox.error("Unable to load source metadata: " + (oError.message || oError));
            } finally {
                sap.ui.core.BusyIndicator.hide();
            }
        },

        // =========================================================
        // SELECTION & DYNAMIC FIELD RESOLUTION
        // =========================================================
        onObjectSelect: function (oEvent) {
            var oItem = oEvent.getParameter("listItem");
            if (!oItem) return;
            var oSelectedObject = oItem.getBindingContext("sourceUnderstanding").getObject();
            this._displayObjectFields(oSelectedObject);
        },

        _displayObjectFields: async function (oObject) {
            if (!oObject) return;

            var oViewModel = this.getView().getModel("sourceUnderstanding");
            var oModel = this.getOwnerComponent().getModel();
            var sTargetClean = String(oObject.cleanName || oObject.objectName || "")
                .replace(/_0001$/, "")
                .trim();

            var aMatchingMetas = this._aAllMetadata.filter(function (oMeta) {
                if (oMeta.sourceObject_ID === oObject.ID) return true;
                var metaObjId = String(oMeta.metadataId || "").toUpperCase();
                return metaObjId.includes(sTargetClean.toUpperCase());
            });

            var oMetadataRecord = aMatchingMetas.length > 0 ? aMatchingMetas[0] : null;
            var aFields = [];

            try {
                var oDirectBinding = oModel.bindList(
                    "/SourceFields",
                    null,
                    null,
                    new Filter("objectName", FilterOperator.EQ, sTargetClean)
                );
                var aDirectContexts = await oDirectBinding.requestContexts(0, 500);
                aFields = aDirectContexts.map(function (ctx) { return ctx.getObject(); });

                if (aFields.length === 0 && aMatchingMetas.length > 0) {
                    var aMetaIds = aMatchingMetas.map(function (m) { return m.ID; });
                    aFields = this._aAllFields.filter(function (oFld) {
                        return aMetaIds.includes(oFld.metadata_ID);
                    });
                }

                if (aFields.length === 0) {
                    aFields = this._aAllFields.filter(function (oFld) {
                        var sObj = String(oFld.objectName || "").replace(/_0001$/, "").toUpperCase();
                        return sObj === sTargetClean.toUpperCase();
                    });
                }
            } catch (err) {
                console.warn("Direct field query failed, checking memory cache:", err);
                if (oMetadataRecord) {
                    aFields = this._aAllFields.filter(function (oFld) {
                        return oFld.metadata_ID === oMetadataRecord.ID;
                    });
                }
            }

            oViewModel.setProperty("/selectedObjectName", sTargetClean);
            oViewModel.setProperty("/selectedObjectType", oObject.objectType || "ODATA_SERVICE");
            oViewModel.setProperty("/selectedObjectDescription", oObject.description || sTargetClean);
            oViewModel.setProperty("/fieldsCount", aFields.length);
            oViewModel.setProperty("/recordCount", oMetadataRecord ? (oMetadataRecord.recordCount || 0) : 0);
            oViewModel.setProperty("/schemaVersion", oMetadataRecord ? (oMetadataRecord.schemaVersion || "1.0") : "1.0");
            oViewModel.setProperty("/sourceFields", aFields);

            this.getView().getModel("migrationContext").setProperty("/recordCount", oMetadataRecord ? (oMetadataRecord.recordCount || 0) : 0);
            

            var oContext = this.getOwnerComponent().getModel("migrationContext");
            if (oContext) {
                oContext.setProperty("/businessObject", sTargetClean);
            }
        },

        // =========================================================
        // EXTRACTION PIPELINE & STAGING
        // =========================================================
        onExtractData: async function () {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            var oContext = this.getOwnerComponent().getModel("migrationContext");
            var oMigration = oContext ? oContext.getData() : {};
            var oModel = this.getOwnerComponent().getModel();
            var that = this;

            var sObjectName = oViewModel.getProperty("/selectedObjectName");
            if (!sObjectName || sObjectName === "-") {
                MessageBox.warning("Please select a source object to extract.");
                return;
            }

            var sRunId = oMigration.runId || "RUN-2026-BP-001";
            var sBatchId = "BATCH-001";

            sap.ui.core.BusyIndicator.show(0);
            MessageToast.show("Extracting live records for " + sObjectName + " from S/4HANA...");

            try {
                var oActionBinding = oModel.bindContext("/ingestSourceData(...)");
                oActionBinding.setParameter("connectionId", oMigration.sourceConnectionId || "CONN-S4-001");
                oActionBinding.setParameter("objectName", sObjectName);
                oActionBinding.setParameter("runId", sRunId);
                oActionBinding.setParameter("batchId", sBatchId);

                await oActionBinding.execute();
                var oResult = oActionBinding.getBoundContext().getObject();

                if (oContext) {
                    oContext.setProperty("/runId", sRunId);
                    oContext.setProperty("/batchId", sBatchId);
                }

                var iIngested = oResult.ingestedCount || oResult.extractedCount || 0;
                oViewModel.setProperty("/recordCount", iIngested);

                await that.loadRawRecords(sRunId);
                that.byId("sourceDetailTabBar").setSelectedKey("rawRecords");

                MessageToast.show("Extracted " + iIngested + " records into HANA Cloud!");
            } catch (err) {
                console.error("Data extraction failed:", err);
                MessageBox.error("Extraction failed: " + (err.message || err));
            } finally {
                sap.ui.core.BusyIndicator.hide();
            }
        },

        loadRawRecords: async function (sRunId) {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            var oModel = this.getOwnerComponent().getModel();
            var oContext = this.getOwnerComponent().getModel("migrationContext");
            var oMigration = oContext ? oContext.getData() : {};
            var sTargetRun = sRunId || oMigration.runId || "RUN-2026-BP-001";

            try {
                var oBinding = oModel.bindList(
                    "/RawRecords",
                    null,
                    null,
                    new Filter("runId", FilterOperator.EQ, sTargetRun)
                );

                var aContexts = await oBinding.requestContexts(0, 100);
                var aRaw = aContexts.map(function (ctx) {
                    var o = ctx.getObject();
                    var sName = o.sourceKey;
                    try {
                        var p = JSON.parse(o.payload || "{}");
                        sName = p.BusinessPartnerFullName || p.OrganizationBPName1 || p.Customer || p.BankName || o.sourceKey;
                    } catch (e) {}

                    return {
                        ...o,
                        displayIdentifier: sName,
                        payloadPreview: o.payload || ""
                    };
                });

                oViewModel.setProperty("/rawRecords", aRaw);
                oViewModel.setProperty("/stagedRecordsCount", aRaw.length);
                if (aRaw.length > 0) {
                    oViewModel.setProperty("/recordCount", aRaw.length);
                }
            } catch (e) {
                console.warn("Failed to read raw records:", e);
            }
        },

        onRefreshRawRecords: async function () {
            sap.ui.core.BusyIndicator.show(0);
            await this.loadRawRecords();
            sap.ui.core.BusyIndicator.hide();
        },

        onViewRawRecordsTab: async function () {
            await this.loadRawRecords();
            this.byId("sourceDetailTabBar").setSelectedKey("rawRecords");
        },

        // =========================================================
        // MODAL RECORD INSPECTOR
        // =========================================================
        onViewRawRecordsModal: async function () {
            var oModel = this.getOwnerComponent().getModel();
            var oContext = this.getOwnerComponent().getModel("migrationContext");
            var oMigration = oContext ? oContext.getData() : {};
            var sRunId = oMigration.runId || "RUN-2026-BP-001";
            var that = this;

            sap.ui.core.BusyIndicator.show(0);

            try {
                var oBinding = oModel.bindList(
                    "/RawRecords",
                    null,
                    null,
                    new Filter("runId", FilterOperator.EQ, sRunId)
                );

                var aContexts = await oBinding.requestContexts(0, 50);
                var aRecords = aContexts.map(function (ctx) {
                    var oData = ctx.getObject();
                    var sPreview = "";
                    try {
                        var oParsed = JSON.parse(oData.payload || "{}");
                        sPreview = oParsed.BusinessPartnerFullName || oParsed.OrganizationBPName1 || oParsed.Customer || oParsed.BankName || oData.sourceKey;
                    } catch (e) {
                        sPreview = oData.sourceKey;
                    }
                    return {
                        ...oData,
                        businessName: sPreview
                    };
                });

                var oDialogModel = new JSONModel({
                    records: aRecords,
                    totalCount: aRecords.length
                });

                var oTableDialog = new Dialog({
                    title: "Staged Raw Records in HANA Cloud (" + aRecords.length + ")",
                    contentWidth: "850px",
                    contentHeight: "500px",
                    content: [
                        new Table({
                            growing: true,
                            growingThreshold: 10,
                            columns: [
                                new Column({ header: new Text({ text: "Source Key" }), width: "9rem" }),
                                new Column({ header: new Text({ text: "Entity / Customer Name" }), width: "16rem" }),
                                new Column({ header: new Text({ text: "Status" }), width: "8rem" }),
                                new Column({ header: new Text({ text: "Ingested At" }), width: "14rem" })
                            ],
                            items: {
                                path: "dialog>/records",
                                template: new ColumnListItem({
                                    cells: [
                                        new Text({ text: "{dialog>sourceKey}" }),
                                        new Text({ text: "{dialog>businessName}" }),
                                        new ObjectStatus({ text: "{dialog>processingStatus}", state: "Success" }),
                                        new Text({ text: "{dialog>ingestedAt}" })
                                    ]
                                })
                            }
                        })
                    ],
                    endButton: new Button({
                        text: "Close",
                        press: function () {
                            oTableDialog.close();
                        }
                    }),
                    afterClose: function () {
                        oTableDialog.destroy();
                    }
                });

                oTableDialog.setModel(oDialogModel, "dialog");
                that.getView().addDependent(oTableDialog);
                oTableDialog.open();

            } catch (err) {
                console.error("Failed to load raw records modal:", err);
                MessageBox.error("Could not fetch raw records: " + (err.message || err));
            } finally {
                sap.ui.core.BusyIndicator.hide();
            }
        },

        // =========================================================
        // SPREADSHEET EXPORT TO EXCEL
        // =========================================================
        // =========================================================
        // SPREADSHEET EXPORT: ALL 69+ EXTRACTED S/4HANA FIELDS
        // =========================================================
        onExportRawRecordsToExcel: function () {
            var oViewModel = this.getView().getModel("sourceUnderstanding");
            var aRawRecords = oViewModel.getProperty("/rawRecords") || [];
            var aSourceFields = oViewModel.getProperty("/sourceFields") || [];
            var sObjectName = oViewModel.getProperty("/selectedObjectName") || "Export";

            if (aRawRecords.length === 0) {
                MessageBox.information("There are no staged records available to export.");
                return;
            }

            sap.ui.core.BusyIndicator.show(0);

            try {
                // 1. Unpack raw JSON payloads for all 50 records
                var aUnpackedData = aRawRecords.map(function (oRecord) {
                    var oParsedPayload = {};
                    try {
                        oParsedPayload = JSON.parse(oRecord.payload || "{}");
                    } catch (e) {
                        console.warn("Failed to parse JSON for record:", oRecord.sourceKey);
                    }

                    // Remove technical OData metadata wrapper if present
                    delete oParsedPayload.__metadata;

                    return {
                        _MIGRATION_SOURCE_KEY: oRecord.sourceKey,
                        _MIGRATION_STATUS: oRecord.processingStatus,
                        _MIGRATION_INGESTED_AT: oRecord.ingestedAt,
                        ...oParsedPayload
                    };
                });

                // 2. Dynamically determine all unique fields across metadata & payload
                var aCols = [
                    {
                        label: "Source Key",
                        property: "_MIGRATION_SOURCE_KEY",
                        type: EdmType.String,
                        width: 15
                    },
                    {
                        label: "Migration Status",
                        property: "_MIGRATION_STATUS",
                        type: EdmType.String,
                        width: 15
                    },
                    {
                        label: "Ingested Timestamp",
                        property: "_MIGRATION_INGESTED_AT",
                        type: EdmType.String,
                        width: 25
                    }
                ];

                if (aSourceFields.length > 0) {
                    // Build columns based on the discovered schema properties (all 69 fields)
                    aSourceFields.forEach(function (oField) {
                        var sProp = oField.fieldName;
                        var sType = EdmType.String;
                        var sDataType = String(oField.dataType || "").toLowerCase();

                        if (sDataType.includes("int") || sDataType.includes("decimal")) {
                            sType = EdmType.Number;
                        } else if (sDataType.includes("date") || sDataType.includes("time")) {
                            sType = EdmType.DateTime;
                        } else if (sDataType.includes("bool")) {
                            sType = EdmType.Boolean;
                        }

                        aCols.push({
                            label: sProp + (oField.nullable === false ? " *" : ""),
                            property: sProp,
                            type: sType,
                            width: Math.max(sProp.length + 5, 18)
                        });
                    });
                } else if (aUnpackedData.length > 0) {
                    // Fallback: derive columns dynamically from JSON keys
                    var aKeys = Object.keys(aUnpackedData[0]).filter(function (k) {
                        return !k.startsWith("_MIGRATION_");
                    });

                    aKeys.forEach(function (sKey) {
                        aCols.push({
                            label: sKey,
                            property: sKey,
                            type: EdmType.String,
                            width: 20
                        });
                    });
                }

                // 3. Configure and trigger the standard UI5 spreadsheet builder
                var oSettings = {
                    workbook: {
                        columns: aCols,
                        context: {
                            sheetName: sObjectName.substring(0, 31)
                        }
                    },
                    dataSource: aUnpackedData,
                    fileName: sObjectName + "_Full_Data_" + new Date().toISOString().slice(0, 10) + ".xlsx",
                    worker: false
                };

                var oSheet = new Spreadsheet(oSettings);
                oSheet.build()
                    .then(function () {
                        MessageToast.show("Exported all " + (aCols.length - 3) + " fields to Excel!");
                    })
                    .catch(function (err) {
                        MessageBox.error("Excel export failed: " + (err.message || err));
                    })
                    .finally(function () {
                        oSheet.destroy();
                        sap.ui.core.BusyIndicator.hide();
                    });

            } catch (err) {
                sap.ui.core.BusyIndicator.hide();
                console.error("Export process failed:", err);
                MessageBox.error("Failed to build Excel spreadsheet: " + (err.message || err));
            }
        },

        // =========================================================
        // BATCH DISCOVERY & ACTION HELPERS
        // =========================================================
        onDiscoverAllObjects: async function () {
            var oContext = this.getOwnerComponent().getModel("migrationContext");
            var oMigration = oContext ? oContext.getData() : {};
            var oModel = this.getOwnerComponent().getModel();
            var that = this;

            if (!oMigration.sourceConnectionId) {
                MessageBox.error("Connection ID not found in migration context.");
                return;
            }

            sap.ui.core.BusyIndicator.show(0);
            try {
                var oAction = oModel.bindContext("/discoverSourceMetadata(...)");
                oAction.setParameter("connectionId", oMigration.sourceConnectionId);
                await oAction.execute();
                MessageToast.show("All metadata discovered successfully!");
                await that._loadSourceUnderstanding();
            } catch (err) {
                console.error("Batch discovery failed:", err);
                MessageBox.error("Batch discovery failed: " + (err.message || err));
            } finally {
                sap.ui.core.BusyIndicator.hide();
            }
        },

        formatNullable: function (bNullable) {
            return bNullable ? "Optional" : "Required";
        },

        formatNullableState: function (bNullable) {
            return bNullable ? "None" : "Warning";
        },

        onContinueToTarget: function () {
            this.getOwnerComponent().getRouter().navTo("TargetMapping");
        },
        onContinueToData: function () {
            this.getOwnerComponent().getRouter().navTo("DataProfiling");
        },

        onContinueToRun: function () {
            this.getOwnerComponent().getRouter().navTo("RunDetails");
        },

        onBack: function () {
            window.history.back();
        },

        onBackToBusinessObjects: function () {
            this.getOwnerComponent().getRouter().navTo("BusinessObjectAssessment");
        },

        onBackToDiscovery: function () {
            this.getOwnerComponent().getRouter().navTo("RouteView1");
        },

        onBackToSource: function () {
            this.getOwnerComponent().getRouter().navTo("SourceUnderstanding");
        },
        onContinueToExtract: function () {
            this.getOwnerComponent().getRouter().navTo("CatalogView");
        },

        onJoule: function () {
            MessageToast.show("Joule assistant");
        }
    });
});