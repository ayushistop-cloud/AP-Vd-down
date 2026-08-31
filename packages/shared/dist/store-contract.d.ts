import type { AdapterEventRow, JobItemRow, JobRow, ResolveRecord } from './types.js';
/**
 * Persistence boundary (docs/11-DATABASE-SCHEMA.md).
 * Implemented by the API/worker PostgresStore (production) and MemoryStore
 * (local dev/tests). Server-side contract; contains no runtime code.
 */
export interface NewJob {
    id: string;
    platform: JobRow['platform'];
    kind: JobRow['kind'];
    resolveId: string | null;
    sourceUrlHash: string;
    sourceUrlRedacted: string;
    sourceUrl: string | null;
    ipHash: string;
    idempotencyKey: string | null;
    title: string | null;
    creator: string | null;
    requestedFormatId: string | null;
}
export interface NewJobItem {
    id: string;
    jobId: string;
    ordinal: number;
    title: string;
    sourceUrl: string;
}
export interface ExpiredArtifact {
    jobId: string;
    artifactKey: string;
}
export interface QueueDepths {
    queued: number;
    processing: number;
}
export interface JobStore {
    saveResolve(record: ResolveRecord): Promise<void>;
    getResolve(resolveId: string): Promise<ResolveRecord | null>;
    purgeExpiredResolves(): Promise<number>;
    createJobWithItems(job: NewJob, items: NewJobItem[]): Promise<void>;
    getJob(id: string): Promise<JobRow | null>;
    listItems(jobId: string): Promise<JobItemRow[]>;
    getItem(itemId: string): Promise<JobItemRow | null>;
    updateJob(id: string, patch: Partial<Omit<JobRow, 'id'>>): Promise<void>;
    updateItem(id: string, patch: Partial<Omit<JobItemRow, 'id'>>): Promise<void>;
    /** Mark a queued/processing job cancelled; returns false when already terminal. */
    requestCancel(id: string): Promise<boolean>;
    activeJobCountForIp(ipHash: string): Promise<number>;
    findJobByIdempotencyKey(key: string): Promise<JobRow | null>;
    recordAdapterEvent(event: Omit<AdapterEventRow, 'id' | 'createdAt'> & {
        id?: string;
    }): Promise<void>;
    /** Mark completed jobs past expiry as expired; returns artifacts to delete. */
    expireDueArtifacts(now: Date): Promise<ExpiredArtifact[]>;
    queueDepths(): Promise<QueueDepths>;
    healthCheck(): Promise<boolean>;
    close(): Promise<void>;
}
//# sourceMappingURL=store-contract.d.ts.map