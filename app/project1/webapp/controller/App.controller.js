sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageToast",
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/List",
  "sap/m/StandardListItem"
], (BaseController, MessageToast, Dialog, Button, List, StandardListItem) => {
  "use strict";

  /**
   * App frame: one header (context line, System Administration, Joule) and one
   * step bar for all pages. The pages themselves carry no header of their own.
   */
  return BaseController.extend("project1.controller.App", {

      onInit() {
          this.getOwnerComponent().getRouter().attachRouteMatched(this._onRouteMatched, this);
      },

      /** Highlights the step of the page that is shown. */
      _onRouteMatched(oEvent) {
          const oJourney = this.byId("journey");
          const sRoute = oEvent.getParameter("name");
          const bIsStep = oJourney.getItems().some((oItem) => oItem.getKey() === sRoute);

          // pages outside the step bar (e.g. the catalog) leave the last step highlighted
          if (bIsStep) {
              oJourney.setSelectedKey(sRoute);
          }
      },

      onStepChange(oEvent) {
          this.getOwnerComponent().getRouter().navTo(oEvent.getParameter("item").getKey());
      },

      /** The administration dialog belongs to the landing page (it uses the source selected there). */
      onOpenAdministration() {
          const oLanding = sap.ui.core.Element.registry.filter(
              (oElement) => oElement.getViewName && oElement.getViewName() === "project1.view.View1"
          )[0];

          if (!oLanding) {
              this.getOwnerComponent().getRouter().navTo("RouteView1");
              MessageToast.show("Select the source system here, then open System Administration.");
              return;
          }

          oLanding.getController().onOpenAdminDialog();
      },

      /** The Object Store page is not a step of the migration: it shows what is stored. */
      onOpenObjectStore() {
          this.getOwnerComponent().getRouter().navTo("ObjectStore");
      },

      /** What is ready and what is still to come, step by step. */
      onOpenRoadmap() {
          const STEPS = [
              ["1. Source", "Select the source system and connection.", "Ready", "Success"],
              ["2. Business Objects", "Find the APIs of a business object, confirm them, extract to the Object Store.", "Ready", "Success"],
              ["3. Source Data", "Extraction report, records and fields per API, Excel export.", "Ready", "Success"],
              ["4. Data Profiling", "Completeness, duplicates, formats and a score of the extracted data.", "Ready", "Success"],
              ["5. Cleansing", "Rules of the functional team: versions, edit, approve, preview of the effect. Still to come: import of the Excel template on this screen, value conversions on screen, applying the rules to produce cleansed data.", "Partly ready", "Warning"],
              ["6. Target & Mapping", "Source and target structures, suggested field mappings, approval, gaps in mandatory target fields. The engine exists; the screen is to be rebuilt on the extracted data.", "Planned", "None"],
              ["7. Execution & Reconciliation", "Simulation with issue list, load-ready staging output, counts: extracted, left out, loaded, rejected.", "Planned", "None"],
              ["Joule", "The same steps from Joule: profiling, cleansing rules, Object Store, status of a business object.", "Partly ready", "Warning"]
          ];

          if (!this._oRoadmap) {
              this._oRoadmap = new Dialog({
                  title: "Migration roadmap",
                  contentWidth: "44rem",
                  content: [new List({
                      items: STEPS.map(([sTitle, sText, sInfo, sState]) => new StandardListItem({
                          title: sTitle, description: sText, info: sInfo, infoState: sState, wrapping: true
                      }))
                  })],
                  endButton: new Button({ text: "Close", press: () => this._oRoadmap.close() })
              });
              this.getView().addDependent(this._oRoadmap);
          }

          this._oRoadmap.open();
      },

      onJoule() {
          MessageToast.show("Joule integration will be connected here.");
      }
  });
});
