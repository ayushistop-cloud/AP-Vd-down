import http from 'node:http';
import { createLogger, loadConfig, MetricsRegistry } from '@3ap/shared';
import { checkEngineAtBoot, createDefaultAdapters } from '@3ap/adapters';
import { createQueue } from '@3ap/queue';
import { MemoryStore, PostgresStore } from '@3ap/store';
import { startEmbeddedWorker } from './index.js';
export * from './index.js';
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/apps/worker/dist/main.js') ||
    process.argv[1]?.replace(/\\/g, '/').endsWith('/apps/worker/src/main.ts') ||
    process.argv[1]?.replace(/\\/g, '/').endsWith('/dist/main.js') ||
    process.argv[1]?.replace(/\\/g, '/').endsWith('/src/main.ts');
if (isMain) {
    const port = process.env.PORT || 10000;
    const dummyServer = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end('Worker is alive (Antigravity active)\n');
    }).listen(port, () => {
        console.log(`Dummy server listening on port ${port} to satisfy Render Web Service requirements.`);
    });
    const config = loadConfig();
    const log = createLogger({ service: 'worker', level: config.LOG_LEVEL });
    const metrics = new MetricsRegistry();
    if ((config.NODE_ENV === 'production' || config.NODE_ENV === 'staging') && !config.DATABASE_URL) {
        throw new Error('FATAL: DATABASE_URL (PostgreSQL) is required in production/staging mode.');
    }
    if ((config.NODE_ENV === 'production' || config.NODE_ENV === 'staging') && !config.REDIS_URL) {
        throw new Error('FATAL: REDIS_URL (Redis queue) is required in production/staging mode.');
    }
    const store = config.DATABASE_URL ? new PostgresStore(config.DATABASE_URL) : new MemoryStore();
    if (!config.DATABASE_URL) {
        log.warn('no DATABASE_URL configured; using in-memory store (development only)');
    }
    if (!config.REDIS_URL) {
        log.warn('standalone worker started without REDIS_URL; it cannot receive jobs from a separate API process. ' +
            'For local development use `npm run dev:api` alone (embedded worker), or configure REDIS_URL for multi-process mode.');
    }
    await checkEngineAtBoot(log.child({ component: 'engine' }));
    const adapters = createDefaultAdapters();
    const queue = createQueue(config.REDIS_URL, log.child({ component: 'queue' }), config.WORKER_CONCURRENCY_GLOBAL);
    void startEmbeddedWorker({ config, store, adapters, queue, log, metrics }).then((worker) => {
        log.info('worker started', { artifactRoot: config.ARTIFACT_ROOT, env: config.NODE_ENV });
        const shutdown = () => {
            log.info('shutting down worker gracefully');
            dummyServer.close();
            void worker.stop().then(() => queue.close()).then(() => store.close()).finally(() => {
                log.info('worker shutdown complete');
                process.exit(0);
            });
        };
        process.once('SIGTERM', shutdown);
        process.once('SIGINT', shutdown);
    });
}
//# sourceMappingURL=main.js.map