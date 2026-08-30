import { Pool } from 'pg';
import { appErrors } from '@3ap/shared';
/**
 * PostgreSQL implementation of the persistence boundary.
 * Schema lives in migrations/001_init.sql (docs/11-DATABASE-SCHEMA.md).
 */
function tsToDate(value) {
    return value instanceof Date ? value : new Date(value);
}
function rowToJob(r) {
    return {
        id: r.id,
        status: r.status,
        platform: r.platform,
        kind: r.kind,
        resolveId: r.resolve_id ?? null,
        sourceUrlHash: r.source_url_hash,
        sourceUrlRedacted: r.source_url_redacted,
        sourceUrl: r.source_url ?? null,
        ipHash: r.ip_hash,
        idempotencyKey: r.idempotency_key ?? null,
        title: r.title ?? null,
        creator: r.creator ?? null,
        requestedFormatId: r.requested_format_id ?? null,
        requestedQualityLabel: r.requested_quality_label ?? null,
        progress: Number(r.progress ?? 0),
        errorCode: r.error_code ?? null,
        errorMessage: r.error_message ?? null,
        cancelRequested: Boolean(r.cancel_requested),
        createdAt: tsToDate(r.created_at),
        startedAt: r.started_at ? tsToDate(r.started_at) : null,
        completedAt: r.completed_at ? tsToDate(r.completed_at) : null,
        expiresAt: r.expires_at ? tsToDate(r.expires_at) : null,
    };
}
function rowToItem(r) {
    return {
        id: r.id,
        jobId: r.job_id,
        ordinal: Number(r.ordinal),
        title: r.title,
        sourceUrl: r.source_url,
        status: r.status,
        progress: Number(r.progress ?? 0),
        artifactKey: r.artifact_key ?? null,
        artifactName: r.artifact_name ?? null,
        artifactSizeBytes: r.artifact_size_bytes === null ? null : Number(r.artifact_size_bytes),
        errorCode: r.error_code ?? null,
        errorMessage: r.error_message ?? null,
    };
}
export class PostgresStore {
    pool;
    constructor(connectionString) {
        this.pool = new Pool({
            connectionString,
            max: 10,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 10_000,
        });
    }
    async query(text, params, client) {
        const executor = client ?? this.pool;
        const result = await executor.query(text, params);
        return result.rows;
    }
    async saveResolve(record) {
        await this.query(`INSERT INTO resolve_cache (id, record, expires_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record, expires_at = EXCLUDED.expires_at`, [record.resolveId, JSON.stringify(record), new Date(record.expiresAt)]);
    }
    async getResolve(resolveId) {
        const rows = await this.query(`SELECT record, expires_at FROM resolve_cache WHERE id = $1 AND expires_at > now()`, [resolveId]);
        return rows[0]?.record ?? null;
    }
    async purgeExpiredResolves() {
        const result = await this.pool.query(`DELETE FROM resolve_cache WHERE expires_at <= now()`);
        return result.rowCount ?? 0;
    }
    async createJobWithItems(job, items) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`INSERT INTO jobs (id, status, platform, kind, resolve_id, source_url_hash, source_url_redacted, source_url,
                           ip_hash, idempotency_key, title, creator, requested_format_id)
         VALUES ($1,'queued',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [job.id, job.platform, job.kind, job.resolveId, job.sourceUrlHash, job.sourceUrlRedacted, job.sourceUrl,
                job.ipHash, job.idempotencyKey, job.title, job.creator, job.requestedFormatId]);
            for (const item of items) {
                await client.query(`INSERT INTO job_items (id, job_id, ordinal, title, source_url, status)
           VALUES ($1,$2,$3,$4,$5,'pending')`, [item.id, item.jobId, item.ordinal, item.title, item.sourceUrl]);
            }
            await client.query('COMMIT');
        }
        catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            if (err.code === '23505') {
                throw appErrors.conflict('A job with this idempotency key already exists.');
            }
            throw err;
        }
        finally {
            client.release();
        }
    }
    async getJob(id) {
        const rows = await this.query(`SELECT * FROM jobs WHERE id = $1`, [id]);
        return rows[0] ? rowToJob(rows[0]) : null;
    }
    async listItems(jobId) {
        const rows = await this.query(`SELECT * FROM job_items WHERE job_id = $1 ORDER BY ordinal`, [jobId]);
        return rows.map(rowToItem);
    }
    async getItem(itemId) {
        const rows = await this.query(`SELECT * FROM job_items WHERE id = $1`, [itemId]);
        return rows[0] ? rowToItem(rows[0]) : null;
    }
    async updateJob(id, patch) {
        const map = {
            status: 'status', platform: 'platform', kind: 'kind', resolveId: 'resolve_id',
            sourceUrlHash: 'source_url_hash', sourceUrlRedacted: 'source_url_redacted', sourceUrl: 'source_url',
            ipHash: 'ip_hash', idempotencyKey: 'idempotency_key', title: 'title', creator: 'creator',
            requestedFormatId: 'requested_format_id', requestedQualityLabel: 'requested_quality_label',
            progress: 'progress', errorCode: 'error_code', errorMessage: 'error_message',
            cancelRequested: 'cancel_requested', startedAt: 'started_at', completedAt: 'completed_at', expiresAt: 'expires_at',
        };
        const sets = [];
        const params = [];
        for (const [key, column] of Object.entries(map)) {
            if (key in patch && patch[key] !== undefined) {
                params.push(patch[key]);
                sets.push(`${column} = $${params.length}`);
            }
        }
        if (sets.length === 0)
            return;
        params.push(id);
        await this.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    async updateItem(id, patch) {
        const map = {
            jobId: 'job_id', ordinal: 'ordinal', title: 'title', sourceUrl: 'source_url',
            status: 'status', progress: 'progress', artifactKey: 'artifact_key',
            artifactName: 'artifact_name', artifactSizeBytes: 'artifact_size_bytes',
            errorCode: 'error_code', errorMessage: 'error_message',
        };
        const sets = [];
        const params = [];
        for (const [key, column] of Object.entries(map)) {
            if (key in patch) {
                params.push(patch[key]);
                sets.push(`${column} = $${params.length}`);
            }
        }
        if (sets.length === 0)
            return;
        params.push(id);
        await this.query(`UPDATE job_items SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    async requestCancel(id) {
        const rows = await this.query(`UPDATE jobs SET status='cancelled', cancel_requested=TRUE, completed_at=now(), source_url=NULL
       WHERE id=$1 AND status IN ('queued','processing')
       RETURNING id`, [id]);
        if (rows.length === 0)
            return false;
        await this.query(`UPDATE job_items SET status='skipped', error_code='CANCELLED'
       WHERE job_id=$1 AND status IN ('pending','downloading')`, [id]);
        return true;
    }
    async activeJobCountForIp(ipHash) {
        const rows = await this.query(`SELECT count(*) AS count FROM jobs WHERE ip_hash=$1 AND status IN ('queued','processing')`, [ipHash]);
        return Number.parseInt(rows[0]?.count ?? '0', 10);
    }
    async findJobByIdempotencyKey(key) {
        const rows = await this.query(`SELECT * FROM jobs WHERE idempotency_key=$1`, [key]);
        return rows[0] ? rowToJob(rows[0]) : null;
    }
    async recordAdapterEvent(event) {
        await this.query(`INSERT INTO adapter_events (id, platform, event_type, job_id, latency_ms, success, error_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [event.id ?? crypto.randomUUID(), event.platform, event.eventType, event.jobId, event.latencyMs, event.success, event.errorCode]);
    }
    async expireDueArtifacts(now) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const jobs = await client.query(`UPDATE jobs SET status='expired', source_url=NULL
         WHERE status='completed' AND expires_at IS NOT NULL AND expires_at <= $1
         RETURNING id`, [now]);
            const expired = [];
            for (const job of jobs.rows) {
                const items = await client.query(`UPDATE job_items SET artifact_key=NULL
           WHERE job_id=$1 AND artifact_key IS NOT NULL
           RETURNING artifact_key`, [job.id]);
                for (const item of items.rows) {
                    expired.push({ jobId: job.id, artifactKey: item.artifact_key });
                }
            }
            await client.query('COMMIT');
            return expired;
        }
        catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
        }
        finally {
            client.release();
        }
    }
    async queueDepths() {
        const rows = await this.query(`SELECT status, count(*) AS count FROM jobs WHERE status IN ('queued','processing') GROUP BY status`, []);
        let queued = 0;
        let processing = 0;
        for (const row of rows) {
            if (row.status === 'queued')
                queued = Number.parseInt(row.count, 10);
            if (row.status === 'processing')
                processing = Number.parseInt(row.count, 10);
        }
        return { queued, processing };
    }
    async healthCheck() {
        try {
            await this.pool.query('SELECT 1');
            return true;
        }
        catch {
            return false;
        }
    }
    async close() {
        await this.pool.end();
    }
}
//# sourceMappingURL=postgres.js.map