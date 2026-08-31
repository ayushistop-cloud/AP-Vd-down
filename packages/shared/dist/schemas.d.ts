import { z } from 'zod';
/** API request schemas (docs/12-API-SPEC.md). All requests are validated. */
export declare const resolveRequestSchema: z.ZodObject<{
    url: z.ZodString;
}, "strip", z.ZodTypeAny, {
    url: string;
}, {
    url: string;
}>;
export type ResolveRequest = z.infer<typeof resolveRequestSchema>;
export declare const createJobRequestSchema: z.ZodObject<{
    resolveId: z.ZodString;
    /** Select one item of a collection; omit for single-media resolves. */
    itemId: z.ZodOptional<z.ZodString>;
    /** Explicit subset for playlists (≤50). Omit for all items. */
    itemIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    /** Format chosen among those offered in the resolve result. */
    formatId: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    resolveId: string;
    itemId?: string | undefined;
    itemIds?: string[] | undefined;
    formatId?: string | undefined;
}, {
    resolveId: string;
    itemId?: string | undefined;
    itemIds?: string[] | undefined;
    formatId?: string | undefined;
}>;
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;
export declare const jobIdParamSchema: z.ZodObject<{
    id: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
}, {
    id: string;
}>;
export declare const cancelJobSchema: z.ZodObject<{}, "strict", z.ZodTypeAny, {}, {}>;
/** Stable error envelope every error response uses. */
export declare const apiErrorBodySchema: z.ZodObject<{
    error: z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
        retryable: z.ZodBoolean;
        details: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        code: string;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown> | undefined;
    }, {
        code: string;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown> | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    error: {
        code: string;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown> | undefined;
    };
}, {
    error: {
        code: string;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown> | undefined;
    };
}>;
//# sourceMappingURL=schemas.d.ts.map