import { ERROR_CODES, type ErrorCode } from './catalog.js';
export { ERROR_CODES };
export type { ErrorCode };
/**
 * Normalized application error carrying a stable machine-readable code from
 * docs/25-ERROR-CATALOG.md plus an operational code set (NOT_FOUND,
 * VALIDATION_ERROR, CONFLICT, INTERNAL) used for API plumbing. Messages are
 * always user-safe: no stack traces, paths or secrets.
 */
export declare class AppError extends Error {
    readonly code: ErrorCode;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown>;
    constructor(code: ErrorCode, message: string, options?: {
        retryable?: boolean;
        details?: Record<string, unknown>;
        cause?: unknown;
    });
    get httpStatus(): number;
    toJSON(): {
        details?: Record<string, unknown> | undefined;
        code: "INVALID_URL" | "UNSUPPORTED" | "NOT_PUBLIC" | "RATE_LIMITED" | "TOO_LARGE" | "PLAYLIST_LIMIT" | "TEMPORARY_PROVIDER_ERROR" | "PROCESSING_FAILED" | "CANCELLED" | "EXPIRED" | "PLATFORM_VERIFICATION" | "YOUTUBE_EXTRACTOR_ERROR" | "NETWORK_ERROR" | "ENGINE_ERROR" | "ENGINE_OUTPUT_EMPTY" | "ENGINE_OUTPUT_INVALID" | "NOT_FOUND" | "VALIDATION_ERROR" | "CONFLICT" | "INTERNAL" | "DOWNLOAD_ENGINE_UNAVAILABLE";
        message: string;
        retryable: boolean;
    };
}
/** Coerce any thrown value into an AppError without leaking internals. */
export declare function toAppError(err: unknown): AppError;
export declare const appErrors: {
    invalidUrl: (message?: string) => AppError;
    unsupported: (message?: string) => AppError;
    notPublic: (message?: string) => AppError;
    rateLimited: (message?: string, details?: Record<string, unknown>) => AppError;
    tooLarge: (message?: string) => AppError;
    playlistLimit: (message?: string) => AppError;
    temporaryProviderError: (message?: string) => AppError;
    processingFailed: (message?: string) => AppError;
    cancelled: () => AppError;
    expired: (message?: string) => AppError;
    platformVerification: (message?: string) => AppError;
    youtubeExtractorError: (message?: string) => AppError;
    networkError: (message?: string) => AppError;
    engineError: (message?: string) => AppError;
    engineOutputEmpty: (message?: string) => AppError;
    engineOutputInvalid: (message?: string) => AppError;
    notFound: (message?: string) => AppError;
    validation: (message: string, details?: Record<string, unknown>) => AppError;
    conflict: (message: string) => AppError;
    internal: () => AppError;
    /**
     * The server-side download engine (yt-dlp) is missing or broken.
     * User-safe message only; detailed diagnostics go to the operator log.
     */
    engineUnavailable: (message?: string) => AppError;
};
//# sourceMappingURL=errors.d.ts.map