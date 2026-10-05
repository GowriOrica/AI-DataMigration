sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/Sorter",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/Label",
    "sap/m/Input",
    "sap/m/Select",
    "sap/m/VBox",
    "sap/ui/core/Item"
], function (Controller, JSONModel, Filter, Sorter, MessageToast, MessageBox, Dialog, Button, Label, Input, Select, VBox, Item) {
    "use strict";

    // rule types by group (the server checks every rule again: srv/lib/cleansing/RuleCatalog.js)
    var RULE_TYPES = [
        ["Standardise", "TRIM"], ["Standardise", "UPPER"], ["Standardise", "LOWER"], ["Standardise", "TITLE"],
        ["Standardise", "DATE_TO_ISO"], ["Standardise", "REPLACE"], ["Convert", "VALUE_MAP"], ["Default", "DEFAULT"],
        ["Derive", "CONCAT"], ["Select", "INCLUDE_IF"], ["Select", "EXCLUDE_IF"], ["Validate", "REQUIRED"],
        ["Validate", "MATCHES"], ["Validate", "MAX_LENGTH"], ["Validate", "ALLOWED_VALUES"]
    ];

    /**
     * Cleansing rules of one business object: versions, rules, change (draft only), approve and the preview of
     * the effect on the extracted data. Every change is a server action; Joule uses the same actions.
     */
    return Controller.extend("project1.controller.Cleansing", {

        onInit: function () {
            this.getView().setModel(new JSONModel({
                busy: false, ready: false, message: "", messageType: "Information",
                sets: [], selectedSetId: "", current: {}, rules: [], preview: { ready: false, rows: [] }
            }), "cleansing");

            this.getOwnerComponent().getRouter().getRoute("Cleansing").attachPatternMatched(function () { this._load(); }, this);
        },

        _model: function () { return this.getView().getModel("cleansing"); },

        _business: function () {
            return (this.getOwnerComponent().getModel("migrationContext").getData() || {}).assessedBusinessObject;
        },

        _call: async function (sName, mParameters) {
            var oAction = this.getOwnerComponent().getModel().bindContext("/" + sName + "(...)");

            Object.keys(mParameters || {}).forEach(function (sKey) {
                if (mParameters[sKey] !== undefined && mParameters[sKey] !== null && mParameters[sKey] !== "") {
                    oAction.setParameter(sKey, mParameters[sKey]);
                }
            });
            await oAction.execute();

            return oAction.getBoundContext().getObject();
        },

        _read: async function (sPath, aFilters, sSort) {
            var oList = this.getOwnerComponent().getModel().bindList(sPath, null, sSort ? [new Sorter(sSort, false)] : [], aFilters);
            var aContexts = await oList.requestContexts(0, 500);

            return aContexts.map(function (oContext) { return oContext.getObject(); });
        },

        _state: function (sStatus) { return sStatus === "APPROVED" ? "Success" : sStatus === "DRAFT" ? "Warning" : "None"; },

        _say: function (sText, sType) {
            this._model().setProperty("/message", sText || "");
            this._model().setProperty("/messageType", sType || "Information");
        },

        // =========================================================
        // LOAD
        // =========================================================
        _load: async function (sKeepId) {
            var oModel = this._model();
            var sBusiness = this._business();

            oModel.setProperty("/preview", { ready: false, rows: [] });

            if (!sBusiness) {
                oModel.setProperty("/ready", false);
                oModel.setProperty("/sets", []);
                oModel.setProperty("/rules", []);
                oModel.setProperty("/selectedSetId", "");
                this._say("Select a business object on step 2 (Business Objects) first. The rules belong to one business object.");
                return;
            }

            oModel.setProperty("/busy", true);

            try {
                var aSets = await this._read("/CleansingRuleSets", [new Filter("businessObject", "EQ", sBusiness)], "version");

                oModel.setProperty("/ready", true);
                oModel.setProperty("/sets", aSets.map(function (oSet) {
                    return Object.assign({}, oSet, { text: "Version " + oSet.version + " · " + oSet.status + " · " + (oSet.ruleCount || 0) + " rules" });
                }));

                if (aSets.length === 0) {
                    oModel.setProperty("/selectedSetId", "");
                    oModel.setProperty("/current", {});
                    oModel.setProperty("/rules", []);
                    this._say("No cleansing rules for '" + sBusiness + "' yet. Press 'Add rule' to start the first version. The import of the functional team's Excel template into this screen comes next.");
                } else {
                    var oPick = (typeof sKeepId === "string" && aSets.find(function (s) { return s.ID === sKeepId; })) ||
                        aSets.find(function (s) { return s.status === "DRAFT"; }) ||
                        aSets.find(function (s) { return s.status === "APPROVED"; }) || aSets[aSets.length - 1];

                    oModel.setProperty("/selectedSetId", oPick.ID);
                    await this._showSet(oPick.ID);
                    this._say("");
                }
            } catch (oError) {
                this._say("Could not read the cleansing rules: " + (oError.message || oError), "Error");
            } finally {
                oModel.setProperty("/busy", false);
            }
        },

        _showSet: async function (sSetId) {
            var oModel = this._model();
            var oSet = oModel.getProperty("/sets").find(function (s) { return s.ID === sSetId; }) || {};
            var aRules = await this._read("/CleansingRules", [new Filter("ruleSet_ID", "EQ", sSetId)]);

            aRules.sort(function (a, b) { return String(a.ruleId).localeCompare(String(b.ruleId)); });
            oModel.setProperty("/current", { status: oSet.status, version: oSet.version, state: this._state(oSet.status) });
            oModel.setProperty("/rules", aRules);
            oModel.setProperty("/preview", { ready: false, rows: [] });
        },

        onSetChange: async function () {
            await this._showSet(this._model().getProperty("/selectedSetId"));
        },

        // =========================================================
        // CHANGE THE RULES (draft only)
        // =========================================================
        _toRule: function (oRow) {
            return {
                ruleId: oRow.ruleId, sourceSystem: oRow.sourceSystem, entity: oRow.sourceEntity, field: oRow.field, level: oRow.level,
                rule: oRow.ruleType, parameter: oRow.parameter, condition: oRow.condition,
                order: oRow.sortOrder, onFailure: oRow.onFailure, reason: oRow.reason, owner: oRow.owner
            };
        },

        onAddRule: function () {
            var sSystem = (this.getOwnerComponent().getModel("migrationContext").getData() || {}).sourceSystemId || "*";
            var aIds = this._model().getProperty("/rules").map(function (r) { return r.ruleId; });
            var sPrefix = (this._business() || "R").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "R";
            var i = 1;

            while (aIds.indexOf(sPrefix + "-" + String(i).padStart(3, "0")) >= 0) { i++; }

            this._openEditor({
                ruleId: sPrefix + "-" + String(i).padStart(3, "0"), sourceSystem: sSystem, entity: "*", field: "", rule: "TRIM",
                parameter: "", condition: "", onFailure: "", reason: "", order: 1
            }, false);
        },

        onEditRule: function (oEvent) {
            if (this._model().getProperty("/current/status") !== "DRAFT") { return; }
            this._openEditor(this._toRule(oEvent.getSource().getBindingContext("cleansing").getObject()), true);
        },

        _openEditor: function (oRule, bExisting) {
            var that = this;
            var oType = new Select({ width: "100%" });
            var mInputs = {};
            var aFields = [
                ["ruleId", "Rule ID", !bExisting], ["sourceSystem", "Source system (* = all)", true], ["entity", "Entity / API (* = all)", true],
                ["field", "Field (empty for a Select rule, * = every text field)", true], ["parameter", "Parameter (e.g. ODATA, 1,2, a domain)", true],
                ["condition", "Condition (Select rules: Field = 'value')", true], ["onFailure", "If it fails (ERROR or WARNING, Validate rules)", true],
                ["reason", "Why this rule exists", true], ["order", "Order (when several rules hit one field)", true]
            ];
            var aContent = [new Label({ text: "What the rule does" }), oType];

            RULE_TYPES.forEach(function (a) { oType.addItem(new Item({ key: a[1], text: a[1] + "  (" + a[0] + ")" })); });
            oType.setSelectedKey(oRule.rule);

            aFields.forEach(function (a) {
                var oInput = new Input({ width: "100%", enabled: a[2] });

                oInput.setValue(oRule[a[0]] === undefined || oRule[a[0]] === null ? "" : String(oRule[a[0]]));
                mInputs[a[0]] = oInput;
                aContent.push(new Label({ text: a[1] }), oInput);
            });

            var oDialog = new Dialog({
                title: bExisting ? "Change rule " + oRule.ruleId : "New rule",
                contentWidth: "34rem",
                content: [new VBox({ items: aContent }).addStyleClass("sapUiSmallMargin")],
                beginButton: new Button({
                    text: "Save", type: "Emphasized",
                    press: async function () {
                        var sKey = oType.getSelectedKey();
                        var oSave = { level: oRule.level || "Source", rule: sKey, group: (RULE_TYPES.find(function (a) { return a[1] === sKey; }) || [""])[0] };

                        Object.keys(mInputs).forEach(function (s) { oSave[s] = mInputs[s].getValue(); });
                        oDialog.close();
                        await that._saveRule(oSave);
                    }
                }),
                endButton: new Button({ text: "Cancel", press: function () { oDialog.close(); } }),
                afterClose: function () { oDialog.destroy(); }
            });

            oDialog.open();
        },

        _saveRule: async function (oRule) {
            var oModel = this._model();
            var sSetId = oModel.getProperty("/selectedSetId");
            var oCurrent = oModel.getProperty("/current") || {};

            oModel.setProperty("/busy", true);

            try {
                var oResult;

                if (!sSetId) {
                    oResult = await this._call("importCleansingRules", { businessObject: this._business(), rules: JSON.stringify([oRule]), origin: "SCREEN" });
                    if (oResult.status === "REJECTED") { throw new Error(this._errorText(oResult.errors) || oResult.message); }
                    await this._load(oResult.ruleSetId);
                } else if (oCurrent.status !== "DRAFT") {
                    throw new Error("Only a draft version can be changed. Press 'New version' first.");
                } else {
                    await this._call("upsertCleansingRule", { ruleSetId: sSetId, rule: JSON.stringify(oRule) });
                    await this._load(sSetId);
                }

                MessageToast.show("Rule " + oRule.ruleId + " saved.");
            } catch (oError) {
                MessageBox.error("The rule was not saved:\n" + (oError.message || oError));
            } finally {
                oModel.setProperty("/busy", false);
            }
        },

        _errorText: function (sErrors) {
            try {
                return JSON.parse(sErrors || "[]").map(function (e) { return "Row " + e.row + ": " + e.messages.join("; "); }).join("\n");
            } catch (e) { return ""; }
        },

        onDeleteRule: function (oEvent) {
            var that = this;
            var oRule = oEvent.getSource().getBindingContext("cleansing").getObject();

            MessageBox.confirm("Remove rule " + oRule.ruleId + " from this draft version?", {
                onClose: async function (sAction) {
                    if (sAction !== MessageBox.Action.OK) { return; }
                    try {
                        await that._call("deleteCleansingRule", { ruleSetId: that._model().getProperty("/selectedSetId"), ruleId: oRule.ruleId });
                        await that._load(that._model().getProperty("/selectedSetId"));
                    } catch (oError) {
                        MessageBox.error("Could not remove the rule: " + (oError.message || oError));
                    }
                }
            });
        },

        onApprove: function () {
            var that = this;
            var oModel = this._model();

            MessageBox.confirm("Approve version " + oModel.getProperty("/current/version") + "? From then on the migration uses these rules, and the version can no longer be changed.", {
                onClose: async function (sAction) {
                    if (sAction !== MessageBox.Action.OK) { return; }
                    try {
                        var oResult = await that._call("approveCleansingRules", { ruleSetId: oModel.getProperty("/selectedSetId") });

                        await that._load(oModel.getProperty("/selectedSetId"));
                        MessageToast.show(oResult.message);
                    } catch (oError) {
                        MessageBox.error("Could not approve: " + (oError.message || oError));
                    }
                }
            });
        },

        onNewVersion: async function () {
            try {
                var oResult = await this._call("newCleansingRulesVersion", { businessObject: this._business() });

                await this._load(oResult.ruleSetId);
                MessageToast.show(oResult.message);
            } catch (oError) {
                MessageBox.error("Could not create a new version: " + (oError.message || oError));
            }
        },

        // =========================================================
        // PREVIEW
        // =========================================================
        onPreview: async function () {
            var oModel = this._model();
            var oMigration = this.getOwnerComponent().getModel("migrationContext").getData() || {};

            oModel.setProperty("/busy", true);
            this._say("Applying the rules to the extracted data (nothing is changed)...");

            try {
                var oResult = await this._call("previewCleansingRules", {
                    businessObject: this._business(), ruleSetId: oModel.getProperty("/selectedSetId"),
                    extractionId: oMigration.lastExtractionId, sourceSystemId: oMigration.sourceSystemId
                });
                var aRows = [];

                JSON.parse(oResult.objects || "[]").forEach(function (oObject) {
                    (oObject.rules || []).forEach(function (oRule) {
                        var oExample = (oRule.examples || [])[0];

                        aRows.push({
                            ruleId: oRule.ruleId, rule: oRule.rule, field: oRule.field, objectName: oObject.objectName,
                            evaluated: oRule.evaluated, changed: oRule.changed, excluded: oRule.excluded, issues: oRule.issues,
                            example: oExample ? JSON.stringify(oExample.before) + " → " + JSON.stringify(oExample.after) : ""
                        });
                    });
                });

                oModel.setProperty("/preview", { ready: true, rows: aRows, message: oResult.message });
                this._say("");
            } catch (oError) {
                this._say("The preview failed: " + (oError.message || oError), "Error");
            } finally {
                oModel.setProperty("/busy", false);
            }
        }
    });
});
