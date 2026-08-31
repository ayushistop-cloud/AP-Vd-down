import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createLogger, loadConfig, MetricsRegistry } from '@3ap/shared';
import { checkEngineAtBoot, createDefaultAdapters } from '@3ap/adapters';
import { createQueue } from '@3ap/queue';
import { MemoryStore, PostgresStore } from '@3ap/store';
import { startEmbeddedWorker } from './index.js';
export * from './index.js';
const currentFile = fileURLToPath(import.meta.url).replace(/\\/g, '/');
const execFile = process.argv[1] ? path.resolve(process.argv[1]).replace(/\\/g, '/') : '';
const isMain = execFile.endsWith('/apps/worker/dist/main.js') ||
    execFile.endsWith('/apps/worker/src/main.ts') ||
    (Boolean(execFile) && execFile === currentFile);
if (isMain) {
    const config = loadConfig();
    const log = createLogger({ service: 'worker', level: config.LOG_LEVEL });
    const metrics = new MetricsRegistry();
    const isEmbeddedMode = config.DOWNLOAD_EXECUTION_MODE === 'embedded' || (!config.REDIS_URL && config.NODE_ENV === 'local');
    if ((config.NODE_ENV === 'production' || config.NODE_ENV === 'staging') && !config.DATABASE_URL) {
        throw new Error('FATAL: DATABASE_URL (PostgreSQL) is required in production/staging mode.');
    }
    if (config.DOWNLOAD_EXECUTION_MODE === 'distributed' && (config.NODE_ENV === 'production' || config.NODE_ENV === 'staging') && !config.REDIS_URL) {
        throw new Error('FATAL: REDIS_URL (Redis queue) is required when running standalone worker in distributed mode.');
    }
    const store = config.DATABASE_URL ? new PostgresStore(config.DATABASE_URL) : new MemoryStore();
    if (!config.DATABASE_URL) {
        log.warn('no DATABASE_URL configured; using in-memory store (development only)');
    }
    if (!config.REDIS_URL && !isEmbeddedMode) {
        log.warn('standalone worker started without REDIS_URL; using in-process queue for standalone execution.');
    }
    await checkEngineAtBoot(log.child({ component: 'engine' }));
    const adapters = createDefaultAdapters();
    const queue = createQueue(isEmbeddedMode ? undefined : config.REDIS_URL, log.child({ component: 'queue' }), config.WORKER_CONCURRENCY_GLOBAL);
    let dummyServer;
    if (process.env.WORKER_PORT) {
        const workerPort = Number.parseInt(process.env.WORKER_PORT, 10);
        dummyServer = http.createServer((_req, res) => {
            res.writeHead(200);
            res.end('Worker is alive\n');
        }).listen(workerPort, () => {
            log.info(`Standalone worker health server listening on port ${workerPort}`);
        });
    }
    void startEmbeddedWorker({ config, store, adapters, queue, log, metrics }).then((worker) => {
        log.info('worker started', { artifactRoot: config.ARTIFACT_ROOT, env: config.NODE_ENV });
        const shutdown = () => {
            log.info('shutting down worker gracefully');
            if (dummyServer)
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