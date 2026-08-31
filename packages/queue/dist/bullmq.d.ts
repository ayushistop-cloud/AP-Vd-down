import type { ConnectionOptions } from 'bullmq';
import type { JobQueue, QueueDriverOptions, QueuePayload } from './types.js';
export declare class BullMqQueue implements JobQueue {
    private readonly options;
    readonly name = "downloads";
    private readonly queue;
    private worker;
    constructor(connection: ConnectionOptions, options: QueueDriverOptions);
    waitUntilReady(): Promise<void>;
    enqueue(payload: Omit<QueuePayload, 'attempt'>): Promise<void>;
    process(handler: (payload: QueuePayload) => Promise<void>): Promise<void>;
    depth(): Promise<{
        waiting: number;
        active: number;
    }>;
    close(): Promise<void>;
}
//# sourceMappingURL=bullmq.d.ts.map