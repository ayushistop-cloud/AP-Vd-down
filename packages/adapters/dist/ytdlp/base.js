import { readFileSync, statSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { appErrors, assertPublicHttpUrl, buildFileName, canonicalizeUrl, createLogger, detectPlatform, genericQualityLadder, heightToLabel, MAX_QUALITY_HEIGHT, toAppError, } from '@3ap/shared';
import { detectJsRuntime, findFfmpegBinary, requireBinary, resolveYtDlpEngine, runYtDlp, YtDlpError } from './binary.js';
import { buildDisplayFormats, normalizeYtDlpFormats } from './formats.js';
/**
 * Sanitizes stderr text to ensure tokens, signatures, and cookies are never logged.
 */
export function sanitizeStderr(stderr) {
    if (!stderr || typeof stderr !== 'string')
        return '';
    return stderr
        .replace(/(n=|sig=|token=|po_token=|lsig=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/--cookies\s+[^\s]+/gi, '--cookies [REDACTED]')
        .replace(/Cookie:\s*[^\r\n]+/gi, 'Cookie: [REDACTED]')
        .slice(-1500);
}
/**
 * Validates whether a file path exists, is a readable file, non-empty, and has a valid Netscape HTTP Cookie format structure.
 * Never logs cookie contents or sensitive secrets.
 */
export function isValidNetscapeCookieFile(filePath) {
    if (!filePath || typeof filePath !== 'string')
        return false;
    try {
        const stats = statSync(filePath);
        if (!stats.isFile() || stats.size === 0) {
            return false;
        }
        // Prevent reading arbitrarily huge non-cookie files (10MB limit)
        if (stats.size > 10 * 1024 * 1024) {
            return false;
        }
        const content = readFileSync(filePath, 'utf8');
        const trimmed = content.trim();
        if (!trimmed)
            return false;
        const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length === 0)
            return false;
        // Check 1: Standard Netscape cookie header comment
        const hasHeader = lines.some((line) => /^#\s*(Netscape HTTP Cookie File|HTTP Cookie File|curl cookie file)/i.test(line));
        // Check 2: Valid tab-separated cookie line (domain \t flag \t path \t secure \t expiration \t name \t value)
        const hasValidCookieLine = lines.some((line) => {
            if (line.startsWith('#'))
                return false;
            const fields = line.split('\t');
            if (fields.length >= 6) {
                const flag = fields[1]?.trim().toUpperCase();
                const secure = fields[3]?.trim().toUpperCase();
                if ((flag === 'TRUE' || flag === 'FALSE') && (secure === 'TRUE' || secure === 'FALSE')) {
                    return true;
                }
                if (fields.length >= 7)
                    return true;
            }
            return false;
        });
        return hasHeader || hasValidCookieLine;
    }
    catch {
        return false;
    }
}
/**
 * Resolves a valid Netscape cookie file path from env vars or standard Render secret location.
 * Returns undefined if missing, empty, malformed, or unreadable.
 */
export function getValidCookiesPath() {
    const envCandidates = [
        process.env.YTDLP_COOKIES_PATH,
        process.env.COOKIES_PATH,
        process.env.YTDLP_COOKIES,
        process.env.COOKIES_FILE,
    ];
    for (const cand of envCandidates) {
        if (cand && cand.trim()) {
            const trimmed = cand.trim();
            if (isValidNetscapeCookieFile(trimmed)) {
                return trimmed;
            }
            engineLog.warn('Configured cookie file path is missing, unreadable, empty, or not valid Netscape format; ignoring cookies', {
                cookiePathConfigured: true,
            });
        }
    }
    const renderSecretsPath = '/etc/secrets/cookies.txt';
    if (isValidNetscapeCookieFile(renderSecretsPath)) {
        return renderSecretsPath;
    }
    return undefined;
}
function getCookiesArgs() {
    const validPath = getValidCookiesPath();
    if (validPath) {
        return ['--cookies', validPath];
    }
    return [];
}
const DEFAULT_SELECTOR = `bv*[height<=${MAX_QUALITY_HEIGHT}]+ba/b[height<=${MAX_QUALITY_HEIGHT}]/bv*+ba/b`;
const engineLog = createLogger({ service: 'yt-dlp', level: 'error' });
export class YtDlpBaseAdapter {
    options;
    constructor(options) {
        this.options = options;
    }
    getCapabilities() {
        return this.options.capabilities;
    }
    canHandle(url) {
        return detectPlatform(url) === this.platform;
    }
    normalizeError(error) {
        if (error instanceof YtDlpError)
            return classifyYtDlpStderr(error.stderrTail, error.timedOut);
        return toAppError(error);
    }
    getExtractionStrategies() {
        return [{ name: 'default', args: [] }];
    }
    async resolve(rawUrl) {
        const canonicalUrl = canonicalizeUrl(assertPublicHttpUrl(rawUrl).toString());
        if (!this.canHandle(canonicalUrl))
            throw appErrors.unsupported();
        const parsed = new URL(canonicalUrl);
        const wantsPlaylist = parsed.pathname.replace(/\/+$/, '').endsWith('/playlist') ||
            (parsed.searchParams.has('list') && !parsed.searchParams.has('v'));
        if (wantsPlaylist && this.options.capabilities.supportsPlaylists) {
            return this.resolvePlaylist(canonicalUrl);
        }
        if (wantsPlaylist && !this.options.capabilities.supportsPlaylists) {
            throw appErrors.unsupported('Playlists are not supported for this platform.');
        }
        return this.resolveSingleOrCollection(canonicalUrl);
    }
    async resolvePlaylist(canonicalUrl) {
        // Fetch one extra entry so overflow beyond the cap is detected exactly.
        const json = await this.dumpJson(canonicalUrl, ['--flat-playlist', '--yes-playlist', '--playlist-items', `1-${CONST_PLAYLIST_CAP + 1}`]);
        const entries = json.entries ?? [];
        if (entries.length > CONST_PLAYLIST_CAP) {
            throw appErrors.playlistLimit();
        }
        if (entries.length === 0) {
            throw appErrors.unsupported('No public items were found in this playlist.');
        }
        const items = entries.map((entry, index) => ({
            id: `item-${index + 1}`,
            title: entry.title ?? `Item ${index + 1}`,
            sourceUrl: entry.webpage_url ?? entry.url ?? canonicalUrl,
            durationSeconds: entry.duration ? Math.round(entry.duration) : undefined,
            thumbnailUrl: pickThumbnail(entry),
            formats: genericQualityLadder(MAX_QUALITY_HEIGHT),
        }));
        return {
            platform: this.platform,
            canonicalUrl,
            title: json.title,
            creator: json.uploader ?? json.channel,
            thumbnailUrl: pickThumbnail(json),
            kind: 'playlist',
            items,
            capabilities: this.options.capabilities,
        };
    }
    async resolveSingleOrCollection(canonicalUrl) {
        // --yes-playlist expands Instagram carousels into collections while
        // leaving ordinary singles untouched.
        const extra = this.platform === 'instagram' ? ['--yes-playlist'] : ['--no-playlist'];
        const json = await this.dumpJson(canonicalUrl, extra);
        if (json._type === 'playlist' && Array.isArray(json.entries) && json.entries.length > 0) {
            const items = json.entries.map((entry, index) => ({
                id: `item-${index + 1}`,
                title: entry.title ?? `${this.platform} media ${index + 1}`,
                sourceUrl: entry.webpage_url ?? entry.url ?? canonicalUrl,
                durationSeconds: entry.duration ? Math.round(entry.duration) : undefined,
                thumbnailUrl: pickThumbnail(entry),
                formats: buildDisplayFormats(normalizeYtDlpFormats(entry.formats ?? [], MAX_QUALITY_HEIGHT), MAX_QUALITY_HEIGHT),
            }));
            return {
                platform: this.platform,
                canonicalUrl,
                title: json.title,
                creator: json.uploader ?? json.channel,
                thumbnailUrl: pickThumbnail(json.entries[0] ?? {}),
                kind: 'collection',
                items,
                capabilities: this.options.capabilities,
            };
        }
        const normalized = normalizeYtDlpFormats(json.formats ?? [], MAX_QUALITY_HEIGHT);
        if (normalized.formats.length === 0 && !normalized.bestAudio) {
            throw appErrors.unsupported('No downloadable media formats are exposed for this link.');
        }
        return {
            platform: this.platform,
            canonicalUrl,
            title: json.title,
            creator: json.uploader ?? json.channel,
            thumbnailUrl: pickThumbnail(json),
            durationSeconds: json.duration ? Math.round(json.duration) : undefined,
            kind: 'single',
            items: [
                {
                    id: 'main',
                    title: json.title ?? 'Media',
                    sourceUrl: json.webpage_url ?? canonicalUrl,
                    durationSeconds: json.duration ? Math.round(json.duration) : undefined,
                    thumbnailUrl: pickThumbnail(json),
                    formats: buildDisplayFormats(normalized, MAX_QUALITY_HEIGHT),
                },
            ],
            capabilities: this.options.capabilities,
        };
    }
    getPlatformExtraArgs() {
        const extra = [];
        const jsRuntime = detectJsRuntime();
        if (jsRuntime.available) {
            extra.push('--js-runtimes', 'node');
        }
        return extra;
    }
    async dumpJson(url, extraArgs, timeoutMs = 45_000) {
        assertPublicHttpUrl(url);
        const engine = await resolveYtDlpEngine({ ...process.env, ...(process.env.YT_DLP_PATH ? { YT_DLP_PATH: process.env.YT_DLP_PATH } : {}) });
        const binary = engine.path;
        const version = engine.version;
        const jsRuntime = engine.jsRuntime;
        const hostname = new URL(url).hostname;
        const cookiePath = getValidCookiesPath();
        const platformArgs = this.getPlatformExtraArgs();
        const strategies = this.getExtractionStrategies();
        let stdout = '';
        let stderrTail = '';
        let durationMs = 0;
        let lastError = null;
        for (let i = 0; i < strategies.length; i++) {
            const strategy = strategies[i];
            const strategyArgs = [...strategy.args];
            engineLog.info('yt-dlp metadata extraction attempt', {
                event: 'yt_dlp_diagnostics',
                platform: this.platform,
                binaryPath: binary,
                ytDlpVersion: version,
                source: engine.source,
                jsRuntimeAvailable: jsRuntime.available,
                jsRuntimeName: jsRuntime.name,
                strategyName: strategy.name,
                strategyIndex: i + 1,
                totalStrategies: strategies.length,
                cookiesState: cookiePath ? 'enabled' : 'disabled',
                hostname,
            });
            const executeSingleStrategy = async (argsToRun, allowCookieRetry) => {
                try {
                    return await runYtDlp(binary, argsToRun, { timeoutMs });
                }
                catch (err) {
                    if (err instanceof YtDlpError) {
                        stderrTail = err.stderrTail;
                        const isCookieErr = /does not look like a netscape format cookies file|invalid cookies? file|error loading cookies/i.test(err.stderrTail);
                        if (isCookieErr && allowCookieRetry && argsToRun.includes('--cookies')) {
                            engineLog.warn('yt-dlp rejected server cookies configuration; retrying current strategy without cookies', {
                                platform: this.platform,
                                strategyName: strategy.name,
                                hostname,
                            });
                            const argsNoCookies = argsToRun.filter((arg, idx) => arg !== '--cookies' && argsToRun[idx - 1] !== '--cookies');
                            return executeSingleStrategy(argsNoCookies, false);
                        }
                    }
                    throw err;
                }
            };
            try {
                const cookieArgs = getCookiesArgs();
                const fullArgs = [
                    '--dump-single-json',
                    '--no-warnings',
                    '--socket-timeout',
                    '20',
                    ...platformArgs,
                    ...strategyArgs,
                    ...cookieArgs,
                    ...extraArgs,
                    url,
                ];
                const res = await executeSingleStrategy(fullArgs, true);
                stdout = res.stdout;
                durationMs = res.durationMs;
                engineLog.info('yt-dlp metadata extraction succeeded', {
                    event: 'yt_dlp_success',
                    platform: this.platform,
                    binaryPath: binary,
                    ytDlpVersion: version,
                    strategyName: strategy.name,
                    durationMs,
                    hostname,
                });
                break;
            }
            catch (err) {
                if (err instanceof YtDlpError) {
                    const classified = classifyYtDlpStderr(err.stderrTail, err.timedOut);
                    lastError = classified;
                    const sanitizedStderr = sanitizeStderr(err.stderrTail);
                    engineLog.warn('yt-dlp metadata extraction strategy failed', {
                        event: 'youtube_strategy_failed',
                        platform: this.platform,
                        strategy: strategy.name,
                        strategyName: strategy.name,
                        strategyIndex: i + 1,
                        totalStrategies: strategies.length,
                        binaryPath: binary,
                        ytDlpVersion: version,
                        exitCode: err.exitCode ?? 1,
                        failureStage: 'metadata',
                        sanitizedStderr,
                        cookiesState: cookiePath ? 'enabled' : 'disabled',
                        classification: classified.code,
                        hostname,
                    });
                    if (classified.code === 'INVALID_URL' || classified.code === 'UNSUPPORTED' || classified.code === 'NOT_PUBLIC') {
                        throw classified;
                    }
                }
                else {
                    throw toAppError(err);
                }
            }
        }
        if (!stdout && lastError) {
            engineLog.error('All yt-dlp extraction strategies failed', {
                event: 'yt_dlp_all_strategies_failed',
                platform: this.platform,
                binaryPath: binary,
                ytDlpVersion: version,
                totalStrategiesAttempted: strategies.length,
                finalClassification: lastError.code,
                lastSanitizedStderr: sanitizeStderr(stderrTail),
                hostname,
            });
            throw lastError;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            engineLog.error('yt-dlp returned empty metadata stdout', {
                event: 'yt_dlp_empty_stdout',
                platform: this.platform,
                hostname,
                stderrTail: stderrTail.slice(-2000),
                classification: 'ENGINE_OUTPUT_EMPTY',
            });
            throw appErrors.engineOutputEmpty('The media metadata could not be extracted from the platform.');
        }
        let parsedJson = null;
        let parseErrorMsg = '';
        // Pass 1: Direct JSON parse
        try {
            parsedJson = JSON.parse(trimmed);
        }
        catch (e1) {
            parseErrorMsg = e1.message;
        }
        // Pass 2: Extract between first '{' and last '}'
        if (!parsedJson) {
            try {
                const firstBrace = trimmed.indexOf('{');
                const lastBrace = trimmed.lastIndexOf('}');
                if (firstBrace >= 0 && lastBrace > firstBrace) {
                    const jsonStr = trimmed.slice(firstBrace, lastBrace + 1);
                    parsedJson = JSON.parse(jsonStr);
                }
            }
            catch (e2) {
                parseErrorMsg = e2.message;
            }
        }
        // Pass 3: Line-by-line NDJSON fallback
        if (!parsedJson) {
            const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            for (const line of lines) {
                if (line.startsWith('{') && line.endsWith('}')) {
                    try {
                        const candidate = JSON.parse(line);
                        if (candidate && (candidate._type || candidate.id || candidate.title || candidate.formats)) {
                            parsedJson = candidate;
                            break;
                        }
                    }
                    catch {
                        /* ignore line parse errors */
                    }
                }
            }
        }
        if (!parsedJson || typeof parsedJson !== 'object') {
            engineLog.error('yt-dlp JSON parse failure', {
                event: 'yt_dlp_json_parse_failed',
                platform: this.platform,
                hostname,
                stdoutLength: stdout.length,
                durationMs,
                stdoutSnippet: stdout.slice(0, 500),
                message: parseErrorMsg,
                classification: 'ENGINE_OUTPUT_INVALID',
            });
            throw appErrors.engineOutputInvalid('Failed to parse media metadata response from provider.');
        }
        return parsedJson;
    }
    /* ── download task ─────────────────────────────────────────────────────── */
    async createDownloadTask(request, ctx) {
        const binary = await requireBinary(process.env.YT_DLP_PATH, ctx.log);
        assertPublicHttpUrl(request.sourceUrl);
        const selection = selectSelector(request);
        const platformArgs = this.getPlatformExtraArgs();
        const strategies = this.getExtractionStrategies();
        const absWorkDir = resolve(ctx.workDir);
        let downloaded = false;
        let lastError = null;
        let lastEmit = 0;
        let stage = 'connecting';
        const onLine = (line) => {
            const percentMatch = /\[download\]\s+(\d{1,3}(?:\.\d+)?)%/.exec(line);
            if (percentMatch) {
                stage = 'downloading';
                const percent = Number.parseFloat(percentMatch[1]);
                const now = Date.now();
                if (now - lastEmit > 400 || percent >= 100) {
                    lastEmit = now;
                    void ctx.onProgress({ stage, percent });
                }
                return;
            }
            if (/^\[(Merger|ExtractAudio|Fixup|VideoRemuxer|Metadata)/i.test(line)) {
                if (stage !== 'processing') {
                    stage = 'processing';
                    void ctx.onProgress({ stage: 'processing' });
                }
            }
        };
        for (let i = 0; i < strategies.length; i++) {
            const strategy = strategies[i];
            const strategyArgs = [...strategy.args];
            const fullArgs = [...buildBaseArgs(request.maxFileSizeBytes), ...platformArgs, ...strategyArgs];
            if (selection.audioOnly) {
                fullArgs.push('--format', selection.selector ?? 'bestaudio[ext=m4a]/bestaudio');
                const ffmpeg = await findFfmpegBinary(process.env.FFMPEG_PATH);
                if (ffmpeg) {
                    fullArgs.push('--ffmpeg-location', ffmpeg, '-x', '--audio-format', 'mp3', '--audio-quality', '0');
                }
            }
            else {
                fullArgs.push('--format', selection.selector ?? DEFAULT_SELECTOR);
            }
            fullArgs.push('--output', join(absWorkDir, '%(id)s.%(ext)s'));
            fullArgs.push(request.sourceUrl);
            const executeSingleDownload = async (argsToRun, allowCookieRetry) => {
                try {
                    await runYtDlp(binary, argsToRun, {
                        timeoutMs: 15 * 60 * 1000,
                        abort: ctx.signal,
                        cwd: absWorkDir,
                        onStdoutLine: onLine,
                        onStderrLine: (line) => ctx.log.debug('yt-dlp stderr', { line: line.trim().slice(0, 300) }),
                    });
                }
                catch (err) {
                    if (err instanceof YtDlpError) {
                        const isCookieErr = /does not look like a netscape format cookies file|invalid cookies? file|error loading cookies/i.test(err.stderrTail);
                        if (isCookieErr && allowCookieRetry && argsToRun.includes('--cookies')) {
                            ctx.log.warn('yt-dlp rejected cookie file during download; retrying current strategy without cookies');
                            const argsNoCookies = argsToRun.filter((arg, idx) => arg !== '--cookies' && argsToRun[idx - 1] !== '--cookies');
                            return executeSingleDownload(argsNoCookies, false);
                        }
                    }
                    throw err;
                }
            };
            try {
                await executeSingleDownload(fullArgs, true);
                downloaded = true;
                break;
            }
            catch (err) {
                if (err instanceof YtDlpError) {
                    const classified = classifyYtDlpStderr(err.stderrTail, err.timedOut);
                    lastError = classified;
                    ctx.log.warn('yt-dlp download strategy failed', {
                        platform: this.platform,
                        strategyName: strategy.name,
                        strategyIndex: i + 1,
                        totalStrategies: strategies.length,
                        classification: classified.code,
                    });
                    if (classified.code === 'INVALID_URL' || classified.code === 'UNSUPPORTED' || classified.code === 'NOT_PUBLIC') {
                        throw classified;
                    }
                }
                else {
                    throw toAppError(err);
                }
            }
        }
        if (!downloaded && lastError) {
            throw lastError;
        }
        const produced = await collectProducedFile(ctx.workDir);
        if (!produced) {
            throw appErrors.processingFailed('The media could not be retrieved from the platform.');
        }
        if (produced.sizeBytes > request.maxFileSizeBytes) {
            await rm(produced.filePath, { force: true }).catch(() => undefined);
            throw appErrors.tooLarge();
        }
        void ctx.onProgress({ stage: 'finalizing', percent: 100 });
        const label = selection.audioOnly ? 'Audio' : selection.height ? heightToLabel(selection.height) : undefined;
        const fileName = buildFileName({
            platform: this.platform,
            title: request.itemTitle ?? 'media',
            creator: request.creator,
            heightOrLabel: label,
            container: produced.container,
        });
        return { filePath: produced.filePath, fileName, sizeBytes: produced.sizeBytes, isAudio: selection.audioOnly };
    }
}
const CONST_PLAYLIST_CAP = 50;
/* ── helpers ─────────────────────────────────────────────────────────────── */
function pickThumbnail(info) {
    if (info.thumbnail)
        return info.thumbnail;
    const thumbs = (info.thumbnails ?? []).filter((t) => typeof t.url === 'string');
    if (thumbs.length === 0)
        return undefined;
    return thumbs.reduce((best, t) => (t.width ?? 0) * (t.height ?? 0) >= (best.width ?? 0) * (best.height ?? 0) ? t : best).url;
}
/** Map the requested formatId onto a concrete yt-dlp format selector. */
export function selectSelector(request) {
    const formatId = request.formatId;
    if (!formatId || formatId === 'best') {
        return { selector: DEFAULT_SELECTOR, audioOnly: false };
    }
    const ladderMatch = /^best<=(\d+)$/.exec(formatId);
    if (ladderMatch) {
        const h = Number.parseInt(ladderMatch[1], 10);
        return { selector: `bv*[height<=${h}]+ba/b[height<=${h}]/b`, audioOnly: false, height: h };
    }
    if (formatId === 'audio') {
        return { audioOnly: true };
    }
    if (formatId.startsWith('a:')) {
        return { selector: formatId.slice(2), audioOnly: true };
    }
    if (formatId.startsWith('f:') || formatId.startsWith('v:')) {
        const rawId = formatId.slice(2);
        const format = request.formats?.find((f) => f.formatId === formatId);
        // Adaptive video-only renditions need audio merged by yt-dlp.
        const adaptive = format?.kind === 'video';
        return { selector: adaptive ? `${rawId}+ba/${rawId}` : rawId, audioOnly: false, height: format?.height };
    }
    return { selector: DEFAULT_SELECTOR, audioOnly: false };
}
function buildBaseArgs(maxFileSizeBytes) {
    const cookieArgs = getCookiesArgs();
    return [
        '--no-warnings',
        '--newline',
        '--no-mtime',
        '--no-playlist',
        '--socket-timeout',
        '25',
        '--retries',
        '3',
        '--fragment-retries',
        '3',
        '--concurrent-fragments',
        '4',
        '--max-filesize',
        String(maxFileSizeBytes),
        ...cookieArgs,
    ];
}
async function collectProducedFile(workDir) {
    let names;
    try {
        names = await readdir(workDir);
    }
    catch {
        return null;
    }
    const candidates = [];
    for (const name of names) {
        if (/\.part$|\.ytdl$|\.temp$|\.json$|\.meta$/i.test(name))
            continue;
        const full = join(workDir, name);
        const info = await stat(full).catch(() => null);
        if (info?.isFile() && info.size > 0)
            candidates.push({ name, path: full, size: info.size });
    }
    if (candidates.length === 0)
        return null;
    candidates.sort((a, b) => b.size - a.size);
    const winner = candidates[0];
    return {
        filePath: winner.path,
        sizeBytes: winner.size,
        container: (winner.name.split('.').pop() ?? 'mp4').toLowerCase(),
    };
}
export function classifyYtDlpStderr(stderrTail, timedOut) {
    const text = stderrTail.toLowerCase();
    if (timedOut)
        return appErrors.temporaryProviderError('Processing took too long and was stopped.');
    // Cookie configuration error classification
    if (/does not look like a netscape format cookies file|invalid cookies? file|error loading cookies/i.test(text)) {
        return appErrors.temporaryProviderError('Media service encountered an invalid server cookies configuration. Please retry.');
    }
    // 1. Genuine private / login-gated content / auth required
    if (/\bprivate video\b|\bmembers-only\b|\bjoin this channel to get access\b|\bthis video is private\b|\baccount is private\b|\bthis content is private\b/i.test(text)) {
        return appErrors.notPublic();
    }
    if (/\bsign in to confirm your identity\b|\blogin required\b|\bauthentication required\b/i.test(text)) {
        return appErrors.youtubeAuthRequired();
    }
    // 2. Explicit YouTube Bot / Verification / Challenge / Age check / PO Token
    // Note: n-sig decipher failures are NOT bot verification! They are format extraction decipher errors.
    if (/sign in to confirm you['’]?re not a bot|confirm you['’]?re not a bot|confirm your age|\bpo_token\b|\bpo token\b|bot detection|bot verification|captcha/i.test(text)) {
        return appErrors.platformVerification('YouTube currently requires provider verification. Please try again later or supply valid cookies.');
    }
    // 3. YouTube Format Access / Decipher / nsig failure
    if (/n-sig extraction failed|nsig extraction failed|signature extraction failed|unable to extract player|player_url|could not extract js/i.test(text)) {
        return appErrors.youtubeFormatAccessFailed('YouTube format deciphering failed. Please try again shortly or with another video.');
    }
    // 4. YouTube Metadata Access failure
    if (/unable to extract video data|unable to download video info|unable to extract title/i.test(text)) {
        return appErrors.youtubeMetadataAccessFailed();
    }
    // 5. HTTP 403 Forbidden
    if (/http error 403|403 forbidden/i.test(text)) {
        return appErrors.temporaryProviderError('The platform temporarily restricted access (HTTP 403). Please try again shortly.');
    }
    // 6. Rate limiting (HTTP 429)
    if (/http error 429|too many requests|rate.?limit/i.test(text)) {
        return appErrors.rateLimited('Too many requests. Please wait a moment and try again.');
    }
    // 7. Video unavailable / removed
    if (/video unavailable|removed by the uploader|has been terminated|does not exist|this video has been removed/i.test(text)) {
        return appErrors.unsupported('This content is no longer available at the platform.');
    }
    // 8. Region / Geo Restricted
    if (/geo-?restrict|not available in your country/i.test(text)) {
        return appErrors.notPublic('This content is region-restricted and not available from this service.');
    }
    // 9. Invalid URL or format missing
    if (/unsupported url|not a valid url|no video formats|no media formats/i.test(text)) {
        return appErrors.unsupported();
    }
    // 10. Size limit exceeded
    if (/file is larger than|max-filesize/i.test(text)) {
        return appErrors.tooLarge();
    }
    // 11. Upstream server / network / DNS / TLS error
    if (/temporary failure|http error 5\d\d|unable to download webpage|connection reset|timed out|could not resolve host|getaddrinfo|tls handshake|socket error/i.test(text)) {
        return appErrors.networkError('The media provider could not be reached. Please try again.');
    }
    // 12. YouTube Extractor specific errors
    if (/\[youtube\]/i.test(text) || /youtube/i.test(text)) {
        return appErrors.youtubeExtractorError('YouTube media could not be resolved right now. Please try another public video.');
    }
    // 13. Generic Engine Error fallback (503 retryable, NOT 500)
    return appErrors.engineError('The media service is temporarily unavailable.');
}
//# sourceMappingURL=base.js.map