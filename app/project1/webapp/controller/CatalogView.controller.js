sap.ui.define([
"sap/ui/core/mvc/Controller",
"sap/ui/model/json/JSONModel",
"sap/ui/model/Filter",
"sap/ui/model/FilterOperator",
"sap/m/MessageBox",
"sap/m/MessageToast",
"sap/m/Column",
"sap/m/Text",
"sap/m/ColumnListItem"
], function (
Controller,
JSONModel,
Filter,
FilterOperator,
MessageBox,
MessageToast,
Column,
Text,
ColumnListItem
){
    "use strict";

    return Controller.extend("project1.controller.CatalogView", {

        /*
         * =====================================================
         * INITIALIZATION
         * =====================================================
         */

        onInit: function () {

            const oCatalogModel =
                new JSONModel({
                    services: []
                });

            oCatalogModel.setSizeLimit(5000);

            this.getView().setModel(
                oCatalogModel,
                "catalog"
            );


            const oMetadataModel =
                new JSONModel({
                    ServiceName: "",
                    ServiceUrl: "",

                    EntitySets: [],
                    Properties: [],
                    NavigationProperties: [],

                    EntitySetCount: 0,
                    PropertyCount: 0,
                    NavigationCount: 0,
                    SelectedEntitySet: "",
                    SelectedEntityType: "",
                    SelectedEntityDescription: "",
                    SelectedPropertyCount: 0,

                    EntityData: [],
                    EntityDataColumns: [],
                    EntityDataCount: 0,
                    EntityDataLoaded: false,

                    EntityDataSkip: 0,
EntityDataPageSize: 20,

EntityDataHasMore: true,
EntityDataLoading: false
                });

            oMetadataModel.setSizeLimit(20000);

            this.getView().setModel(
                oMetadataModel,
                "metadata"
            );


            this._loadServices();
        },


        /*
         * =====================================================
         * LOAD SERVICE COLLECTION
         * =====================================================
         */

        _loadServices: async function () {

            const oView =
                this.getView();

            try {

                oView.setBusy(true);

                const oResponse =
                    await fetch(
                        "/migration/Services",
                        {
                            method: "GET",
                            headers: {
                                "Accept":
                                    "application/json"
                            }
                        }
                    );


                if (!oResponse.ok) {

                    const sError =
                        await oResponse.text();

                    throw new Error(
                        "HTTP "
                        + oResponse.status
                        + ": "
                        + sError
                    );
                }


                const oResult =
                    await oResponse.json();


                /*
                 * CAP OData V4 normally returns:
                 *
                 * {
                 *   "@odata.context": "...",
                 *   "value": [...]
                 * }
                 */
                const aServices =
                    Array.isArray(
                        oResult.value
                    )
                        ? oResult.value
                        : [];


                this.getView()
                    .getModel("catalog")
                    .setProperty(
                        "/services",
                        aServices
                    );


                console.log(
                    "Services loaded:",
                    aServices
                );


                MessageToast.show(
                    aServices.length
                    + " services loaded"
                );


            } catch (oError) {

                console.error(
                    "Service loading failed:",
                    oError
                );


                MessageBox.error(
                    "Unable to load S/4HANA services.\n\n"
                    + oError.message
                );


            } finally {

                oView.setBusy(false);

            }
        },

        /* ON PRESS ENTITY SET */

        onEntitySetPress: function (oEvent) {

    /*
     * Get clicked Entity Set.
     */
    const oContext =
        oEvent
            .getSource()
          .getBindingContext(
              "metadata"
            );

  if (!oContext) {

        MessageBox.error(
            "Unable to determine the selected Entity Set."
        );

        return;
    }


    const oEntitySet =
        oContext.getObject();


    if (!oEntitySet) {

        MessageBox.error(
            "Entity Set information is not available."
        );

        return;
    }


    const sEntitySetName =
        oEntitySet.EntitySetName
        || "";


    const sEntityType =
        oEntitySet.EntityType
        || "";


    const sDescription =
        oEntitySet.Description
        || "";


    /*
     * EntityType normally looks like:
     *
     * API_BUSINESS_PARTNER.A_BusinessPartnerType
     *
     * Properties contain:
     *
     * EntityName = A_BusinessPartnerType
     *
     * Therefore remove the namespace.
     */
    const aEntityTypeParts =
        sEntityType.split(".");


    const sEntityTypeName =
        aEntityTypeParts[
            aEntityTypeParts.length - 1
        ];


    console.log(
        "Selected Entity Set:",
        sEntitySetName
    );


    console.log(
        "Selected Entity Type:",
        sEntityType
    );


    console.log(
        "Entity Type used for filtering:",
        sEntityTypeName
    );


    /*
     * Store selected entity information.
     */
    const oMetadataModel =
        this.getView()
            .getModel(
                "metadata"
            );


    oMetadataModel.setProperty(
        "/SelectedEntitySet",
        sEntitySetName
    );


    oMetadataModel.setProperty(
        "/SelectedEntityType",
        sEntityTypeName
    );


    oMetadataModel.setProperty(
        "/SelectedEntityDescription",
        sDescription
    );


    /*
     * Get Properties table binding.
     */
    const oPropertiesTable =
        this.byId(
            "propertiesTable"
        );


    if (!oPropertiesTable) {

        MessageBox.error(
            "Properties table was not found."
        );

        return;
    }


    const oBinding =
        oPropertiesTable.getBinding(
            "items"
        );


    if (!oBinding) {

        MessageBox.error(
            "Properties table binding was not found."
        );

        return;
    }


    /*
     * Filter properties belonging only
     * to the selected Entity Type.
     */
    const oEntityFilter =
        new Filter(
            "EntityName",
            FilterOperator.EQ,
            sEntityTypeName
        );


    oBinding.filter([
        oEntityFilter
    ]);


    /*
     * Count matching properties directly
     * from the JSONModel.
     */
    const aProperties =
      oMetadataModel.getProperty(
           "/   "
        ) || [];


    const aSelectedProperties =
        aProperties.filter(
            function (oProperty) {

                return (
                    oProperty.EntityName
                    === sEntityTypeName
                );

            }
        );


    oMetadataModel.setProperty(
        "/SelectedPropertyCount",
        aSelectedProperties.length
    );


    console.log(
        "Properties found:",
        aSelectedProperties.length
    );


    /*
     * Clear the textual property search.
     *
     * We do NOT clear the table filter here,
     * because the EntityName filter has just
     * been applied.
     */
    const oPropertySearch =
        this.byId(
            "propertySearchField"
        );


    if (oPropertySearch) {

        oPropertySearch.setValue(
            ""
        );

    }


    /*
     * Automatically switch to Properties tab.
     */
    const oTabBar =
        this.byId(
            "metadataTabBar"
        );


    if (oTabBar) {

        oTabBar.setSelectedKey(
            "properties"
        );

    }


    MessageToast.show(
        aSelectedProperties.length
        + " properties found for "
        + sEntitySetName
    );

},

/* Show entityset data */
onViewEntityData: async function (oEvent) {

    const oContext =
        oEvent
            .getSource()
            .getBindingContext("metadata");


    if (!oContext) {

        MessageBox.error(
            "Unable to determine the selected Entity Set."
        );

        return;
    }


    const oEntitySet =
        oContext.getObject();


    const sEntitySetName =
        oEntitySet.EntitySetName;


    const oMetadataModel =
        this.getView()
            .getModel("metadata");


    /*
     * Reset paging for the newly selected Entity Set.
     */
    oMetadataModel.setProperty(
        "/SelectedEntitySet",
        sEntitySetName
    );


    oMetadataModel.setProperty(
        "/EntityData",
        []
    );


    oMetadataModel.setProperty(
        "/EntityDataColumns",
        []
    );


    oMetadataModel.setProperty(
        "/EntityDataCount",
        0
    );


    oMetadataModel.setProperty(
        "/EntityDataSkip",
        0
    );


    oMetadataModel.setProperty(
        "/EntityDataHasMore",
        true
    );


    /*
     * Load the first page of Entity Set data.
     */
    await this._loadEntityDataBatch(
        true
    );


    /*
     * Switch automatically to the
     * Entity Data IconTabFilter.
     */
    const oTabBar =
        this.byId(
            "metadataTabBar"
        );


    if (oTabBar) {

        oTabBar.setSelectedKey(
            "entityData"
        );

    }

},

_loadEntityDataBatch: async function (bInitialLoad) {

    const oMetadataModel =
        this.getView()
            .getModel("metadata");


    /*
     * Prevent duplicate requests while
     * another request is already running.
     */
    if (
        oMetadataModel.getProperty(
            "/EntityDataLoading"
        )
    ) {
        return;
    }


    /*
     * Stop requesting data when
     * the final page has already been reached.
     */
    if (
        !bInitialLoad
        && !oMetadataModel.getProperty(
            "/EntityDataHasMore"
        )
    ) {
        return;
    }


    const sServiceUrl =
        oMetadataModel.getProperty(
            "/ServiceUrl"
        );


    const sEntitySetName =
        oMetadataModel.getProperty(
            "/SelectedEntitySet"
        );


    const iTop =
        oMetadataModel.getProperty(
            "/EntityDataPageSize"
        ) || 200;


    const iSkip =
        bInitialLoad
            ? 0
            : (
                oMetadataModel.getProperty(
                    "/EntityDataSkip"
                ) || 0
            );


    /*
     * Validate required information.
     */
    if (
        !sServiceUrl
        || !sEntitySetName
    ) {

        MessageBox.error(
            "Service URL or Entity Set is missing."
        );

        return;
    }


    try {

        oMetadataModel.setProperty(
            "/EntityDataLoading",
            true
        );


        /*
         * Escape single quotes for
         * OData string literals.
         */
        const sEscapedServiceUrl =
            sServiceUrl.replace(
                /'/g,
                "''"
            );


        const sEscapedEntitySet =
            sEntitySetName.replace(
                /'/g,
                "''"
            );


        /*
         * Build CAP request.
         *
         * Example:
         *
         * /catalog/getEntityData(
         *   serviceUrl='...',
         *   entitySetName='A_BusinessPartner',
         *   top=20,
         *   skip=0
         * )
         */
        const sRequestUrl =
            "/migration/getEntityData("
            + "serviceUrl='"
            + encodeURIComponent(
                sEscapedServiceUrl
            )
            + "',"
            + "entitySetName='"
            + encodeURIComponent(
                sEscapedEntitySet
            )
            + "',"
            + "top="
            + iTop
            + ","
            + "skip="
            + iSkip
            + ")";


        console.log(
            "Loading Entity Data:",
            {
                entitySet:
                    sEntitySetName,

                top:
                    iTop,

                skip:
                    iSkip
            }
        );


        console.log(
            "Entity Data Request URL:",
            sRequestUrl
        );


        /*
         * Call CAP backend.
         */
        const oResponse =
            await fetch(
                sRequestUrl,
                {
                    method: "GET",

                    headers: {
                        "Accept":
                            "application/json"
                    }
                }
            );


        /*
         * Handle HTTP errors.
         */
        if (!oResponse.ok) {

            const sError =
                await oResponse.text();


            throw new Error(
                "HTTP "
                + oResponse.status
                + ": "
                + sError
            );
        }


        /*
         * Read CAP response.
         */
        const oRawResult =
            await oResponse.json();


        console.log(
            "Raw Entity Data response:",
            oRawResult
        );


        /*
         * CAP may return the function result
         * directly or inside value.
         */
        const oResult =
            oRawResult.value
            && !Array.isArray(
                oRawResult.value
            )
                ? oRawResult.value
                : oRawResult;


        console.log(
            "Normalized Entity Data response:",
            oResult
        );


        /*
         * Convert JSON strings returned by CAP
         * into JavaScript arrays.
         */
        const aNewColumns =
            JSON.parse(
                oResult.ColumnsJson
                || "[]"
            );


        const aNewRows =
            JSON.parse(
                oResult.RowsJson
                || "[]"
            );


        console.log(
            "Loaded batch:",
            aNewRows.length
        );


        /*
         * Build dynamic columns only during
         * the initial load.
         *
         * Subsequent requests only append rows.
         */
        if (bInitialLoad) {

            oMetadataModel.setProperty(
                "/EntityDataColumns",
                aNewColumns
            );


            this._buildEntityDataTable(
                aNewColumns
            );
        }


        /*
         * Get existing records.
         *
         * On initial load start with
         * an empty array.
         */
        const aCurrentRows =
            bInitialLoad
                ? []
                : (
                    oMetadataModel.getProperty(
                        "/EntityData"
                    ) || []
                );


        /*
         * Append the newly retrieved
         * S/4HANA records.
         */
        const aAllRows =
            aCurrentRows.concat(
                aNewRows
            );


        /*
         * Update Entity Data model.
         */
        oMetadataModel.setProperty(
            "/EntityData",
            aAllRows
        );


        /*
         * Update total number of
         * records loaded into the UI.
         */
        oMetadataModel.setProperty(
            "/EntityDataCount",
            aAllRows.length
        );


        /*
         * Next request starts after all
         * records currently loaded.
         *
         * Examples:
         *
         * First load:
         * 20 records -> skip 20
         *
         * Second load:
         * 40 records -> skip 40
         *
         * Third load:
         * 60 records -> skip 60
         */
        oMetadataModel.setProperty(
            "/EntityDataSkip",
            aAllRows.length
        );


        /*
         * CAP tells the UI whether
         * another page may exist.
         */
        oMetadataModel.setProperty(
            "/EntityDataHasMore",
            oResult.HasMore === true
        );


        /*
         * Mark Entity Data as loaded.
         */
        oMetadataModel.setProperty(
            "/EntityDataLoaded",
            true
        );


        /*
         * Refresh the JSONModel.
         */
        oMetadataModel.refresh(
            true
        );


        console.log(
            "Total records now loaded:",
            aAllRows.length
        );


        console.log(
            "Next skip value:",
            aAllRows.length
        );


        console.log(
            "Has more records:",
            oResult.HasMore === true
        );


    } catch (oError) {

        console.error(
            "Load Entity Data Error:",
            oError
        );


        MessageBox.error(
            "Unable to load Entity Set data.\n\n"
            + oError.message
        );


    } finally {

        /*
         * Always reset loading state.
         */
        oMetadataModel.setProperty(
            "/EntityDataLoading",
            false
        );

    }

},

onEntityDataGrowingStarted: function () {

    this._loadEntityDataBatch(
        false
    );

},

_attachEntityDataScrollHandler: function () {

    const oScrollContainer =
        this.byId(
            "entityDataScrollContainer"
        );

    if (!oScrollContainer) {

        console.error(
            "entityDataScrollContainer not found."
        );

        return;
    }


    /*
     * Wait until ScrollContainer is rendered.
     */
    setTimeout(
        function () {

            const oDomRef =
                oScrollContainer.getDomRef();

            if (!oDomRef) {

                console.error(
                    "ScrollContainer DOM not available."
                );

                return;
            }


            /*
             * Remove previously attached listener.
             *
             * This avoids multiple getEntityData
             * requests when switching Entity Sets.
             */
            if (this._fnEntityDataScroll) {

                oDomRef.removeEventListener(
                    "scroll",
                    this._fnEntityDataScroll
                );
            }


            /*
             * Save handler reference so that
             * it can be removed later.
             */
            this._fnEntityDataScroll =
                this._onEntityDataScroll
                    .bind(this);


            oDomRef.addEventListener(
                "scroll",
                this._fnEntityDataScroll
            );


            console.log(
                "Entity Data scroll handler attached."
            );

        }.bind(this),
        100
    );

},


onLoadMoreEntityData: async function () {

    await this._loadEntityDataBatch(
        false
    );

},

/*Build entity data*/
_buildEntityDataTable: function (aColumns) {

    const oTable =
        this.byId("entityDataTable");

    if (!oTable) {

        console.error(
            "entityDataTable control was not found."
        );

        return;
    }


    /*
     * Remove the previous Entity Set columns
     * and row bindings.
     *
     * This is required because different
     * Entity Sets can have different columns.
     */
    oTable.unbindItems();

    oTable.destroyColumns();


    /*
     * Avoid displaying too many columns.
     *
     * Display the first 20 scalar properties.
     */
    const aVisibleColumns =
        aColumns.slice(
            0,
            20
        );


    const aCells = [];


    /*
     * Dynamically create columns and cells.
     */
    aVisibleColumns.forEach(
        function (sPropertyName) {

            /*
             * Create table column.
             */
            oTable.addColumn(

                new Column({

                    width: "12rem",

                    header:
                        new Text({
                            text: sPropertyName
                        })

                })

            );


            /*
             * Create cell binding for the
             * corresponding property.
             *
             * Example:
             *
             * {metadata>BusinessPartner}
             */
            aCells.push(

                new Text({

                    text:
                        "{metadata>"
                        + sPropertyName
                        + "}",

                    wrapping: false,

                    // tooltip:
                    //     "{metadata>"
                    //     + sPropertyName
                    //     + "}"

                })

            );

        }
    );


    /*
     * Create row template.
     */
    const oTemplate =
        new ColumnListItem({

            cells: aCells

        });


    /*
     * Bind rows from the metadata JSONModel.
     *
     * EntityData contains the live records
     * retrieved from S/4HANA.
     */
    oTable.bindItems({

        path: "metadata>/EntityData",

        template: oTemplate

    });


    console.log(
        "Entity Data table created:",
        aVisibleColumns.length,
        "columns"
    );

},
        /*
         * =====================================================
         * REFRESH
         * =====================================================
         */


        onRefresh: function () {

            const oSearch =
                this.byId(
                    "serviceSearchField"
                );

            if (oSearch) {
                oSearch.setValue("");
            }


            const oTable =
                this.byId(
                    "serviceTable"
                );


            if (
                oTable
                && oTable.getBinding("items")
            ) {

                oTable
                    .getBinding("items")
                    .filter([]);
            }


            this._loadServices();
        },


        /*
         * =====================================================
         * SERVICE SEARCH
         * =====================================================
         */

        onSearch: function (oEvent) {

            const sValue =
                this._getSearchValue(
                    oEvent
                );


            const oBinding =
                this.byId("serviceTable")
                    .getBinding("items");


            if (!sValue) {

                oBinding.filter([]);

                return;
            }


            const oFilter =
                new Filter({

                    filters: [

                        new Filter(
                            "TechnicalServiceName",
                            FilterOperator.Contains,
                            sValue
                        ),

                        new Filter(
                            "Description",
                            FilterOperator.Contains,
                            sValue
                        ),

                        new Filter(
                            "ServiceUrl",
                            FilterOperator.Contains,
                            sValue
                        )

                    ],

                    and: false
                });


            oBinding.filter([
                oFilter
            ]);
        },


        /*
         * =====================================================
         * TECHNICAL SERVICE CLICK
         * =====================================================
         */

        onServicePress: async function (oEvent) {

            const oContext =
                oEvent
                    .getSource()
                    .getBindingContext(
                        "catalog"
                    );


            if (!oContext) {

                MessageBox.error(
                    "Unable to determine the selected service."
                );

                return;
            }


            const oService =
                oContext.getObject();


            if (
                !oService
                || !oService.ServiceUrl
            ) {

                MessageBox.error(
                    "Service URL is not available."
                );

                return;
            }


            const sServiceUrl =
                oService.ServiceUrl;


            const sServiceName =
                oService.TechnicalServiceName
                || "OData Service";


            try {

                this.getView()
                    .setBusy(true);


                /*
                 * OData string literals escape a single quote
                 * by doubling the quote.
                 */
                const sEscapedServiceUrl =
                    sServiceUrl.replace(
                        /'/g,
                        "''"
                    );


                const sRequestUrl =
                    "/migration/getMetadata(serviceUrl='"
                    + encodeURIComponent(
                        sEscapedServiceUrl
                    )
                    + "')";


                console.log(
                    "Metadata request URL:",
                    sRequestUrl
                );


                const oResponse =
                    await fetch(
                        sRequestUrl,
                        {
                            method: "GET",
                            headers: {
                                "Accept":
                                    "application/json"
                            }
                        }
                    );


                if (!oResponse.ok) {

                    const sError =
                        await oResponse.text();


                    throw new Error(
                        "HTTP "
                        + oResponse.status
                        + ": "
                        + sError
                    );
                }


                /*
                 * =================================================
                 * READ RAW CAP RESPONSE
                 * =================================================
                 */

                const oRawData =
                    await oResponse.json();


                console.log(
                    "Raw metadata response:",
                    oRawData
                );


                /*
                 * CAP can return a structured function
                 * result directly or wrapped inside value.
                 *
                 * Support both formats.
                 */
                let oMetadata =
                    oRawData;


                if (
                    oRawData
                    && oRawData.value
                    && !Array.isArray(
                        oRawData.value
                    )
                ) {

                    oMetadata =
                        oRawData.value;
                }


                console.log(
                    "Normalized metadata response:",
                    oMetadata
                );


                /*
                 * =================================================
                 * NORMALIZE ARRAYS
                 * =================================================
                 */

                const aEntitySets =
                    Array.isArray(
                        oMetadata.EntitySets
                    )
                        ? oMetadata.EntitySets
                        : [];


                const aProperties =
                    Array.isArray(
                        oMetadata.Properties
                    )
                        ? oMetadata.Properties
                        : [];


                const aNavigationProperties =
                    Array.isArray(
                        oMetadata.NavigationProperties
                    )
                        ? oMetadata.NavigationProperties
                        : [];


                /*
                 * =================================================
                 * BUILD UI MODEL
                 * =================================================
                 */

                const oUiMetadata = {

                    ServiceName:
                        oMetadata.ServiceName
                        || sServiceName,

                    ServiceUrl:
                        oMetadata.ServiceUrl
                        || sServiceUrl,

                    EntitySets:
                        aEntitySets,

                    Properties:
                        aProperties,

                    NavigationProperties:
                        aNavigationProperties,

                    EntitySetCount:
                        aEntitySets.length,

                    PropertyCount:
                        aProperties.length,

                    NavigationCount:
                        aNavigationProperties.length
                };


                console.log(
                    "Final metadata UI model:",
                    oUiMetadata
                );


                /*
                 * =================================================
                 * IMPORTANT:
                 * UPDATE THE EXISTING NAMED JSON MODEL
                 * =================================================
                 */

                const oMetadataModel =
                    this.getView()
                        .getModel(
                            "metadata"
                        );


                oMetadataModel.setData(
                    oUiMetadata
                );


                oMetadataModel.refresh(
                    true
                );


                /*
                 * Debug exactly what the XML receives.
                 */
                console.log(
                    "metadata>/EntitySets:",
                    oMetadataModel.getProperty(
                        "/EntitySets"
                    )
                );


                console.log(
                    "metadata>/Properties:",
                    oMetadataModel.getProperty(
                        "/Properties"
                    )
                );


                console.log(
                    "metadata>/NavigationProperties:",
                    oMetadataModel.getProperty(
                        "/NavigationProperties"
                    )
                );


                /*
                 * Reset filters/search before opening
                 * metadata page.
                 */
                this._resetMetadataSearches();


                /*
                 * Always show Entity Sets initially.
                 */
                const oIconTabBar =
                    this.byId(
                        "metadataTabBar"
                    );


                if (oIconTabBar) {

                    oIconTabBar.setSelectedKey(
                        "entitySets"
                    );
                }


                /*
                 * =================================================
                 * NAVIGATE TO METADATA PAGE
                 * =================================================
                 */

                const oApp =
                    this.byId(
                        "app"
                    );


                const oPage =
                    this.byId(
                        "metadataPage"
                    );


                if (
                    !oApp
                    || !oPage
                ) {

                    throw new Error(
                        "Metadata page UI controls were not found."
                    );
                }


                oApp.to(
                    oPage,
                    "slide"
                );


                MessageToast.show(
                    "Metadata loaded: "
                    + aEntitySets.length
                    + " Entity Sets, "
                    + aProperties.length
                    + " Properties"
                );


            } catch (oError) {

                console.error(
                    "Metadata loading failed:",
                    oError
                );


                MessageBox.error(
                    "Unable to load metadata for "
                    + sServiceName
                    + ".\n\n"
                    + oError.message
                );


            } finally {

                this.getView()
                    .setBusy(false);

            }
        },


        /*
         * =====================================================
         * BACK
         * =====================================================
         */

        onMetadataBack: function () {

            const oApp =
                this.byId(
                    "app"
                );


            if (oApp) {

                oApp.back();

            }
        },


        /*
         * =====================================================
         * ENTITY SEARCH
         * =====================================================
         */

        onEntitySearch: function (oEvent) {

            const sValue =
                this._getSearchValue(
                    oEvent
                );


            const oBinding =
                this.byId(
                    "entitySetTable"
                ).getBinding(
                    "items"
                );


            if (!sValue) {

                oBinding.filter([]);

                return;
            }


            oBinding.filter([

                new Filter({

                    filters: [

                        new Filter(
                            "EntitySetName",
                            FilterOperator.Contains,
                            sValue
                        ),

                        new Filter(
                            "Description",
                            FilterOperator.Contains,
                            sValue
                        ),

                        new Filter(
                            "EntityType",
                            FilterOperator.Contains,
                            sValue
                        )

                    ],

                    and: false
                })

            ]);
        },


        /*
         * =====================================================
         * PROPERTY SEARCH
         * =====================================================
         */

        // onPropertySearch: function (oEvent) {

        //     const sValue =
        //         this._getSearchValue(
        //             oEvent
        //         );


        //     const oBinding =
        //         this.byId(
        //             "propertiesTable"
        //         ).getBinding(
        //             "items"
        //         );


        //     if (!sValue) {

        //         oBinding.filter([]);

        //         return;
        //     }


        //     oBinding.filter([

        //         new Filter({

        //             filters: [

        //                 new Filter(
        //                     "EntityName",
        //                     FilterOperator.Contains,
        //                     sValue
        //                 ),

        //                 new Filter(
        //                     "PropertyName",
        //                     FilterOperator.Contains,
        //                     sValue
        //                 ),

        //                 new Filter(
        //                     "Type",
        //                     FilterOperator.Contains,
        //                     sValue
        //                 )

        //             ],

        //             and: false
        //         })

        //     ]);
        // },

        onPropertySearch: function (oEvent) {

    const sValue =
        this._getSearchValue(
            oEvent
        );


    const oMetadataModel =
        this.getView()
            .getModel(
                "metadata"
            );


    const sEntityTypeName =
        oMetadataModel.getProperty(
            "/SelectedEntityType"
        );


    const oTable =
        this.byId(
            "propertiesTable"
        );


    if (!oTable) {
        return;
    }


    const oBinding =
        oTable.getBinding(
            "items"
        );


    if (!oBinding) {
        return;
    }


    const aFilters = [];


    /*
     * Always restrict Properties to
     * selected Entity Type.
     */
    if (sEntityTypeName) {

        aFilters.push(
            new Filter(
                "EntityName",
                FilterOperator.EQ,
                sEntityTypeName
            )
        );

    }


    /*
     * Apply textual property search.
     */
    if (sValue) {

        const oSearchFilter =
            new Filter({

                filters: [

                    new Filter(
                        "PropertyName",
                        FilterOperator.Contains,
                        sValue
                    ),

                    new Filter(
                        "Type",
                        FilterOperator.Contains,
                        sValue
                    )

                ],

                and: false

            });


        aFilters.push(
            oSearchFilter
        );

    }


    /*
     * All filters in aFilters are ANDed.
     *
     * Result:
     *
     * EntityName = selected entity
     *
     * AND
     *
     * (
     *   PropertyName contains search
     *   OR
     *   Type contains search
     * )
     */
    oBinding.filter(
        aFilters
    );

},
        /*
         * =====================================================
         * NAVIGATION SEARCH
         * =====================================================
         */

        onNavigationSearch: function (oEvent) {

            const sValue =
                this._getSearchValue(
                    oEvent
                );


            const oBinding =
                this.byId(
                    "navigationTable"
                ).getBinding(
                    "items"
                );


            if (!sValue) {

                oBinding.filter([]);

                return;
            }


            oBinding.filter([

                new Filter({

                    filters: [

                        new Filter(
                            "EntityName",
                            FilterOperator.Contains,
                            sValue
                        ),

                        new Filter(
                            "NavigationProperty",
                            FilterOperator.Contains,
                            sValue
                        ),

                        new Filter(
                            "Relationship",
                            FilterOperator.Contains,
                            sValue
                        )

                    ],

                    and: false
                })

            ]);
        },


        /*
         * =====================================================
         * GET SEARCH FIELD VALUE
         * =====================================================
         */

        _getSearchValue: function (
            oEvent
        ) {

            return (
                oEvent.getParameter(
                    "newValue"
                )
                || oEvent.getParameter(
                    "query"
                )
                || ""
            ).trim();
        },


        /*
         * =====================================================
         * RESET METADATA TABLE FILTERS
         * =====================================================
         */

        _resetMetadataSearches: function () {

            const aSearchIds = [

                "entitySearchField",

                "propertySearchField",

                "navigationSearchField"

            ];


            aSearchIds.forEach(
                function (sId) {

                    const oControl =
                        this.byId(
                            sId
                        );


                    if (oControl) {

                        oControl.setValue(
                            ""
                        );
                    }

                }.bind(this)
            );


            const aTableIds = [

                "entitySetTable",

                "propertiesTable",

                "navigationTable"

            ];


            aTableIds.forEach(
                function (sId) {

                    const oTable =
                        this.byId(
                            sId
                        );


                    if (!oTable) {
                        return;
                    }


                    const oBinding =
                        oTable.getBinding(
                            "items"
                        );


                    if (oBinding) {

                        oBinding.filter(
                            []
                        );

                    }

                }.bind(this)
            );
        },

         onContinueToData: function () {
            this.getOwnerComponent().getRouter().navTo("DataProfiling");
        },

        onContinueToExtract: function () {
            this.getOwnerComponent().getRouter().navTo("CatalogView");
        },

          onBack: function () {
            window.history.back();
        },

    });

});