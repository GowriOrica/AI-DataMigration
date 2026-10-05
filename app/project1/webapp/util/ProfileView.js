sap.ui.define([], function () {
    "use strict";

    /**
     * Turns the profile of ONE API (result of the server action profileExtraction)
     * into what the screens show. Used by "Source Data > Profiling" and by "Data Profiling",
     * so both show exactly the same.
     */
    return {

        /** One row per field: fill bar, number of different values, most frequent values, findings. */
        fieldRows: function (oProfile) {
            return (oProfile.fields || []).map(function (oField) {
                var aNotes = [];

                if (oField.kind === "EMPTY") { aNotes.push("empty in every record"); }
                if (oField.types && oField.types["odata-date"]) { aNotes.push("OData date format, to convert"); }
                if (oField.mixedDateFormats) { aNotes.push("mixed date formats"); }
                if (oField.spellingVariants > 0) { aNotes.push("spelling variants (" + oField.spellingVariants + ")"); }
                if (oField.valuesWithSpaces > 0) { aNotes.push(oField.valuesWithSpaces + " with leading/trailing spaces"); }
                if (oField.invalidEmails > 0) { aNotes.push(oField.invalidEmails + " invalid e-mail"); }

                return {
                    name: oField.name,
                    kind: oField.kind,
                    fillPct: oField.fillPct,
                    fillText: oField.fillPct + " %",
                    fillState: oField.kind === "EMPTY" ? "None" : oField.fillPct >= 90 ? "Success" : oField.fillPct >= 50 ? "Warning" : "Information",
                    distinctText: oField.kind === "EMPTY" ? "" : String(oField.distinct) + (oField.distinctCapped ? "+" : ""),
                    topText: (oField.top || []).slice(0, 3).map(function (t) { return t.value + " (" + t.count + ")"; }).join(", "),
                    notes: aNotes.join("; "),
                    hasFindings: aNotes.length > 0 && oField.kind !== "EMPTY"
                };
            });
        },

        /** The sentences of the server, without the last one (the score, which is shown separately). */
        findings: function (oProfile) {
            return (oProfile.findings || []).slice(0, -1).map(function (s) { return { text: s }; });
        },

        /** Score texts and the colour of the score. */
        score: function (oProfile) {
            var oScore = oProfile.score || {};

            return {
                scoreText: oScore.value + " / 100 (" + oScore.status + ")",
                scoreState: oScore.status === "OK" ? "Success" : oScore.status === "WARNING" ? "Warning" : "Error",
                scoreDetail: "Completeness " + oScore.completeness + " · uniqueness " + oScore.uniqueness + " · validity " + oScore.validity +
                    " (indicative: the mandatory fields of the target are not known yet)"
            };
        },

        /** Everything the detail part needs for one API. */
        detail: function (oProfile, sKey) {
            var aFields = this.fieldRows(oProfile);
            var oScore = this.score(oProfile);

            return {
                ready: true,
                forKey: sKey,
                filter: "ALL",
                message: oProfile.truncated ? "The extraction of this API stopped at the record limit, so this describes only the " + oProfile.records + " extracted records." : "",
                messageType: "Warning",
                scoreText: oScore.scoreText,
                scoreState: oScore.scoreState,
                scoreDetail: oScore.scoreDetail,
                findings: this.findings(oProfile),
                allFields: aFields,
                fields: aFields
            };
        },

        /** The fields that match the chosen filter. */
        filterFields: function (aAll, sKey) {
            return (aAll || []).filter(function (oField) {
                return sKey === "ALL" ||
                    (sKey === "PARTIAL" && oField.kind === "PARTIAL") ||
                    (sKey === "EMPTY" && oField.kind === "EMPTY") ||
                    (sKey === "ISSUES" && oField.hasFindings);
            });
        }
    };
});
