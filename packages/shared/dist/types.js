/**
 * Core domain types shared across web, api, worker and adapters.
 * These mirror the data model documented in docs/11-DATABASE-SCHEMA.md,
 * docs/12-API-SPEC.md and docs/14-ADAPTER-CONTRACT.md.
 */
export const PLATFORMS = ['youtube', 'tiktok', 'instagram', 'facebook', 'terabox'];
export const JOB_STATUSES = [
    'queued',
    'processing',
    'completed',
    'failed',
    'cancelled',
    'expired',
];
export const JOB_ITEM_STATUSES = ['pending', 'downloading', 'completed', 'failed', 'skipped'];
//# sourceMappingURL=types.js.map