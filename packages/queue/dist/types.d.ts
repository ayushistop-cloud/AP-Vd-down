import type { Logger } from '@3ap/shared';
/**
 * Minimal queue contract (docs/21-QUEUE-WORKER.md).
 * Payload is intentionally tiny: workers hydrate authoritative state from
 * the job store, keeping the queue disposable.
 */
export interface QueuePayload {
    jobId: string;
    itemId: string;
    attempt: number;
}
export interface QueueDriverOptions {
    concurrency: number;
    /** Total attempts per payload (first try + retries). */
    maxAttempts: number;
    baseBackoffMs: number;
    logger: Logger;
}
export interface JobQueue {
    readonly name: string;
    enqueue(payload: Omit<QueuePayload, 'attempt'>, options?: {
        delayMs?: number;
    }): Promise<void>;
    process(handler: (payload: QueuePayload) => Promise<void>): Promise<void>;
    depth(): Promise<{
        waiting: number;
        active: number;
    }>;
    close(): Promise<void>;
}
export declare const MAX_ATTEMPTS = 3;
export declare const BASE_BACKOFF_MS = 2000;
//# sourceMappingURL=types.d.ts.map