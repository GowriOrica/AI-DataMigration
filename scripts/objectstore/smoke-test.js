"use strict";

/**
 * ============================================================
 * OBJECT STORE SMOKE TEST (SAP Object Store on AWS)
 * ============================================================
 *
 * Proves connectivity and permissions with the app's own S3Storage class:
 *   write -> list -> read (compare) -> delete -> list again
 *
 * 1. Save the service key to a file OUTSIDE the project, e.g.:
 *      cf service-key migration-objectstore migration-objectstore-key > %USERPROFILE%\objectstore-key.json
 *    (the header line printed by cf is ignored)
 * 2. Run:
 *      node scripts/objectstore/smoke-test.js %USERPROFILE%\objectstore-key.json
 *
 * Options:  --keep   leave the test file in the bucket
 *
 * Secrets are never printed. Only a small text file under
 * migration-orchestrator/smoke-test/ is written.
 */

const fs = require("fs");
const S3Storage = require("../../srv/lib/storage/S3Storage");

async function main() {
    const keyFile = process.argv.slice(2).find(arg => !arg.startsWith("--"));
    const keep = process.argv.includes("--keep");

    if (!keyFile) {
        console.error("Usage: node scripts/objectstore/smoke-test.js <path-to-service-key.json> [--keep]");
        process.exit(2);
    }

    const storage = new S3Storage(fs.readFileSync(keyFile, "utf8"), { prefix: "migration-orchestrator/" });
    const { location, region } = storage.describe();

    console.log(`Object Store: ${location}  (region ${region})`);

    const key = `smoke-test/${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    const content = `Migration Orchestrator smoke test ${new Date().toISOString()}`;

    const step = async (label, action) => {
        process.stdout.write(`  ${label} ... `);

        try {
            const result = await action();
            console.log("OK");
            return result;
        } catch (error) {
            console.log("FAILED");
            console.error(`\n✗ ${label} failed: ${error.name || "Error"} - ${error.message}`);
            console.error(hint(error));
            process.exit(1);
        }
    };

    await step(`write  ${key}`, () => storage.put(key, content, { contentType: "text/plain" }));

    const listed = await step("list   smoke-test/", () => storage.list("smoke-test/"));

    if (!listed.some(item => item.key === key)) {
        console.error("✗ The written file is not listed");
        process.exit(1);
    }

    const read = await step("read   and compare", () => storage.get(key));

    if (read.toString("utf8") !== content) {
        console.error("✗ Read content differs from written content");
        process.exit(1);
    }

    if (!keep) {
        await step("delete test file", () => storage.remove(key));
    }

    console.log(`\n✓ Object Store works: write, list, read${keep ? "" : " and delete"} succeeded.`);
}

function hint(error) {
    const name = String(error.name || "");

    // Specific errors first - several of them also come with HTTP 403
    if (name === "InvalidAccessKeyId" || name === "SignatureDoesNotMatch") {
        return "  Hint: the key is invalid or was rotated. Create a new service key.";
    }

    if (name === "NoSuchBucket") {
        return "  Hint: the bucket in the key does not exist (instance deleted?). Create a new service key.";
    }

    if (name === "AccessDenied" || error.$metadata?.httpStatusCode === 403) {
        return "  Hint: the key has no permission for this action, or the key belongs to another bucket.";
    }

    if (["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT"].includes(error.code)) {
        return "  Hint: no network route to AWS - check proxy / VPN / firewall (corporate networks often need a proxy).";
    }

    return "  Hint: check that the file is the Object Store service key of an AWS-based instance.";
}

main();
