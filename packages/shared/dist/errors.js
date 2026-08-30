import { ERROR_CODES } from './catalog.js';
import { HTTP_STATUS_BY_CODE } from './status-map.js';
export { ERROR_CODES };
/**
 * Normalized application error carrying a stable machine-readable code from
 * docs/25-ERROR-CATALOG.md plus an operational code set (NOT_FOUND,
 * VALIDATION_ERROR, CONFLICT, INTERNAL) used for API plumbing. Messages are
 * always user-safe: no stack traces, paths or secrets.
 */
export class AppError extends Error {
    code;
    retryable;
    details;
    constructor(code, message, options) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = 'AppError';
        this.code = code;
        this.retryable =
            options?.retryable ??
                (code === 'TEMPORARY_PROVIDER_ERROR' || code === 'RATE_LIMITED');
        if (options?.details !== undefined)
            this.details = options.details;
    }
    get httpStatus() {
        return HTTP_STATUS_BY_CODE[this.code];
    }
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            ...(this.details ? { details: this.details } : {}),
        };
    }
}
/** Coerce any thrown value into an AppError without leaking internals. */
export function toAppError(err) {
    if (err instanceof AppError)
        return err;
    if (err instanceof Error && err.name === 'AbortError') {
        return new AppError('TEMPORARY_PROVIDER_ERROR', 'The request timed out. Please try again.');
    }
    return new AppError('PROCESSING_FAILED', 'Processing failed unexpectedly. Please try again.');
}
export const appErrors = {
    invalidUrl: (message = 'That does not look like a valid link. Check the URL and try again.') => new AppError('INVALID_URL', message),
    unsupported: (message = 'This platform or link is not supported yet. Try a YouTube, TikTok, Instagram, Facebook or Terabox link.') => new AppError('UNSUPPORTED', message),
    notPublic: (message = 'This content is not publicly accessible.') => new AppError('NOT_PUBLIC', message),
    rateLimited: (message = 'Too many requests. Please wait a moment and try again.', details) => new AppError('RATE_LIMITED', message, { details }),
    tooLarge: (message = 'This file exceeds the size limit for anonymous downloads.') => new AppError('TOO_LARGE', message),
    playlistLimit: (message = 'Playlists are limited to 50 items.') => new AppError('PLAYLIST_LIMIT', message),
    temporaryProviderError: (message = 'The platform is temporarily unavailable. Please try again shortly.') => new AppError('TEMPORARY_PROVIDER_ERROR', message),
    processingFailed: (message = 'Processing failed. Please try again.') => new AppError('PROCESSING_FAILED', message),
    cancelled: () => new AppError('CANCELLED', 'The job was cancelled.', { retryable: false }),
    expired: (message = 'This result has expired. Start a new download.') => new AppError('EXPIRED', message, { retryable: false }),
    platformVerification: (message = 'Platform verification is currently required by the provider. Please try again later.') => new AppError('PLATFORM_VERIFICATION', message, { retryable: true }),
    youtubeExtractorError: (message = 'YouTube media could not be resolved right now. Please try another public video.') => new AppError('YOUTUBE_EXTRACTOR_ERROR', message, { retryable: true }),
    networkError: (message = 'The media provider could not be reached. Please try again.') => new AppError('NETWORK_ERROR', message, { retryable: true }),
    engineError: (message = 'The media service is temporarily unavailable.') => new AppError('ENGINE_ERROR', message, { retryable: true }),
    engineOutputEmpty: (message = 'The media processing engine returned an empty response.') => new AppError('ENGINE_OUTPUT_EMPTY', message, { retryable: true }),
    engineOutputInvalid: (message = 'The media processing engine returned invalid metadata.') => new AppError('ENGINE_OUTPUT_INVALID', message, { retryable: true }),
    notFound: (message = 'Not found.') => new AppError('NOT_FOUND', message, { retryable: false }),
    validation: (message, details) => new AppError('VALIDATION_ERROR', message, { retryable: false, details }),
    conflict: (message) => new AppError('CONFLICT', message, { retryable: false }),
    internal: () => new AppError('INTERNAL', 'An unexpected server error occurred.'),
    /**
     * The server-side download engine (yt-dlp) is missing or broken.
     * User-safe message only; detailed diagnostics go to the operator log.
     */
    engineUnavailable: (message = 'The service is missing its media processing engine. This is temporary while it is being set up.') => new AppError('DOWNLOAD_ENGINE_UNAVAILABLE', message),
};
//# sourceMappingURL=errors.js.map