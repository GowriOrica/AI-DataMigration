"use strict";

const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    ListObjectsV2Command,
    DeleteObjectCommand
} = require("@aws-sdk/client-s3");

/**
 * ============================================================
 * SAP OBJECT STORE (AWS S3) STORAGE
 * ============================================================
 *
 * Credentials come from the Object Store service binding / key
 * (plan "standard" on an AWS region):
 *   { access_key_id, secret_access_key, bucket, region, host, uri, ... }
 *
 * Secrets are never logged or returned.
 */

/**
 * Accepts the credentials object, a full service key ({ credentials: {...} })
 * or the raw text printed by `cf service-key` (header line + JSON).
 */
function normalizeCredentials(input) {
    let value = input;

    if (typeof value === "string") {
        const start = value.indexOf("{");

        if (start < 0) {
            throw new Error("Object Store key text contains no JSON");
        }

        value = JSON.parse(value.slice(start));
    }

    const credentials = value?.credentials || value;

    const region =
        credentials.region ||
        (credentials.host && /s3[.-]([a-z0-9-]+)\.amazonaws\.com/.exec(credentials.host)?.[1]) ||
        null;

    const missing = ["access_key_id", "secret_access_key", "bucket"].filter(name => !credentials[name]);

    if (missing.length > 0) {
        throw new Error(
            `Object Store credentials are missing ${missing.join(", ")} - is this an AWS-based Object Store key?`
        );
    }

    if (!region) {
        throw new Error("Object Store credentials contain no region (or host to derive it from)");
    }

    return {
        accessKeyId: credentials.access_key_id,
        secretAccessKey: credentials.secret_access_key,
        bucket: credentials.bucket,
        region
    };
}

async function streamToBuffer(body) {
    if (!body) {
        return Buffer.alloc(0);
    }

    if (typeof body.transformToByteArray === "function") {
        return Buffer.from(await body.transformToByteArray());
    }

    const chunks = [];

    for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
}

class S3Storage {

    /**
     * @param {Object} credentials  binding credentials / service key
     * @param {Object} [options]
     * @param {Object} [options.client] injected S3 client (tests)
     * @param {string} [options.prefix] key prefix inside the bucket, e.g. "migration-orchestrator/"
     */
    constructor(credentials, options = {}) {
        const normalized = normalizeCredentials(credentials);

        this.bucket = normalized.bucket;
        this.region = normalized.region;
        this.prefix = options.prefix || "";
        this.client = options.client || new S3Client({
            region: normalized.region,
            credentials: {
                accessKeyId: normalized.accessKeyId,
                secretAccessKey: normalized.secretAccessKey
            }
        });
    }

    describe() {
        return {
            kind: "OBJECT_STORE",
            location: `s3://${this.bucket}/${this.prefix}`,
            region: this.region
        };
    }

    _key(key) {
        return `${this.prefix}${key}`;
    }

    /**
     * A link straight to one file in the bucket, valid for a short time. The download
     * does not pass through the application. Anyone holding the link can download the
     * file until it expires.
     */
    async signedDownloadUrl(key, { expiresInSeconds = 900, fileName } = {}) {
        const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

        return getSignedUrl(
            this.client,
            new GetObjectCommand({
                Bucket: this.bucket,
                Key: this._key(key),
                ResponseContentDisposition: fileName ? `attachment; filename="${fileName}"` : undefined
            }),
            { expiresIn: expiresInSeconds }
        );
    }

    async put(key, body, { contentType = "application/octet-stream" } = {}) {
        const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");

        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: this._key(key),
            Body: data,
            ContentType: contentType
        }));

        return { key, size: data.length };
    }

    async get(key) {
        const response = await this.client.send(new GetObjectCommand({
            Bucket: this.bucket,
            Key: this._key(key)
        }));

        return streamToBuffer(response.Body);
    }

    async list(prefix = "") {
        const results = [];
        let ContinuationToken;

        do {
            const page = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: this._key(prefix),
                ContinuationToken
            }));

            for (const item of page.Contents || []) {
                results.push({
                    key: item.Key.slice(this.prefix.length),
                    size: item.Size,
                    lastModified: item.LastModified
                });
            }

            ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (ContinuationToken);

        return results;
    }

    async remove(key) {
        await this.client.send(new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: this._key(key)
        }));
    }
}

module.exports = S3Storage;
module.exports.normalizeCredentials = normalizeCredentials;
