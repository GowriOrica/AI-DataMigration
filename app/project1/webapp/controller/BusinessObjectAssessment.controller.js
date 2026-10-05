sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/Input",
    "sap/m/Text",
    "sap/m/TextArea",
    "sap/m/SearchField",
    "sap/m/List",
    "sap/m/StandardListItem",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/Select",
    "sap/ui/core/Item",
    "sap/m/VBox",
    "sap/m/HBox",
    "sap/m/BusyIndicator"
], function (
    Controller,
    JSONModel,
    MessageBox,
    MessageToast,
    Dialog,
    Button,
    Input,
    Text,
    TextArea,
    SearchField,
    List,
    StandardListItem,
    Filter,
    FilterOperator,
    Select,
    Item,
    VBox,
    HBox,
    BusyIndicator
) {
    "use strict";

    return Controller.extend(
        "project1.controller.BusinessObjectAssessment",
        {

            // =====================================================
            // INITIALIZATION
            // =====================================================

            onInit: function () {

                var oModel = new JSONModel({
                    busy: false,

                    phase: "BEFORE",

                    view: "PROGRAMS",

                    programs: [],

                    selectedCount: 0,

                    programFilter: { query: "", area: "", show: "ALL", countText: "" },

                    nextText: "",

                    summary: { sorted: 0, objects: 0, confirmed: 0, open: 0 },

                    inventory: {
                        loaded: false, count: 0, areaCount: 0, noun: "programs", title: "Sort the source system into business objects",
                        introText: "", browseText: "Browse everything that was found", everythingText: "Everything (recommended)",
                        factsText: "", moreText: "", showAll: false, areas: [], visibleAreas: []
                    },

                    summaryText: "",

                    totalObjects: 0,

                    businessObjectCount: 0,

                    status: "Not Loaded",

                    statusState: "None",

                    groups: [],

                    selectedBusinessObject: null,

                    extract: {
                        maxRecords: "",
                        job: { has: false, active: false, resumable: false, objects: [] },
                        busy: false,
                        message: "",
                        type: "Information",
                        lastId: ""
                    },

                    scope: {
                        modeIndex: 0,
                        showSort: false,
                        percent: 0,
                        progressText: "",
                        prefixes: "",
                        businessApisOnly: true,
                        readOnly: true,
                        includeCustom: false,
                        busy: false,
                        hasResult: false,
                        error: "",
                        assessMessage: "",
                        assessType: "Information",
                        steps: [],
                        excluded: [],
                        excludedCount: 0,
                        toAssess: 0,
                        alreadyAssessed: 0,
                        newToAssess: 0,
                        batches: 0,
                        tokensText: ""
                    }
                });

                this.getView().setModel(
                    oModel,
                    "assessment"
                );

                this
                    .getOwnerComponent()
                    .getRouter()
                    .getRoute("BusinessObjectAssessment")
                    .attachPatternMatched(
                        this._onRouteMatched,
                        this
                    );
            },


            // =====================================================
            // ROUTE MATCHED
            // =====================================================

            _onRouteMatched: async function () {

                // the list of all programs comes first, also when nothing is sorted yet
                try {
                    await this._loadInventory();
                } catch (oError) {
                    console.warn("The list of programs could not be read:", oError);
                }

                await this._loadBusinessObjectAssessment();

            },


            // =====================================================
            // LOAD BUSINESS OBJECT ASSESSMENT
            // =====================================================

            _loadBusinessObjectAssessment: async function () {

                var oViewModel =
                    this.getView().getModel("assessment");

                var oMigrationContext =
                    this
                        .getOwnerComponent()
                        .getModel("migrationContext");

                if (!oMigrationContext) {

                    MessageBox.error(
                        "Migration context is not available."
                    );

                    return;
                }

                var oMigration =
                    oMigrationContext.getData() || {};

                var sSourceSystemId =
                    oMigration.sourceSystemId;

                if (!sSourceSystemId) {

                    MessageBox.warning(
                        "Source system is not available. Please complete Discovery first."
                    );

                    return;
                }

                var oModel =
                    this
                        .getOwnerComponent()
                        .getModel();

                if (!oModel) {

                    MessageBox.error(
                        "Migration OData model is not available."
                    );

                    return;
                }

                try {

                    oViewModel.setProperty(
                        "/busy",
                        true
                    );

                    oViewModel.setProperty(
                        "/status",
                        "Loading..."
                    );

                    oViewModel.setProperty(
                        "/statusState",
                        "Information"
                    );


                    /*
                     * =================================================
                     * BUSINESS OBJECT GROUPING ENDPOINT
                     *
                     * Backend response:
                     *
                     * {
                     *   totalObjects: 5,
                     *   businessObjectCount: 5,
                     *   groups: [...]
                     * }
                     *
                     * =================================================
                     */

                    var sPath =
                        "/MigrationAssessments" +
                        "?groupByBusinessObject=true" +
                        "&$filter=" +
                        encodeURIComponent(
                            "sourceSystemId eq '" +
                            sSourceSystemId.replace(/'/g, "''") +
                            "'"
                        );


                    // The grouped result is not an OData entity list (no key), so it is read with
                    // fetch; a query string cannot be used as an OData V4 binding path.
                    var oResponse = await fetch("/migration" + sPath, {
                        headers: { Accept: "application/json" }
                    });

                    if (!oResponse.ok) {
                        throw new Error("Request failed with status " + oResponse.status);
                    }

                    var oPayload = await oResponse.json();

                    var aContexts = (oPayload.value || []).map(function (oValue) {
                        return {
                            getObject: function () {
                                return oValue;
                            }
                        };
                    });


                    if (
                        !aContexts ||
                        aContexts.length === 0
                    ) {

                        oViewModel.setProperty(
                            "/totalObjects",
                            0
                        );

                        oViewModel.setProperty(
                            "/businessObjectCount",
                            0
                        );

                        oViewModel.setProperty(
                            "/groups",
                            []
                        );

                        this._updatePhase();

                        oViewModel.setProperty(
                            "/status",
                            "No Assessment"
                        );

                        oViewModel.setProperty(
                            "/statusState",
                            "Warning"
                        );

                        return;
                    }


                    var oResult =
                        aContexts[0].getObject();


                    /*
                     * Backend returns:
                     *
                     * {
                     *   totalObjects,
                     *   businessObjectCount,
                     *   groups
                     * }
                     */


                    oViewModel.setProperty(
                        "/totalObjects",
                        Number(
                            oResult.totalObjects || 0
                        )
                    );


                    oViewModel.setProperty(
                        "/businessObjectCount",
                        Number(
                            oResult.businessObjectCount || 0
                        )
                    );


                    await this._loadInventory();

                    // list on the left: catalog objects first, and which ones were extracted already
                    var aGroups = oResult.groups || [];
                    var mExtracted = await this._latestExtractions(sSourceSystemId);

                    var mDescription = this._mDescription || {};

                    aGroups.forEach(function (oGroup) {
                        (oGroup.apis || []).forEach(function (oApi) {
                            oApi.description = mDescription[oApi.sourceObject] || mDescription[String(oApi.sourceObject).split(".")[0]] || "";
                        });

                        oGroup.inCatalog = !!oGroup.catalogCode;
                        oGroup.lastExtraction = mExtracted[oGroup.businessObject] || null;
                    });

                    oViewModel.setProperty(
                        "/groups",
                        aGroups
                    );

                    this._applyBusinessObjectListFilter();
                    this._updatePhase();
                    this._refreshPrograms();


                    if (
                        Number(oResult.totalObjects || 0) > 0
                    ) {

                        oViewModel.setProperty(
                            "/status",
                            "Completed"
                        );

                        oViewModel.setProperty(
                            "/statusState",
                            "Success"
                        );

                    } else {

                        oViewModel.setProperty(
                            "/status",
                            "No Assessment"
                        );

                        oViewModel.setProperty(
                            "/statusState",
                            "Warning"
                        );
                    }


                    console.log(
                        "Business Object Assessment:",
                        oResult
                    );

                } catch (oError) {

                    console.error(
                        "Business Object Assessment loading failed:",
                        oError
                    );

                    oViewModel.setProperty(
                        "/status",
                        "Failed"
                    );

                    oViewModel.setProperty(
                        "/statusState",
                        "Error"
                    );

                    MessageBox.error(
                        "Unable to load Business Object Assessment: " +
                        (
                            oError.message ||
                            oError
                        )
                    );

                } finally {

                    oViewModel.setProperty(
                        "/busy",
                        false
                    );
                }
            },


            // =====================================================
            // WHAT THE SOURCE SYSTEM OFFERS (names and descriptions only): intro, areas, size of a sort
            // =====================================================

            // well known areas of M3, in plain words (a code without a name is shown as it is)
            _mAreaNames: {
                CRS: "Customers, suppliers, banks",
                OIS: "Customer orders",
                MMS: "Items and inventory",
                PPS: "Purchasing"
            },

            _loadInventory: async function () {
                var that = this;
                var oViewModel = this.getView().getModel("assessment");
                var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};

                if (!oMigration.sourceSystemUUID || this._sInventoryOf === oMigration.sourceSystemUUID) { return; }

                var aAll = (await this._readAllRows("/SourceObjects", [new Filter("sourceSystem_ID", FilterOperator.EQ, oMigration.sourceSystemUUID)]));
                var bM3 = aAll.some(function (oObject) { return oObject.objectType === "M3_MI_PROGRAM"; });

                // M3: the programs are listed (single transactions are not programs)
                var aObjects = bM3 ? aAll.filter(function (oObject) { return oObject.objectType === "M3_MI_PROGRAM"; }) : aAll;
                var mDescription = {};
                var mCount = {};

                var aPrograms = aObjects.map(function (oObject) {
                    var sName = String(oObject.objectName || "").replace(/_0001$/, "");
                    var sPrefix = that._namePrefix(sName);

                    mDescription[oObject.objectName] = oObject.description || "";
                    mCount[sPrefix] = (mCount[sPrefix] || 0) + 1;

                    return {
                        name: oObject.objectName,
                        shown: sName,
                        description: oObject.description || "",
                        area: sPrefix,
                        areaText: that._mAreaNames[sPrefix] ? that._mAreaNames[sPrefix] + " (" + sPrefix + ")" : sPrefix,
                        businessObject: "", boText: "Not sorted yet", boState: "None", sorted: false
                    };
                }).sort(function (a, b) { return a.shown.localeCompare(b.shown); });

                var aAreas = Object.keys(mCount).sort(function (a, b) { return a.localeCompare(b); });
                var iCount = aPrograms.length;
                var sNoun = bM3 ? "programs" : "APIs";
                var sSystem = oMigration.sourceSystemId || "the source system";
                var iRequests = Math.ceil(iCount / 11);
                var iFrom = Math.max(1, Math.round(iRequests * 0.125));
                var iTo = Math.max(iFrom + 1, Math.round(iRequests * 0.17));
                var sExample = aPrograms.length ? aPrograms[0].shown : "";

                this._mDescription = mDescription;
                this._sInventoryOf = oMigration.sourceSystemUUID;

                oViewModel.setProperty("/inventory", {
                    loaded: true,
                    count: iCount,
                    areaCount: aAreas.length,
                    noun: sNoun,
                    system: sSystem,
                    introText: iCount
                        ? "Your " + sSystem + " offers " + iCount + " " + sNoun + ". " +
                          (bM3 ? "A program is a technical interface with a name like " : "An API is a technical interface with a name like ") + sExample +
                          ". A business object is a thing you migrate, like " + (bM3 ? "Customer or Supplier" : "Business Partner or Material") +
                          ". Here the AI helps to find out which " + sNoun + " belong to which business object."
                        : "Nothing was discovered in " + sSystem + " yet. Connect and discover the source system on step 1 first.",
                    factsText: "Takes about " + iFrom + " to " + iTo + " minutes",
                    areaFilter: [{ key: "", text: "Area: all " + aAreas.length }].concat(aAreas.map(function (sArea) {
                        return { key: sArea, text: (that._mAreaNames[sArea] ? that._mAreaNames[sArea] + " (" + sArea + ")" : sArea) + " - " + mCount[sArea] };
                    }))
                });

                oViewModel.setProperty("/programs", aPrograms);
                this._refreshPrograms();
            },

            /** Shows in the list of programs which business object each one was put in (after a sort or a review). */
            _refreshPrograms: function () {
                var oViewModel = this.getView().getModel("assessment");
                var aPrograms = oViewModel.getProperty("/programs") || [];
                var mWhere = {};

                (oViewModel.getProperty("/groups") || []).forEach(function (oGroup) {
                    (oGroup.apis || []).forEach(function (oApi) {
                        var oWhere = { bo: oGroup.businessObject, status: oApi.reviewStatus };
                        var sProgram = String(oApi.sourceObject).split(".")[0];

                        if (!mWhere[oApi.sourceObject]) { mWhere[oApi.sourceObject] = oWhere; }
                        // a list of a program (M3: PROGRAM.Transaction) puts the program there as well
                        if (oApi.sourceObject.indexOf(".") > 0 && !mWhere[sProgram]) { mWhere[sProgram] = oWhere; }
                    });
                });

                aPrograms.forEach(function (oProgram) {
                    var oWhere = mWhere[oProgram.name];

                    oProgram.sorted = !!oWhere;
                    oProgram.businessObject = oWhere ? oWhere.bo : "";
                    oProgram.boText = oWhere ? oWhere.bo : "Not sorted yet";
                    oProgram.boState = !oWhere ? "None" : oWhere.status === "CONFIRMED" ? "Success" : oWhere.status === "REJECTED" ? "Error" : "Warning";
                });

                oViewModel.setProperty("/programs", aPrograms.slice());
                this._applyProgramFilter();
            },

            _applyProgramFilter: function () {
                var oViewModel = this.getView().getModel("assessment");
                var oTable = this.byId("programTable");
                var oBinding = oTable && oTable.getBinding("items");

                if (!oBinding) { return; }

                var oFilter = oViewModel.getProperty("/programFilter") || {};
                var fnNorm = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); };
                var sQuery = fnNorm(oFilter.query);

                oBinding.filter(sQuery || oFilter.area || oFilter.show !== "ALL" ? [new Filter({
                    path: "",
                    test: function (oProgram) {
                        return (!oFilter.area || oProgram.area === oFilter.area) &&
                            (oFilter.show === "ALL" || (oFilter.show === "SORTED") === oProgram.sorted) &&
                            (!sQuery || fnNorm(oProgram.shown).indexOf(sQuery) >= 0 || fnNorm(oProgram.description).indexOf(sQuery) >= 0);
                    }
                })] : []);

                oViewModel.setProperty("/programFilter/countText",
                    "Showing " + oBinding.getLength() + " of " + (oViewModel.getProperty("/programs") || []).length);
                this._updateSelected();
            },

            onProgramSearch: function (oEvent) {
                this.getView().getModel("assessment").setProperty("/programFilter/query", oEvent.getParameter("newValue"));
                this._applyProgramFilter();
            },

            onProgramFilterChange: function () {
                this._applyProgramFilter();
            },

            onProgramSelection: function () {
                this._updateSelected();
            },

            _updateSelected: function () {
                var oTable = this.byId("programTable");

                this.getView().getModel("assessment").setProperty("/selectedCount", oTable ? oTable.getSelectedContexts().length : 0);
            },

            onProgramPress: function (oEvent) {
                var oProgram = oEvent.getSource().getBindingContext("assessment").getObject();
                var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};

                this._showObjectDetails({ name: oProgram.name, shown: oProgram.shown }, oMigration.sourceSystemId);
            },

            onShowObjects: function () {
                this.getView().getModel("assessment").setProperty("/view", "OBJECTS");
            },

            // the three ways to send programs to the AI
            onSortAll: function () {
                this._sortWith([]);
            },

            onSortSelected: function () {
                var aNames = this.byId("programTable").getSelectedContexts().map(function (oContext) { return oContext.getObject().name; });

                if (!aNames.length) {
                    MessageBox.information("Tick at least one program in the list first.");
                    return;
                }

                this._sortWith(aNames);
            },

            onSortArea: function () {
                var sArea = this.getView().getModel("assessment").getProperty("/programFilter/area");

                if (!sArea) {
                    MessageBox.information("Choose an area in the filter first.");
                    return;
                }

                this._sortWith([sArea]);
            },

            onToggleAreas: function () {
                var oViewModel = this.getView().getModel("assessment");
                var bAll = !oViewModel.getProperty("/inventory/showAll");
                var aAreas = oViewModel.getProperty("/inventory/areas") || [];

                oViewModel.setProperty("/inventory/showAll", bAll);
                oViewModel.setProperty("/inventory/visibleAreas", bAll ? aAreas : aAreas.slice(0, 4));
                oViewModel.setProperty("/inventory/moreText", bAll ? "Show fewer areas" : "Show all " + aAreas.length + " areas");
            },

            // confirm every open program of the selected business object in one go
            onConfirmAll: function () {
                var that = this;
                var oViewModel = this.getView().getModel("assessment");
                var oSelected = oViewModel.getProperty("/selectedBusinessObject") || {};
                var aOpen = (oSelected.apis || []).filter(function (oApi) { return oApi.reviewStatus === "SUGGESTED"; });

                if (!aOpen.length) { return; }

                MessageBox.confirm(
                    "Confirm all " + aOpen.length + " open program(s) / API(s) of '" + oSelected.businessObject + "'?\n\nYou can still reject single ones afterwards.",
                    {
                        title: "Confirm all",
                        actions: ["Confirm all", MessageBox.Action.CANCEL],
                        emphasizedAction: "Confirm all",
                        onClose: async function (sAction) {
                            if (sAction !== "Confirm all") { return; }

                            var oMigration = that.getOwnerComponent().getModel("migrationContext").getData() || {};

                            try {
                                for (var i = 0; i < aOpen.length; i++) {
                                    var oAction = that.getOwnerComponent().getModel().bindContext("/reviewAssessment(...)");
                                    oAction.setParameter("sourceSystemId", oMigration.sourceSystemId);
                                    oAction.setParameter("sourceObject", aOpen[i].sourceObject);
                                    oAction.setParameter("decision", "CONFIRM");
                                    await oAction.execute();
                                }

                                MessageToast.show(aOpen.length + " confirmed.");
                                await that._reloadKeepSelection(oSelected.businessObject);
                            } catch (oError) {
                                MessageBox.error("Confirming failed: " + (oError.message || oError));
                            }
                        }
                    }
                );
            },

            // the "next" bar: the data sets of the selected business object (or the first one that has confirmed programs)
            onChooseDataSets: function () {
                var oViewModel = this.getView().getModel("assessment");

                if (!oViewModel.getProperty("/selectedBusinessObject")) {
                    var oFirst = (oViewModel.getProperty("/groups") || []).find(function (g) { return g.confirmedCount > 0; });

                    if (!oFirst) {
                        MessageBox.information("Confirm at least one program first: click a business object and confirm its programs.");
                        return;
                    }

                    this._selectBusinessObject(oFirst);
                    this._highlightSelectedBusinessObject();
                }

                this.onAddEntitySets();
            },


            // =====================================================
            // WHICH GUIDED STATE THE PAGE IS IN: before / sorting / review
            // =====================================================

            _updatePhase: function () {
                var oViewModel = this.getView().getModel("assessment");
                var aGroups = oViewModel.getProperty("/groups") || [];
                var iApis = 0, iConfirmed = 0, iOpen = 0;

                aGroups.forEach(function (oGroup) {
                    iApis += Number(oGroup.apiCount) || 0;
                    iConfirmed += Number(oGroup.confirmedCount) || 0;
                    iOpen += Number(oGroup.openCount) || 0;
                });

                oViewModel.setProperty("/summaryText",
                    iApis + (iApis === 1 ? " program / API" : " programs / APIs") + " sorted into " +
                    aGroups.length + (aGroups.length === 1 ? " business object" : " business objects") +
                    " - " + iConfirmed + " confirmed, " + iOpen + " to review");

                oViewModel.setProperty("/summary", { sorted: iApis, objects: aGroups.length, confirmed: iConfirmed, open: iOpen });

                var oReady = aGroups.filter(function (g) { return g.confirmedCount > 0; })[0];

                oViewModel.setProperty("/nextText", oReady
                    ? "Next: for the confirmed business objects, choose which data to read. " + oReady.businessObject + " has " + oReady.confirmedCount +
                      " confirmed " + (oReady.confirmedCount === 1 ? "item" : "items") + "."
                    : "Next: open a business object on the left and confirm its programs. Then choose which data to read.");

                var sPhase = oViewModel.getProperty("/scope/assessing") ? "WORKING"
                    : (aGroups.length === 0 || oViewModel.getProperty("/scope/showSort")) ? "BEFORE" : "REVIEW";

                oViewModel.setProperty("/phase", sPhase);
            },

            onSortMore: function () {
                this.getView().getModel("assessment").setProperty("/view", "PROGRAMS");
            },

            onSortBack: function () {
                this.getView().getModel("assessment").setProperty("/scope/showSort", false);
                this._updatePhase();
            },

            // size it first (nothing is sent), then ask, then sort. An empty list means everything.
            _sortWith: async function (aPrefixes) {
                var oViewModel = this.getView().getModel("assessment");

                oViewModel.setProperty("/scope/assessMessage", "");
                oViewModel.setProperty("/scope/prefixes", aPrefixes.join(", "));

                await this.onPreviewScope();

                if (oViewModel.getProperty("/scope/error") || !oViewModel.getProperty("/scope/hasResult")) {
                    return;
                }

                if (!(oViewModel.getProperty("/scope/newToAssess") > 0)) {
                    oViewModel.setProperty("/scope/assessType", "Success");
                    oViewModel.setProperty("/scope/assessMessage",
                        "Nothing new to sort: everything in this selection was sorted before.");
                    return;
                }

                this.onAssessScope();
            },


            // =====================================================
            // STEP 3a: ASSESSMENT SCOPE PREVIEW (no AI call)
            // =====================================================

            onPreviewScope: async function () {

                var oViewModel = this.getView().getModel("assessment");
                var oMigration = (
                    this.getOwnerComponent().getModel("migrationContext").getData() || {}
                );

                if (!oMigration.sourceSystemId) {
                    MessageBox.warning("Please select a source system on the Discovery tab first.");
                    return;
                }

                oViewModel.setProperty("/scope/busy", true);
                oViewModel.setProperty("/scope/error", "");

                try {
                    var oAction = this.getOwnerComponent().getModel()
                        .bindContext("/previewAssessmentScope(...)");

                    this._scopeParameters(oAction);

                    await oAction.execute();

                    var oResult = oAction.getBoundContext().getObject();
                    var aExcluded = JSON.parse(oResult.excluded || "[]");

                    oViewModel.setProperty("/scope/steps", JSON.parse(oResult.steps || "[]"));
                    oViewModel.setProperty("/scope/excluded", aExcluded);
                    oViewModel.setProperty("/scope/excludedCount", aExcluded.length);
                    oViewModel.setProperty("/scope/toAssess", oResult.toAssess);
                    oViewModel.setProperty("/scope/alreadyAssessed", oResult.alreadyAssessed);
                    oViewModel.setProperty("/scope/newToAssess", oResult.newToAssess);
                    oViewModel.setProperty("/scope/batches", oResult.batches);
                    oViewModel.setProperty(
                        "/scope/tokensText",
                        "~" + Number(oResult.estimatedInputTokens).toLocaleString() +
                        " / ~" + Number(oResult.estimatedOutputTokens).toLocaleString()
                    );
                    oViewModel.setProperty("/scope/hasResult", true);

                } catch (oError) {
                    oViewModel.setProperty("/scope/hasResult", false);
                    oViewModel.setProperty("/scope/error", oError.message || String(oError));
                } finally {
                    oViewModel.setProperty("/scope/busy", false);
                }
            },


            // =====================================================
            // STEP 3b: ASSESS WITH AI (only the objects of the scope)
            // =====================================================

            _scopeParameters: function (oAction) {
                var oViewModel = this.getView().getModel("assessment");
                var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};
                var sPrefixes = oViewModel.getProperty("/scope/prefixes") || "";

                oAction.setParameter("sourceSystemId", oMigration.sourceSystemId);
                oAction.setParameter("scopePrefixes", sPrefixes.split(/[\s,;]+/).filter(Boolean));
                oAction.setParameter("businessApisOnly", !!oViewModel.getProperty("/scope/businessApisOnly"));
                oAction.setParameter("readOnly", !!oViewModel.getProperty("/scope/readOnly"));
                oAction.setParameter("includeCustom", !!oViewModel.getProperty("/scope/includeCustom"));
            },

            onAssessScope: function () {
                var that = this;
                var oViewModel = this.getView().getModel("assessment");
                var iNew = oViewModel.getProperty("/scope/newToAssess");
                var sTokens = oViewModel.getProperty("/scope/tokensText");

                MessageBox.confirm(
                    "The AI will sort " + iNew + " program(s) / API(s) into business objects.\n\n" +
                    "Sent: names and descriptions (and field metadata where the source provides it).\n" +
                    "Not sent: any data records.\n" +
                    "Estimated tokens (in / out): " + sTokens + "\n\n" +
                    "A large scope runs in several rounds with progress; you can stop at any time and continue later " +
                    "(what is assessed already is kept and not sent again).",
                    {
                        title: "Sort with AI",
                        actions: ["Sort with AI", MessageBox.Action.CANCEL],
                        emphasizedAction: "Sort with AI",
                        onClose: function (sAction) {
                            if (sAction === "Sort with AI") {
                                that._runAssessScope();
                            }
                        }
                    }
                );
            },

            _runAssessScope: async function () {
                var oViewModel = this.getView().getModel("assessment");
                var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};

                if (!oMigration.sourceSystemId) {
                    MessageBox.warning("Please select a source system on the Discovery tab first.");
                    return;
                }

                oViewModel.setProperty("/scope/busy", true);
                oViewModel.setProperty("/scope/assessing", true);
                oViewModel.setProperty("/scope/showSort", false);
                oViewModel.setProperty("/scope/percent", 0);
                oViewModel.setProperty("/scope/progressText", "Starting...");
                oViewModel.setProperty("/scope/stop", false);
                this._updatePhase();
                oViewModel.setProperty("/scope/error", "");
                oViewModel.setProperty("/scope/assessMessage", "Sorting - this can take a few minutes...");
                oViewModel.setProperty("/scope/assessType", "Information");

                try {
                    // the server assesses a limited number per round and says when more remain: repeat until done,
                    // until nothing more can be assessed, or until the user presses Stop
                    var iTotal = oViewModel.getProperty("/scope/newToAssess") || 0;
                    var iDone = 0;
                    var iRound = 0;
                    var oResult;
                    var bStopped = false;

                    for (;;) {
                        iRound++;
                        oViewModel.setProperty("/scope/assessMessage",
                            "Sorting - round " + iRound + (iTotal ? ", " + iDone + " of " + iTotal + " sorted so far" : "") + "...");

                        var oAction = this.getOwnerComponent().getModel().bindContext("/assessScope(...)");
                        this._scopeParameters(oAction);
                        // short rounds (two AI requests, about 35 seconds): the answer comes back well within the gateway time limit
                        oAction.setParameter("maxObjects", 22);

                        await oAction.execute();

                        oResult = oAction.getBoundContext().getObject();
                        iDone += Number(oResult.objectsAssessed) || 0;
                        oViewModel.setProperty("/scope/percent", iTotal ? Math.min(100, Math.round(iDone * 100 / iTotal)) : 0);
                        oViewModel.setProperty("/scope/progressText", iDone + " of " + iTotal + " sorted");

                        var bMore = /more object\(s\) remain/.test(oResult.message || "");

                        // the groups appear while it runs
                        await this._loadBusinessObjectAssessment();

                        if (oViewModel.getProperty("/scope/stop")) { bStopped = true; break; }
                        if (oResult.status === "FAILED" || !bMore || (Number(oResult.objectsAssessed) || 0) === 0) { break; }
                    }

                    var bFailed = oResult.status === "FAILED";

                    oViewModel.setProperty("/scope/assessMessage",
                        (iRound > 1 || bStopped ? "Sorted " + iDone + " program(s) / API(s) in " + iRound + " round(s)" + (bStopped ? " (stopped by you; press 'Sort programs into business objects' to continue)" : "") + ". " : "") + oResult.message);
                    oViewModel.setProperty("/scope/assessType", bFailed ? "Error" : (bStopped || oResult.status === "PARTIAL" ? "Warning" : "Success"));

                    // refresh the scope numbers and the grouped results
                    oViewModel.setProperty("/scope/busy", false);
                    await this.onPreviewScope();
                    await this._loadBusinessObjectAssessment();
                } catch (oError) {
                    oViewModel.setProperty("/scope/assessMessage", "");
                    oViewModel.setProperty("/scope/error", oError.message || String(oError));
                } finally {
                    oViewModel.setProperty("/scope/busy", false);
                    oViewModel.setProperty("/scope/assessing", false);
                    this._updatePhase();
                }
            },

            onStopAssess: function () {
                this.getView().getModel("assessment").setProperty("/scope/stop", true);
                this.getView().getModel("assessment").setProperty("/scope/assessMessage", "Stopping after the current round...");
            },


            // =====================================================
            // REVIEW OF AN AI PROPOSAL: confirm / reject / change
            // =====================================================

            // =====================================================
            // EXTRACT CONFIRMED APIS TO THE OBJECT STORE
            // =====================================================

            onExtractToObjectStore: function () {
                var that = this;
                var oViewModel = this.getView().getModel("assessment");
                var oGroup = oViewModel.getProperty("/selectedBusinessObject") || {};
                var sMax = oViewModel.getProperty("/extract/maxRecords");

                MessageBox.confirm(
                    "Start the extraction of the " + oGroup.confirmedCount + " confirmed API(s) / entity set(s) of '" + oGroup.businessObject + "'?\n\n" +
                    "The records are read from the source system in the background and stored as files in the Object Store " +
                    (sMax ? "(max " + sMax + " per item)" : "(all records, up to 100,000 per item)") + ". " +
                    "You can leave this page; the progress is shown here and in Joule.\n" +
                    "Nothing is stored in the database.",
                    {
                        title: "Start extraction",
                        actions: ["Start", MessageBox.Action.CANCEL],
                        emphasizedAction: "Start",
                        onClose: function (sAction) {
                            if (sAction === "Start") {
                                that._startExtractionJob();
                            }
                        }
                    }
                );
            },

            // =====================================================
            // BACKGROUND EXTRACTION JOB: start, watch, cancel, resume
            // =====================================================

            _jobCall: async function (sName, mParameters) {
                var oAction = this.getOwnerComponent().getModel().bindContext("/" + sName + "(...)");

                Object.keys(mParameters || {}).forEach(function (sKey) {
                    if (mParameters[sKey] !== undefined && mParameters[sKey] !== null && mParameters[sKey] !== "") {
                        oAction.setParameter(sKey, mParameters[sKey]);
                    }
                });
                await oAction.execute();

                return oAction.getBoundContext().getObject();
            },

            _jobIdentity: function () {
                var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};
                var oGroup = this.getView().getModel("assessment").getProperty("/selectedBusinessObject") || {};

                return { sourceSystemId: oMigration.sourceSystemId, businessObject: oGroup.businessObject };
            },

            /** Puts a job answer of the server into the model of the screen. */
            _applyJob: function (oJob) {
                var oViewModel = this.getView().getModel("assessment");
                var bActive = oJob.status === "QUEUED" || oJob.status === "RUNNING";
                var aObjects = [];

                try { aObjects = JSON.parse(oJob.objects || "[]"); } catch (e) { aObjects = []; }

                var mStates = { DONE: "Success", STOPPED_AT_LIMIT: "Warning", FAILED: "Error", CANCELLED: "Warning", RUNNING: "Information", PENDING: "None" };
                var mText = { DONE: "done", STOPPED_AT_LIMIT: "stopped at the limit", FAILED: "failed", CANCELLED: "cancelled", RUNNING: "reading", PENDING: "waiting" };

                oViewModel.setProperty("/extract/job", {
                    has: true,
                    extractionId: oJob.extractionId,
                    status: oJob.status,
                    active: bActive,
                    resumable: !!oJob.resumable,
                    state: oJob.status === "COMPLETED" ? "Success" : oJob.status === "FAILED" ? "Error" : bActive ? "Information" : "Warning",
                    percentValue: oJob.percent === null || oJob.percent === undefined ? 0 : oJob.percent,
                    displayValue: oJob.percent === null || oJob.percent === undefined
                        ? oJob.totalRecords + " records"
                        : oJob.totalRecords + " of " + oJob.expectedRecords + " records (" + oJob.percent + " %)",
                    message: oJob.message,
                    objects: aObjects.map(function (o) {
                        return {
                            objectName: o.objectName,
                            stateText: mText[o.state] || o.state,
                            state: mStates[o.state] || "None",
                            records: o.records,
                            expected: o.expected === null || o.expected === undefined ? "-" : o.expected
                        };
                    })
                });

                return bActive;
            },

            _stopPolling: function () {
                if (this._jobTimer) {
                    clearTimeout(this._jobTimer);
                    this._jobTimer = null;
                }
            },

            _poll: function () {
                var that = this;

                this._stopPolling();
                this._jobTimer = setTimeout(function () { that._loadJobStatus(); }, 3000);
            },

            /** The latest job of the selected business object (none: the panel stays hidden). */
            _loadJobStatus: async function () {
                var oViewModel = this.getView() && this.getView().getModel("assessment");
                var oId = oViewModel ? this._jobIdentity() : {};

                if (!oViewModel || !oId.businessObject || !oId.sourceSystemId) { return; }

                var bWasActive = !!oViewModel.getProperty("/extract/job/active");

                try {
                    var oJob = await this._jobCall("getExtractionStatus", oId);

                    // another business object was selected meanwhile
                    if (oId.businessObject !== this._jobIdentity().businessObject) { return; }

                    if (this._applyJob(oJob)) {
                        this._poll();
                    } else if (bWasActive) {
                        // the job ended: the list shows the new extraction
                        this._stopPolling();
                        await this._reloadKeepSelection(oId.businessObject);
                    }
                } catch (oError) {
                    this._stopPolling();

                    if (!/No extraction job/.test(oError.message || "")) {
                        oViewModel.setProperty("/extract/job/message", "Could not read the status: " + (oError.message || oError));
                    } else {
                        oViewModel.setProperty("/extract/job", { has: false, active: false, resumable: false, objects: [] });
                    }
                }
            },

            _startExtractionJob: async function () {
                var oViewModel = this.getView().getModel("assessment");
                var iMax = parseInt(oViewModel.getProperty("/extract/maxRecords"), 10);

                oViewModel.setProperty("/extract/busy", true);
                oViewModel.setProperty("/extract/message", "");

                try {
                    var oJob = await this._jobCall("startExtraction", Object.assign({}, this._jobIdentity(), { maxRecordsPerObject: iMax > 0 ? iMax : undefined }));

                    oViewModel.setProperty("/extract/lastId", oJob.extractionId);
                    this._applyJob(oJob);
                    this._poll();
                } catch (oError) {
                    oViewModel.setProperty("/extract/type", "Error");
                    oViewModel.setProperty("/extract/message", oError.message || String(oError));
                } finally {
                    oViewModel.setProperty("/extract/busy", false);
                }
            },

            onCancelExtraction: async function () {
                var oViewModel = this.getView().getModel("assessment");

                try {
                    this._applyJob(await this._jobCall("cancelExtraction", { extractionId: oViewModel.getProperty("/extract/job/extractionId") }));
                    this._poll();
                } catch (oError) {
                    MessageBox.error(oError.message || String(oError));
                }
            },

            onResumeExtraction: async function () {
                var oViewModel = this.getView().getModel("assessment");

                try {
                    this._applyJob(await this._jobCall("resumeExtraction", { extractionId: oViewModel.getProperty("/extract/job/extractionId") }));
                    this._poll();
                } catch (oError) {
                    MessageBox.error(oError.message || String(oError));
                }
            },

            onExit: function () {
                this._stopPolling();
            },

            onVerifyExtraction: async function () {
                var oViewModel = this.getView().getModel("assessment");

                oViewModel.setProperty("/extract/busy", true);

                try {
                    // the latest extraction of the selected business object
                    var oLast = oViewModel.getProperty("/selectedBusinessObject/lastExtraction") || {};
                    var oAction = this.getOwnerComponent().getModel().bindContext("/verifyExtraction(...)");
                    oAction.setParameter("extractionId", oLast.extractionId || oViewModel.getProperty("/extract/lastId"));

                    await oAction.execute();

                    var oResult = oAction.getBoundContext().getObject();

                    oViewModel.setProperty("/extract/type", oResult.status === "OK" ? "Success" : "Error");
                    oViewModel.setProperty("/extract/message", "Verification of " + oResult.extractionId + ": " + oResult.message);
                } catch (oError) {
                    oViewModel.setProperty("/extract/type", "Error");
                    oViewModel.setProperty("/extract/message", oError.message || String(oError));
                } finally {
                    oViewModel.setProperty("/extract/busy", false);
                }
            },

            onReviewFilterChange: function () {
                this._applyReviewFilter();
            },

            // keeps the chosen status filter when another business object is selected or after a review
            _applyReviewFilter: function () {
                var that = this;

                setTimeout(function () {
                    var oTable = that.byId("businessObjectApiTable");
                    var oFilter = that.byId("reviewFilter");
                    var oBinding = oTable && oTable.getBinding("items");

                    if (!oBinding || !oFilter) { return; }

                    var sKey = oFilter.getSelectedKey();

                    oBinding.filter(sKey && sKey !== "ALL"
                        ? [new Filter("reviewStatus", FilterOperator.EQ, sKey)]
                        : []);
                }, 0);
            },

            _apiOfEvent: function (oEvent) {
                var oContext = oEvent.getSource().getBindingContext("assessment");
                return oContext ? oContext.getObject() : null;
            },

            onReviewConfirm: function (oEvent) {
                var oApi = this._apiOfEvent(oEvent);
                if (oApi) { this._review(oApi.sourceObject, "CONFIRM"); }
            },

            onReviewReject: function (oEvent) {
                var that = this;
                var oApi = this._apiOfEvent(oEvent);
                if (!oApi) { return; }

                var oReason = this._reasonField("e.g. not part of this business object - confirmed by client on 3 Oct");

                var oDialog = new Dialog({
                    title: "Reject API",
                    contentWidth: "28rem",
                    content: [
                        new Text({ text: oApi.sourceObject + " will not be extracted for this business object. Why?" }).addStyleClass("sapUiSmallMargin"),
                        oReason.addStyleClass("sapUiSmallMarginBeginEnd sapUiSmallMarginBottom")
                    ],
                    beginButton: new Button({
                        text: "Reject",
                        type: "Reject",
                        press: function () {
                            oDialog.close();
                            that._review(oApi.sourceObject, "REJECT", null, oReason.getValue());
                        }
                    }),
                    endButton: new Button({ text: "Cancel", press: function () { oDialog.close(); } }),
                    afterClose: function () { oDialog.destroy(); }
                });

                oDialog.open();
            },

            /** Reason text for a review decision - saved with the decision (who / when / why). */
            _reasonField: function (sPlaceholder) {
                return new TextArea({ placeholder: sPlaceholder, width: "100%", rows: 2, maxLength: 1000 });
            },

            // =====================================================
            // ADD THE ENTITY SETS OF THE CONFIRMED APIS (addresses, roles, banks ...)
            // =====================================================

            onAddEntitySets: function () {
                var that = this;
                var sTarget = (this.getView().getModel("assessment").getProperty("/selectedBusinessObject") || {}).businessObject;

                if (!sTarget) { return; }

                MessageBox.confirm(
                    "Add the entity sets / transactions of the confirmed API(s) / program(s) of '" + sTarget + "'?\n\n" +
                    "The source system is asked what each one holds (nothing is extracted yet). " +
                    "S/4: the entity sets that hold data are added. M3: the lists that can be read as a whole are added; " +
                    "lists that need a value in every call (for example a customer number) are named and read later. " +
                    "Everything is added as confirmed; you can reject any of it afterwards.",
                    {
                        title: "Add entity sets",
                        actions: ["Add", MessageBox.Action.CANCEL],
                        emphasizedAction: "Add",
                        onClose: function (sAction) {
                            if (sAction === "Add") { that._addEntitySets(sTarget); }
                        }
                    }
                );
            },

            _addEntitySets: async function (sBusinessObject) {
                var oViewModel = this.getView().getModel("assessment");
                var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};

                oViewModel.setProperty("/extract/busy", true);
                oViewModel.setProperty("/extract/type", "Information");
                oViewModel.setProperty("/extract/message", "Counting the records of every entity set in the source system...");

                try {
                    var oAction = this.getOwnerComponent().getModel().bindContext("/addEntitySets(...)");

                    oAction.setParameter("sourceSystemId", oMigration.sourceSystemId);
                    oAction.setParameter("businessObject", sBusinessObject);
                    await oAction.execute();

                    var oResult = oAction.getBoundContext().getObject();

                    oViewModel.setProperty("/extract/type", oResult.added > 0 ? "Success" : "Information");
                    oViewModel.setProperty("/extract/message", oResult.message);
                    await this._reloadKeepSelection(sBusinessObject);
                } catch (oError) {
                    oViewModel.setProperty("/extract/type", "Error");
                    oViewModel.setProperty("/extract/message", oError.message || String(oError));
                } finally {
                    oViewModel.setProperty("/extract/busy", false);
                }
            },

            // =====================================================
            // ALL DISCOVERED PROGRAMS / APIS OF THE SOURCE SYSTEM (read only)
            // =====================================================

            /** Reads all rows of a list: the server answers at most 1000 rows per request, so it is read in pages. */
            _readAllRows: async function (sPath, aFilters) {
                var aRows = [];
                var iPage = 1000;

                for (var iStart = 0; ; iStart += iPage) {
                    var oBinding = this.getOwnerComponent().getModel().bindList(sPath, null, null, aFilters);
                    var aContexts = await oBinding.requestContexts(iStart, iPage);

                    aRows = aRows.concat(aContexts.map(function (oContext) { return oContext.getObject(); }));

                    if (aContexts.length < iPage) { break; }
                }

                return aRows;
            },

            onShowDiscovered: async function () {
                var that = this;
                var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};

                if (!oMigration.sourceSystemUUID) {
                    MessageBox.information("Select a source system on step 1 first.");
                    return;
                }

                // where each object sits today (business object proposed or confirmed)
                var mWhere = {};

                ((this.getView().getModel("assessment").getProperty("/groups")) || []).forEach(function (oGroup) {
                    (oGroup.apis || []).forEach(function (oApi) { mWhere[oApi.sourceObject] = oGroup.businessObject; });
                });

                var aObjects;

                try {
                    aObjects = (await this._readAllRows("/SourceObjects", [new Filter("sourceSystem_ID", FilterOperator.EQ, oMigration.sourceSystemUUID)]))
                        .map(function (oObject) {
                            var sName = String(oObject.objectName || "").replace(/_0001$/, "");

                            return {
                                name: oObject.objectName,
                                shown: sName,
                                description: oObject.description || "",
                                type: oObject.objectType || "",
                                prefix: that._namePrefix(sName),
                                where: mWhere[oObject.objectName] ? "in: " + mWhere[oObject.objectName] : "not assigned yet"
                            };
                        })
                        .sort(function (a, b) { return a.shown.localeCompare(b.shown); });
                } catch (oError) {
                    MessageBox.error("Could not read the discovered objects: " + (oError.message || oError));
                    return;
                }

                // what the entries are called in this source (one line per source type; a new source adds one line)
                var mTypeText = {
                    ODATA_SERVICE: "OData services (APIs)",
                    M3_MI_PROGRAM: "API programs (MI programs)"
                };
                var aTypes = [];

                aObjects.forEach(function (o) {
                    var sText = mTypeText[o.type] || "objects (APIs / programs)";

                    if (aTypes.indexOf(sText) < 0) { aTypes.push(sText); }
                });

                var sSystem = oMigration.sourceSystemId || "the source system";

                var oIntro = new Text({
                    text: "These are the " + aTypes.join(" and ") + " found in " + sSystem + ". " +
                        "The list shows names and descriptions only: no business data was read. " +
                        "Click an entry to see what it offers. " +
                        "Next step: put the entries that belong together into one business object. " +
                        "Use 'Preview Scope' and 'Assess with AI' on the page, or add an entry by hand to a business object."
                }).addStyleClass("sapUiSmallMargin");

                // the name prefix groups (S/4: API, MD ...; M3: CRS, OIS ...), with counts
                var mCount = {};

                aObjects.forEach(function (o) { mCount[o.prefix] = (mCount[o.prefix] || 0) + 1; });

                var aPrefixes = Object.keys(mCount).sort(function (a, b) { return mCount[b] - mCount[a] || a.localeCompare(b); }).slice(0, 30);
                var oArea = new Select({ width: "14rem" });

                oArea.addItem(new Item({ key: "", text: "All (" + aObjects.length + ")" }));
                aPrefixes.forEach(function (sPrefix) {
                    oArea.addItem(new Item({ key: sPrefix, text: sPrefix + " (" + mCount[sPrefix] + ")" }));
                });

                var oList = new List({
                    growing: true,
                    growingThreshold: 50,
                    noDataText: "Nothing found.",
                    items: {
                        path: "/objects",
                        template: new StandardListItem({
                            title: "{shown}", description: "{description}", info: "{where}", infoState: "None",
                            type: "Active",
                            press: function (oEvent) { that._showObjectDetails(oEvent.getSource().getBindingContext().getObject(), sSystem); }
                        })
                    }
                });

                oList.setModel(new JSONModel({ objects: aObjects }));

                var fnNorm = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); };
                var oSearch = new SearchField({
                    placeholder: "Search " + aObjects.length + " entries (name or description)",
                    width: "100%",
                    liveChange: function () { fnFilter(); }
                });

                // search and area together; case, spaces and underscores are ignored
                var fnFilter = function () {
                    var sQuery = fnNorm(oSearch.getValue());
                    var sArea = oArea.getSelectedKey();

                    oList.getBinding("items").filter(sQuery || sArea ? [new Filter({
                        path: "",
                        test: function (oObject) {
                            return (!sArea || oObject.prefix === sArea) &&
                                (!sQuery || fnNorm(oObject.shown).indexOf(sQuery) >= 0 || fnNorm(oObject.description).indexOf(sQuery) >= 0);
                        }
                    })] : []);
                };

                oArea.attachChange(fnFilter);

                var oDialog = new Dialog({
                    title: "Discovered in " + sSystem + " (" + aObjects.length + ")",
                    contentWidth: "52rem",
                    contentHeight: "36rem",
                    content: [
                        oIntro,
                        new HBox({ alignItems: "Center", items: [oArea.addStyleClass("sapUiSmallMarginBegin sapUiSmallMarginEnd"), oSearch] }).addStyleClass("sapUiSmallMarginEnd"),
                        oList
                    ],
                    endButton: new Button({ text: "Close", press: function () { oDialog.close(); } }),
                    afterClose: function () { oDialog.destroy(); }
                });

                oDialog.open();
            },

            /** The part of a name that tells the area: API_BANK -> API, /DCO/UI_X -> /DCO/, CRS610MI -> CRS. */
            _namePrefix: function (sName) {
                var sClean = String(sName || "");
                var aNamespace = sClean.match(/^(\/[^/]+\/)/);

                if (aNamespace) { return aNamespace[1]; }

                return sClean.indexOf("_") > 0 ? sClean.split("_")[0] : sClean.slice(0, 3);
            },

            /** What one entry offers (asks the server; the answer is in the words of the source). */
            _showObjectDetails: async function (oEntry, sSystem) {
                var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};
                var oBusy = new BusyIndicator({ size: "2rem" }).addStyleClass("sapUiMediumMargin");
                var oBody = new VBox({ items: [oBusy] });
                var oDialog = new Dialog({
                    title: oEntry.shown,
                    contentWidth: "44rem",
                    content: [oBody],
                    endButton: new Button({ text: "Close", press: function () { oDialog.close(); } }),
                    afterClose: function () { oDialog.destroy(); }
                });

                oDialog.open();

                try {
                    var oAction = this.getOwnerComponent().getModel().bindContext("/describeSourceObject(...)");

                    oAction.setParameter("sourceSystemId", oMigration.sourceSystemId);
                    oAction.setParameter("objectName", oEntry.name);
                    await oAction.execute();

                    var oResult = oAction.getBoundContext().getObject();
                    var aItems = JSON.parse(oResult.items || "[]");
                    var mKind = { LIST: "reads a list of records", GET: "reads one record", SEARCH: "looks records up", ENTITY_SET: "" };
                    var oModel = new JSONModel({
                        rows: aItems.map(function (o) {
                            return { name: o.name, description: [mKind[o.kind], o.description].filter(Boolean).join(" · "), kind: o.kind };
                        })
                    });
                    var oList = new List({
                        growing: true, growingThreshold: 40, noDataText: "Nothing listed.",
                        items: { path: "/rows", template: new StandardListItem({ title: "{name}", description: "{description}", info: "{kind}", infoState: "None" }) }
                    });

                    oList.setModel(oModel);
                    oBody.removeAllItems();
                    oBody.addItem(new Text({ text: oEntry.description || oResult.description || "(no description in the source)" }).addStyleClass("sapUiSmallMargin"));
                    oBody.addItem(new Text({ text: (oResult.itemLabel || "Contents") + " (" + aItems.length + ")" }).addStyleClass("sapUiSmallMarginBeginEnd sapUiTinyMarginTop"));
                    oBody.addItem(oList);

                    if (oResult.hiddenCount > 0) {
                        oBody.addItem(new Text({ text: oResult.hiddenCount + " more that change data are not shown and are never used." }).addStyleClass("sapUiSmallMargin"));
                    }

                    if (oResult.note) {
                        oBody.addItem(new Text({ text: oResult.note }).addStyleClass("sapUiSmallMargin"));
                    }
                } catch (oError) {
                    oBody.removeAllItems();
                    oBody.addItem(new Text({ text: "Could not read what this entry offers from " + sSystem + ": " + (oError.message || oError) }).addStyleClass("sapUiSmallMargin"));
                }
            },

            // =====================================================
            // ADD AN API BY HAND (any discovered API of the source)
            // =====================================================

            onAddApi: async function () {
                var that = this;
                var oViewModel = this.getView().getModel("assessment");
                var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};
                var sTarget = (oViewModel.getProperty("/selectedBusinessObject") || {}).businessObject;

                if (!sTarget) { return; }

                // where each API sits today (AI proposal or earlier decision)
                var mWhere = {};
                (oViewModel.getProperty("/groups") || []).forEach(function (oGroup) {
                    (oGroup.apis || []).forEach(function (oApi) { mWhere[oApi.sourceObject] = oGroup.businessObject; });
                });

                var aApis;

                try {
                    aApis = (await this._readAllRows("/SourceObjects", [new Filter("sourceSystem_ID", FilterOperator.EQ, oMigration.sourceSystemUUID)]))
                        .filter(function (oObject) { return mWhere[oObject.objectName] !== sTarget; })
                        .map(function (oObject) {
                            return {
                                name: oObject.objectName,
                                description: oObject.description || "",
                                where: mWhere[oObject.objectName] ? "now in: " + mWhere[oObject.objectName] : "not assessed"
                            };
                        })
                        .sort(function (a, b) { return a.name.localeCompare(b.name); });
                } catch (oError) {
                    MessageBox.error("Could not read the discovered APIs: " + (oError.message || oError));
                    return;
                }

                var oList = new List({
                    mode: "SingleSelectMaster",
                    growing: true,
                    growingThreshold: 30,
                    noDataText: "No API found.",
                    items: {
                        path: "/apis",
                        template: new StandardListItem({ title: "{name}", description: "{description}", info: "{where}" })
                    }
                });
                oList.setModel(new JSONModel({ apis: aApis }));

                var oSearch = new SearchField({
                    placeholder: "Search " + aApis.length + " discovered APIs",
                    liveChange: function (oEvent) {
                        // "customer master" finds MD_CUSTOMER_MASTER_SRV_01: case, spaces and underscores are ignored
                        var fnNorm = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); };
                        var sQuery = fnNorm(oEvent.getParameter("newValue"));
                        oList.getBinding("items").filter(sQuery ? [new Filter({
                            path: "",
                            test: function (oApi) {
                                return fnNorm(oApi.name).indexOf(sQuery) >= 0 || fnNorm(oApi.description).indexOf(sQuery) >= 0;
                            }
                        })] : []);
                    }
                });

                var oReason = this._reasonField("Why does it belong here? e.g. confirmed by client on 3 Oct");

                var oDialog = new Dialog({
                    title: "Add API to " + sTarget,
                    contentWidth: "40rem",
                    contentHeight: "32rem",
                    content: [
                        oSearch.addStyleClass("sapUiSmallMargin"),
                        oList,
                        new Text({ text: "Reason" }).addStyleClass("sapUiSmallMarginBeginEnd sapUiSmallMarginTop"),
                        oReason.addStyleClass("sapUiSmallMarginBeginEnd sapUiSmallMarginBottom")
                    ],
                    beginButton: new Button({
                        text: "Add and confirm",
                        type: "Emphasized",
                        press: function () {
                            var oItem = oList.getSelectedItem();
                            if (!oItem) { MessageToast.show("Select an API first."); return; }
                            oDialog.close();
                            that._review(oItem.getTitle(), "ADD", sTarget, oReason.getValue());
                        }
                    }),
                    endButton: new Button({ text: "Cancel", press: function () { oDialog.close(); } }),
                    afterClose: function () { oDialog.destroy(); }
                });

                oDialog.open();
            },

            onReviewChange: function (oEvent) {
                var that = this;
                var oApi = this._apiOfEvent(oEvent);
                if (!oApi) { return; }

                var oInput = new Input({
                    placeholder: "e.g. Business Partner",
                    width: "100%",
                    value: this.getView().getModel("assessment").getProperty("/selectedBusinessObject/businessObject")
                });

                var oReason = this._reasonField("Why? e.g. confirmed by client on 3 Oct");

                var oDialog = new Dialog({
                    title: "Change business object",
                    contentWidth: "28rem",
                    content: [
                        new Text({ text: "Which business object does " + oApi.sourceObject + " belong to?" }).addStyleClass("sapUiSmallMargin"),
                        oInput.addStyleClass("sapUiSmallMarginBeginEnd sapUiSmallMarginBottom"),
                        new Text({ text: "Reason" }).addStyleClass("sapUiSmallMarginBeginEnd"),
                        oReason.addStyleClass("sapUiSmallMarginBeginEnd sapUiSmallMarginBottom")
                    ],
                    beginButton: new Button({
                        text: "Confirm as this object",
                        type: "Emphasized",
                        press: function () {
                            var sName = (oInput.getValue() || "").trim();
                            if (!sName) { oInput.setValueState("Error"); return; }
                            oDialog.close();
                            that._review(oApi.sourceObject, "CHANGE", sName, oReason.getValue());
                        }
                    }),
                    endButton: new Button({
                        text: "Cancel",
                        press: function () { oDialog.close(); }
                    }),
                    afterClose: function () { oDialog.destroy(); }
                });

                oDialog.open();
            },

            _review: async function (sSourceObject, sDecision, sBusinessObject, sComment) {
                var oViewModel = this.getView().getModel("assessment");
                var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};

                try {
                    var oAction = this.getOwnerComponent().getModel().bindContext("/reviewAssessment(...)");
                    oAction.setParameter("sourceSystemId", oMigration.sourceSystemId);
                    oAction.setParameter("sourceObject", sSourceObject);
                    oAction.setParameter("decision", sDecision);
                    if (sBusinessObject) { oAction.setParameter("businessObject", sBusinessObject); }
                    if (sComment && sComment.trim()) { oAction.setParameter("comment", sComment.trim()); }

                    await oAction.execute();

                    MessageToast.show(oAction.getBoundContext().getObject().value);

                    // reload and stay on the business object being reviewed
                    await this._reloadKeepSelection(sBusinessObject ||
                        (oViewModel.getProperty("/selectedBusinessObject") || {}).businessObject);
                } catch (oError) {
                    MessageBox.error("Review failed: " + (oError.message || oError));
                }
            },

            /** Reloads the list (counts, extractions) and selects the given business object again. */
            _reloadKeepSelection: async function (sBusinessObject) {
                var oViewModel = this.getView().getModel("assessment");

                await this._loadBusinessObjectAssessment();

                var oGroup = (oViewModel.getProperty("/groups") || []).find(function (g) {
                    return g.businessObject === sBusinessObject;
                });

                if (oGroup) {
                    this._selectBusinessObject(oGroup);
                } else {
                    oViewModel.setProperty("/selectedBusinessObject", null);
                }

                this._highlightSelectedBusinessObject();
            },

            /**
             * What the Extract tab shows: the confirmed APIs, what the last extraction
             * contained for each of them, and whether the confirmed APIs changed since.
             */
            _extractPlan: function (oGroup) {
                var oLast = oGroup.lastExtraction;
                var aLastObjects = [];

                try { aLastObjects = oLast ? JSON.parse(oLast.objects || "[]") : []; } catch (e) { aLastObjects = []; }

                var aConfirmed = (oGroup.apis || []).filter(function (oApi) { return oApi.reviewStatus === "CONFIRMED"; });

                var aRows = aConfirmed.map(function (oApi) {
                    var oIn = aLastObjects.find(function (o) { return o.objectName === oApi.sourceObject; });
                    var sText, sState;

                    if (!oLast) { sText = "not extracted yet"; sState = "None"; }
                    else if (!oIn) { sText = "not in the last extraction"; sState = "Warning"; }
                    else if (oIn.error) { sText = "failed: " + oIn.error; sState = "Error"; }
                    else if (oIn.truncated) { sText = oIn.records + " records, stopped at the limit"; sState = "Warning"; }
                    else { sText = oIn.records + " records, complete"; sState = "Success"; }

                    return {
                        api: oApi.sourceObject,
                        origin: oApi.origin === "MANUAL" ? "Added by hand" : oApi.origin === "ENTITY_SET" ? "Entity set of an API" : oApi.originalBusinessObject ? "Moved by hand" : "Proposed by AI",
                        lastText: sText,
                        lastState: sState
                    };
                });

                var aConfirmedNames = aConfirmed.map(function (oApi) { return oApi.sourceObject; });
                var aMissing = aConfirmedNames.filter(function (s) { return !aLastObjects.some(function (o) { return o.objectName === s; }); });
                var aNoLonger = aLastObjects.map(function (o) { return o.objectName; })
                    .filter(function (s) { return aConfirmedNames.indexOf(s) < 0; });

                var sChange = "";
                if (oLast && (aMissing.length || aNoLonger.length)) {
                    sChange = "The confirmed APIs changed after the last extraction." +
                        (aMissing.length ? " Not included yet: " + aMissing.join(", ") + "." : "") +
                        (aNoLonger.length ? " No longer confirmed but in the last extraction: " + aNoLonger.join(", ") + "." : "") +
                        " Extract again to bring it up to date.";
                }

                return {
                    rows: aRows,
                    changeText: sChange,
                    lastText: oLast
                        ? new Date(oLast.startedAt).toLocaleString() + " · " + oLast.totalRecords + " records"
                        : ""
                };
            },


            // =====================================================
            // BUSINESS OBJECT CLICK
            // =====================================================

            // a row of the list on the left was selected
            onBusinessObjectSelect: function (oEvent) {
                var oItem = oEvent.getParameter("listItem");
                var oContext = oItem && oItem.getBindingContext("assessment");

                if (oContext) {
                    this._selectBusinessObject(oContext.getObject());
                }
            },

            onBusinessObjectPress: function (oEvent) {
                var oContext = oEvent.getSource().getBindingContext("assessment");

                if (oContext) {
                    this._selectBusinessObject(oContext.getObject());
                }
            },

            _selectBusinessObject: function (oBusinessObject) {
                oBusinessObject.extractPlan = this._extractPlan(oBusinessObject);
                this.getView().getModel("assessment").setProperty("/selectedBusinessObject", oBusinessObject);

                // a job of this business object may be running (also one started in Joule)
                this._stopPolling();
                this.getView().getModel("assessment").setProperty("/extract/job", { has: false, active: false, resumable: false, objects: [] });
                this._loadJobStatus();

                // shown in the header of every page
                this.getOwnerComponent().getModel("migrationContext")
                    .setProperty("/assessedBusinessObject", oBusinessObject.businessObject);

                this._applyReviewFilter();
            },

            // =====================================================
            // LIST ON THE LEFT: search, catalog filter, selection
            // =====================================================

            onBusinessObjectListFilter: function () {
                this._applyBusinessObjectListFilter();
            },

            _applyBusinessObjectListFilter: function () {
                var oBinding = this.byId("businessObjectTable").getBinding("items");
                var fnNorm = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); };
                var sQuery = fnNorm(this.byId("businessObjectSearch").getValue());
                var aFilters = [];

                if (!oBinding) { return; }

                if (sQuery) {
                    aFilters.push(new Filter({
                        path: "businessObject",
                        test: function (sName) { return fnNorm(sName).indexOf(sQuery) >= 0; }
                    }));
                }

                if (this.byId("catalogFilter").getSelectedKey() === "CATALOG") {
                    aFilters.push(new Filter("inCatalog", FilterOperator.EQ, true));
                }

                oBinding.filter(aFilters);
                this._highlightSelectedBusinessObject();
            },

            // keeps the selected business object highlighted after a reload or filter
            _highlightSelectedBusinessObject: function () {
                var oTable = this.byId("businessObjectTable");
                var sSelected = (this.getView().getModel("assessment").getProperty("/selectedBusinessObject") || {}).businessObject;

                oTable.removeSelections(true);

                oTable.getItems().forEach(function (oItem) {
                    var oContext = oItem.getBindingContext("assessment");
                    if (oContext && oContext.getObject().businessObject === sSelected) {
                        oTable.setSelectedItem(oItem);
                    }
                });
            },

            /** Latest extraction per business object, from the Object Store (empty if it cannot be read). */
            _latestExtractions: async function (sSourceSystemId) {
                var mLatest = {};

                try {
                    var oAction = this.getOwnerComponent().getModel().bindContext("/listExtractions(...)");
                    oAction.setParameter("sourceSystemId", sSourceSystemId);
                    await oAction.execute();

                    // newest first
                    (oAction.getBoundContext().getObject().value || []).forEach(function (oExtraction) {
                        if (oExtraction.businessObject && !mLatest[oExtraction.businessObject]) {
                            mLatest[oExtraction.businessObject] = oExtraction;
                        }
                    });
                } catch (oError) {
                    console.warn("Extractions could not be read:", oError);
                }

                return mLatest;
            },


            // =====================================================
            // REFRESH
            // =====================================================

            onRefresh: async function () {

                await this._loadBusinessObjectAssessment();

                MessageToast.show(
                    "Business Object Assessment refreshed."
                );
            },


            // =====================================================
            // NAVIGATION
            // =====================================================

            onNavigateDiscovery: function () {

                this
                    .getOwnerComponent()
                    .getRouter()
                    .navTo(
                        "RouteView1"
                    );
            },


            onNavigateAssessment: function () {

                this
                    .getOwnerComponent()
                    .getRouter()
                    .navTo(
                        "BusinessObjectAssessment"
                    );
            },


            onNavigateSource: function () {

                this
                    .getOwnerComponent()
                    .getRouter()
                    .navTo(
                        "SourceUnderstanding"
                    );
            },


            onNavigateExtraction: function () {

                this
                    .getOwnerComponent()
                    .getRouter()
                    .navTo(
                        "CatalogView"
                    );
            },


            onNavigateData: function () {

                this
                    .getOwnerComponent()
                    .getRouter()
                    .navTo(
                        "DataProfiling"
                    );
            },


            onNavigateMapping: function () {

                this
                    .getOwnerComponent()
                    .getRouter()
                    .navTo(
                        "TargetMapping"
                    );
            },


            onNavigateRun: function () {

                this
                    .getOwnerComponent()
                    .getRouter()
                    .navTo(
                        "RunDetails"
                    );
            },


            onBackToDiscovery: function () {

                this
                    .getOwnerComponent()
                    .getRouter()
                    .navTo(
                        "RouteView1"
                    );
            },


            /**
             * Source Understanding works on ONE business object: its confirmed APIs,
             * their fields and the records extracted to the Object Store.
             * The choice is handed over in the migrationContext model.
             */
            onContinueToSource: function () {

                var oViewModel = this.getView().getModel("assessment");
                var oGroup = oViewModel.getProperty("/selectedBusinessObject");

                if (!oGroup) {
                    MessageBox.information(
                        "Select a business object in the list first (click its row). " +
                        "Source Understanding shows the confirmed APIs of that business object, their fields and the extracted records."
                    );
                    return;
                }

                var aConfirmed = (oGroup.apis || [])
                    .filter(function (oApi) { return oApi.reviewStatus === "CONFIRMED"; })
                    .map(function (oApi) { return oApi.sourceObject; });

                if (aConfirmed.length === 0) {
                    MessageBox.warning(
                        "No API of '" + oGroup.businessObject + "' is confirmed yet. " +
                        "Confirm at least one API in the review list - only confirmed APIs go to the next steps."
                    );
                    return;
                }

                var oContext = this.getOwnerComponent().getModel("migrationContext");

                oContext.setProperty("/assessedBusinessObject", oGroup.businessObject);
                oContext.setProperty("/confirmedApis", aConfirmed);
                oContext.setProperty("/businessObject", aConfirmed[0]);
                oContext.setProperty("/lastExtractionId", oViewModel.getProperty("/extract/lastId") || "");

                this
                    .getOwnerComponent()
                    .getRouter()
                    .navTo(
                        "SourceUnderstanding"
                    );
            }

        }
    );
});