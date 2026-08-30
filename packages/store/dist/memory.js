import { appErrors } from '@3ap/shared';
function rowToIsoDate(value) {
    return value instanceof Date ? value : new Date(value);
}
/**
 * In-memory implementation for local development and tests.
 * Data lives for the process lifetime only — matching the privacy posture
 * that nothing here is meant to be durable.
 */
export class MemoryStore {
    resolves = new Map();
    jobs = new Map();
    items = new Map();
    itemsByJob = new Map();
    events = [];
    async saveResolve(record) {
        this.resolves.set(record.resolveId, { ...record });
    }
    async getResolve(resolveId) {
        const record = this.resolves.get(resolveId);
        if (!record)
            return null;
        if (record.expiresAt <= Date.now())
            return null;
        return { ...record };
    }
    async purgeExpiredResolves() {
        let purged = 0;
        const now = Date.now();
        for (const [id, record] of this.resolves) {
            if (record.expiresAt <= now) {
                this.resolves.delete(id);
                purged += 1;
            }
        }
        return purged;
    }
    async createJobWithItems(job, items) {
        if (job.idempotencyKey && [...this.jobs.values()].some((j) => j.idempotencyKey === job.idempotencyKey)) {
            throw appErrors.conflict('A job with this idempotency key already exists.');
        }
        const now = new Date();
        const row = {
            id: job.id,
            status: 'queued',
            platform: job.platform,
            kind: job.kind,
            resolveId: job.resolveId,
            sourceUrlHash: job.sourceUrlHash,
            sourceUrlRedacted: job.sourceUrlRedacted,
            sourceUrl: job.sourceUrl,
            ipHash: job.ipHash,
            idempotencyKey: job.idempotencyKey,
            title: job.title,
            creator: job.creator,
            requestedFormatId: job.requestedFormatId,
            requestedQualityLabel: null,
            progress: 0,
            errorCode: null,
            errorMessage: null,
            cancelRequested: false,
            createdAt: rowToIsoDate(now),
            startedAt: null,
            completedAt: null,
            expiresAt: null,
        };
        this.jobs.set(row.id, row);
        const ids = new Set();
        for (const item of items) {
            const itemRow = {
                id: item.id,
                jobId: item.jobId,
                ordinal: item.ordinal,
                title: item.title,
                sourceUrl: item.sourceUrl,
                status: 'pending',
                progress: 0,
                artifactKey: null,
                artifactName: null,
                artifactSizeBytes: null,
                errorCode: null,
                errorMessage: null,
            };
            this.items.set(itemRow.id, itemRow);
            ids.add(itemRow.id);
        }
        this.itemsByJob.set(row.id, ids);
    }
    async getJob(id) {
        const job = this.jobs.get(id);
        return job ? { ...job } : null;
    }
    async listItems(jobId) {
        const ids = this.itemsByJob.get(jobId);
        if (!ids)
            return [];
        const rows = [...ids].map((id) => this.items.get(id)).filter((r) => !!r);
        return rows.map((r) => ({ ...r })).sort((a, b) => a.ordinal - b.ordinal);
    }
    async getItem(itemId) {
        const item = this.items.get(itemId);
        return item ? { ...item } : null;
    }
    async updateJob(id, patch) {
        const job = this.jobs.get(id);
        if (!job)
            throw new Error(`job ${id} not found`);
        Object.assign(job, patch);
    }
    async updateItem(id, patch) {
        const item = this.items.get(id);
        if (!item)
            throw new Error(`item ${id} not found`);
        Object.assign(item, patch);
    }
    async requestCancel(id) {
        const job = this.jobs.get(id);
        if (!job)
            return false;
        if (!['queued', 'processing'].includes(job.status))
            return false;
        job.cancelRequested = true;
        job.status = 'cancelled';
        job.completedAt = new Date();
        // Queued items never started → skipped; running ones observe cancel flag.
        for (const itemId of this.itemsByJob.get(id) ?? []) {
            const item = this.items.get(itemId);
            if (item && ['pending', 'downloading'].includes(item.status)) {
                item.status = 'skipped';
                item.errorCode = 'CANCELLED';
            }
        }
        job.sourceUrl = null;
        return true;
    }
    async activeJobCountForIp(ipHash) {
        let count = 0;
        for (const job of this.jobs.values()) {
            if (job.ipHash === ipHash && ['queued', 'processing'].includes(job.status))
                count += 1;
        }
        return count;
    }
    async findJobByIdempotencyKey(key) {
        for (const job of this.jobs.values()) {
            if (job.idempotencyKey === key)
                return { ...job };
        }
        return null;
    }
    async recordAdapterEvent(event) {
        this.events.push({
            ...event,
            id: event.id ?? crypto.randomUUID(),
            createdAt: new Date(),
        });
        // Bound telemetry memory in dev
        if (this.events.length > 5000)
            this.events.splice(0, 1000);
    }
    async expireDueArtifacts(now) {
        const expired = [];
        for (const job of this.jobs.values()) {
            if (job.status === 'completed' && job.expiresAt && job.expiresAt.getTime() <= now.getTime()) {
                job.status = 'expired';
                job.sourceUrl = null;
                for (const itemId of this.itemsByJob.get(job.id) ?? []) {
                    const item = this.items.get(itemId);
                    if (item?.artifactKey) {
                        expired.push({ jobId: job.id, artifactKey: item.artifactKey });
                        item.artifactKey = null;
                    }
                }
            }
        }
        return expired;
    }
    async queueDepths() {
        let queued = 0;
        let processing = 0;
        for (const job of this.jobs.values()) {
            if (job.status === 'queued')
                queued += 1;
            if (job.status === 'processing')
                processing += 1;
        }
        return { queued, processing };
    }
    async healthCheck() {
        return true;
    }
    async close() {
        /* nothing to release */
    }
}
//# sourceMappingURL=memory.js.map