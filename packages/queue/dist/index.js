import { BullMqQueue } from './bullmq.js';
import { MemoryQueue } from './memory.js';
import { parseRedisUrl } from './redis-url.js';
import { BASE_BACKOFF_MS, MAX_ATTEMPTS } from './types.js';
export * from './types.js';
export * from './memory.js';
export * from './redis-url.js';
export { BullMqQueue };
/**
 * Create a queue driver: BullMQ when redisUrl is provided, otherwise an
 * in-process queue. Both implement identical retry/backoff semantics.
 */
export function createQueue(redisUrl, logger, concurrency = 4) {
    const options = {
        concurrency,
        maxAttempts: MAX_ATTEMPTS,
        baseBackoffMs: BASE_BACKOFF_MS,
        logger,
    };
    if (redisUrl) {
        const q = new BullMqQueue(parseRedisUrl(redisUrl), options);
        logger.info('using BullMQ queue driver');
        return q;
    }
    logger.info('no REDIS_URL configured; using in-process queue');
    return new MemoryQueue('downloads', options);
}
//# sourceMappingURL=index.js.map