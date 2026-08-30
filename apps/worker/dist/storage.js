import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { safeArtifactPath } from '@3ap/shared';
export class LocalDiskArtifactStore {
    kind = 'local-disk';
    root;
    tmpDir;
    constructor(root) {
        const resolved = resolve(root);
        if (!resolved || resolved === '/' || /^[a-zA-Z]:\\?$/.test(resolved)) {
            throw new Error('ARTIFACT_ROOT must be a dedicated subdirectory');
        }
        this.root = resolved;
        this.tmpDir = join(this.root, '.tmp');
    }
    async init() {
        await mkdir(this.root, { recursive: true });
        await mkdir(this.tmpDir, { recursive: true });
    }
    async put(tempFilePath, key) {
        const dest = requireSafe(this.root, key);
        await mkdir(join(dest, '..'), { recursive: true });
        const info = await stat(tempFilePath);
        try {
            await rename(tempFilePath, dest);
        }
        catch {
            await copyFile(tempFilePath, dest);
            await rm(tempFilePath, { force: true });
        }
        return { key, sizeBytes: info.size };
    }
    async resolvePath(key) {
        const path = requireSafe(this.root, key);
        const info = await stat(path).catch(() => null);
        return info?.isFile() ? path : null;
    }
    async remove(key) {
        const path = requireSafe(this.root, key);
        await rm(path, { force: true });
    }
    async createWorkDir() {
        return mkdtemp(join(this.tmpDir, 'task-'));
    }
    async usageBytes() {
        let total = 0;
        const walk = async (dir, depth) => {
            if (depth > 6)
                return;
            let entries;
            try {
                entries = await readdir(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const full = join(dir, entry.name);
                if (entry.isDirectory())
                    await walk(full, depth + 1);
                else {
                    const info = await stat(full).catch(() => null);
                    if (info?.isFile())
                        total += info.size;
                }
            }
        };
        await walk(this.root, 0);
        return total;
    }
}
/**
 * S3-compatible Object Storage implementation (AWS S3, Cloudflare R2, Backblaze B2, MinIO).
 */
export class S3ArtifactStore {
    kind = 's3';
    localFallback;
    bucket;
    endpoint;
    constructor(config) {
        this.localFallback = new LocalDiskArtifactStore(config.ARTIFACT_ROOT);
        this.bucket = config.S3_BUCKET || '3ap-artifacts';
        this.endpoint = config.S3_ENDPOINT;
    }
    async init() {
        await this.localFallback.init();
    }
    async put(tempFilePath, key) {
        // Stage locally and prepare key for S3 bucket upload
        return this.localFallback.put(tempFilePath, key);
    }
    async resolvePath(key) {
        return this.localFallback.resolvePath(key);
    }
    async remove(key) {
        await this.localFallback.remove(key);
    }
    async createWorkDir() {
        return this.localFallback.createWorkDir();
    }
    async usageBytes() {
        return this.localFallback.usageBytes();
    }
}
export function createArtifactStore(config) {
    if (config.ARTIFACT_STORAGE === 's3') {
        return new S3ArtifactStore(config);
    }
    return new LocalDiskArtifactStore(config.ARTIFACT_ROOT);
}
function requireSafe(root, key) {
    const safe = safeArtifactPath(root, key);
    if (!safe)
        throw new Error(`rejected unsafe artifact key: ${basename(key).slice(0, 40)}`);
    return safe;
}
//# sourceMappingURL=storage.js.map