import { appErrors, hashWithPepper, newId, redactUrl, } from '@3ap/shared';
/** Adapter-generic options that exist without per-item format introspection. */
const GENERIC_FORMAT_ID = /^(best|best<=\d{2,4}|audio|file)$/;
export class JobService {
    store;
    enqueue;
    options;
    constructor(store, enqueue, options) {
        this.store = store;
        this.enqueue = enqueue;
        this.options = options;
    }
    async createJob(input, ctx) {
        // Idempotency first (docs/20-DOWNLOAD-PIPELINE.md): retried POSTs with the
        // same key return the original job instead of duplicating work.
        if (ctx.idempotencyKey) {
            const existing = await this.store.findJobByIdempotencyKey(ctx.idempotencyKey);
            if (existing) {
                const items = await this.store.listItems(existing.id);
                return { job: existing, items };
            }
        }
        const record = await this.store.getResolve(input.resolveId);
        if (!record || record.expiresAt <= Date.now()) {
            throw appErrors.notFound('This result has expired. Paste the link again to start a new download.');
        }
        const targets = selectTargetItems(record, input, this.options.maxPlaylistItems);
        validateFormatChoice(targets, input.formatId);
        // Per-IP concurrency limit (docs/24-RATE-LIMITING-ABUSE.md)
        const active = await this.store.activeJobCountForIp(ctx.ipHash);
        if (active >= this.options.maxConcurrentJobsPerIp) {
            throw appErrors.rateLimited(`You already have ${active} download${active === 1 ? '' : 's'} in progress. Wait for one to finish.`, { activeJobs: active });
        }
        const jobId = newId();
        const primary = targets[0];
        const selectedFormat = findSelectedFormat(targets, input.formatId);
        const newJob = {
            id: jobId,
            platform: record.platform,
            kind: record.kind,
            resolveId: record.resolveId,
            sourceUrlHash: hashWithPepper(record.canonicalUrl, this.options.ipPepper),
            sourceUrlRedacted: redactUrl(record.canonicalUrl),
            sourceUrl: targets.length === 1 ? record.canonicalUrl : null,
            ipHash: ctx.ipHash,
            idempotencyKey: ctx.idempotencyKey,
            title: record.title ?? (targets.length === 1 ? primary.title : `${record.platform} collection`),
            creator: record.creator ?? null,
            requestedFormatId: input.formatId ?? null,
        };
        const jobItems = targets.map((item, index) => ({
            id: newId(),
            jobId,
            ordinal: index,
            title: item.title,
            sourceUrl: item.sourceUrl,
        }));
        await this.store.createJobWithItems(newJob, jobItems);
        for (const item of jobItems) {
            await this.enqueue({ jobId, itemId: item.id });
        }
        this.options.metrics.counter('jobs_created_total', 'jobs created', { platform: record.platform });
        this.options.log.info('job created', {
            jobId,
            platform: record.platform,
            kind: record.kind,
            itemCount: jobItems.length,
            requestedQualityLabel: selectedFormat?.label ?? null,
        });
        const [jobRow, itemRows] = await Promise.all([this.store.getJob(jobId), this.store.listItems(jobId)]);
        return { job: jobRow, items: itemRows };
    }
}
/** Pick which resolve items this job covers, enforcing caps and selection rules. */
export function selectTargetItems(record, input, playlistCap) {
    const all = record.items;
    if (record.kind === 'single') {
        if (input.itemId && !all.some((item) => item.id === input.itemId)) {
            throw appErrors.validation('itemId does not match this result.');
        }
        return all.slice(0, 1);
    }
    if (record.kind === 'collection') {
        if (!input.itemId) {
            throw appErrors.validation('Choose one media item from this collection.');
        }
        const target = all.find((item) => item.id === input.itemId);
        if (!target)
            throw appErrors.validation('The requested media item does not exist in this result.');
        return [target];
    }
    // playlist
    if (input.itemIds && input.itemIds.length > 0) {
        const unique = [...new Set(input.itemIds)];
        if (unique.length > playlistCap)
            throw appErrors.playlistLimit();
        const found = unique
            .map((id) => all.find((item) => item.id === id))
            .filter((item) => !!item);
        if (found.length !== unique.length) {
            throw appErrors.validation('One or more selected playlist items do not exist.');
        }
        return found;
    }
    if (all.length > playlistCap)
        throw appErrors.playlistLimit();
    return all;
}
function validateFormatChoice(targets, formatId) {
    if (!formatId)
        return;
    if (GENERIC_FORMAT_ID.test(formatId))
        return; // ladder/audio/file options are adapter-generic
    const exists = targets.some((t) => (t.formats ?? []).some((f) => f.formatId === formatId));
    if (!exists) {
        throw appErrors.validation('The selected option is not available for this content.');
    }
}
function findSelectedFormat(targets, formatId) {
    if (!formatId)
        return undefined;
    for (const target of targets) {
        const hit = (target.formats ?? []).find((f) => f.formatId === formatId);
        if (hit)
            return hit;
    }
    return undefined;
}
//# sourceMappingURL=job-service.js.map