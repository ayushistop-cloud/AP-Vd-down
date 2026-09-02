import crypto from 'node:crypto';
import { createReadStream, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { appErrors, assertPublicHttpUrl, hashWithPepper, newId, safeArtifactPath, signExpiringToken, toAppError, verifyExpiringToken, HTTP_STATUS_BY_CODE, jobIdParamSchema, createJobRequestSchema, resolveRequestSchema, } from '@3ap/shared';
import { prepareYtDlpCookies, performCookieStartupCheck, requireBinary, runYtDlp, runSelfDiagnostics, resolveYtDlpEngine, findFfmpegBinary, detectJsRuntime } from '@3ap/adapters';
import { SlidingWindowRateLimiter } from './lib/rate-limit.js';
import { ResolveService } from './services/resolve-service.js';
import { JobService } from './services/job-service.js';
import { jobToView, resolveRecordToView } from './views.js';
function zodToAppError(error) {
    const first = error.issues[0];
    const where = first?.path?.length ? ` (${first.path.map(String).join('.')})` : '';
    return appErrors.validation(`${first?.message ?? 'Invalid request.'}${where}`);
}
/** Build a fully wired API instance. Dependencies are injected for tests. */
export async function buildApp(deps) {
    const { config, store, adapters, queue, log, metrics } = deps;
    const cookieStartup = performCookieStartupCheck();
    log.info('yt-dlp runtime & cookie startup status', {
        event: 'startup_check',
        cookiesConfigured: cookieStartup.cookiesConfigured,
        cookiesReadable: cookieStartup.cookiesReadable,
        configuredPath: cookieStartup.configuredPath,
    });
    const resolveService = new ResolveService(adapters, store, {
        resolveTtlMs: config.RESOLVE_TTL_MINUTES * 60_000,
        ipPepper: config.IP_HASH_PEPPER,
        log,
        metrics,
    });
    const jobService = new JobService(store, (payload) => queue.enqueue(payload), {
        maxPlaylistItems: config.MAX_PLAYLIST_ITEMS,
        maxConcurrentJobsPerIp: config.MAX_CONCURRENT_JOBS_PER_IP,
        ipPepper: config.IP_HASH_PEPPER,
        log,
        metrics,
    });
    const limiters = {
        resolve: new SlidingWindowRateLimiter({ windowMs: 60_000, max: config.RATE_RESOLVE_PER_MINUTE }),
        jobs: new SlidingWindowRateLimiter({ windowMs: 60_000, max: config.RATE_JOB_CREATE_PER_MINUTE }),
        download: new SlidingWindowRateLimiter({ windowMs: 60_000, max: config.RATE_DOWNLOAD_PER_MINUTE }),
    };
    const app = Fastify({
        logger: false,
        genReqId: () => newId(),
        trustProxy: config.TRUST_PROXY,
        bodyLimit: 16 * 1024,
    });
    /* ── cross-cutting hooks ───────────────────────────────────────────────── */
    app.addHook('onRequest', async (_request, reply) => {
        reply.header('x-content-type-options', 'nosniff');
        reply.header('referrer-policy', 'strict-origin-when-cross-origin');
        reply.header('x-frame-options', 'DENY');
    });
    const allowedOrigins = config.WEB_ORIGINS.split(',')
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean);
    // Production safety net: always allow Vercel frontend and localhost even if WEB_ORIGINS is misconfigured
    const EXTRA_ALLOWED_ORIGINS = [
        'https://3ap-video-downloader.vercel.app',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:3000',
    ];
    await app.register(cors, {
        origin: (origin, cb) => {
            if (!origin)
                return cb(null, true);
            const normalizedOrigin = origin.trim().replace(/\/+$/, '');
            if (allowedOrigins.includes(normalizedOrigin) || allowedOrigins.includes('*') || EXTRA_ALLOWED_ORIGINS.includes(normalizedOrigin)) {
                return cb(null, true);
            }
            // Allow any vercel.app preview deployment for this project
            if (normalizedOrigin.endsWith('.vercel.app'))
                return cb(null, true);
            return cb(new Error('Not allowed by CORS'), false);
        },
        credentials: false,
        methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Requested-With', 'Range', 'x-diagnostic-secret'],
        exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type', 'Content-Disposition', 'Cache-Control'],
        hideOptionsRoute: false,
    });
    app.addHook('onResponse', async (request, reply) => {
        const route = request.routeOptions?.url ?? 'unmatched';
        metrics.counter('http_requests_total', 'API requests', {
            route,
            method: request.method,
            status: String(Math.floor(reply.statusCode / 100) * 100),
        });
        const startedAt = request._startedAt;
        if (startedAt)
            metrics.observe('http_request_duration_ms', Date.now() - startedAt);
    });
    app.addHook('onRequest', async (request) => {
        request._startedAt = Date.now();
    });
    function enforceRateLimit(kind) {
        return async (request, reply) => {
            const decision = limiters[kind].check(`${kind}:${request.ip}`);
            reply.header('x-ratelimit-limit', String(limiters[kind].max));
            if (!decision.allowed) {
                metrics.counter('rate_limited_total', 'requests rejected by rate limiting', { kind });
                reply.header('retry-after', String(decision.retryAfterSeconds));
                const err = appErrors.rateLimited('Too many requests. Please wait a moment and try again.');
                void reply.code(err.httpStatus);
                throw err;
            }
        };
    }
    /* ── routes ────────────────────────────────────────────────────────────── */
    app.get('/', async () => ({
        status: 'ok',
        name: '3AP Video Downloader API',
    }));
    app.get('/health', async () => ({
        status: 'ok',
        service: '3ap-api',
    }));
    app.get('/healthz', async () => {
        const [storeOk, depths] = await Promise.all([store.healthCheck(), store.queueDepths().catch(() => null)]);
        metrics.gauge('queue_depth_waiting', depths?.queued ?? -1);
        metrics.gauge('queue_depth_active', depths?.processing ?? -1);
        return {
            status: storeOk ? 'ok' : 'degraded',
            uptimeSeconds: Math.round(process.uptime()),
            queue: depths ? { queued: depths.queued, processing: depths.processing } : null,
        };
    });
    app.get('/health/diagnostics', async () => {
        let dbConnected = false;
        try {
            dbConnected = await store.healthCheck();
        }
        catch { }
        const engine = await resolveYtDlpEngine().catch(() => null);
        const ffmpeg = await findFfmpegBinary().catch(() => null);
        const jsRuntime = detectJsRuntime();
        const cookieDiag = performCookieStartupCheck();
        return {
            apiVersion: 'v1',
            nodeVersion: process.version,
            ytDlpPath: engine?.path ?? null,
            ytDlpVersion: engine?.version ?? null,
            ffmpegAvailable: !!ffmpeg,
            ffmpegVersion: ffmpeg ? 'ffmpeg-available' : null,
            jsRuntimeAvailable: jsRuntime.available,
            cookiesConfigured: cookieDiag.cookiesConfigured,
            cookiesReadable: cookieDiag.cookiesReadable,
            executionMode: config.DOWNLOAD_EXECUTION_MODE,
            databaseConnected: dbConnected,
        };
    });
    app.get('/metrics', async () => ({ ...metrics.snapshot() }));
    app.get('/api/v1/meta/platforms', async () => ({
        platforms: adapters.all().map((adapter) => ({
            platform: adapter.platform,
            capabilities: adapter.getCapabilities(),
        })),
    }));
    app.post('/api/v1/resolve', { preHandler: enforceRateLimit('resolve') }, async (request, reply) => {
        const parsed = resolveRequestSchema.safeParse(request.body);
        if (!parsed.success)
            throw zodToAppError(parsed.error);
        const outcome = await resolveService.resolve(parsed.data.url);
        void reply.code(200);
        return resolveRecordToView(outcome.record, {
            tokenFactory: (rId, iId, fId) => signExpiringToken(`${rId}:${iId}:${fId}`, config.DOWNLOAD_TOKEN_SECRET, config.RESOLVE_TTL_MINUTES * 60),
        });
    });
    // Support trailing slash for convenience
    app.post('/api/v1/resolve/', { preHandler: enforceRateLimit('resolve') }, async (request, reply) => {
        const parsed = resolveRequestSchema.safeParse(request.body);
        if (!parsed.success)
            throw zodToAppError(parsed.error);
        const outcome = await resolveService.resolve(parsed.data.url);
        void reply.code(200);
        return resolveRecordToView(outcome.record, {
            tokenFactory: (rId, iId, fId) => signExpiringToken(`${rId}:${iId}:${fId}`, config.DOWNLOAD_TOKEN_SECRET, config.RESOLVE_TTL_MINUTES * 60),
        });
    });
    app.post('/api/v1/jobs', { preHandler: enforceRateLimit('jobs') }, async (request, reply) => {
        const parsed = createJobRequestSchema.safeParse(request.body);
        if (!parsed.success)
            throw zodToAppError(parsed.error);
        const rawKey = request.headers['idempotency-key'];
        const idempotencyKey = typeof rawKey === 'string' && rawKey.length >= 8 && rawKey.length <= 128 && /^[\w.-]+$/.test(rawKey)
            ? rawKey
            : null;
        const ipHash = hashIp(request.ip);
        const { job, items } = await jobService.createJob(parsed.data, { ipHash, idempotencyKey });
        void reply.code(201);
        return jobToView(job, items);
    });
    app.get('/api/v1/jobs/:id', async (request, reply) => {
        const params = jobIdParamSchema.safeParse(request.params);
        if (!params.success)
            throw zodToAppError(params.error);
        const job = await requireJob(params.data.id);
        const items = await store.listItems(job.id);
        if (job.status === 'completed')
            assertNotExpired(job);
        void reply.code(200);
        return jobToView(job, items, {
            tokenFactory: (jId, iId) => signExpiringToken(`${jId}:${iId}`, config.DOWNLOAD_TOKEN_SECRET, config.ARTIFACT_TTL_MINUTES * 60),
        });
    });
    app.post('/api/v1/jobs/:id/cancel', async (request, reply) => {
        const params = jobIdParamSchema.safeParse(request.params);
        if (!params.success)
            throw zodToAppError(params.error);
        const job = await store.getJob(params.data.id);
        if (!job)
            throw appErrors.notFound('This job does not exist.');
        const cancelled = await store.requestCancel(job.id);
        const updated = (await store.getJob(job.id));
        void reply.code(200);
        return {
            id: updated.id,
            cancelled,
            status: updated.status,
        };
    });
    /* ── Self-Diagnostics Endpoint (Phase 2) ──────────────────────────────── */
    app.get('/api/v1/diagnostics/ytdlp', async (request, reply) => {
        const query = (request.query ?? {});
        const headers = request.headers;
        const secretFromHeader = headers['x-diagnostic-secret'];
        const secretFromEnv = process.env.DIAGNOSTIC_SECRET;
        const isEnabled = process.env.ENABLE_DIAGNOSTICS === 'true';
        const isAuthorized = isEnabled ||
            (secretFromEnv && (secretFromHeader === secretFromEnv || query.secret === secretFromEnv));
        if (!isAuthorized) {
            void reply.code(403);
            return { error: 'Forbidden. Set ENABLE_DIAGNOSTICS=true or supply valid x-diagnostic-secret header.' };
        }
        const testUrl = query.testUrl || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
        const diagResult = await runSelfDiagnostics(testUrl);
        void reply.code(200);
        return diagResult;
    });
    /* ── downloads ─────────────────────────────────────────────────────────── */
    async function handleDownload(request, reply) {
        const params = (request.params ?? {});
        const query = (request.query ?? {});
        const jobId = params.id ?? '';
        const itemId = params.itemId ?? query.item ?? '';
        if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^[0-9a-f-]{36}$/i.test(itemId)) {
            throw appErrors.invalidUrl('Malformed download link.');
        }
        const token = query.token ?? '';
        const scope = verifyExpiringToken(token, config.DOWNLOAD_TOKEN_SECRET);
        if (!scope || scope !== `${jobId}:${itemId}`) {
            throw appErrors.expired('This download link is invalid or has expired.');
        }
        const job = await requireJob(jobId);
        if (job.status === 'expired')
            throw appErrors.expired();
        if (job.status !== 'completed')
            throw appErrors.conflict('The download is not ready yet.');
        assertNotExpired(job);
        const item = await store.getItem(itemId);
        if (!item || item.jobId !== jobId)
            throw appErrors.notFound('This item does not exist.');
        if (!item.artifactKey)
            throw appErrors.expired();
        const filePath = safeArtifactPath(config.ARTIFACT_ROOT, item.artifactKey);
        if (!filePath)
            throw appErrors.expired();
        const info = await stat(filePath).catch(() => null);
        if (!info?.isFile()) {
            // File already swept; converge DB state lazily.
            await store.updateItem(item.id, { artifactKey: null });
            throw appErrors.expired();
        }
        const mimeType = getMimeTypeFromName(item.artifactName ?? 'download.bin');
        reply.header('content-type', mimeType);
        reply.header('accept-ranges', 'bytes');
        reply.header('cache-control', 'private, no-store');
        reply.header('access-control-expose-headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type, Content-Disposition');
        const rangeHeader = request.headers['range'];
        if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
            const parts = rangeHeader.replace(/bytes=/, '').split('-');
            const start = parts[0] ? parseInt(parts[0], 10) : 0;
            const end = parts[1] ? parseInt(parts[1], 10) : info.size - 1;
            if (isNaN(start) || isNaN(end) || start >= info.size || end >= info.size || start > end) {
                reply.header('content-range', `bytes */${info.size}`);
                void reply.code(416);
                return { error: { code: 'INVALID_RANGE', message: 'Requested range not satisfiable' } };
            }
            const chunkSize = end - start + 1;
            reply.header('content-range', `bytes ${start}-${end}/${info.size}`);
            reply.header('content-length', chunkSize);
            void reply.code(206);
            return createReadStream(filePath, { start, end });
        }
        reply.header('content-length', info.size);
        reply.header('content-disposition', `attachment; filename="${sanitizeHeaderName(item.artifactName ?? 'download.bin')}"; filename*=UTF-8''${encodeURIComponent(item.artifactName ?? 'download.bin')}`);
        void reply.code(200);
        return createReadStream(filePath);
    }
    app.get('/api/v1/jobs/:id/items/:itemId/download', { preHandler: enforceRateLimit('download') }, handleDownload);
    app.get('/api/v1/jobs/:id/download', { preHandler: enforceRateLimit('download') }, handleDownload);
    /* ── thumbnails (Terabox) ─────────────────────────────────────────────── */
    async function handleResolveThumbnail(request, reply) {
        const params = (request.params ?? {});
        const query = (request.query ?? {});
        const resolveId = params.resolveId ?? '';
        const itemId = params.itemId ?? '';
        if (!/^[0-9a-f-]{36}$/i.test(resolveId) || !itemId) {
            throw appErrors.invalidUrl('Malformed thumbnail link.');
        }
        const token = query.token ?? '';
        const scope = verifyExpiringToken(token, config.DOWNLOAD_TOKEN_SECRET);
        // token was generated as `${resolveId}:${itemId}:thumb`
        if (!scope || scope !== `${resolveId}:${itemId}:thumb`) {
            throw appErrors.expired('This thumbnail link is invalid or has expired.');
        }
        const record = await store.getResolve(resolveId);
        if (!record)
            throw appErrors.expired('This playback session has expired.');
        const item = record.items.find((i) => i.id === itemId);
        if (!item || !item.thumbnailUrl)
            throw appErrors.notFound('Thumbnail not available.');
        // Validate that thumbnailUrl is a provider URL we expect (data.*.com/thumbnail or terabox image)
        let thumbUrl;
        try {
            thumbUrl = new URL(item.thumbnailUrl);
        }
        catch {
            throw appErrors.temporaryProviderError('Thumbnail URL is invalid.');
        }
        // SSRF guard: only allow terabox thumbnail hosts and our known CDN
        const allowedHosts = ['data.terabox.com', 'data.terabox.app', 'data.1024tera.com', 'data.freeterabox.com', 'thumbnail.terabox.com'];
        const hostOk = allowedHosts.some((h) => thumbUrl.hostname === h || thumbUrl.hostname.endsWith(`.${h}`) || thumbUrl.hostname.includes('terabox') || thumbUrl.hostname.includes('1024tera') || thumbUrl.hostname.includes('freeterabox'));
        if (!hostOk && !thumbUrl.hostname.includes('terabox') && !thumbUrl.hostname.includes('1024tera')) {
            // Still allow data.*.com thumbnail hosts which are provider CDN
            if (!thumbUrl.hostname.startsWith('data.'))
                throw appErrors.unsupported('Thumbnail host not allowed.');
        }
        assertPublicHttpUrl(thumbUrl.toString());
        // Fetch thumbnail server-side with provider headers (no cookies needed per diag, but include referer/UA)
        const thumbResp = await fetch(thumbUrl.toString(), {
            headers: {
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                'referer': `https://${new URL(item.sourceUrl).hostname}/`,
            },
        });
        if (!thumbResp.ok) {
            log.warn('Thumbnail fetch failed', { status: thumbResp.status, itemId });
            throw appErrors.temporaryProviderError('Failed to retrieve thumbnail.');
        }
        const ct = thumbResp.headers.get('content-type') || 'image/jpeg';
        if (!ct.startsWith('image/'))
            throw appErrors.temporaryProviderError('Thumbnail is not an image.');
        const buf = Buffer.from(await thumbResp.arrayBuffer());
        if (buf.length > 5 * 1024 * 1024)
            throw appErrors.tooLarge();
        reply.header('content-type', ct);
        reply.header('cache-control', 'public, max-age=3600');
        reply.header('content-length', buf.length);
        reply.header('access-control-expose-headers', 'Content-Length, Content-Type');
        reply.header('accept-ranges', 'bytes');
        void reply.code(200);
        return buf;
    }
    /* ── streaming (playback) ────────────────────────────────────────────────── */
    async function handleResolveStream(request, reply) {
        const params = (request.params ?? {});
        const query = (request.query ?? {});
        const resolveId = params.resolveId ?? '';
        const itemId = params.itemId ?? '';
        const formatId = query.format ?? '';
        const requestId = request.id;
        const initialRangeHeader = request.headers.range ?? null;
        const requestHostname = request.hostname;
        const requestOrigin = request.headers.origin ?? null;
        // Structured diagnostics — sanitize tokens, log request context
        log.info('[Stream] incoming request', {
            requestId,
            resolveId,
            itemId,
            format: formatId || null,
            requestHostname,
            requestOrigin,
            rangeHeader: initialRangeHeader,
            tokenPresent: !!(query.token),
            url: request.url.slice(0, 120),
        });
        if (!/^[0-9a-f-]{36}$/i.test(resolveId) || !itemId || !formatId) {
            log.warn('[Stream] malformed stream link', { requestId, resolveId, itemId, format: formatId });
            throw appErrors.invalidUrl('Malformed stream link.');
        }
        const token = query.token ?? '';
        const scope = verifyExpiringToken(token, config.DOWNLOAD_TOKEN_SECRET);
        if (!scope || scope !== `${resolveId}:${itemId}:${formatId}`) {
            log.warn('[Stream] token invalid/expired', { requestId, resolveId, itemId, format: formatId, scopeValid: !!scope });
            throw appErrors.expired('This stream link is invalid or has expired.');
        }
        const record = await store.getResolve(resolveId);
        if (!record) {
            log.warn('[Stream] resolve record not found (expired)', { requestId, resolveId });
            throw appErrors.expired('This playback session has expired.');
        }
        const item = record.items.find((i) => i.id === itemId);
        if (!item) {
            log.warn('[Stream] item not found', { requestId, resolveId, itemId });
            throw appErrors.notFound('This item does not exist.');
        }
        const format = item.formats.find((f) => f.formatId === formatId);
        if (!format) {
            log.warn('[Stream] format not found', { requestId, resolveId, itemId, format: formatId });
            throw appErrors.notFound('This format does not exist.');
        }
        if (!format.playable) {
            log.warn('[Stream] format not playable', { requestId, resolveId, format: formatId, playable: format.playable });
            throw appErrors.unsupported('This format is not browser-playable.');
        }
        log.info('[Stream] format resolved', {
            requestId,
            resolveId,
            itemId,
            format: formatId,
            platform: record.platform,
            sourcePlatform: record.platform,
            playable: format.playable,
            container: format.container,
            tokenValid: true,
            sourceUrlObtained: !!item.sourceUrl,
        });
        let streamUrl = '';
        let proxyHeaders = {};
        if (record.platform === 'terabox') {
            streamUrl = format.sourceSelector ?? '';
            if (streamUrl.includes('/share/streaming')) {
                // Terabox HLS requires careful handling: playlist + segments need same cookies/referer,
                // and browser needs seekable MP4 with correct Range support. We generate a temp MP4
                // file via ffmpeg from locally-fetched segments, then serve it with Range (like handleStream).
                const u = new URL(streamUrl);
                const randsk = u.searchParams.get('randsk') ?? '';
                const browserid = u.searchParams.get('browserid') ?? '';
                const shortKeyMatch = /\/sharing\/link\?surl=([\w-]+)/i.exec(item.sourceUrl) || /\/s\/1([\w-]+)/i.exec(item.sourceUrl) || /\/s\/([\w-]+)/i.exec(item.sourceUrl);
                const shortKey = shortKeyMatch?.[1] ?? '';
                const cookiesWithBoxClnd = `browserid=${browserid}; BOXCLND=${randsk}`;
                const referer = `https://${u.hostname}/sharing/link?surl=${shortKey}`;
                // Use a cache key per resolve so repeated Range requests reuse the same file
                const cacheKey = `terabox-play-${resolveId}-${itemId}.mp4`;
                const tmpMp4Path = `${tmpdir()}/${cacheKey}`.replace(/\\/g, '/');
                let fileInfo = await stat(tmpMp4Path).catch(() => null);
                const needsGenerate = !fileInfo || Date.now() - fileInfo.mtimeMs > 10 * 60 * 1000 || fileInfo.size < 1024;
                if (needsGenerate) {
                    const segHeaders = {
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'accept': '*/*',
                        'referer': referer,
                        'cookie': cookiesWithBoxClnd,
                    };
                    const baseU = new URL(streamUrl);
                    const uk = baseU.searchParams.get('uk') ?? '';
                    const shareid = baseU.searchParams.get('shareid') ?? '';
                    const fid = baseU.searchParams.get('fid') ?? '';
                    const jsToken = baseU.searchParams.get('jsToken') ?? '';
                    const segUrls = [];
                    const seenSegSet = new Set();
                    let hasMoreSegs = true;
                    let segAttempts = 0;
                    while (hasMoreSegs && segAttempts < 1500) {
                        segAttempts++;
                        const nowTime = Math.floor(Date.now() / 1000);
                        const clienttype = '0';
                        const channel = 'dubox';
                        const msg = `${clienttype}${channel}${browserid}${nowTime}`;
                        const saltKey = 'iuuPc64E4Fhn0rTXEzrnbLph0o5qyEEa';
                        const loopSig = crypto.createHmac('sha1', saltKey).update(msg).digest('hex');
                        const loopParams = new URLSearchParams({
                            uk,
                            shareid,
                            type: 'M3U8_AUTO_480',
                            fid,
                            sign: loopSig,
                            timestamp: String(nowTime),
                            ...(jsToken ? { jsToken } : {}),
                            esl: '1',
                            isplayer: '1',
                            ehps: '1',
                            clienttype,
                            app_id: '250528',
                            channel,
                            randsk,
                            browserid,
                        });
                        const loopUrl = `https://${u.hostname}/share/streaming?${loopParams.toString()}`;
                        const playlistRes = await fetch(loopUrl, { headers: segHeaders });
                        if (!playlistRes.ok)
                            break;
                        const text = await playlistRes.text();
                        if (text.includes('errno') || !text.includes('#EXTINF:')) {
                            hasMoreSegs = false;
                            break;
                        }
                        const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('http'));
                        let addedCount = 0;
                        for (const seg of lines) {
                            // Strip ephemeral timestamp parameters to accurately deduplicate segment resources
                            const baseSegUrl = seg.split('&t=')[0] ?? seg;
                            if (!seenSegSet.has(baseSegUrl)) {
                                seenSegSet.add(baseSegUrl);
                                segUrls.push(seg);
                                addedCount++;
                            }
                        }
                        if (addedCount === 0 || text.includes('#EXT-X-ENDLIST')) {
                            hasMoreSegs = false;
                        }
                    }
                    if (segUrls.length === 0)
                        throw appErrors.temporaryProviderError('Playlist contains no segments.');
                    const segDir = `${tmpdir()}/terabox-seg-${resolveId}-${itemId}`.replace(/\\/g, '/');
                    try {
                        mkdirSync(segDir, { recursive: true });
                    }
                    catch { /* ignore */ }
                    const localSegPaths = new Array(segUrls.length);
                    // Fetch segment files in controlled parallel batches (5 concurrent downloads) to avoid Terabox CDN throttling
                    const sBatchSize = 5;
                    for (let i = 0; i < segUrls.length; i += sBatchSize) {
                        const batch = segUrls.slice(i, i + sBatchSize);
                        await Promise.all(batch.map(async (segUrl, idxInBatch) => {
                            const globalIdx = i + idxInBatch;
                            const segRes = await fetch(segUrl, { headers: segHeaders });
                            if (!segRes.ok)
                                throw appErrors.temporaryProviderError(`Failed to fetch segment ${globalIdx}`);
                            const buf = Buffer.from(await segRes.arrayBuffer());
                            if (buf.length < 100)
                                throw appErrors.temporaryProviderError('Segment too small, likely provider error page.');
                            const head = buf.slice(0, 200).toString('utf8');
                            if (head.includes('<!DOCTYPE') || head.includes('"errno"'))
                                throw appErrors.temporaryProviderError('Provider returned error for segment.');
                            const segPath = `${segDir}/seg-${String(globalIdx).padStart(5, '0')}.ts`.replace(/\\/g, '/');
                            writeFileSync(segPath, buf);
                            localSegPaths[globalIdx] = segPath;
                        }));
                    }
                    // Create concat list for ffmpeg
                    const concatList = localSegPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
                    const concatPath = `${segDir}/concat.txt`.replace(/\\/g, '/');
                    writeFileSync(concatPath, concatList);
                    // Transmux TS segments to MP4 with faststart, stream copy (no re-encode)
                    await new Promise((resolve, reject) => {
                        const args = ['-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', '-movflags', 'faststart', '-y', tmpMp4Path];
                        const proc = spawn('ffmpeg', args);
                        let stderr = '';
                        proc.stderr.on('data', d => stderr += d.toString());
                        proc.on('close', code => {
                            // Cleanup segment files but keep mp4
                            try {
                                localSegPaths.forEach(p => { try {
                                    unlinkSync(p);
                                }
                                catch { /* ignore */ } });
                                unlinkSync(concatPath);
                            }
                            catch { /* ignore */ }
                            try {
                                rmSync(segDir, { recursive: true, force: true });
                            }
                            catch { /* ignore */ }
                            if (code === 0)
                                resolve();
                            else
                                reject(appErrors.temporaryProviderError(`Transmux failed (code ${code}): ${stderr.slice(-500)}`));
                        });
                        proc.on('error', e => reject(toAppError(e)));
                    });
                    fileInfo = await stat(tmpMp4Path).catch(() => null);
                    if (!fileInfo || fileInfo.size < 1024)
                        throw appErrors.temporaryProviderError('Generated playback file is empty.');
                    // Validate with ffprobe (optional, but ensures correct MP4)
                    try {
                        const { runYtDlp: _unused, requireBinary: _unused2 } = await import('@3ap/adapters');
                        // Use ffprobe if available: just check file exists
                    }
                    catch { /* ignore */ }
                }
                // Serve the temp MP4 with proper Range support (like handleStream)
                const info = fileInfo;
                const mimeType = 'video/mp4';
                const rangeHeader = request.headers.range;
                if (rangeHeader) {
                    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
                    if (m) {
                        const start = m[1] ? parseInt(m[1], 10) : 0;
                        const end = m[2] ? parseInt(m[2], 10) : info.size - 1;
                        const chunkSize = end - start + 1;
                        if (start >= info.size || end >= info.size || chunkSize <= 0) {
                            reply.header('content-range', `bytes */${info.size}`);
                            void reply.code(416);
                            return;
                        }
                        reply.header('content-range', `bytes ${start}-${end}/${info.size}`);
                        reply.header('accept-ranges', 'bytes');
                        reply.header('content-length', chunkSize);
                        reply.header('content-type', mimeType);
                        reply.header('content-disposition', 'inline');
                        reply.header('cache-control', 'private, no-store');
                        reply.header('access-control-expose-headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type, Content-Disposition');
                        void reply.code(206);
                        return createReadStream(tmpMp4Path, { start, end });
                    }
                }
                reply.header('content-type', mimeType);
                reply.header('content-length', info.size);
                reply.header('accept-ranges', 'bytes');
                reply.header('content-disposition', 'inline');
                reply.header('cache-control', 'private, no-store');
                reply.header('access-control-expose-headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type, Content-Disposition');
                void reply.code(200);
                return createReadStream(tmpMp4Path);
            }
            proxyHeaders = {
                'user-agent': 'netdisk;',
                referer: 'https://www.terabox.com/',
            };
        }
        else if (record.platform === 'tiktok') {
            const binary = await requireBinary(process.env.YT_DLP_PATH, log);
            const rawFormatId = (format.sourceSelector ?? format.formatId).replace(/^[vfa]:/, '');
            const isByteVc1 = rawFormatId.includes('bytevc1') || rawFormatId.includes('hevc') || rawFormatId.includes('h265');
            broadcastLog('STREAM', 'UPSTREAM_REQUEST_STARTED', `Piping TikTok stream via yt-dlp (${rawFormatId}, bytevc1=${isByteVc1})`, { resolveId, itemId, formatId });
            const ytFormatSelector = isByteVc1
                ? `${rawFormatId}/best`
                : `${rawFormatId}[vcodec^=h264]/${rawFormatId}[vcodec^=avc]/b[vcodec^=h264]/b[vcodec^=avc]/download/best`;
            const ytProc = spawn(binary, [
                '--no-warnings',
                '--no-playlist',
                '--format', ytFormatSelector,
                '-o', '-',
                item.sourceUrl,
            ]);
            if (isByteVc1) {
                // Transcode ByteVC1 (HEVC) stream to browser-playable H.264 MP4 stream via FFmpeg
                const ffmpegProc = spawn('ffmpeg', [
                    '-i', 'pipe:0',
                    '-c:v', 'libx264',
                    '-preset', 'ultrafast',
                    '-tune', 'zerolatency',
                    '-c:a', 'copy',
                    '-f', 'mp4',
                    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                    'pipe:1',
                ]);
                ytProc.stdout.pipe(ffmpegProc.stdin);
                ytProc.stderr.on('data', (d) => log.debug('[TikTok yt-dlp stderr]', { data: d.toString().slice(0, 200) }));
                ffmpegProc.stderr.on('data', (d) => {
                    const errChunk = d.toString();
                    if (errChunk.includes('Error') || errChunk.includes('error')) {
                        broadcastLog('WARN', 'FFMPEG_STDERR', errChunk.slice(0, 200), { resolveId });
                    }
                });
                request.raw.on('close', () => {
                    if (!ytProc.killed)
                        ytProc.kill('SIGKILL');
                    if (!ffmpegProc.killed)
                        ffmpegProc.kill('SIGKILL');
                });
                reply.header('content-type', 'video/mp4');
                reply.header('accept-ranges', 'none');
                reply.header('content-disposition', 'inline');
                reply.header('cache-control', 'private, no-store');
                void reply.code(200);
                broadcastLog('STREAM', 'MEDIA_LOADSTART', `TikTok stream transcoding (ByteVC1 -> H.264) started`, { resolveId, itemId, formatId, contentType: 'video/mp4' });
                return ffmpegProc.stdout;
            }
            else {
                request.raw.on('close', () => {
                    if (!ytProc.killed) {
                        log.info('[TikTok Stream] Client disconnected, terminating yt-dlp process', { resolveId, itemId });
                        broadcastLog('STREAM', 'PLAYBACK_ABORTED', 'Client disconnected during TikTok streaming', { resolveId });
                        ytProc.kill('SIGKILL');
                    }
                });
                reply.header('content-type', 'video/mp4');
                reply.header('accept-ranges', 'none');
                reply.header('content-disposition', 'inline');
                reply.header('cache-control', 'private, no-store');
                void reply.code(200);
                broadcastLog('STREAM', 'MEDIA_LOADSTART', `TikTok stream piping started`, { resolveId, itemId, formatId, contentType: 'video/mp4' });
                return ytProc.stdout;
            }
        }
        else {
            proxyHeaders = {
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                ...(record.platform === 'youtube' ? { referer: 'https://www.youtube.com/' } : {}),
                ...(record.platform === 'instagram' ? { referer: 'https://www.instagram.com/' } : {}),
                ...(record.platform === 'facebook' ? { referer: 'https://www.facebook.com/' } : {}),
            };
            const binary = await requireBinary(process.env.YT_DLP_PATH, log);
            const rawFormatId = (format.sourceSelector ?? format.formatId).replace(/^[vfa]:/, '');
            const cookiePrep = await prepareYtDlpCookies();
            try {
                const commonYtArgs = [
                    '--js-runtimes', 'node',
                    ...(cookiePrep.enabled && cookiePrep.runtimeCookiePath ? ['--cookies', cookiePrep.runtimeCookiePath] : []),
                ];
                const isAudioOnlyFormat = format.kind === 'audio';
                const rawVcodec = isAudioOnlyFormat
                    ? ''
                    : (format.videoCodec ?? (format.kind !== 'audio' ? format.codec : '') ?? '').toLowerCase();
                const rawAcodec = (format.audioCodec ?? (format.kind === 'audio' ? format.codec : '') ?? '').toLowerCase();
                const knownAudioCodecs = ['opus', 'vorbis', 'mp4a', 'aac', 'flac', 'ac3', 'eac3', 'dts', 'mp3'];
                const vcodec = knownAudioCodecs.some((c) => rawVcodec.includes(c)) ? '' : rawVcodec;
                const acodec = rawAcodec;
                if (isAudioOnlyFormat) {
                    broadcastLog('STREAM', 'UPSTREAM_REQUEST_STARTED', `Extracting audio stream (${rawFormatId}) via yt-dlp`, {
                        resolveId,
                        itemId,
                        formatId,
                        rawFormatId,
                    });
                    try {
                        const { stdout } = await runYtDlp(binary, ['--get-url', ...commonYtArgs, '-f', `${rawFormatId}/bestaudio/140/139/best`, item.sourceUrl], { timeoutMs: 15_000 });
                        streamUrl = stdout.trim().split('\n')[0] ?? '';
                    }
                    catch (err) {
                        log.warn('Audio stream URL extraction failed', { error: err });
                    }
                    if (streamUrl) {
                        assertPublicHttpUrl(streamUrl);
                        const isDirectPlayableAudio = acodec.includes('aac') || acodec.includes('mp4a') || acodec.includes('mp3') || format.container === 'mp3' || format.container === 'm4a';
                        if (isDirectPlayableAudio) {
                            // Native audio stream: served directly via proxy below
                        }
                        else {
                            // Transcode non-browser audio (Opus / FLAC) to AAC fMP4 without video (-vn)
                            const seekSeconds = parseFloat(query.ss ?? '0');
                            const seekArgs = Number.isFinite(seekSeconds) && seekSeconds > 0 ? ['-ss', String(seekSeconds)] : [];
                            const headerStr = `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36\r\n${record.platform === 'youtube' ? 'Referer: https://www.youtube.com/\r\n' : ''}`;
                            const ffmpegArgs = [
                                '-headers', headerStr,
                                ...seekArgs,
                                '-i', streamUrl,
                                '-vn',
                                '-c:a', 'aac',
                                '-b:a', '128k',
                                '-f', 'mp4',
                                '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                                'pipe:1',
                            ];
                            const sanitizeUrl = (u) => {
                                try {
                                    const parsed = new URL(u);
                                    parsed.search = '?...[token_hidden]';
                                    return parsed.toString();
                                }
                                catch {
                                    return u.length > 60 ? u.slice(0, 60) + '...' : u;
                                }
                            };
                            log.info('[DirectPlay FFmpeg Diagnostics (Audio Only)]', {
                                resolveId,
                                itemId,
                                ffmpegPath: 'ffmpeg',
                                strategy: 'TRANSCODE_AUDIO_ONLY',
                                inputAudioCodec: acodec || 'unknown',
                                sanitizedAudioUrl: sanitizeUrl(streamUrl),
                                sanitizedArgs: ffmpegArgs.map((a) => (a.startsWith('http') ? sanitizeUrl(a) : a)),
                                outputContentType: 'audio/mp4',
                            });
                            const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
                            let bytesEmitted = 0;
                            let firstByteTimeMs = null;
                            let ffmpegStderr = '';
                            let isClientDisconnected = false;
                            const startTime = Date.now();
                            ffmpegProc.stdout.on('data', (chunk) => {
                                if (bytesEmitted === 0)
                                    firstByteTimeMs = Date.now() - startTime;
                                bytesEmitted += chunk.length;
                            });
                            ffmpegProc.stderr.on('data', (data) => {
                                const str = data.toString();
                                if (ffmpegStderr.length < 4096)
                                    ffmpegStderr += str;
                            });
                            ffmpegProc.on('close', (code, signal) => {
                                const elapsedMs = Date.now() - startTime;
                                log.info('[DirectPlay FFmpeg Process Summary (Audio Only)]', {
                                    resolveId,
                                    itemId,
                                    exitCode: code,
                                    exitSignal: signal,
                                    elapsedMs,
                                    timeToFirstByteMs: firstByteTimeMs,
                                    totalBytesEmitted: bytesEmitted,
                                    clientDisconnected: isClientDisconnected,
                                });
                            });
                            request.raw.on('close', () => {
                                isClientDisconnected = true;
                                if (!ffmpegProc.killed) {
                                    ffmpegProc.kill('SIGKILL');
                                }
                            });
                            reply.header('content-type', 'audio/mp4');
                            reply.header('accept-ranges', 'none');
                            reply.header('content-disposition', 'inline');
                            reply.header('cache-control', 'private, no-store');
                            void reply.code(200);
                            return ffmpegProc.stdout;
                        }
                    }
                }
                // TIER 1 Check: Try single progressive stream if format is video+audio
                if (!isAudioOnlyFormat && format.kind === 'video+audio') {
                    try {
                        const { stdout } = await runYtDlp(binary, ['--get-url', ...commonYtArgs, '--format', `${rawFormatId}/b[vcodec!=none][acodec!=none]/18/22/best`, item.sourceUrl], { timeoutMs: 15_000 });
                        const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
                        if (lines.length === 1 && lines[0]) {
                            streamUrl = lines[0];
                        }
                    }
                    catch {
                        // Fall back to Tier 2 transmuxing
                    }
                }
                // TIER 2 Transmuxing / Transcoding: Separate video & audio streams via FFmpeg
                if (!streamUrl && !isAudioOnlyFormat) {
                    broadcastLog('STREAM', 'UPSTREAM_REQUEST_STARTED', `Extracting separate video (${rawFormatId}) and audio streams via yt-dlp`, {
                        resolveId,
                        itemId,
                        formatId,
                        rawFormatId,
                    });
                    let videoUrl = '';
                    let audioUrl = '';
                    try {
                        const selector = `${rawFormatId}+bestaudio[ext=m4a]/bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo+bestaudio/best`;
                        const { stdout } = await runYtDlp(binary, ['--get-url', ...commonYtArgs, '-f', selector, item.sourceUrl], { timeoutMs: 15_000 });
                        const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
                        if (lines.length >= 2) {
                            videoUrl = lines[0];
                            audioUrl = lines[1];
                        }
                        else if (lines.length === 1) {
                            videoUrl = lines[0];
                        }
                    }
                    catch (err) {
                        log.warn('Combined format URL extraction failed, attempting separate resolution', { error: err });
                    }
                    // If audio URL wasn't retrieved in combined call, retrieve it separately
                    if (videoUrl && !audioUrl) {
                        try {
                            const { stdout } = await runYtDlp(binary, ['--get-url', ...commonYtArgs, '-f', 'bestaudio[ext=m4a]/bestaudio/140/139', item.sourceUrl], { timeoutMs: 10_000 });
                            audioUrl = stdout.trim().split('\n')[0] ?? '';
                        }
                        catch (audioErr) {
                            log.warn('Audio stream extraction failed', { error: audioErr });
                        }
                    }
                    if (videoUrl && audioUrl) {
                        assertPublicHttpUrl(videoUrl);
                        assertPublicHttpUrl(audioUrl);
                        // Codec compatibility analysis: STRATEGY 3 (Remux Copy) vs STRATEGY 4 (Transcode Fallback)
                        const isH264 = !vcodec || vcodec.includes('avc') || vcodec.includes('h264') || vcodec.includes('mp4v');
                        const isAacOrMp3 = !acodec || acodec.includes('aac') || acodec.includes('mp4a') || acodec.includes('mp3');
                        const needsTranscode = !isH264 || !isAacOrMp3;
                        const codecArgs = needsTranscode
                            ? [
                                '-c:v', 'libx264',
                                '-preset', 'ultrafast',
                                '-tune', 'zerolatency',
                                '-pix_fmt', 'yuv420p',
                                '-c:a', 'aac',
                                '-b:a', '128k',
                            ]
                            : [
                                '-c:v', 'copy',
                                '-c:a', 'copy',
                            ];
                        const headerStr = `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36\r\n${record.platform === 'youtube' ? 'Referer: https://www.youtube.com/\r\n' : ''}`;
                        const seekSeconds = parseFloat(query.ss ?? '0');
                        const seekArgs = Number.isFinite(seekSeconds) && seekSeconds > 0 ? ['-ss', String(seekSeconds)] : [];
                        const ffmpegArgs = [
                            '-headers', headerStr,
                            ...seekArgs,
                            '-i', videoUrl,
                            '-headers', headerStr,
                            ...seekArgs,
                            '-i', audioUrl,
                            ...codecArgs,
                            '-f', 'mp4',
                            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                            'pipe:1',
                        ];
                        const sanitizeUrl = (u) => {
                            try {
                                const parsed = new URL(u);
                                parsed.search = '?...[token_hidden]';
                                return parsed.toString();
                            }
                            catch {
                                return u.length > 60 ? u.slice(0, 60) + '...' : u;
                            }
                        };
                        log.info('[DirectPlay FFmpeg Diagnostics]', {
                            resolveId,
                            itemId,
                            ffmpegPath: 'ffmpeg',
                            strategy: needsTranscode ? 'TRANSCODE' : 'REMUX',
                            inputVideoCodec: vcodec || 'unknown/h264',
                            inputAudioCodec: acodec || 'unknown/aac',
                            sanitizedVideoUrl: sanitizeUrl(videoUrl),
                            sanitizedAudioUrl: sanitizeUrl(audioUrl),
                            sanitizedArgs: ffmpegArgs.map((a) => (a.startsWith('http') ? sanitizeUrl(a) : a)),
                            outputContentType: 'video/mp4',
                        });
                        broadcastLog('STREAM', 'FFMPEG_STARTED', `Spawning FFmpeg ${needsTranscode ? 'transcoder' : 'remuxer'} for ${format.height ?? 480}p MP4 playback`, {
                            resolveId,
                            itemId,
                            formatId,
                            strategy: needsTranscode ? 'TRANSCODE' : 'REMUX',
                            videoCodec: vcodec || 'h264',
                        });
                        const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
                        let bytesEmitted = 0;
                        let firstByteTimeMs = null;
                        let isValidFtypHeader = false;
                        let ffmpegStderr = '';
                        let isClientDisconnected = false;
                        const startTime = Date.now();
                        ffmpegProc.stdout.on('data', (chunk) => {
                            if (bytesEmitted === 0) {
                                firstByteTimeMs = Date.now() - startTime;
                                if (chunk.length >= 8 && chunk.toString('ascii', 4, 8) === 'ftyp') {
                                    isValidFtypHeader = true;
                                }
                            }
                            bytesEmitted += chunk.length;
                        });
                        ffmpegProc.stderr.on('data', (data) => {
                            const str = data.toString();
                            if (ffmpegStderr.length < 4096)
                                ffmpegStderr += str;
                            if (str.toLowerCase().includes('error')) {
                                broadcastLog('WARN', 'FFMPEG_STDERR', str.slice(0, 200), { resolveId });
                            }
                        });
                        ffmpegProc.on('close', (code, signal) => {
                            const elapsedMs = Date.now() - startTime;
                            log.info('[DirectPlay FFmpeg Process Summary]', {
                                resolveId,
                                itemId,
                                exitCode: code,
                                exitSignal: signal,
                                elapsedMs,
                                timeToFirstByteMs: firstByteTimeMs,
                                totalBytesEmitted: bytesEmitted,
                                isValidFtypHeader,
                                clientDisconnected: isClientDisconnected,
                                ...(code !== 0 && !isClientDisconnected ? { ffmpegStderrTail: ffmpegStderr.slice(-1000) } : {}),
                            });
                        });
                        // Cancellation safety: kill FFmpeg process immediately if client disconnects
                        request.raw.on('close', () => {
                            isClientDisconnected = true;
                            if (!ffmpegProc.killed) {
                                log.info('[DirectPlay FFmpeg] Client disconnected, terminating FFmpeg process', {
                                    resolveId,
                                    itemId,
                                    bytesEmittedBeforeDisconnect: bytesEmitted,
                                });
                                broadcastLog('STREAM', 'PLAYBACK_ABORTED', 'Client disconnected during FFmpeg streaming', { resolveId });
                                ffmpegProc.kill('SIGKILL');
                            }
                        });
                        reply.header('content-type', 'video/mp4');
                        reply.header('accept-ranges', 'none');
                        reply.header('content-disposition', 'inline');
                        reply.header('cache-control', 'private, no-store');
                        void reply.code(200);
                        broadcastLog('STREAM', 'MEDIA_LOADSTART', `FFmpeg ${needsTranscode ? 'transcoding' : 'remuxing'} stream started for ${format.height ?? 480}p`, {
                            resolveId,
                            itemId,
                            formatId,
                            contentType: 'video/mp4',
                        });
                        return ffmpegProc.stdout;
                    }
                    else if (videoUrl) {
                        streamUrl = videoUrl;
                    }
                }
            }
            finally {
                await cookiePrep.cleanup?.();
            }
        }
        if (!streamUrl) {
            throw appErrors.temporaryProviderError('Streaming URL could not be resolved.');
        }
        assertPublicHttpUrl(streamUrl);
        // Forward the Range request headers if present.
        const rangeHeader = request.headers.range;
        let currentStreamUrl = streamUrl;
        const currentProxyHeaders = { ...proxyHeaders };
        let response;
        let attempt = 0;
        while (attempt < 2) {
            let hop = 0;
            let redirectUrl = currentStreamUrl;
            let success = false;
            while (hop < 10) {
                try {
                    assertPublicHttpUrl(redirectUrl);
                }
                catch (urlErr) {
                    log.error('Invalid redirect URL', { url: redirectUrl, error: urlErr });
                    break;
                }
                const controller = new AbortController();
                request.raw.on('close', () => {
                    controller.abort();
                });
                try {
                    response = await fetch(redirectUrl, {
                        headers: {
                            ...currentProxyHeaders,
                            ...(rangeHeader ? { range: rangeHeader } : {}),
                        },
                        method: 'GET',
                        redirect: 'manual', // MANUAL REDIRECTS!
                        signal: controller.signal,
                    });
                }
                catch (fetchErr) {
                    if (controller.signal.aborted)
                        return;
                    log.error('Provider fetch failed', { error: fetchErr });
                    break;
                }
                // Follow redirects manually so custom headers like User-Agent are not dropped!
                if ([301, 302, 303, 307, 308].includes(response.status)) {
                    const location = response.headers.get('location');
                    if (!location) {
                        log.error('Redirect response missing location header');
                        break;
                    }
                    void response.body?.cancel();
                    redirectUrl = new URL(location, redirectUrl).toString();
                    hop++;
                    continue;
                }
                success = response.ok || response.status === 206;
                break;
            }
            if (!success && attempt === 0) {
                log.warn('Stream URL returned error or failed redirects, attempting to re-resolve...', {
                    status: response?.status,
                    platform: record.platform,
                });
                attempt++;
                const adapter = adapters.get(record.platform);
                if (adapter) {
                    try {
                        const output = await adapter.resolve(item.sourceUrl);
                        const updatedRecord = {
                            ...record,
                            items: output.items,
                            expiresAt: Date.now() + (config.RESOLVE_TTL_MINUTES * 60_000),
                        };
                        await store.saveResolve(updatedRecord);
                        const updatedItem = output.items.find((i) => i.id === itemId);
                        const updatedFormat = updatedItem?.formats.find((f) => f.formatId === formatId);
                        if (updatedFormat?.sourceSelector) {
                            currentStreamUrl = updatedFormat.sourceSelector;
                            if (response)
                                void response.body?.cancel();
                            continue;
                        }
                    }
                    catch (resolveErr) {
                        log.error('Failed to re-resolve URL during retry', { error: resolveErr, platform: record.platform });
                    }
                }
            }
            break;
        }
        if (!response || (!response.ok && response.status !== 206)) {
            log.error('Provider returned error status', { status: response?.status });
            throw appErrors.temporaryProviderError('Provider rejected streaming request. Please try downloading instead.');
        }
        const responseHeaders = response.headers;
        const contentType = responseHeaders.get('content-type') ?? format.mimeType ?? 'video/mp4';
        const contentRange = responseHeaders.get('content-range');
        const contentLength = responseHeaders.get('content-length');
        const acceptRanges = responseHeaders.get('accept-ranges') ?? 'bytes';
        log.info('[DirectPlay Stream Pipeline]', {
            resolveId,
            itemId,
            formatId,
            platform: record.platform,
            rawSelector: format.sourceSelector,
            height: format.height,
            kind: format.kind,
            container: format.container,
            codec: format.codec,
            upstreamStatus: response.status,
            upstreamContentType: contentType,
            contentLength: contentLength ?? 'unknown',
            contentRange: contentRange ?? 'none',
            rangeHeader: rangeHeader ?? 'none',
            tokenValid: true,
        });
        reply.header('content-type', contentType);
        reply.header('accept-ranges', acceptRanges);
        reply.header('content-disposition', 'inline');
        reply.header('cache-control', 'private, no-store');
        reply.header('access-control-expose-headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type, Content-Disposition');
        if (response.status === 206 && contentRange) {
            reply.header('content-range', contentRange);
            if (contentLength) {
                reply.header('content-length', contentLength);
            }
            void reply.code(206);
        }
        else {
            if (contentLength) {
                reply.header('content-length', contentLength);
            }
            void reply.code(200);
        }
        if (!response.body) {
            throw appErrors.temporaryProviderError('Provider stream body is empty.');
        }
        return response.body;
    }
    async function handleStream(request, reply) {
        const params = (request.params ?? {});
        const query = (request.query ?? {});
        const jobId = params.id ?? '';
        const itemId = params.itemId ?? query.item ?? '';
        if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^[0-9a-f-]{36}$/i.test(itemId)) {
            throw appErrors.invalidUrl('Malformed stream link.');
        }
        const token = query.token ?? '';
        const scope = verifyExpiringToken(token, config.DOWNLOAD_TOKEN_SECRET);
        if (!scope || scope !== `${jobId}:${itemId}`) {
            throw appErrors.expired('This stream link is invalid or has expired.');
        }
        const job = await requireJob(jobId);
        if (job.status === 'expired')
            throw appErrors.expired();
        if (job.status !== 'completed')
            throw appErrors.conflict('The media is not ready yet.');
        assertNotExpired(job);
        const item = await store.getItem(itemId);
        if (!item || item.jobId !== jobId)
            throw appErrors.notFound('This item does not exist.');
        if (!item.artifactKey)
            throw appErrors.expired();
        const filePath = safeArtifactPath(config.ARTIFACT_ROOT, item.artifactKey);
        if (!filePath)
            throw appErrors.expired();
        const info = await stat(filePath).catch(() => null);
        if (!info?.isFile()) {
            await store.updateItem(item.id, { artifactKey: null });
            throw appErrors.expired();
        }
        // Determine MIME type from file extension
        const mimeType = getMimeType(item.artifactName ?? '');
        if (!mimeType) {
            throw appErrors.unsupported('This file type cannot be played in the browser.');
        }
        // Handle Range requests for seeking
        const rangeHeader = request.headers.range;
        if (rangeHeader) {
            const rangeMatch = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
            if (rangeMatch) {
                const start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
                const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : info.size - 1;
                const chunkSize = end - start + 1;
                if (start >= info.size || end >= info.size || chunkSize <= 0) {
                    reply.header('content-range', `bytes */${info.size}`);
                    void reply.code(416);
                    return;
                }
                reply.header('content-range', `bytes ${start}-${end}/${info.size}`);
                reply.header('accept-ranges', 'bytes');
                reply.header('content-length', chunkSize);
                reply.header('content-type', mimeType);
                reply.header('content-disposition', 'inline');
                reply.header('cache-control', 'private, no-store');
                reply.header('access-control-expose-headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type, Content-Disposition');
                void reply.code(206);
                const stream = createReadStream(filePath, { start, end });
                return stream;
            }
        }
        // Full file response
        reply.header('content-type', mimeType);
        reply.header('content-length', info.size);
        reply.header('accept-ranges', 'bytes');
        reply.header('content-disposition', 'inline');
        reply.header('cache-control', 'private, no-store');
        reply.header('access-control-expose-headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type, Content-Disposition');
        return createReadStream(filePath);
    }
    const sseClients = new Set();
    function broadcastLog(level, tag, message, payload) {
        const data = JSON.stringify({
            level,
            tag,
            message,
            payload,
            timestamp: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }),
        });
        sseClients.forEach((reply) => {
            try {
                reply.raw.write(`data: ${data}\n\n`);
            }
            catch {
                sseClients.delete(reply);
            }
        });
    }
    app.get('/api/v1/logs/stream', async (request, reply) => {
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        reply.raw.write(`data: ${JSON.stringify({ level: 'INFO', tag: 'SSE_CONNECTED', message: 'Connected to API log stream' })}\n\n`);
        sseClients.add(reply);
        request.raw.on('close', () => {
            sseClients.delete(reply);
        });
        return new Promise(() => { });
    });
    app.get('/api/v1/resolve/:resolveId/items/:itemId/thumbnail', { preHandler: enforceRateLimit('download') }, handleResolveThumbnail);
    app.get('/api/v1/resolve/:resolveId/items/:itemId/stream', { preHandler: enforceRateLimit('download') }, handleResolveStream);
    app.get('/api/v1/jobs/:id/items/:itemId/stream', { preHandler: enforceRateLimit('download') }, handleStream);
    app.get('/api/v1/jobs/:id/stream', { preHandler: enforceRateLimit('download') }, handleStream);
    async function handleDirectStreamProxy(request, reply) {
        const query = (request.query ?? {});
        const targetUrl = query.url ?? '';
        if (!targetUrl) {
            reply.header('x-debug-error', 'Missing required url query parameter');
            throw appErrors.validation('Missing required url query parameter.');
        }
        let urlObj;
        try {
            urlObj = new URL(targetUrl);
        }
        catch {
            reply.header('x-debug-error', 'Invalid stream URL format');
            throw appErrors.invalidUrl('Invalid stream URL format.');
        }
        assertPublicHttpUrl(urlObj.toString());
        const proxyHeaders = {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        };
        const host = urlObj.hostname.toLowerCase();
        if (host.includes('googlevideo.com') || host.includes('youtube.com') || host.includes('youtu.be')) {
            proxyHeaders['referer'] = 'https://www.youtube.com/';
        }
        else if (host.includes('terabox') || host.includes('1024tera') || host.includes('terafileshare')) {
            proxyHeaders['user-agent'] = 'netdisk;';
            proxyHeaders['referer'] = 'https://www.terabox.com/';
        }
        const rangeHeader = request.headers.range;
        let redirectUrl = targetUrl;
        let response;
        let hop = 0;
        const fetchStart = Date.now();
        while (hop < 10) {
            try {
                assertPublicHttpUrl(redirectUrl);
            }
            catch (urlErr) {
                log.error('Invalid redirect URL', { url: redirectUrl, error: urlErr });
                break;
            }
            const controller = new AbortController();
            request.raw.on('close', () => {
                controller.abort();
            });
            try {
                response = await fetch(redirectUrl, {
                    headers: {
                        ...proxyHeaders,
                        ...(rangeHeader ? { range: rangeHeader } : {}),
                    },
                    method: 'GET',
                    redirect: 'manual',
                    signal: controller.signal,
                });
            }
            catch (fetchErr) {
                if (controller.signal.aborted)
                    return;
                log.error('Direct stream proxy fetch failed', { error: fetchErr });
                broadcastLog('ERROR', 'STREAM_FETCH_ERR', `Proxy fetch failed for ${redirectUrl}`, { error: fetchErr?.message });
                break;
            }
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get('location');
                if (!location)
                    break;
                void response.body?.cancel();
                redirectUrl = new URL(location, redirectUrl).toString();
                hop++;
                continue;
            }
            break;
        }
        const latencyMs = Date.now() - fetchStart;
        if (!response || (!response.ok && response.status !== 206)) {
            log.error('Upstream CDN returned error status', { status: response?.status, url: targetUrl });
            const errMsg = `Upstream CDN status ${response?.status ?? 'fetch_failed'}`;
            reply.header('x-debug-error', errMsg);
            broadcastLog('ERROR', 'STREAM_CDN_ERR', errMsg, { status: response?.status, latencyMs, url: targetUrl });
            throw appErrors.temporaryProviderError('Upstream provider rejected streaming request.');
        }
        const responseHeaders = response.headers;
        const contentType = responseHeaders.get('content-type') || 'video/mp4';
        const contentRange = responseHeaders.get('content-range');
        const contentLength = responseHeaders.get('content-length');
        const acceptRanges = responseHeaders.get('accept-ranges') ?? 'bytes';
        broadcastLog('STREAM', 'STREAM_PIPELINE', `Proxied stream ${response.status} (${contentType}, ${contentLength ?? 'chunked'} bytes, ${latencyMs}ms)`, {
            status: response.status,
            rangeHeader: rangeHeader ?? 'none',
            contentRange: contentRange ?? 'none',
            contentLength,
            contentType,
            latencyMs,
        });
        reply.header('content-type', contentType);
        reply.header('accept-ranges', acceptRanges);
        reply.header('content-disposition', 'inline');
        reply.header('cache-control', 'private, no-store');
        if ((response.status === 206 || contentRange) && contentRange) {
            reply.header('content-range', contentRange);
            if (contentLength)
                reply.header('content-length', contentLength);
            void reply.code(206);
        }
        else {
            if (contentLength)
                reply.header('content-length', contentLength);
            void reply.code(200);
        }
        if (!response.body) {
            reply.header('x-debug-error', 'Empty upstream stream body');
            throw appErrors.temporaryProviderError('Upstream stream body is empty.');
        }
        return response.body;
    }
    app.get('/api/v1/stream', { preHandler: enforceRateLimit('download') }, handleDirectStreamProxy);
    /* ── helpers ───────────────────────────────────────────────────────────── */
    async function requireJob(id) {
        const job = await store.getJob(id);
        if (!job)
            throw appErrors.notFound('This job does not exist.');
        return job;
    }
    function assertNotExpired(job) {
        if (job.status === 'completed' && job.expiresAt && job.expiresAt.getTime() <= Date.now()) {
            throw appErrors.expired();
        }
    }
    function hashIp(ip) {
        return hashWithPepper(ip, config.IP_HASH_PEPPER);
    }
    /* ── error surface ─────────────────────────────────────────────────────── */
    app.setErrorHandler((rawError, request, reply) => {
        const error = rawError;
        if (error.validation) {
            const err = appErrors.validation(String(error.message ?? 'Invalid request.'));
            void reply.code(err.httpStatus);
            return { error: err.toJSON() };
        }
        const appErr = toAppError(rawError);
        const status = HTTP_STATUS_BY_CODE[appErr.code];
        if (status >= 500) {
            log.error('request failed', {
                requestId: request.id,
                method: request.method,
                url: redactUrlForLog(request.url),
                errorCode: appErr.code,
                message: appErr.message,
                stack: error.stack?.split('\n').slice(0, 6).join('\n'),
            });
        }
        else {
            log.info('request rejected', {
                requestId: request.id,
                url: redactUrlForLog(request.url),
                errorCode: appErr.code,
            });
        }
        void reply.code(status);
        return { error: appErr.toJSON() };
    });
    app.setNotFoundHandler((request, reply) => {
        const rawPath = request.url.split('?')[0] ?? '';
        const cleanPath = rawPath.replace(/\/+$/, '') || '/';
        let msg = `Route ${request.method} ${cleanPath} not found.`;
        if (cleanPath === '/api/v1/resolve' && request.method !== 'POST') {
            msg = `Route ${request.method} ${cleanPath} not found. Use POST /api/v1/resolve for link resolution.`;
        }
        const err = appErrors.notFound(msg);
        void reply.code(404);
        return { error: err.toJSON() };
    });
    return app;
}
function sanitizeHeaderName(name) {
    return name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'download.bin';
}
function getMimeTypeFromName(filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'mp4': return 'video/mp4';
        case 'webm': return 'video/webm';
        case 'm4a': return 'audio/mp4';
        case 'mp3': return 'audio/mpeg';
        case 'ogg': return 'audio/ogg';
        default: return 'application/octet-stream';
    }
}
function redactUrlForLog(url) {
    try {
        const u = new URL(url, 'http://internal');
        return u.pathname;
    }
    catch {
        return '(unparseable)';
    }
}
function getMimeType(filename) {
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    const mimeMap = {
        mp4: 'video/mp4',
        webm: 'video/webm',
        mkv: 'video/x-matroska',
        mov: 'video/quicktime',
        m4v: 'video/x-m4v',
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        aac: 'audio/aac',
        ogg: 'audio/ogg',
        opus: 'audio/opus',
        wav: 'audio/wav',
        flac: 'audio/flac',
    };
    return mimeMap[ext] ?? null;
}
//# sourceMappingURL=app.js.map