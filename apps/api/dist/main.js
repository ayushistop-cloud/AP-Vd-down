import { join } from 'node:path';
import { createLogger, loadConfig, MetricsRegistry } from '@3ap/shared';
import { checkEngineAtBoot, createDefaultAdapters } from '@3ap/adapters';
import { createQueue } from '@3ap/queue';
import { MemoryStore, PostgresStore } from '@3ap/store';
import { buildApp } from './app.js';
/**
 * API service entrypoint (docs/09-ARCHITECTURE.md — stateless API tier).
 * Supports two production modes:
 * - DOWNLOAD_EXECUTION_MODE=embedded: API + in-process download worker in one Render service (Free mode).
 * - DOWNLOAD_EXECUTION_MODE=distributed: Separate API and Redis/BullMQ worker services (Paid mode).
 */
export async function startApi() {
    const config = loadConfig();
    const log = createLogger({ service: 'api', level: config.LOG_LEVEL });
    const metrics = new MetricsRegistry();
    let store;
    if (config.DATABASE_URL) {
        try {
            const migratePath = join(process.cwd(), 'scripts/migrate.mjs');
            const { runMigrations } = await import(`file://${migratePath.replace(/\\/g, '/')}`);
            await runMigrations(config.DATABASE_URL);
            log.info('database migrations verified/applied on startup');
        }
        catch (err) {
            log.warn('auto-migration startup check warning', { message: err.message });
        }
        store = new PostgresStore(config.DATABASE_URL);
        log.info('using PostgreSQL store');
    }
    else {
        if (config.NODE_ENV === 'production' || config.NODE_ENV === 'staging') {
            throw new Error('FATAL: DATABASE_URL (PostgreSQL) is required in production/staging mode.');
        }
        store = new MemoryStore();
        log.warn('no DATABASE_URL configured; using in-memory store (development only)');
    }
    const adapters = createDefaultAdapters();
    const isEmbeddedMode = config.DOWNLOAD_EXECUTION_MODE === 'embedded' || (!config.REDIS_URL && config.NODE_ENV === 'local');
    if ((config.NODE_ENV === 'production' || config.NODE_ENV === 'staging') && !isEmbeddedMode && !config.REDIS_URL) {
        throw new Error('FATAL: REDIS_URL (Redis queue) is required when DOWNLOAD_EXECUTION_MODE=distributed.');
    }
    const queue = createQueue(isEmbeddedMode ? undefined : config.REDIS_URL, log.child({ component: 'queue' }), config.WORKER_CONCURRENCY_GLOBAL);
    // Operator-facing engine check at boot; requests fail closed with a
    // normalized error until the engine is available.
    await checkEngineAtBoot(log.child({ component: 'engine' }));
    let embeddedWorkerRef;
    if (isEmbeddedMode) {
        const { startEmbeddedWorker } = await import('@3ap/worker');
        embeddedWorkerRef = await startEmbeddedWorker({
            config,
            store,
            adapters,
            queue,
            log: log.child({ component: 'embedded-worker' }),
            metrics,
        });
        log.info('embedded in-process download worker started (single-service mode)');
    }
    const app = await buildApp({ config, store, adapters, queue, log, metrics });
    const listenHost = config.NODE_ENV === 'production' || config.NODE_ENV === 'staging' ? '0.0.0.0' : config.API_HOST;
    const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : config.API_PORT;
    try {
        await app.listen({ port, host: listenHost });
    }
    catch (err) {
        if (err?.code === 'EADDRINUSE') {
            log.info(`API backend is already running on http://${listenHost}:${port}`);
            return { stop: async () => { } };
        }
        log.error('failed to bind API port', { port, host: listenHost, message: err.message });
        throw err;
    }
    log.info('api listening', {
        host: listenHost,
        port,
        env: config.NODE_ENV,
        executionMode: config.DOWNLOAD_EXECUTION_MODE,
        routes: [
            'GET  /',
            'GET  /health',
            'GET  /healthz',
            'GET  /api/v1/meta/platforms',
            'POST /api/v1/resolve',
            'POST /api/v1/jobs',
            'GET  /api/v1/jobs/:id',
            'POST /api/v1/jobs/:id/cancel',
            'GET  /api/v1/jobs/:id/download',
        ],
    });
    let shuttingDown = false;
    const stop = async () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        log.info('shutting down api gracefully');
        if (embeddedWorkerRef) {
            await embeddedWorkerRef.stop().catch(() => undefined);
        }
        await app.close().catch(() => undefined);
        await queue.close().catch(() => undefined);
        await store.close().catch(() => undefined);
        log.info('api shutdown complete');
    };
    process.once('SIGTERM', () => void stop());
    process.once('SIGINT', () => void stop());
    return { stop };
}
// Run directly when executed as a script.
import { fileURLToPath } from 'node:url';
const currentFile = fileURLToPath(import.meta.url).replace(/\\/g, '/');
const execFile = process.argv[1] ? join(process.argv[1]).replace(/\\/g, '/') : '';
const isMain = execFile.endsWith('/apps/api/dist/main.js') ||
    execFile.endsWith('/apps/api/src/main.ts') ||
    (Boolean(execFile) && execFile === currentFile);
if (isMain) {
    startApi().catch((err) => {
        console.error(JSON.stringify({ event: 'fatal', message: err.message }));
        process.exit(1);
    });
}
//# sourceMappingURL=main.js.map