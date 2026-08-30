import { rm } from 'node:fs/promises';
import { appErrors, artifactKeyOf, toAppError, } from '@3ap/shared';
import { MAX_ATTEMPTS } from '@3ap/queue';
/** Per-platform concurrency caps (docs/21-QUEUE-WORKER.md). */
class PlatformSemaphores {
    limits;
    slots = new Map();
    constructor(limits) {
        this.limits = limits;
    }
    async acquire(key) {
        let slot = this.slots.get(key);
        if (!slot) {
            slot = { active: 0, max: this.limits[key] ?? 2, waiters: [] };
            this.slots.set(key, slot);
        }
        const current = slot;
        if (current.active < current.max) {
            current.active += 1;
            return () => this.release(current);
        }
        await new Promise((resolve) => current.waiters.push(resolve));
        current.active += 1;
        return () => this.release(current);
    }
    release(slot) {
        slot.active -= 1;
        const next = slot.waiters.shift();
        if (next)
            next();
    }
}
const TERMINAL_ITEM_STATUSES = ['completed', 'failed', 'skipped'];
export function createJobHandler(deps) {
    const semaphores = new PlatformSemaphores({
        youtube: deps.config.WORKER_CONCURRENCY_YOUTUBE,
        tiktok: deps.config.WORKER_CONCURRENCY_TIKTOK,
        instagram: deps.config.WORKER_CONCURRENCY_INSTAGRAM,
        facebook: deps.config.WORKER_CONCURRENCY_FACEBOOK,
        terabox: deps.config.WORKER_CONCURRENCY_TERABOX,
    });
    const maxFileSizeBytes = deps.config.MAX_FILE_SIZE_MB * 1024 * 1024;
    return async (payload) => {
        const started = Date.now();
        const job = await deps.store.getJob(payload.jobId).catch(() => null);
        if (!job)
            return; // purged or unknown — nothing to do
        const item = await deps.store.getItem(payload.itemId).catch(() => null);
        if (!item)
            return;
        // Cancellation / skip short-circuit
        if (job.cancelRequested || job.status === 'cancelled' || item.status === 'skipped') {
            await markItemSkipped(deps, item, 'CANCELLED');
            await finalizeIfDone(deps, payload.jobId);
            return;
        }
        if (TERMINAL_ITEM_STATUSES.includes(item.status)) {
            await finalizeIfDone(deps, payload.jobId);
            return;
        }
        const adapter = deps.adapters.get(job.platform);
        // Claim the job as processing (idempotent).
        if (job.status !== 'processing') {
            await deps.store.updateJob(job.id, { status: 'processing', startedAt: job.startedAt ?? new Date() });
        }
        const release = await semaphores.acquire(job.platform);
        try {
            await runTask(deps, job, item, adapter, maxFileSizeBytes);
            deps.metrics.counter('job_items_total', 'processed items', { platform: job.platform, outcome: 'ok' });
            deps.metrics.observe('worker_item_duration_ms', Date.now() - started);
        }
        catch (err) {
            const appErr = normalizeWith(err, adapter);
            const attemptsLeft = payload.attempt + 1 < MAX_ATTEMPTS;
            if (appErr.code === 'CANCELLED') {
                await markItemSkipped(deps, item, 'CANCELLED');
                await finalizeIfDone(deps, payload.jobId);
                return;
            }
            if (appErr.retryable && attemptsLeft) {
                deps.metrics.counter('job_items_total', 'processed items', { platform: job.platform, outcome: appErr.code });
                deps.log.warn('item failed transiently; returning to queue', {
                    jobId: job.id,
                    itemId: item.id,
                    attempt: payload.attempt + 1,
                    errorCode: appErr.code,
                });
                await deps.store.updateItem(item.id, { status: 'pending', progress: 0 }).catch(() => undefined);
                throw Object.assign(err instanceof Error ? err : new Error(appErr.message), { retryable: true });
            }
            deps.metrics.counter('job_items_total', 'processed items', { platform: job.platform, outcome: appErr.code });
            deps.log.error('item failed terminally', { jobId: job.id, itemId: item.id, errorCode: appErr.code });
            await deps.store
                .updateItem(item.id, { status: 'failed', errorCode: appErr.code, errorMessage: appErr.message })
                .catch(() => undefined);
            await finalizeIfDone(deps, payload.jobId);
        }
        finally {
            release();
        }
    };
}
async function runTask(deps, job, item, adapter, maxFileSizeBytes) {
    const workDir = await deps.artifacts.createWorkDir();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, deps.config.JOB_TIMEOUT_SECONDS * 1000);
    timer.unref?.();
    let lastWrite = 0;
    try {
        await deps.store.updateItem(item.id, { status: 'downloading', progress: 1 });
        // Rehydrate exact formats from the resolve record when still cached.
        const formats = await loadItemFormats(deps, job.resolveId, item);
        const taskCtx = {
            workDir,
            signal: controller.signal,
            onProgress: async (progress) => {
                const now = Date.now();
                if (now - lastWrite < 500 && progress.percent !== 100)
                    return;
                lastWrite = now;
                const pct = clampPercent(progress.percent);
                if (pct !== undefined) {
                    await deps.store.updateItem(item.id, { progress: pct }).catch(() => undefined);
                    await recalcJobProgress(deps, job.id);
                }
            },
            isCancelled: async () => {
                const freshJob = await deps.store.getJob(job.id).catch(() => null);
                const freshItem = await deps.store.getItem(item.id).catch(() => null);
                return !!freshJob?.cancelRequested || freshJob?.status === 'cancelled' || freshItem?.status === 'skipped';
            },
            log: deps.log.child({ jobId: job.id, itemId: item.id }),
        };
        const result = await adapter.createDownloadTask({
            jobId: job.id,
            sourceUrl: item.sourceUrl,
            itemTitle: item.title,
            creator: job.creator ?? undefined,
            formatId: job.requestedFormatId ?? undefined,
            formats,
            maxFileSizeBytes,
        }, taskCtx);
        const key = artifactKeyOf(job.id, item.id, result.fileName);
        if (!key)
            throw appErrors.internal();
        const stored = await deps.artifacts.put(result.filePath, key);
        await deps.store.updateItem(item.id, {
            status: 'completed',
            progress: 100,
            artifactKey: stored.key,
            artifactName: result.fileName,
            artifactSizeBytes: stored.sizeBytes,
            errorCode: null,
            errorMessage: null,
        });
        await recalcJobProgress(deps, job.id);
        await finalizeIfDone(deps, job.id);
    }
    catch (err) {
        // A full timeout is terminal: retrying would double wall time for nothing.
        if (timedOut) {
            throw appErrors.processingFailed('Processing took too long and was stopped.');
        }
        throw err;
    }
    finally {
        clearTimeout(timer);
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
function normalizeWith(err, adapter) {
    try {
        return adapter.normalizeError(err);
    }
    catch {
        return toAppError(err);
    }
}
async function loadItemFormats(deps, resolveId, item) {
    if (!resolveId)
        return undefined;
    let resolve;
    try {
        resolve = await deps.store.getResolve(resolveId);
    }
    catch {
        resolve = null; // store hiccup — generic selectors still apply
    }
    if (!resolve)
        return undefined; // TTL elapsed — generic selectors still apply
    const match = resolve.items.find((entry) => entry.sourceUrl === item.sourceUrl) ??
        resolve.items.find((entry) => entry.title === item.title);
    return match?.formats;
}
async function markItemSkipped(deps, item, code) {
    await deps.store.updateItem(item.id, {
        status: 'skipped',
        errorCode: code,
        errorMessage: 'Cancelled.',
    }).catch(() => undefined);
}
/** Recompute aggregate job progress from its items. */
async function recalcJobProgress(deps, jobId) {
    const items = await deps.store.listItems(jobId).catch(() => []);
    if (items.length === 0)
        return;
    const avg = Math.round(items.reduce((sum, i) => sum + i.progress, 0) / items.length);
    await deps.store.updateJob(jobId, { progress: avg }).catch(() => undefined);
}
/**
 * When every item reached a terminal state, close out the job:
 * completed (≥1 succeeded), cancelled, or failed. Completed jobs get their
 * expiration timestamp and lose raw source URLs immediately (privacy).
 */
export async function finalizeIfDone(deps, jobId) {
    const [job, items] = await Promise.all([deps.store.getJob(jobId), deps.store.listItems(jobId)]);
    if (!job)
        return;
    const allTerminal = items.length > 0 &&
        items.every((i) => TERMINAL_ITEM_STATUSES.includes(i.status));
    if (!allTerminal || ['completed', 'failed', 'cancelled', 'expired'].includes(job.status))
        return;
    if (job.cancelRequested) {
        await deps.store.updateJob(jobId, {
            status: 'cancelled',
            completedAt: new Date(),
            sourceUrl: null,
            errorCode: 'CANCELLED',
        });
        deps.metrics.counter('jobs_finalized_total', 'jobs finalized', { platform: job.platform, outcome: 'cancelled' });
        return;
    }
    const anyCompleted = items.some((i) => i.status === 'completed');
    if (anyCompleted) {
        const expiresAt = new Date(Date.now() + deps.config.ARTIFACT_TTL_MINUTES * 60_000);
        await deps.store.updateJob(jobId, {
            status: 'completed',
            completedAt: new Date(),
            expiresAt,
            sourceUrl: null,
            progress: 100,
        });
        deps.metrics.counter('jobs_finalized_total', 'jobs finalized', { platform: job.platform, outcome: 'completed' });
        return;
    }
    const firstFailure = items.find((i) => i.errorCode);
    await deps.store.updateJob(jobId, {
        status: 'failed',
        completedAt: new Date(),
        sourceUrl: null,
        errorCode: firstFailure?.errorCode ?? 'PROCESSING_FAILED',
        errorMessage: firstFailure?.errorMessage ?? 'Processing failed.',
        progress: 100,
    });
    deps.metrics.counter('jobs_finalized_total', 'jobs finalized', { platform: job.platform, outcome: 'failed' });
}
function clampPercent(percent) {
    if (percent === undefined || !Number.isFinite(percent))
        return undefined;
    return Math.max(0, Math.min(100, Math.round(percent)));
}
//# sourceMappingURL=processor.js.map