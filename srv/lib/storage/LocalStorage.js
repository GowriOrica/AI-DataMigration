"use strict";

const fs = require("fs");
const path = require("path");

/**
 * ============================================================
 * LOCAL FOLDER STORAGE
 * ============================================================
 *
 * Same interface as S3Storage, backed by a local folder.
 * Used locally, in tests and on accounts without Object Store.
 */
class LocalStorage {

    constructor(rootDir) {
        this.rootDir = path.resolve(rootDir);
    }

    describe() {
        return { kind: "LOCAL", location: this.rootDir };
    }

    /** A local folder has no direct download link; callers fall back to the application link. */
    async signedDownloadUrl() {
        return null;
    }

    _resolve(key) {
        const target = path.resolve(this.rootDir, key);

        // Keys must stay inside the storage folder
        if (target !== this.rootDir && !target.startsWith(this.rootDir + path.sep)) {
            throw new Error(`Invalid storage key '${key}'`);
        }

        return target;
    }

    async put(key, body) {
        const target = this._resolve(key);
        const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");

        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, data);

        return { key, size: data.length };
    }

    async get(key) {
        return fs.promises.readFile(this._resolve(key));
    }

    async list(prefix = "") {
        const results = [];

        const walk = async (dir) => {
            let entries;

            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch (error) {
                if (error.code === "ENOENT") {
                    return;
                }

                throw error;
            }

            for (const entry of entries) {
                const full = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    await walk(full);
                    continue;
                }

                const key = path.relative(this.rootDir, full).split(path.sep).join("/");

                if (key.startsWith(prefix)) {
                    const stat = await fs.promises.stat(full);
                    results.push({ key, size: stat.size, lastModified: stat.mtime });
                }
            }
        };

        await walk(this.rootDir);

        return results.sort((left, right) => left.key.localeCompare(right.key));
    }

    async remove(key) {
        await fs.promises.rm(this._resolve(key), { force: true });
    }
}

module.exports = LocalStorage;
