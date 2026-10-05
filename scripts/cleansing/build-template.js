"use strict";

/**
 * Writes the cleansing rules template to docs/cleansing/cleansing-rules-template.xlsx
 *
 *   node scripts/cleansing/build-template.js
 *
 * If the file is open in Excel (locked), the new version is written next to it as
 * cleansing-rules-template (new).xlsx.
 */

const fs = require("fs");
const path = require("path");
const { buildCleansingTemplate } = require("../../srv/lib/cleansing/CleansingTemplate");

(async () => {
    const folder = path.join(__dirname, "..", "..", "docs", "cleansing");
    const buffer = await buildCleansingTemplate();

    fs.mkdirSync(folder, { recursive: true });

    for (const name of ["cleansing-rules-template.xlsx", "cleansing-rules-template (new).xlsx"]) {
        try {
            fs.writeFileSync(path.join(folder, name), buffer);
            console.log("written", path.join(folder, name), buffer.length, "bytes");
            return;
        } catch (error) {
            if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
            console.log(`${name} is open in another program, trying the next name`);
        }
    }
})();
