import type { AdapterCapabilities, AppError, Logger, MediaFormat, MediaItem, MediaKind, Platform } from '@3ap/shared';
/**
 * The platform adapter contract (docs/14-ADAPTER-CONTRACT.md).
 * Adapters are the ONLY place where provider-specific logic lives.
 */
export interface ResolveOutput {
    platform: Platform;
    canonicalUrl: string;
    title?: string;
    creator?: string;
    thumbnailUrl?: string;
    durationSeconds?: number;
    kind: MediaKind;
    items: MediaItem[];
    capabilities: AdapterCapabilities;
}
export interface DownloadRequest {
    jobId: string;
    sourceUrl: string;
    itemTitle?: string;
    creator?: string;
    /** Format chosen by the user among resolve-provided options. */
    formatId?: string;
    /** Formats from the original resolve result (enables exact rendition mapping). */
    formats?: MediaFormat[];
    maxFileSizeBytes: number;
}
export type TaskStage = 'connecting' | 'downloading' | 'processing' | 'finalizing';
export interface TaskProgress {
    stage: TaskStage;
    percent?: number;
    downloadedBytes?: number;
    totalBytes?: number;
}
export interface DownloadTaskContext {
    workDir: string;
    signal: AbortSignal;
    onProgress(progress: TaskProgress): void | Promise<void>;
    /** Polled by adapters at safe interruption points. */
    isCancelled(): boolean | Promise<boolean>;
    log: Logger;
}
export interface DownloadTaskResult {
    filePath: string;
    fileName: string;
    sizeBytes: number;
    isAudio: boolean;
}
export interface MediaAdapter {
    readonly platform: Platform;
    getCapabilities(): AdapterCapabilities;
    canHandle(url: string): boolean;
    resolve(url: string): Promise<ResolveOutput>;
    createDownloadTask(request: DownloadRequest, ctx: DownloadTaskContext): Promise<DownloadTaskResult>;
    normalizeError(error: unknown): AppError;
}
//# sourceMappingURL=contract.d.ts.map