/**
 * Core domain types shared across web, api, worker and adapters.
 * These mirror the data model documented in docs/11-DATABASE-SCHEMA.md,
 * docs/12-API-SPEC.md and docs/14-ADAPTER-CONTRACT.md.
 */
export declare const PLATFORMS: readonly ["youtube", "tiktok", "instagram", "facebook", "terabox"];
export type Platform = (typeof PLATFORMS)[number];
export declare const JOB_STATUSES: readonly ["queued", "processing", "completed", "failed", "cancelled", "expired"];
export type JobStatus = (typeof JOB_STATUSES)[number];
export declare const JOB_ITEM_STATUSES: readonly ["pending", "downloading", "completed", "failed", "skipped"];
export type JobItemStatus = (typeof JOB_ITEM_STATUSES)[number];
/** Kind of media a resolve result represents. */
export type MediaKind = 'single' | 'playlist' | 'collection';
export interface AdapterCapabilities {
    /** An audio-only rendition can be produced where the provider exposes one. */
    supportsAudioOnly: boolean;
    /** Individual quality options are exposed (as opposed to a single rendition). */
    supportsQualitySelection: boolean;
    supportsPlaylists: boolean;
    playlistMaxItems?: number;
    /** Hard ceiling on offered video quality (e.g. 1440 === 2K, per product spec). */
    maxQualityHeight?: number;
}
export type MediaFormatKind = 'video+audio' | 'video' | 'audio' | 'file';
export interface MediaFormat {
    /** Stable id used by clients to select this option when creating a job. */
    formatId: string;
    kind: MediaFormatKind;
    container: string;
    /** Human-facing label, e.g. "1080p" or "Audio (m4a)". */
    label: string;
    width?: number;
    height?: number;
    fps?: number;
    codec?: string;
    bitrateKbps?: number;
    estimatedSizeBytes?: number;
    /**
     * Opaque adapter-private hint persisted with the resolve result so the
     * worker can act on the exact provider rendition without re-resolving.
     * Never interpreted by the API or UI.
     */
    sourceSelector?: string;
    /** Whether this format is playable in-browser (has video+audio or is audio-only with supported codec). */
    playable?: boolean;
    /** MIME type for playback (e.g., video/mp4, audio/mpeg). */
    mimeType?: string;
}
export interface MediaItem {
    /** Stable within one resolve result. */
    id: string;
    title: string;
    /** Canonical per-item source URL used by the worker. */
    sourceUrl: string;
    durationSeconds?: number;
    thumbnailUrl?: string;
    formats: MediaFormat[];
}
/**
 * Result of resolving a user URL through an adapter.
 * Persisted briefly (resolve TTL) so POST /jobs can reference it.
 */
export interface ResolveRecord {
    resolveId: string;
    platform: Platform;
    canonicalUrl: string;
    title?: string;
    creator?: string;
    thumbnailUrl?: string;
    durationSeconds?: number;
    kind: MediaKind;
    items: MediaItem[];
    capabilities: AdapterCapabilities;
    createdAt: number;
    expiresAt: number;
}
export interface JobRow {
    id: string;
    status: JobStatus;
    platform: Platform;
    kind: MediaKind;
    /** Operational linkage back to the short-lived resolve record (lets the
     *  worker rehydrate exact format selectors without storing provider URLs
     *  beyond the active window). Documented addition to docs/11 schema. */
    resolveId: string | null;
    /** sha256(sourceUrl + pepper); raw URLs are never persisted long-term. */
    sourceUrlHash: string;
    /** Display-safe form: scheme + host + trimmed path, no query string. */
    sourceUrlRedacted: string;
    /** Raw URL retained only while the job is still active (privacy policy). */
    sourceUrl: string | null;
    ipHash: string;
    idempotencyKey: string | null;
    title: string | null;
    creator: string | null;
    requestedFormatId: string | null;
    requestedQualityLabel: string | null;
    progress: number;
    errorCode: string | null;
    errorMessage: string | null;
    cancelRequested: boolean;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    expiresAt: Date | null;
}
export interface JobItemRow {
    id: string;
    jobId: string;
    ordinal: number;
    title: string;
    sourceUrl: string;
    status: JobItemStatus;
    progress: number;
    artifactKey: string | null;
    artifactName: string | null;
    artifactSizeBytes: number | null;
    errorCode: string | null;
    errorMessage: string | null;
}
export interface AdapterEventRow {
    id: string;
    platform: Platform;
    eventType: 'resolve' | 'download';
    jobId: string | null;
    latencyMs: number;
    success: boolean;
    errorCode: string | null;
    createdAt: Date;
}
export interface JobItemView {
    id: string;
    ordinal: number;
    title: string;
    status: JobItemStatus;
    progress: number;
    errorCode?: string;
    errorMessage?: string;
    downloadUrl?: string;
    sizeBytes?: number;
}
export interface JobView {
    id: string;
    status: JobStatus;
    platform: Platform;
    kind: MediaKind;
    title?: string;
    creator?: string;
    /** Aggregate progress 0..100. */
    progress: number;
    items: JobItemView[];
    errorCode?: string;
    errorMessage?: string;
    retryable: boolean;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    expiresAt?: string;
}
export interface ApiErrorBody {
    error: {
        code: string;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown>;
    };
}
//# sourceMappingURL=types.d.ts.map