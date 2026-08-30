import { createJobHandler } from './processor.js';
import { createArtifactStore } from './storage.js';
export * from './processor.js';
export * from './storage.js';
const CLEANUP_INTERVAL_MS = 60_000;
/**
 * Start the worker loop against injected dependencies (used both by the
 * standalone worker service and by the API's embedded dev worker).
 * Returns a stop function that ends consumption + cleanup scheduling.
 */
export async function startEmbeddedWorker(deps) {
    const artifacts = createArtifactStore(deps.config);
    if ('init' in artifacts && typeof artifacts.init === 'function') {
        await artifacts.init();
    }
    const handler = createJobHandler({ ...deps, artifacts });
    const consuming = deps.queue.process(handler).catch((err) => {
        deps.log.error('worker queue crashed', { message: err.message });
    });
    const cleanupTimer = setInterval(() => {
        void runCleanup(deps, artifacts);
    }, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();
    // Initial sweep at startup to clear anything left behind.
    await runCleanup(deps, artifacts);
    const stop = async () => {
        clearInterval(cleanupTimer);
        await consuming;
        deps.log.info('worker stopped');
    };
    return { stop };
}
/** Expire due artifacts, delete files, purge stale rows and resolve cache. */
async function runCleanup(deps, artifacts) {
    try {
        const now = new Date();
        const expired = await deps.store.expireDueArtifacts(now);
        for (const artifact of expired) {
            await artifacts.remove(artifact.artifactKey).catch(() => undefined);
            deps.log.info('expired artifact removed', { jobId: artifact.jobId });
            deps.metrics.counter('cleanup_artifacts_removed_total', 'expired artifacts deleted');
        }
        if (expired.length > 0) {
            deps.metrics.counter('cleanup_sweeps_with_removals_total', 'sweeps that removed files');
        }
        const purgedResolves = await deps.store.purgeExpiredResolves().catch(() => 0);
        if (purgedResolves > 0) {
            deps.metrics.counter('purged_resolves_total', 'resolve cache entries removed', {});
        }
        const usage = await artifacts.usageBytes().catch(() => -1);
        if (usage >= 0)
            deps.metrics.gauge('artifact_storage_bytes', usage, 'total temporary storage in use');
    }
    catch (err) {
        deps.log.error('cleanup sweep failed', { message: err.message });
        deps.metrics.counter('cleanup_failures_total', 'failed cleanup sweeps');
    }
}
//# sourceMappingURL=index.js.map