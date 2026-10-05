"use strict";

/**
 * ============================================================
 * START DEMO SERVER - MIGRATION WORKBENCH
 * ============================================================
 *
 * Starts the app with the 'demo' profile:
 *   - file-based SQLite database demo.sqlite (survives idle time and restarts)
 *   - S/4 and M3 adapters in MOCK mode (local fixtures, no system access)
 *   - port 4010 (4004 is often taken by another cds watch)
 *
 * Usage:
 *   npm run demo:start            start (creates demo.sqlite on first run)
 *   npm run demo:start -- --reset recreate demo.sqlite (empty), then start
 *   npm run demo:setup            second terminal: load the demo scenario
 *   npm run demo:start -- --objectstore   also use the company Object Store binding
 *                                 (profile "company", created with: cds bind objectstore --to <instance>:<key> --for company)
 *
 * Uses the project's own @sap/cds-dk, not a globally installed one.
 */

const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..", "..");
const database = path.join(projectRoot, "demo.sqlite");
const cdsCli = require.resolve("@sap/cds-dk/bin/cds.js", { paths: [projectRoot] });
const port = process.env.DEMO_PORT || "4010";
const profile = process.argv.includes("--objectstore") ? "demo,company" : "demo";

const env = {
    ...process.env,
    S4_DISCOVERY_MODE: "MOCK",
    M3_MODE: "MOCK"
};

if (process.argv.includes("--reset") && fs.existsSync(database)) {
    fs.rmSync(database);
    console.log("Removed demo.sqlite");
}

if (!fs.existsSync(database)) {
    console.log("Creating demo.sqlite ...");

    const deploy = spawnSync(process.execPath, [cdsCli, "deploy", "--profile", "demo"], {
        cwd: projectRoot,
        env,
        stdio: "inherit"
    });

    if (deploy.status !== 0) {
        process.exit(deploy.status || 1);
    }
}

console.log(`Starting Migration Workbench demo on http://localhost:${port} (profile ${profile})`);
console.log(`  Workbench      : http://localhost:${port}/workbench/webapp/index.html`);
console.log(`  Value Mappings : http://localhost:${port}/value-mappings/webapp/index.html`);
console.log("  First time? Run 'npm run demo:setup' in a second terminal.\n");

const server = spawn(process.execPath, [cdsCli, "watch", "--profile", profile, "--port", port], {
    cwd: projectRoot,
    env,
    stdio: "inherit"
});

server.on("exit", code => process.exit(code ?? 0));
