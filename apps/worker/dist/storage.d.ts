import { type AppConfig } from '@3ap/shared';
/**
 * Temporary artifact storage interface.
 * Supports local disk (single-node VPS / Docker volume) and S3-compatible
 * object storage (Amazon S3, Cloudflare R2, Backblaze B2, MinIO).
 */
export interface ArtifactStore {
    readonly kind: 'local-disk' | 's3';
    /** Move/upload a finished temp file into storage. */
    put(tempFilePath: string, key: string): Promise<{
        key: string;
        sizeBytes: number;
    }>;
    /** Absolute local path or signed URL when present, else null (expired/swept). */
    resolvePath(key: string): Promise<string | null>;
    remove(key: string): Promise<void>;
    /** New unique scratch directory for one download task. */
    createWorkDir(): Promise<string>;
    usageBytes(): Promise<number>;
}
export declare class LocalDiskArtifactStore implements ArtifactStore {
    readonly kind: "local-disk";
    private readonly root;
    private readonly tmpDir;
    constructor(root: string);
    init(): Promise<void>;
    put(tempFilePath: string, key: string): Promise<{
        key: string;
        sizeBytes: number;
    }>;
    resolvePath(key: string): Promise<string | null>;
    remove(key: string): Promise<void>;
    createWorkDir(): Promise<string>;
    usageBytes(): Promise<number>;
}
/**
 * S3-compatible Object Storage implementation (AWS S3, Cloudflare R2, Backblaze B2, MinIO).
 */
export declare class S3ArtifactStore implements ArtifactStore {
    readonly kind: "s3";
    private readonly localFallback;
    private readonly bucket;
    private readonly endpoint?;
    constructor(config: AppConfig);
    init(): Promise<void>;
    put(tempFilePath: string, key: string): Promise<{
        key: string;
        sizeBytes: number;
    }>;
    resolvePath(key: string): Promise<string | null>;
    remove(key: string): Promise<void>;
    createWorkDir(): Promise<string>;
    usageBytes(): Promise<number>;
}
export declare function createArtifactStore(config: AppConfig): ArtifactStore;
//# sourceMappingURL=storage.d.ts.map