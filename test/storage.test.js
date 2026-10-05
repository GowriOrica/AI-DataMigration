"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LocalStorage = require("../srv/lib/storage/LocalStorage");
const S3Storage = require("../srv/lib/storage/S3Storage");
const { normalizeCredentials } = S3Storage;

const FAKE_KEY = {
    access_key_id: "AKIAFAKEFAKEFAKE",
    secret_access_key: "fake-secret",
    bucket: "hcp-fake-bucket",
    region: "eu-central-1",
    host: "s3-eu-central-1.amazonaws.com"
};

describe("LocalStorage", () => {

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mo-storage-"));
    const storage = new LocalStorage(root);

    it("writes, lists, reads and removes files", async () => {
        await storage.put("runs/r1/summary.json", '{"ok":true}');
        await storage.put("runs/r1/issues.json", "[]");
        await storage.put("other/x.txt", "x");

        const listed = await storage.list("runs/");

        assert.deepEqual(listed.map(item => item.key), ["runs/r1/issues.json", "runs/r1/summary.json"]);
        assert.equal((await storage.get("runs/r1/summary.json")).toString(), '{"ok":true}');

        await storage.remove("runs/r1/issues.json");

        assert.equal((await storage.list("runs/")).length, 1);
    });

    it("refuses keys outside the storage folder", async () => {
        await assert.rejects(storage.put("../escape.txt", "no"), /Invalid storage key/);
    });

    it("lists nothing for an unknown prefix", async () => {
        assert.deepEqual(await new LocalStorage(path.join(root, "missing")).list(), []);
    });
});

describe("Object Store credentials", () => {

    it("accepts plain credentials, a wrapped service key and raw `cf service-key` output", () => {
        const wrapped = { credentials: FAKE_KEY };
        const cfText = `Getting key migration-objectstore-key for service instance migration-objectstore as user...\n\n${JSON.stringify(wrapped, null, 2)}`;

        for (const input of [FAKE_KEY, wrapped, cfText]) {
            const normalized = normalizeCredentials(input);

            assert.equal(normalized.bucket, "hcp-fake-bucket");
            assert.equal(normalized.region, "eu-central-1");
        }
    });

    it("derives the region from the host when no region is given", () => {
        const { region, ...withoutRegion } = FAKE_KEY;

        assert.equal(normalizeCredentials({ ...withoutRegion, host: "s3-ap-southeast-2.amazonaws.com" }).region, "ap-southeast-2");
    });

    it("explains non-AWS or incomplete keys", () => {
        assert.throws(() => normalizeCredentials({ account_name: "x", sas_token: "y" }), /AWS-based/);
    });
});

describe("S3Storage (fake S3 client - no network)", () => {

    const fakeClient = () => {
        const objects = new Map();
        const sent = [];

        return {
            sent,
            objects,
            async send(command) {
                const name = command.constructor.name;
                const input = command.input;

                sent.push({ name, input });

                switch (name) {
                    case "PutObjectCommand":
                        objects.set(input.Key, Buffer.from(input.Body));
                        return {};
                    case "GetObjectCommand":
                        return { Body: { transformToByteArray: async () => objects.get(input.Key) } };
                    case "DeleteObjectCommand":
                        objects.delete(input.Key);
                        return {};
                    case "ListObjectsV2Command": {
                        const keys = [...objects.keys()].filter(key => key.startsWith(input.Prefix)).sort();
                        // two items per page: exercises continuation
                        const start = Number(input.ContinuationToken || 0);
                        const page = keys.slice(start, start + 2);
                        const next = start + 2 < keys.length ? String(start + 2) : undefined;

                        return {
                            Contents: page.map(Key => ({ Key, Size: objects.get(Key).length })),
                            IsTruncated: Boolean(next),
                            NextContinuationToken: next
                        };
                    }
                    default:
                        throw new Error(`unexpected command ${name}`);
                }
            }
        };
    };

    it("writes under the prefix, pages through listings and reads back", async () => {
        const client = fakeClient();
        const storage = new S3Storage(FAKE_KEY, { client, prefix: "migration-orchestrator/" });

        for (const name of ["a", "b", "c"]) {
            await storage.put(`runs/${name}.json`, `{"n":"${name}"}`, { contentType: "application/json" });
        }

        assert.ok([...client.objects.keys()].every(key => key.startsWith("migration-orchestrator/runs/")));
        assert.equal(client.sent[0].input.Bucket, "hcp-fake-bucket");
        assert.equal(client.sent[0].input.ContentType, "application/json");

        const listed = await storage.list("runs/");

        assert.deepEqual(listed.map(item => item.key), ["runs/a.json", "runs/b.json", "runs/c.json"]);
        assert.equal((await storage.get("runs/b.json")).toString(), '{"n":"b"}');

        await storage.remove("runs/a.json");

        assert.equal((await storage.list("runs/")).length, 2);
    });

    it("never exposes secrets in its description", () => {
        const description = JSON.stringify(new S3Storage(FAKE_KEY, { client: fakeClient() }).describe());

        assert.doesNotMatch(description, /fake-secret|AKIAFAKE/);
        assert.match(description, /s3:\/\/hcp-fake-bucket/);
    });

    it("creates a time-limited download link without a network call and without exposing the secret", async () => {
        // signing is computed locally, so the real client with fake credentials is enough
        const storage = new S3Storage(FAKE_KEY, { prefix: "migration-orchestrator/" });

        const url = await storage.signedDownloadUrl("exports/EX-1/file.xlsx", { expiresInSeconds: 900, fileName: "file.xlsx" });
        const parsed = new URL(url);

        assert.match(parsed.hostname, /hcp-fake-bucket/);
        assert.equal(parsed.pathname, "/migration-orchestrator/exports/EX-1/file.xlsx");
        assert.equal(parsed.searchParams.get("X-Amz-Expires"), "900");
        assert.match(parsed.searchParams.get("response-content-disposition"), /attachment; filename="file.xlsx"/);
        assert.doesNotMatch(url, /fake-secret/);
    });
});

describe("LocalStorage download link", () => {
    it("has no direct link, callers fall back to the application link", async () => {
        const storage = new LocalStorage(fs.mkdtempSync(path.join(os.tmpdir(), "mo-link-")));

        assert.equal(await storage.signedDownloadUrl("exports/x.xlsx"), null);
    });
});
