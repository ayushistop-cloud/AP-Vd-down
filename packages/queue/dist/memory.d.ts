import type { JobQueue, QueueDriverOptions, QueuePayload } from './types.js';
/**
 * In-process FIFO queue used when REDIS_URL is not configured (single-node
 * dev/small deployments). Implements the same retry/backoff semantics as the
 * BullMQ driver so worker behavior is identical across drivers.
 */
export declare class MemoryQueue implements JobQueue {
    private readonly options;
    readonly name: string;
    private readonly waiting;
    private active;
    private running;
    private closed;
    private readonly inFlight;
    private timer;
    constructor(name: string, options: QueueDriverOptions);
    enqueue(payload: Omit<QueuePayload, 'attempt'>, opts?: {
        delayMs?: number;
    }): Promise<void>;
    process(handler: (payload: QueuePayload) => Promise<void>): Promise<void>;
    depth(): Promise<{
        waiting: number;
        active: number;
    }>;
    close(): Promise<void>;
    private nextRunDelay;
    private waitForNext;
    private runWithRetry;
}
//# sourceMappingURL=memory.d.ts.map