/**
 * Stable error codes from docs/25-ERROR-CATALOG.md.
 * Additional operational codes (NOT_FOUND, VALIDATION_ERROR, CONFLICT,
 * INTERNAL) cover API plumbing concerns; the catalog codes are the only ones
 * ever surfaced for domain failures.
 */
export const ERROR_CODES = [
    // Product catalog (docs/25-ERROR-CATALOG.md)
    'INVALID_URL',
    'UNSUPPORTED',
    'NOT_PUBLIC',
    'RATE_LIMITED',
    'TOO_LARGE',
    'PLAYLIST_LIMIT',
    'TEMPORARY_PROVIDER_ERROR',
    'PROCESSING_FAILED',
    'CANCELLED',
    'EXPIRED',
    // Domain / Operational Provider & Engine Error Codes
    'PLATFORM_VERIFICATION',
    'YOUTUBE_EXTRACTOR_ERROR',
    'NETWORK_ERROR',
    'ENGINE_ERROR',
    'ENGINE_OUTPUT_EMPTY',
    'ENGINE_OUTPUT_INVALID',
    // Operational
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'CONFLICT',
    'INTERNAL',
    /** Our server-side extraction binary is missing/broken — operator action needed.
     *  Kept separate from TEMPORARY_PROVIDER_ERROR so users never see a misleading
     *  "platform unavailable" message for our own misconfiguration. */
    'DOWNLOAD_ENGINE_UNAVAILABLE',
];
//# sourceMappingURL=catalog.js.map