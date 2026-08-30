import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { appErrors, assertPublicHttpUrl, buildFileName, canonicalizeUrl, createLogger, detectPlatform, genericQualityLadder, heightToLabel, MAX_QUALITY_HEIGHT, toAppError, } from '@3ap/shared';
import { findFfmpegBinary, requireBinary, runYtDlp, YtDlpError } from './binary.js';
import { buildDisplayFormats, normalizeYtDlpFormats } from './formats.js';
const DEFAULT_SELECTOR = `bv*[height<=${MAX_QUALITY_HEIGHT}]+ba/b[height<=${MAX_QUALITY_HEIGHT}]/bv*+ba/b`;
const engineLog = createLogger({ service: 'yt-dlp', level: 'error' });
/**
 * Shared implementation of the adapter contract for all platforms whose
 * extraction is delegated to yt-dlp. Platform subclasses declare identity
 * and capabilities; URL allowlists come from the shared pattern registry.
 */
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
    async dumpJson(url, extraArgs, timeoutMs = 45_000) {
        assertPublicHttpUrl(url);
        const binary = await requireBinary(process.env.YT_DLP_PATH, engineLog);
        try {
            const { stdout } = await runYtDlp(binary, ['--dump-single-json', '--no-warnings', '--socket-timeout', '20', ...extraArgs, url], { timeoutMs });
            return JSON.parse(stdout);
        }
        catch (err) {
            throw err instanceof YtDlpError ? classifyYtDlpStderr(err.stderrTail, err.timedOut) : toAppError(err);
        }
    }
    /* ── download task ─────────────────────────────────────────────────────── */
    async createDownloadTask(request, ctx) {
        const binary = await requireBinary(process.env.YT_DLP_PATH, ctx.log);
        assertPublicHttpUrl(request.sourceUrl);
        const selection = selectSelector(request);
        const args = buildBaseArgs(request.maxFileSizeBytes);
        if (selection.audioOnly) {
            args.push('--format', selection.selector ?? 'bestaudio[ext=m4a]/bestaudio');
            const ffmpeg = await findFfmpegBinary(process.env.FFMPEG_PATH);
            if (ffmpeg) {
                args.push('--ffmpeg-location', ffmpeg, '-x', '--audio-format', 'mp3', '--audio-quality', '0');
            }
        }
        else {
            args.push('--format', selection.selector ?? DEFAULT_SELECTOR);
        }
        // Absolute paths are mandatory here: yt-dlp resolves --output against its
        // own cwd, and mixing two relative bases silently misplaces artifacts.
        const absWorkDir = resolve(ctx.workDir);
        args.push('--output', join(absWorkDir, '%(id)s.%(ext)s'));
        args.push(request.sourceUrl);
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
        try {
            await runYtDlp(binary, args, {
                timeoutMs: 15 * 60 * 1000,
                abort: ctx.signal,
                cwd: absWorkDir,
                onStdoutLine: onLine,
                onStderrLine: (line) => ctx.log.debug('yt-dlp stderr', { line: line.trim().slice(0, 300) }),
            });
        }
        catch (err) {
            throw err instanceof YtDlpError ? classifyYtDlpStderr(err.stderrTail, err.timedOut) : toAppError(err);
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
    if (/private video|members-only|join this channel|login required|sign in to confirm|requested content is not available|authentication|account is private|this content isn't available/i.test(text)) {
        return appErrors.notPublic();
    }
    if (/http error 429|too many requests|rate.?limit/i.test(text)) {
        return appErrors.rateLimited('The platform is rate limiting downloads right now. Try again later.');
    }
    if (/video unavailable|removed by the uploader|has been terminated|does not exist/i.test(text)) {
        return appErrors.unsupported('This content is no longer available at the platform.');
    }
    if (/geo-?restrict|not available in your country/i.test(text)) {
        return appErrors.notPublic('This content is region-restricted and not available from this service.');
    }
    if (/unsupported url|not a valid url|no video formats|no media formats/i.test(text)) {
        return appErrors.unsupported();
    }
    if (/file is larger than|max-filesize/i.test(text)) {
        return appErrors.tooLarge();
    }
    if (/temporary failure|http error 5\d\d|unable to download webpage|connection reset|timed out/i.test(text)) {
        return appErrors.temporaryProviderError();
    }
    return appErrors.processingFailed();
}
//# sourceMappingURL=base.js.map