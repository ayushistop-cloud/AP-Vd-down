import type { FastifyRequest, FastifyReply } from 'fastify';
export declare const PLAYBACK_DIR: string;
export declare const PLAYBACK_TTL_MS: number;
export declare const MAX_PLAYBACK_BYTES: number;
export declare const playbackInFlight: Map<string, Promise<void>>;
export declare const playbackActiveCount: Map<string, number>;
export declare const playbackLastTouch: Map<string, number>;
export declare function getPlaybackArtifactPath(resolveId: string, itemId: string, formatId: string): string;
export declare function playbackCacheKey(resolveId: string, itemId: string, formatId: string): string;
export declare function isPlaybackArtifactFresh(info: {
    mtimeMs: number;
    size: number;
} | null): boolean;
export declare function incrementActive(path: string): void;
export declare function decrementActive(path: string): void;
export declare function parseRangeHeader(header: string | undefined, size: number): {
    start: number;
    end: number;
    valid: boolean;
    isRange: boolean;
};
export declare function ensurePlaybackDir(): Promise<void>;
export declare function cleanupStalePlaybackArtifacts(log?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
}): Promise<number>;
export declare function servePlaybackFile(request: FastifyRequest, reply: FastifyReply, filePath: string, opts: {
    contentType?: string;
    logContext?: Record<string, unknown>;
    generationMs?: number;
}): Promise<unknown>;
export declare function removeIncompleteArtifact(path: string): Promise<void>;
//# sourceMappingURL=playback-artifact.d.ts.map