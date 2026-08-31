import type { AdapterCapabilities, MediaKind, Platform } from './types.js';
/**
 * Wire-level API contract types (docs/12-API-SPEC.md), shared by the API
 * service and the browser client so they cannot drift.
 */
export interface ResolveFormatView {
    formatId: string;
    kind: 'video+audio' | 'video' | 'audio' | 'file';
    container: string;
    label: string;
    width?: number;
    height?: number;
    fps?: number;
    codec?: string;
    bitrateKbps?: number;
    estimatedSizeBytes?: number;
    playable?: boolean;
    mimeType?: string;
    /** Streaming URL for in-browser playback (requires valid token). */
    streamUrl?: string;
}
export interface ResolveItemView {
    id: string;
    title: string;
    durationSeconds?: number;
    thumbnailUrl?: string;
    formats: ResolveFormatView[];
    /** Streaming URL for the first playable format (requires valid token). */
    streamUrl?: string;
    /** Direct Play URL alias for immediate playback. */
    playbackUrl?: string;
}
export interface ResolveResponse {
    resolveId: string;
    platform: Platform;
    kind: MediaKind;
    title?: string;
    creator?: string;
    thumbnailUrl?: string;
    durationSeconds?: number;
    capabilities: AdapterCapabilities;
    expiresAt: string;
    items: ResolveItemView[];
}
export interface JobItemApiView {
    id: string;
    ordinal: number;
    title: string;
    status: 'pending' | 'downloading' | 'completed' | 'failed' | 'skipped';
    progress: number;
    sizeBytes?: number;
    errorCode?: string;
    errorMessage?: string;
    downloadUrl?: string;
    /** Streaming URL for in-browser playback (requires valid token). */
    streamUrl?: string;
}
export interface JobApiResponse {
    id: string;
    status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'expired';
    platform: Platform;
    kind: MediaKind;
    title?: string;
    creator?: string;
    requestedFormatId?: string | null;
    requestedQualityLabel?: string | null;
    progress: number;
    errorCode?: string;
    errorMessage?: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    expiresAt?: string;
    items: JobItemApiView[];
}
//# sourceMappingURL=api-types.d.ts.map