import crypto from 'node:crypto';
import { createReadStream, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { stat, rename, unlink as unlinkAsync } from 'node:fs/promises';
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
import { getPlaybackArtifactPath, playbackCacheKey, playbackInFlight, isPlaybackArtifactFresh, ensurePlaybackDir, cleanupStalePlaybackArtifacts, } from './lib/playback-artifact.js';
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
    await ensurePlaybackDir();
    // Periodic playback artifact GC — never deletes active streams
    const playbackGcTimer = setInterval(() => {
        cleanupStalePlaybackArtifacts(log).catch(() => { });
    }, 5 * 60 * 1000);
    // Allow process to exit cleanly in tests
    playbackGcTimer.unref?.();
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
                return;
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
        // ── Unified browser-compatible artifact pipeline ─────────────────────
        // All direct-play media is materialized to a seekable MP4 artifact and served via Range.
        // This fixes TikTok bytes=0- disconnect (unseekable pipe), Instagram/Facebook CDN non-Range, Terabox HLS.
        let streamUrl = '';
        let proxyHeaders = {};
        const artifactKey = playbackCacheKey(resolveId, itemId, formatId);
        const artifactPath = getPlaybackArtifactPath(resolveId, itemId, formatId);
        let artifactGenerationMs = 0;
        let artifactCacheHit = false;
        let artifactStatus = 'MISS';
        let firstByteMs = null;
        const genStartTime = Date.now();
        let clientDisconnected = false;
        request.raw.on('close', () => { clientDisconnected = true; });
        // Helper: yt-dlp download to file (seekable, no pipe)
        const ytdlpDownloadToFile = async (binary, selector, source, outPath) => {
            const tmp = `${outPath}.incomplete`;
            await ensurePlaybackDir();
            await new Promise((resolve, reject) => {
                const args = ['--no-warnings', '--no-playlist', '--format', selector, '-o', tmp, source];
                const proc = spawn(binary, args);
                let stderr = '';
                proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 4000)
                    stderr = stderr.slice(-4000); });
                proc.on('close', async (code) => {
                    if (code === 0) {
                        try {
                            const st = await stat(tmp);
                            if (!st || st.size < 1024)
                                return reject(appErrors.temporaryProviderError('Downloaded artifact too small'));
                            await rename(tmp, outPath);
                            resolve();
                        }
                        catch (e) {
                            reject(toAppError(e));
                        }
                    }
                    else {
                        await unlinkAsync(tmp).catch(() => { });
                        reject(appErrors.temporaryProviderError(`yt-dlp download failed (code ${code}): ${stderr.slice(-600)}`));
                    }
                });
                proc.on('error', (e) => reject(toAppError(e)));
                // Do not kill on client disconnect — artifact is reusable; keep generating for cache
            });
        };
        const ffmpegTranscodeToFile = async (inputPath, outPath, videoArgs, audioArgs) => {
            const tmp = `${outPath}.transcode.incomplete`;
            await new Promise((resolve, reject) => {
                const args = ['-y', '-i', inputPath, ...videoArgs, ...audioArgs, '-movflags', 'faststart', tmp];
                const proc = spawn('ffmpeg', args);
                let stderr = '';
                proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 4000)
                    stderr = stderr.slice(-4000); });
                proc.on('close', async (code) => {
                    if (code === 0) {
                        try {
                            const st = await stat(tmp);
                            if (!st || st.size < 1024)
                                return reject(appErrors.temporaryProviderError('Transcoded artifact too small'));
                            await rename(tmp, outPath);
                            resolve();
                        }
                        catch (e) {
                            reject(toAppError(e));
                        }
                    }
                    else {
                        await unlinkAsync(tmp).catch(() => { });
                        reject(appErrors.temporaryProviderError(`FFmpeg transcode failed (code ${code}): ${stderr.slice(-600)}`));
                    }
                });
                proc.on('error', (e) => reject(toAppError(e)));
            });
        };
        const ffmpegRemuxUrlsToFile = async (videoUrl, audioUrl, outPath, needsTranscode) => {
            const tmp = `${outPath}.incomplete`;
            const headerStr = `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36\r\n${record.platform === 'youtube' ? 'Referer: https://www.youtube.com/\r\n' : ''}`;
            const codecArgs = needsTranscode
                ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k']
                : ['-c:v', 'copy', '-c:a', 'copy'];
            const inputs = [];
            if (videoUrl)
                inputs.push('-headers', headerStr, '-i', videoUrl);
            if (audioUrl)
                inputs.push('-headers', headerStr, '-i', audioUrl);
            const args = [...inputs, ...codecArgs, '-f', 'mp4', '-movflags', 'faststart', '-y', tmp];
            await new Promise((resolve, reject) => {
                const proc = spawn('ffmpeg', args);
                let stderr = '';
                proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 4000)
                    stderr = stderr.slice(-4000); });
                proc.on('close', async (code) => {
                    if (code === 0) {
                        try {
                            const st = await stat(tmp);
                            if (!st || st.size < 1024)
                                return reject(appErrors.temporaryProviderError('Remuxed artifact too small'));
                            await rename(tmp, outPath);
                            resolve();
                        }
                        catch (e) {
                            reject(toAppError(e));
                        }
                    }
                    else {
                        await unlinkAsync(tmp).catch(() => { });
                        reject(appErrors.temporaryProviderError(`FFmpeg remux failed (code ${code}): ${stderr.slice(-600)}`));
                    }
                });
                proc.on('error', (e) => reject(toAppError(e)));
            });
        };
        // ── Terabox HLS (special) → artifact via same unified path ─────
        if (record.platform === 'terabox') {
            const sel = format.sourceSelector ?? '';
            if (sel.includes('/share/streaming')) {
                const u = new URL(sel);
                const randsk = u.searchParams.get('randsk') ?? '';
                const browserid = u.searchParams.get('browserid') ?? '';
                const shortKeyMatch = /\/sharing\/link\?surl=([\w-]+)/i.exec(item.sourceUrl) || /\/s\/1([\w-]+)/i.exec(item.sourceUrl) || /\/s\/([\w-]+)/i.exec(item.sourceUrl);
                const shortKey = shortKeyMatch?.[1] ?? '';
                const cookiesWithBoxClnd = `browserid=${browserid}; BOXCLND=${randsk}`;
                const referer = `https://${u.hostname}/sharing/link?surl=${shortKey}`;
                const existing = await stat(artifactPath).catch(() => null);
                if (isPlaybackArtifactFresh(existing)) {
                    artifactCacheHit = true;
                    artifactStatus = 'HIT';
                }
                else {
                    if (!playbackInFlight.has(artifactKey)) {
                        const p = (async () => {
                            const segHeaders = {
                                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                'accept': '*/*',
                                'referer': referer,
                                'cookie': cookiesWithBoxClnd,
                            };
                            const baseU = new URL(sel);
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
                                    uk, shareid, type: 'M3U8_AUTO_480', fid, sign: loopSig, timestamp: String(nowTime),
                                    ...(jsToken ? { jsToken } : {}), esl: '1', isplayer: '1', ehps: '1', clienttype, app_id: '250528', channel, randsk, browserid,
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
                                    const baseSegUrl = seg.split('&t=')[0] ?? seg;
                                    if (!seenSegSet.has(baseSegUrl)) {
                                        seenSegSet.add(baseSegUrl);
                                        segUrls.push(seg);
                                        addedCount++;
                                    }
                                }
                                if (addedCount === 0 || text.includes('#EXT-X-ENDLIST'))
                                    hasMoreSegs = false;
                            }
                            if (segUrls.length === 0)
                                throw appErrors.temporaryProviderError('Playlist contains no segments.');
                            const segDir = `${tmpdir()}/terabox-seg-${resolveId}-${itemId}`.replace(/\\/g, '/');
                            try {
                                mkdirSync(segDir, { recursive: true });
                            }
                            catch { }
                            const localSegPaths = new Array(segUrls.length);
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
                                        throw appErrors.temporaryProviderError('Segment too small');
                                    const head = buf.slice(0, 200).toString('utf8');
                                    if (head.includes('<!DOCTYPE') || head.includes('"errno"'))
                                        throw appErrors.temporaryProviderError('Provider returned error for segment.');
                                    const segPath = `${segDir}/seg-${String(globalIdx).padStart(5, '0')}.ts`.replace(/\\/g, '/');
                                    writeFileSync(segPath, buf);
                                    localSegPaths[globalIdx] = segPath;
                                }));
                            }
                            const concatList = localSegPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
                            const concatPath = `${segDir}/concat.txt`.replace(/\\/g, '/');
                            writeFileSync(concatPath, concatList);
                            const tmpIncomplete = `${artifactPath}.incomplete`;
                            await new Promise((resolve, reject) => {
                                const args = ['-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', '-movflags', 'faststart', '-y', tmpIncomplete];
                                const proc = spawn('ffmpeg', args);
                                let stderr = '';
                                proc.stderr.on('data', d => stderr += d.toString());
                                proc.on('close', async (code) => {
                                    try {
                                        localSegPaths.forEach(p => { try {
                                            unlinkSync(p);
                                        }
                                        catch { } });
                                        unlinkSync(concatPath);
                                    }
                                    catch { }
                                    try {
                                        rmSync(segDir, { recursive: true, force: true });
                                    }
                                    catch { }
                                    if (code === 0) {
                                        const st = await stat(tmpIncomplete).catch(() => null);
                                        if (!st || st.size < 1024)
                                            return reject(appErrors.temporaryProviderError('Generated playback file empty'));
                                        await rename(tmpIncomplete, artifactPath);
                                        resolve();
                                    }
                                    else
                                        reject(appErrors.temporaryProviderError(`Transmux failed (code ${code}): ${stderr.slice(-500)}`));
                                });
                                proc.on('error', e => reject(toAppError(e)));
                            });
                        })();
                        playbackInFlight.set(artifactKey, p);
                        p.catch(async () => { await unlinkAsync(artifactPath).catch(() => { }); await unlinkAsync(`${artifactPath}.incomplete`).catch(() => { }); });
                        p.finally(() => playbackInFlight.delete(artifactKey));
                        try {
                            await p;
                            artifactGenerationMs = Date.now() - genStartTime;
                        }
                        catch (e) {
                            throw e;
                        }
                    }
                    else {
                        await playbackInFlight.get(artifactKey);
                        artifactCacheHit = true;
                        artifactStatus = 'WAIT_HIT';
                        artifactGenerationMs = Date.now() - genStartTime;
                    }
                }
                // Unified Range serve via artifact
                const rangeHeader = initialRangeHeader ?? request.headers.range;
                const isHead = request.method === 'HEAD';
                const statInfo = await stat(artifactPath).catch(() => null);
                if (!statInfo)
                    throw appErrors.temporaryProviderError('Playback artifact missing after generation');
                const size = statInfo.size;
                const rangeParse = (() => {
                    if (!rangeHeader || !rangeHeader.startsWith('bytes='))
                        return { isRange: false, valid: true, start: 0, end: size - 1 };
                    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
                    if (!m)
                        return { isRange: true, valid: false, start: 0, end: 0 };
                    const s = m[1] ? parseInt(m[1], 10) : 0;
                    const e = m[2] ? parseInt(m[2], 10) : size - 1;
                    if (Number.isNaN(s) || Number.isNaN(e) || s >= size || e >= size || s > e || s < 0 || e < 0)
                        return { isRange: true, valid: false, start: s, end: e };
                    return { isRange: true, valid: true, start: s, end: e };
                })();
                log.info('[Stream] playback artifact serve', { platform: record.platform, resolveId, itemId, formatId, range: rangeHeader ?? 'none', artifactStatus, artifactPath: artifactPath.split('/').pop(), generationMs: artifactGenerationMs, cacheHit: artifactCacheHit, size, httpStatus: !rangeParse.isRange ? 200 : !rangeParse.valid ? 416 : 206, contentType: 'video/mp4', contentLength: rangeParse.isRange && rangeParse.valid ? (rangeParse.end - rangeParse.start + 1) : size, contentRange: rangeParse.isRange && rangeParse.valid ? `bytes ${rangeParse.start}-${rangeParse.end}/${size}` : 'none', firstByteMs: artifactGenerationMs, disconnectState: clientDisconnected });
                reply.header('content-type', 'video/mp4');
                reply.header('accept-ranges', 'bytes');
                reply.header('content-disposition', 'inline');
                reply.header('cache-control', 'private, no-store');
                reply.header('access-control-expose-headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type, Content-Disposition');
                if (rangeParse.isRange && !rangeParse.valid) {
                    reply.header('content-range', `bytes */${size}`);
                    void reply.code(416);
                    if (isHead)
                        return;
                    return;
                }
                if (rangeParse.isRange && rangeParse.valid) {
                    const chunkSize = rangeParse.end - rangeParse.start + 1;
                    reply.header('content-range', `bytes ${rangeParse.start}-${rangeParse.end}/${size}`);
                    reply.header('content-length', chunkSize);
                    void reply.code(206);
                    if (isHead)
                        return;
                    const stream = createReadStream(artifactPath, { start: rangeParse.start, end: rangeParse.end });
                    return stream;
                }
                reply.header('content-length', size);
                void reply.code(200);
                if (isHead)
                    return;
                return createReadStream(artifactPath);
            }
            // Terabox direct file (non-HLS) falls through to proxy path
            proxyHeaders = {
                'user-agent': 'netdisk;',
                referer: 'https://www.terabox.com/',
            };
            streamUrl = sel;
        }
        else if (record.platform === 'tiktok') {
            // ── TikTok unified artifact (no stdout pipe) ──
            const binary = await requireBinary(process.env.YT_DLP_PATH, log);
            const rawFormatId = (format.sourceSelector ?? format.formatId).replace(/^[vfa]:/, '');
            const isByteVc1 = rawFormatId.includes('bytevc1') || rawFormatId.includes('hevc') || rawFormatId.includes('h265');
            const selector = isByteVc1 ? `${rawFormatId}/best` : `${rawFormatId}[vcodec^=h264]/${rawFormatId}[vcodec^=avc]/b[vcodec^=h264]/b[vcodec^=avc]/download/best`;
            const existing = await stat(artifactPath).catch(() => null);
            if (isPlaybackArtifactFresh(existing)) {
                artifactCacheHit = true;
                artifactStatus = 'HIT';
            }
            else {
                if (!playbackInFlight.has(artifactKey)) {
                    const p = (async () => {
                        if (isByteVc1) {
                            const hevcTmp = `${artifactPath}.hevc.tmp.mp4`;
                            await ytdlpDownloadToFile(binary, selector, item.sourceUrl, hevcTmp);
                            // Transcode HEVC → H264/AAC
                            const tmpIncomplete = `${artifactPath}.incomplete`;
                            await new Promise((resolve, reject) => {
                                const args = ['-y', '-i', hevcTmp, '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-c:a', 'copy', '-movflags', 'faststart', tmpIncomplete];
                                const proc = spawn('ffmpeg', args);
                                let stderr = '';
                                proc.stderr.on('data', d => stderr += d.toString());
                                proc.on('close', async (code) => {
                                    await unlinkAsync(hevcTmp).catch(() => { });
                                    if (code === 0) {
                                        const st = await stat(tmpIncomplete).catch(() => null);
                                        if (!st || st.size < 1024)
                                            return reject(appErrors.temporaryProviderError('Transcoded artifact too small'));
                                        await rename(tmpIncomplete, artifactPath);
                                        resolve();
                                    }
                                    else {
                                        await unlinkAsync(tmpIncomplete).catch(() => { });
                                        reject(appErrors.temporaryProviderError(`ByteVC1 transcode failed (code ${code}): ${stderr.slice(-500)}`));
                                    }
                                });
                                proc.on('error', e => reject(toAppError(e)));
                            });
                        }
                        else {
                            await ytdlpDownloadToFile(binary, selector, item.sourceUrl, artifactPath);
                        }
                    })();
                    playbackInFlight.set(artifactKey, p);
                    p.catch(async () => { await unlinkAsync(artifactPath).catch(() => { }); await unlinkAsync(`${artifactPath}.incomplete`).catch(() => { }); });
                    p.finally(() => playbackInFlight.delete(artifactKey));
                    try {
                        await p;
                        artifactGenerationMs = Date.now() - genStartTime;
                    }
                    catch (e) {
                        throw e;
                    }
                }
                else {
                    await playbackInFlight.get(artifactKey);
                    artifactCacheHit = true;
                    artifactStatus = 'WAIT_HIT';
                }
            }
            const rangeHeader = initialRangeHeader ?? request.headers.range;
            const isHead = request.method === 'HEAD';
            const statInfo = await stat(artifactPath).catch(() => null);
            if (!statInfo)
                throw appErrors.temporaryProviderError('TikTok artifact missing after generation');
            const size = statInfo.size;
            const rangeParse = (() => {
                if (!rangeHeader || !rangeHeader.startsWith('bytes='))
                    return { isRange: false, valid: true, start: 0, end: size - 1 };
                const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
                if (!m)
                    return { isRange: true, valid: false, start: 0, end: 0 };
                const s = m[1] ? parseInt(m[1], 10) : 0;
                const e = m[2] ? parseInt(m[2], 10) : size - 1;
                if (Number.isNaN(s) || Number.isNaN(e) || s >= size || e >= size || s > e)
                    return { isRange: true, valid: false, start: s, end: e };
                return { isRange: true, valid: true, start: s, end: e };
            })();
            log.info('[Stream] playback artifact serve', { platform: 'tiktok', resolveId, itemId, formatId, range: rangeHeader ?? 'none', artifactStatus, generationMs: artifactGenerationMs, cacheHit: artifactCacheHit, size, httpStatus: !rangeParse.isRange ? 200 : !rangeParse.valid ? 416 : 206, contentType: 'video/mp4', contentLength: rangeParse.isRange && rangeParse.valid ? (rangeParse.end - rangeParse.start + 1) : size, contentRange: rangeParse.isRange && rangeParse.valid ? `bytes ${rangeParse.start}-${rangeParse.end}/${size}` : 'none', firstByteMs: artifactGenerationMs, disconnectState: clientDisconnected, isByteVc1 });
            reply.header('content-type', 'video/mp4');
            reply.header('accept-ranges', 'bytes');
            reply.header('content-disposition', 'inline');
            reply.header('cache-control', 'private, no-store');
            reply.header('access-control-expose-headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type, Content-Disposition');
            if (rangeParse.isRange && !rangeParse.valid) {
                reply.header('content-range', `bytes */${size}`);
                void reply.code(416);
                if (isHead)
                    return;
                return;
            }
            if (rangeParse.isRange && rangeParse.valid) {
                const chunkSize = rangeParse.end - rangeParse.start + 1;
                reply.header('content-range', `bytes ${rangeParse.start}-${rangeParse.end}/${size}`);
                reply.header('content-length', chunkSize);
                void reply.code(206);
                if (isHead)
                    return;
                return createReadStream(artifactPath, { start: rangeParse.start, end: rangeParse.end });
            }
            reply.header('content-length', size);
            void reply.code(200);
            if (isHead)
                return;
            return createReadStream(artifactPath);
        }
        else {
            // Early artifact hit for Instagram/Facebook: if seekable MP4 already cached, serve immediately without yt-dlp
            if (record.platform === 'instagram' || record.platform === 'facebook') {
                const earlyExisting = await stat(artifactPath).catch(() => null);
                if (isPlaybackArtifactFresh(earlyExisting)) {
                    const earlyRange = initialRangeHeader ?? request.headers.range;
                    const earlyIsHead = request.method === 'HEAD';
                    const earlySize = earlyExisting.size;
                    const earlyRangeParse = (() => {
                        if (!earlyRange || !earlyRange.startsWith('bytes='))
                            return { isRange: false, valid: true, start: 0, end: earlySize - 1 };
                        const m = /bytes=(\d*)-(\d*)/.exec(earlyRange);
                        if (!m)
                            return { isRange: true, valid: false, start: 0, end: 0 };
                        const s = m[1] ? parseInt(m[1], 10) : 0;
                        const e = m[2] ? parseInt(m[2], 10) : earlySize - 1;
                        if (Number.isNaN(s) || Number.isNaN(e) || s >= earlySize || e >= earlySize || s > e)
                            return { isRange: true, valid: false, start: s, end: e };
                        return { isRange: true, valid: true, start: s, end: e };
                    })();
                    artifactCacheHit = true;
                    artifactStatus = 'HIT_EARLY';
                    artifactGenerationMs = 0;
                    log.info('[Stream] playback artifact serve (early)', { platform: record.platform, resolveId, itemId, formatId, range: earlyRange ?? 'none', artifactStatus, size: earlySize, httpStatus: !earlyRangeParse.isRange ? 200 : !earlyRangeParse.valid ? 416 : 206 });
                    reply.header('content-type', 'video/mp4');
                    reply.header('accept-ranges', 'bytes');
                    reply.header('content-disposition', 'inline');
                    reply.header('cache-control', 'private, no-store');
                    reply.header('access-control-expose-headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type, Content-Disposition');
                    if (earlyRangeParse.isRange && !earlyRangeParse.valid) {
                        reply.header('content-range', `bytes */${earlySize}`);
                        void reply.code(416);
                        if (earlyIsHead)
                            return;
                        return;
                    }
                    if (earlyRangeParse.isRange && earlyRangeParse.valid) {
                        const chunkSize = earlyRangeParse.end - earlyRangeParse.start + 1;
                        reply.header('content-range', `bytes ${earlyRangeParse.start}-${earlyRangeParse.end}/${earlySize}`);
                        reply.header('content-length', chunkSize);
                        void reply.code(206);
                        if (earlyIsHead)
                            return;
                        return createReadStream(artifactPath, { start: earlyRangeParse.start, end: earlyRangeParse.end });
                    }
                    reply.header('content-length', earlySize);
                    void reply.code(200);
                    if (earlyIsHead)
                        return;
                    return createReadStream(artifactPath);
                }
            }
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
                        const isH264 = !vcodec || vcodec.includes('avc') || vcodec.includes('h264') || vcodec.includes('mp4v');
                        const isAacOrMp3 = !acodec || acodec.includes('aac') || acodec.includes('mp4a') || acodec.includes('mp3');
                        const needsTranscode = !isH264 || !isAacOrMp3;
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
                            outputContentType: 'video/mp4',
                        });
                        broadcastLog('STREAM', 'FFMPEG_STARTED', `Spawning FFmpeg ${needsTranscode ? 'transcoder' : 'remuxer'} for ${format.height ?? 480}p MP4 playback`, {
                            resolveId,
                            itemId,
                            formatId,
                            strategy: needsTranscode ? 'TRANSCODE' : 'REMUX',
                            videoCodec: vcodec || 'h264',
                        });
                        // ── Unified artifact: materialize to seekable MP4, not pipe ──
                        const existingIg = await stat(artifactPath).catch(() => null);
                        if (!isPlaybackArtifactFresh(existingIg)) {
                            const keyIg = playbackCacheKey(resolveId, itemId, formatId);
                            if (!playbackInFlight.has(keyIg)) {
                                const pIg = (async () => {
                                    await ffmpegRemuxUrlsToFile(videoUrl, audioUrl, artifactPath, needsTranscode);
                                })();
                                playbackInFlight.set(keyIg, pIg);
                                pIg.catch(async () => { await unlinkAsync(artifactPath).catch(() => { }); await unlinkAsync(`${artifactPath}.incomplete`).catch(() => { }); });
                                pIg.finally(() => playbackInFlight.delete(keyIg));
                                try {
                                    await pIg;
                                    artifactGenerationMs = Date.now() - genStartTime;
                                }
                                catch (e) {
                                    throw e;
                                }
                            }
                            else {
                                await playbackInFlight.get(keyIg);
                                artifactCacheHit = true;
                                artifactStatus = 'WAIT_HIT';
                                artifactGenerationMs = Date.now() - genStartTime;
                            }
                        }
                        else {
                            artifactCacheHit = true;
                            artifactStatus = 'HIT';
                            artifactGenerationMs = 0;
                        }
                        // Serve via unified Range (HEAD supported, 206/416, Accept-Ranges bytes)
                        const rangeHeaderIg = initialRangeHeader ?? request.headers.range;
                        const isHeadIg = request.method === 'HEAD';
                        const statIg = await stat(artifactPath).catch(() => null);
                        if (!statIg)
                            throw appErrors.temporaryProviderError('Playback artifact missing after remux');
                        const sizeIg = statIg.size;
                        const rangeIg = (() => {
                            if (!rangeHeaderIg || !rangeHeaderIg.startsWith('bytes='))
                                return { isRange: false, valid: true, start: 0, end: sizeIg - 1 };
                            const m = /bytes=(\d*)-(\d*)/.exec(rangeHeaderIg);
                            if (!m)
                                return { isRange: true, valid: false, start: 0, end: 0 };
                            const s = m[1] ? parseInt(m[1], 10) : 0;
                            const e = m[2] ? parseInt(m[2], 10) : sizeIg - 1;
                            if (Number.isNaN(s) || Number.isNaN(e) || s >= sizeIg || e >= sizeIg || s > e)
                                return { isRange: true, valid: false, start: s, end: e };
                            return { isRange: true, valid: true, start: s, end: e };
                        })();
                        log.info('[Stream] playback artifact serve', { platform: record.platform, resolveId, itemId, formatId, range: rangeHeaderIg ?? 'none', artifactStatus, generationMs: artifactGenerationMs, cacheHit: artifactCacheHit, size: sizeIg, httpStatus: !rangeIg.isRange ? 200 : !rangeIg.valid ? 416 : 206, contentType: 'video/mp4', contentLength: rangeIg.isRange && rangeIg.valid ? (rangeIg.end - rangeIg.start + 1) : sizeIg, contentRange: rangeIg.isRange && rangeIg.valid ? `bytes ${rangeIg.start}-${rangeIg.end}/${sizeIg}` : 'none', firstByteMs: artifactGenerationMs, disconnectState: clientDisconnected, strategy: needsTranscode ? 'TRANSCODE' : 'REMUX' });
                        reply.header('content-type', 'video/mp4');
                        reply.header('accept-ranges', 'bytes');
                        reply.header('content-disposition', 'inline');
                        reply.header('cache-control', 'private, no-store');
                        reply.header('access-control-expose-headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type, Content-Disposition');
                        if (rangeIg.isRange && !rangeIg.valid) {
                            reply.header('content-range', `bytes */${sizeIg}`);
                            void reply.code(416);
                            if (isHeadIg)
                                return;
                            return;
                        }
                        if (rangeIg.isRange && rangeIg.valid) {
                            const chunkSize = rangeIg.end - rangeIg.start + 1;
                            reply.header('content-range', `bytes ${rangeIg.start}-${rangeIg.end}/${sizeIg}`);
                            reply.header('content-length', chunkSize);
                            void reply.code(206);
                            if (isHeadIg)
                                return;
                            return createReadStream(artifactPath, { start: rangeIg.start, end: rangeIg.end });
                        }
                        reply.header('content-length', sizeIg);
                        void reply.code(200);
                        if (isHeadIg)
                            return;
                        return createReadStream(artifactPath);
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