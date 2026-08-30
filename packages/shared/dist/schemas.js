import { z } from 'zod';
/** API request schemas (docs/12-API-SPEC.md). All requests are validated. */
export const resolveRequestSchema = z.object({
    url: z.string({ required_error: 'url is required' }).min(5).max(2048),
});
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const createJobRequestSchema = z
    .object({
    resolveId: z.string().regex(UUID_REGEX, 'resolveId must be an id returned by /resolve'),
    /** Select one item of a collection; omit for single-media resolves. */
    itemId: z.string().max(128).optional(),
    /** Explicit subset for playlists (≤50). Omit for all items. */
    itemIds: z.array(z.string().max(128)).max(50).optional(),
    /** Format chosen among those offered in the resolve result. */
    formatId: z.string().min(1).max(128).optional(),
})
    .strict();
export const jobIdParamSchema = z.object({
    id: z.string().regex(UUID_REGEX, 'malformed job id'),
});
export const cancelJobSchema = z.object({}).strict();
/** Stable error envelope every error response uses. */
export const apiErrorBodySchema = z.object({
    error: z.object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        details: z.record(z.unknown()).optional(),
    }),
});
//# sourceMappingURL=schemas.js.map