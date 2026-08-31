import { type JobItemRow, type JobRow, type JobStore, type Logger, type MediaItem, type MetricsRegistry, type ResolveRecord } from '@3ap/shared';
import type { QueuePayload } from '@3ap/queue';
/**
 * Job creation + lifecycle queries (docs/12-API-SPEC.md).
 * Enforces playlist caps, option validation, idempotency and per-IP
 * concurrency limits before anything is queued.
 */
export interface CreateJobInput {
    resolveId: string;
    itemId?: string;
    itemIds?: string[];
    formatId?: string;
}
export interface CreateJobContext {
    ipHash: string;
    idempotencyKey: string | null;
}
export interface JobServiceOptions {
    maxPlaylistItems: number;
    maxConcurrentJobsPerIp: number;
    ipPepper: string;
    log: Logger;
    metrics: MetricsRegistry;
}
export declare class JobService {
    private readonly store;
    private readonly enqueue;
    private readonly options;
    constructor(store: JobStore, enqueue: (payload: Omit<QueuePayload, 'attempt'>) => Promise<void>, options: JobServiceOptions);
    createJob(input: CreateJobInput, ctx: CreateJobContext): Promise<{
        job: JobRow;
        items: JobItemRow[];
    }>;
}
/** Pick which resolve items this job covers, enforcing caps and selection rules. */
export declare function selectTargetItems(record: ResolveRecord, input: CreateJobInput, playlistCap: number): MediaItem[];
//# sourceMappingURL=job-service.d.ts.map