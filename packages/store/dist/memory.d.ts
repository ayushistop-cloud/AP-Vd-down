import type { AdapterEventRow, ExpiredArtifact, JobItemRow, JobRow, JobStore, NewJob, NewJobItem, QueueDepths, ResolveRecord } from '@3ap/shared';
/**
 * In-memory implementation for local development and tests.
 * Data lives for the process lifetime only — matching the privacy posture
 * that nothing here is meant to be durable.
 */
export declare class MemoryStore implements JobStore {
    private readonly resolves;
    private readonly jobs;
    private readonly items;
    private readonly itemsByJob;
    private readonly events;
    saveResolve(record: ResolveRecord): Promise<void>;
    getResolve(resolveId: string): Promise<ResolveRecord | null>;
    purgeExpiredResolves(): Promise<number>;
    createJobWithItems(job: NewJob, items: NewJobItem[]): Promise<void>;
    getJob(id: string): Promise<JobRow | null>;
    listItems(jobId: string): Promise<JobItemRow[]>;
    getItem(itemId: string): Promise<JobItemRow | null>;
    updateJob(id: string, patch: Partial<Omit<JobRow, 'id'>>): Promise<void>;
    updateItem(id: string, patch: Partial<Omit<JobItemRow, 'id'>>): Promise<void>;
    requestCancel(id: string): Promise<boolean>;
    activeJobCountForIp(ipHash: string): Promise<number>;
    findJobByIdempotencyKey(key: string): Promise<JobRow | null>;
    recordAdapterEvent(event: Omit<AdapterEventRow, 'id' | 'createdAt'> & {
        id?: string;
    }): Promise<void>;
    expireDueArtifacts(now: Date): Promise<ExpiredArtifact[]>;
    queueDepths(): Promise<QueueDepths>;
    healthCheck(): Promise<boolean>;
    close(): Promise<void>;
}
//# sourceMappingURL=memory.d.ts.map