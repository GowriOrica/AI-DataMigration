sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/TextArea"
], function (Controller, JSONModel, MessageToast, Dialog, Button, TextArea) {
    "use strict";

    /**
     * Object Store administration: what is stored, by extraction, and a folder view like a file explorer.
     * Everything is read from the server (srv/storage-admin-handlers.js); nothing can be changed here.
     */
    return Controller.extend("project1.controller.ObjectStore", {

        onInit: function () {
            this.getView().setModel(new JSONModel({
                busy: false, ready: false, message: "", messageType: "Information",
                overview: {}, lastWriteText: "", areas: [], extractions: [], problems: [],
                folder: { prefix: "", summary: "" }, crumbs: [], entries: []
            }), "objectStore");

            this.getOwnerComponent().getRouter().getRoute("ObjectStore").attachPatternMatched(this._load, this);
        },

        _model: function () { return this.getView().getModel("objectStore"); },

        _call: async function (sName, mParameters) {
            var oAction = this.getOwnerComponent().getModel().bindContext("/" + sName + "(...)");

            Object.keys(mParameters || {}).forEach(function (sKey) {
                oAction.setParameter(sKey, mParameters[sKey]);
            });

            await oAction.execute();

            return oAction.getBoundContext().getObject();
        },

        // =========================================================
        // OVERVIEW
        // =========================================================
        _load: async function () {
            var oModel = this._model();

            oModel.setProperty("/busy", true);
            oModel.setProperty("/message", "Reading the Object Store...");
            oModel.setProperty("/messageType", "Information");

            try {
                var oResult = await this._call("getObjectStoreOverview");
                var aAreas = JSON.parse(oResult.areas || "[]");
                var iTotal = Number(oResult.totalBytes) || 0;

                oModel.setProperty("/overview", oResult);
                oModel.setProperty("/lastWriteText", oResult.lastWrite ? new Date(oResult.lastWrite).toLocaleString() : "-");

                oModel.setProperty("/areas", aAreas.map(function (oArea) {
                    var nPercent = iTotal ? Math.round(1000 * oArea.bytes / iTotal) / 10 : 0;
                    return Object.assign({}, oArea, { percent: nPercent, percentText: nPercent + " %" });
                }));

                oModel.setProperty("/extractions", JSON.parse(oResult.extractions || "[]").map(function (oExtraction) {
                    return Object.assign({}, oExtraction, {
                        startedText: oExtraction.startedAt ? new Date(oExtraction.startedAt).toLocaleString() : "",
                        statusState: oExtraction.status === "COMPLETED" ? "Success" : oExtraction.status === "PARTIAL" ? "Warning" : "Error",
                        apis: oExtraction.apis === null ? "-" : oExtraction.apis,
                        records: oExtraction.records === null ? "-" : oExtraction.records
                    });
                }));

                var mTypes = { NO_MANIFEST: "No manifest", FAILED: "Failed", PARTIAL: "Partial", MISSING_FILES: "Files missing" };

                oModel.setProperty("/problems", JSON.parse(oResult.problems || "[]").map(function (oProblem) {
                    return Object.assign({}, oProblem, { typeText: mTypes[oProblem.type] || oProblem.type });
                }));

                oModel.setProperty("/ready", true);
                oModel.setProperty("/message", "");

                await this._browse("", false);
            } catch (oError) {
                oModel.setProperty("/ready", false);
                oModel.setProperty("/messageType", "Error");
                oModel.setProperty("/message", "Could not read the Object Store: " + (oError.message || oError));
            } finally {
                oModel.setProperty("/busy", false);
            }
        },

        onRefresh: async function () {
            await this._load();
            MessageToast.show("Object Store refreshed.");
        },

        onTabSelect: function () { /* the data is already loaded */ },

        // =========================================================
        // EXPLORER
        // =========================================================
        _browse: async function (sPrefix, bShowExplorer) {
            var oModel = this._model();

            try {
                var oResult = await this._call("browseObjectStore", { prefix: sPrefix });
                var aFolders = JSON.parse(oResult.folders || "[]");
                var aFiles = JSON.parse(oResult.files || "[]");

                oModel.setProperty("/folder", {
                    prefix: oResult.prefix || "",
                    parent: oResult.parent,
                    summary: oResult.fileCount + " file(s), " + oResult.sizeText + " in this folder and below"
                });
                var aCrumbs = JSON.parse(oResult.crumbs || "[]");

                oModel.setProperty("/crumbs", aCrumbs.map(function (oCrumb, i) {
                    return Object.assign({}, oCrumb, { text: oCrumb.name + (i < aCrumbs.length - 1 ? "  ›" : "") });
                }));

                oModel.setProperty("/entries", aFolders.map(function (oFolder) {
                    return {
                        isFolder: true, icon: "sap-icon://folder-full", iconColor: "Critical", name: oFolder.name, prefix: oFolder.prefix,
                        description: oFolder.description || "", sizeInfo: oFolder.files + " files · " + oFolder.sizeText,
                        modifiedText: oFolder.lastModified ? new Date(oFolder.lastModified).toLocaleString() : ""
                    };
                }).concat(aFiles.map(function (oFile) {
                    return {
                        isFolder: false, icon: oFile.type === "EXCEL" ? "sap-icon://excel-attachment" : "sap-icon://document-text", iconColor: "Default",
                        name: oFile.name, key: oFile.key, description: oFile.type, sizeInfo: oFile.sizeText,
                        modifiedText: oFile.lastModified ? new Date(oFile.lastModified).toLocaleString() : ""
                    };
                })));

                // the user opened a folder: show the explorer; on the first load stay on the extractions
                if (bShowExplorer !== false) {
                    this.byId("storeTabs").setSelectedKey("explorer");
                }
            } catch (oError) {
                MessageToast.show("Could not open the folder: " + (oError.message || oError));
            }
        },

        onEntryPress: async function (oEvent) {
            var oEntry = oEvent.getSource().getBindingContext("objectStore").getObject();

            if (oEntry.isFolder) {
                await this._browse(oEntry.prefix);
            } else {
                await this._preview(oEntry);
            }
        },

        onCrumb: async function (oEvent) {
            await this._browse(oEvent.getSource().getBindingContext("objectStore").getObject().prefix);
        },

        onFolderUp: async function () {
            await this._browse(this._model().getProperty("/folder/parent") || "");
        },

        onOpenArea: async function (oEvent) {
            await this._browse(oEvent.getSource().getBindingContext("objectStore").getObject().area + "/");
        },

        onOpenExtraction: async function (oEvent) {
            await this._browse("extractions/" + oEvent.getSource().getBindingContext("objectStore").getObject().extractionId + "/");
        },

        onOpenProblem: async function (oEvent) {
            var sKey = oEvent.getSource().getBindingContext("objectStore").getObject().key;

            await this._browse(sKey.replace(/[^/]*$/, ""));
        },

        // =========================================================
        // ONE FILE
        // =========================================================
        onPreviewFile: async function (oEvent) {
            await this._preview(oEvent.getSource().getBindingContext("objectStore").getObject());
        },

        _preview: async function (oEntry) {
            try {
                var oResult = await this._call("previewObjectStoreFile", { fileKey: oEntry.key });
                var oText = new TextArea({ editable: false, width: "100%", rows: 24, growing: false });

                // set afterwards: a text that starts with { would be taken for a data binding in the constructor
                oText.setValue(oResult.text);
                var oDialog = new Dialog({
                    title: oResult.fileName + " · " + (oResult.bytes < 1024 ? oResult.bytes + " B" : Math.round(oResult.bytes / 102.4) / 10 + " KB"),
                    contentWidth: "52rem",
                    content: [oText],
                    endButton: new Button({ text: "Close", press: function () { oDialog.close(); } }),
                    afterClose: function () { oDialog.destroy(); }
                });

                oText.addStyleClass("sapUiSmallMargin");
                oDialog.open();
            } catch (oError) {
                MessageToast.show("Could not show the file: " + (oError.message || oError));
            }
        },

        onDownloadFile: async function (oEvent) {
            var oEntry = oEvent.getSource().getBindingContext("objectStore").getObject();

            try {
                var oResult = await this._call("getObjectStoreFileLink", { fileKey: oEntry.key });

                if (!oResult.url) {
                    MessageToast.show(oResult.message);
                    return;
                }

                var oLink = document.createElement("a");
                oLink.href = oResult.url;
                oLink.download = oResult.fileName;
                oLink.rel = "noopener";
                document.body.appendChild(oLink);
                oLink.click();
                document.body.removeChild(oLink);
                MessageToast.show("Download started: " + oResult.fileName);
            } catch (oError) {
                MessageToast.show("Could not create the download link: " + (oError.message || oError));
            }
        }
    });
});
