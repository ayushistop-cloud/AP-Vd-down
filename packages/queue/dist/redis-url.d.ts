import type { ConnectionOptions } from 'bullmq';
/** Parse a redis:// URL into BullMQ connection options (fail fast on junk). */
export declare function parseRedisUrl(url: string): ConnectionOptions;
export declare function isLoopbackConfig(host: string): boolean;
//# sourceMappingURL=redis-url.d.ts.map