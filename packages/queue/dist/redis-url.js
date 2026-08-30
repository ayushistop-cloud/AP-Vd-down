import { isIP } from 'node:net';
/** Parse a redis:// URL into BullMQ connection options (fail fast on junk). */
export function parseRedisUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error(`Invalid REDIS_URL: ${url.replace(/:\/\/[^@]*@/, '://***@')}`);
    }
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
        throw new Error('REDIS_URL must start with redis:// or rediss://');
    }
    return {
        host: parsed.hostname,
        port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
        username: parsed.username || undefined,
        password: parsed.password || undefined,
        db: parsed.pathname && parsed.pathname.length > 1 ? Number.parseInt(parsed.pathname.slice(1), 10) : undefined,
        maxRetriesPerRequest: null,
    };
}
export function isLoopbackConfig(host) {
    return isIP(host) === 4 && host.startsWith('127.');
}
//# sourceMappingURL=redis-url.js.map