import type { Logger } from '@3ap/shared';
import { BullMqQueue } from './bullmq.js';
import { type JobQueue } from './types.js';
export * from './types.js';
export * from './memory.js';
export * from './redis-url.js';
export { BullMqQueue };
/**
 * Create a queue driver: BullMQ when redisUrl is provided, otherwise an
 * in-process queue. Both implement identical retry/backoff semantics.
 */
export declare function createQueue(redisUrl: string | undefined, logger: Logger, concurrency?: number): JobQueue;
//# sourceMappingURL=index.d.ts.map