import { basename } from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { appErrors, assertPublicHttpUrl, guardedFetch, sanitizeFilename, toAppError, TERABOX_DOMAINS, } from '@3ap/shared';
import { guardedDownloadToFile } from './http-download.js';
/**
 * Terabox adapter (docs/19-TERABOX-SPEC.md) — public share links only.
 *
 * Genuine HTTP client implementation of the public share flow:
 *   share page → shorturlinfo/share/list APIs → per-file dlink download.
 * No user credentials are ever requested or stored. Provider endpoints are
 * undocumented and change without notice: every failure normalizes to a
 * stable error code and the adapter fails closed.
 *
 * Resource-exhaustion limits (docs/19): max 20 files, max recursion depth 2,
 * total size enforced by MAX_FILE_SIZE at task level and per-item here.
 */
const APP_ID = '250528';
const MAX_FILES = 20;
const MAX_DEPTH = 2;
function parseSize(value) {
    const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : NaN;
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}
export function normalizeTeraboxShortKey(raw) {
    if (!raw)
        return raw;
    return raw.startsWith('1') ? raw : `1${raw}`;
}
export class TeraboxAdapter {
    platform = 'terabox';
    getCapabilities() {
        return { supportsAudioOnly: false, supportsQualitySelection: false, supportsPlaylists: false };
    }
    canHandle(url) {
        try {
            const u = new URL(url);
            if (u.protocol !== 'https:' && u.protocol !== 'http:')
                return false;
            const hostname = u.hostname.toLowerCase().replace(/^www\./, '');
            return TERABOX_DOMAINS.includes(hostname) || TERABOX_DOMAINS.some((d) => hostname.endsWith('.' + d));
        }
        catch {
            return false;
        }
    }
    normalizeError(error) {
        return toAppError(error);
    }
    async resolve(rawUrl) {
        assertPublicHttpUrl(rawUrl);
        if (!this.canHandle(rawUrl))
            throw appErrors.unsupported();
        // 1) Fetch the share page (follows short-link redirects), capture cookies + jsToken.
        const page = await guardedFetch(rawUrl, {
            timeoutMs: 20_000,
            maxBytes: 3 * 1024 * 1024,
            headers: {
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
            }
        });
        const finalUrl = new URL(page.finalUrl);
        let shortKey = finalUrl.searchParams.get('surl') ?? '';
        if (!shortKey) {
            const match = /\/s\/(1[\w-]+)/i.exec(finalUrl.pathname) || /\/s\/([\w-]+)/i.exec(finalUrl.pathname) || finalUrl.pathname.split('/').filter(Boolean).pop();
            shortKey = typeof match === 'string' ? match : (match?.[1] ?? '');
        }
        if (!shortKey || !/^[\w-]{4,60}$/.test(shortKey)) {
            throw appErrors.invalidUrl('This Terabox link does not contain a recognizable share key.');
        }
        // Provider shorturlinfo expects the full key with leading '1' (e.g. /s/1X -> API shorturl=1X).
        // Redirects strip the leading '1' into ?surl=X, so we must reconstruct it.
        const originalSurl = shortKey;
        if (!shortKey.startsWith('1')) {
            shortKey = `1${shortKey}`;
        }
        // Preserve diagnostics: original host vs redirect host vs normalized surl
        const diagInputHost = (() => { try {
            return new URL(rawUrl).hostname;
        }
        catch {
            return '(unparseable)';
        } })();
        const cookieHeader = page.setCookies
            .map((c) => c.split(';')[0] ?? '')
            .filter(Boolean)
            .join('; ');
        const html = page.body.toString('utf8');
        let jsToken = /jsToken['"]?\s*[:=]\s*['"]([^"']{8,})/.exec(html)?.[1];
        if (!jsToken) {
            const evalMatch = /eval\s*\(\s*decodeURIComponent\s*\(\s*['"`]([^'"`]+)/i.exec(html)?.[1];
            if (evalMatch) {
                try {
                    const decoded = decodeURIComponent(evalMatch);
                    jsToken = /fn\s*\(\s*['"]([^'"]{8,})['"]\s*\)/i.exec(decoded)?.[1];
                }
                catch {
                    // ignore
                }
            }
        }
        // 2) Ask the public shorturlinfo API for share metadata + file list.
        const shorturlInfoUrl = buildApiUrl(`https://${finalUrl.hostname}/api/shorturlinfo`, {
            app_id: APP_ID,
            web: '1',
            channel: 'dubox',
            clienttype: '0',
            shorturl: shortKey,
            root: '1',
        });
        const info = await this.api(shorturlInfoUrl, cookieHeader, finalUrl.hostname);
        // ── SAFE structured diagnostics (never log cookies/jsToken/dlink/secrets) ──
        {
            const safeErrno = info.errno;
            const safeNewno = info.newno;
            const safeShowMsg = info.show_msg;
            const hasShareMeta = !!(info.shareid || info.uk || info.randsk || info.sign);
            const innerList = (info.list ?? info.data?.list);
            const listLen = Array.isArray(innerList) ? innerList.length : Array.isArray(info.list) ? info.list.length : 0;
            const hasList = listLen > 0;
            console.error(`[terabox diag] inputHost=${diagInputHost} redirectHost=${finalUrl.hostname} surlOrig=${originalSurl} surlSent=${shortKey} hostApi=${finalUrl.hostname} endpoint=shorturlinfo http=200 errno=${String(safeErrno)} newno=${String(safeNewno)} show_msg=${String(safeShowMsg ?? '').slice(0, 80)} shareMeta=${hasShareMeta} hasList=${hasList} listCount=${listLen}`);
        }
        if (Number(info.errno) !== 0)
            throw mapTeraboxErrno(Number(info.errno), info);
        let files = (info.list ?? []).map((f) => ({ ...f }));
        const shareid = info.shareid;
        const uk = info.uk;
        const sign = info.sign;
        const randsk = info.randsk;
        // Folder shares: recurse one more level (depth ≤ 2 overall).
        const hasDir = files.some((f) => String(f.isdir ?? '0') === '1');
        if (hasDir && shareid !== undefined && uk !== undefined) {
            const dirs = files.filter((f) => String(f.isdir ?? '0') === '1').slice(0, 5);
            for (const dir of dirs.slice(0, MAX_DEPTH)) {
                const listResp = await this.api(buildApiUrl(`https://${finalUrl.hostname}/api/share/list`, {
                    app_id: APP_ID,
                    web: '1',
                    channel: 'dubox',
                    clienttype: '0',
                    shorturl: shortKey,
                    shareid: String(shareid),
                    uk: String(uk),
                    sign: sign ? String(sign) : '',
                    dir: dir.path ?? '/',
                    ...(jsToken ? { jsToken } : {}),
                }), cookieHeader, finalUrl.hostname);
                if (Number(listResp.errno) === 0) {
                    files.push(...(listResp.list ?? []));
                }
            }
            files = files.filter((f) => String(f.isdir ?? '0') !== '1');
        }
        files = files.filter((f) => String(f.isdir ?? '0') !== '1').slice(0, MAX_FILES);
        if (files.length === 0)
            throw appErrors.unsupported('No downloadable files were found in this share.');
        const browseridCookie = page.setCookies
            .map((c) => c.split(';')[0] ?? '')
            .find((c) => c.toLowerCase().startsWith('browserid='))
            ?.split('=')[1] ?? '';
        const items = files.map((file, index) => {
            const name = sanitizeFilename(file.server_filename ?? file.filename ?? basename(file.path ?? `file-${index + 1}`));
            const size = parseSize(file.size);
            const detection = detectTeraboxMediaType(name, file.category);
            let sourceSelector = file.dlink ?? '';
            if (!sourceSelector && detection.playable && browseridCookie && shareid !== undefined && uk !== undefined) {
                const nowTime = Math.floor(Date.now() / 1000);
                const clienttype = '0';
                const channel = 'dubox';
                const msg = `${clienttype}${channel}${browseridCookie}${nowTime}`;
                const saltKey = 'iuuPc64E4Fhn0rTXEzrnbLph0o5qyEEa';
                const signature = crypto.createHmac('sha1', saltKey).update(msg).digest('hex');
                sourceSelector = buildApiUrl(`https://${finalUrl.hostname}/share/streaming`, {
                    uk: String(uk),
                    shareid: String(shareid),
                    type: 'M3U8_AUTO_480',
                    fid: String(file.fs_id),
                    sign: signature,
                    timestamp: String(nowTime),
                    ...(jsToken ? { jsToken } : {}),
                    esl: '1',
                    isplayer: '1',
                    ehps: '1',
                    clienttype,
                    app_id: APP_ID,
                    channel,
                    randsk: String(randsk),
                    browserid: String(browseridCookie),
                });
            }
            // Thumbnail: prefer thumbs.url3 (850) > url2 > url1 > icon
            const rawThumb = file.thumbs?.url3 || file.thumbs?.url2 || file.thumbs?.url1 || file.thumbs?.icon || undefined;
            const thumb = rawThumb ? rawThumb.replace(/&amp;/g, '&') : undefined;
            return {
                id: `item-${index + 1}`,
                title: name,
                sourceUrl: page.finalUrl,
                thumbnailUrl: thumb,
                formats: [
                    {
                        formatId: 'file',
                        kind: detection.kind,
                        playable: detection.playable,
                        mimeType: detection.mimeType,
                        container: (name.includes('.') ? name.split('.').pop() : 'bin'),
                        label: size !== undefined ? `${formatBytes(size)} — ${name}` : name,
                        estimatedSizeBytes: size,
                        sourceSelector,
                    },
                ],
            };
        });
        // Use first item's thumbnail as record-level thumbnail
        const recordThumb = items[0]?.thumbnailUrl;
        return {
            platform: this.platform,
            canonicalUrl: page.finalUrl,
            thumbnailUrl: recordThumb,
            kind: items.length > 1 ? 'collection' : 'single',
            items,
            capabilities: this.getCapabilities(),
        };
    }
    async createDownloadTask(request, ctx) {
        const format = request.formats?.[0];
        const dlink = format?.sourceSelector;
        if (!dlink)
            throw appErrors.temporaryProviderError('The provider did not expose a download link for this file.');
        assertPublicHttpUrl(dlink);
        const fileName = sanitizeFilename(request.itemTitle ?? 'terabox-file.bin', 150) || 'terabox-file.bin';
        const destPath = `${ctx.workDir}/${fileName}`.replace(/\\/g, '/');
        if (dlink.includes('/share/streaming')) {
            const page = await guardedFetch(request.sourceUrl, {
                timeoutMs: 20_000,
                maxBytes: 3 * 1024 * 1024,
                headers: {
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'accept-language': 'en-US,en;q=0.9',
                }
            });
            const finalUrl = new URL(page.finalUrl);
            let shortKey = finalUrl.searchParams.get('surl') ?? '';
            if (!shortKey) {
                const match = /\/s\/(1[\w-]+)/i.exec(finalUrl.pathname) || /\/s\/([\w-]+)/i.exec(finalUrl.pathname) || finalUrl.pathname.split('/').filter(Boolean).pop();
                shortKey = typeof match === 'string' ? match : (match?.[1] ?? '');
            }
            if (!shortKey || !/^[\w-]{4,60}$/.test(shortKey)) {
                throw appErrors.invalidUrl('This Terabox link does not contain a recognizable share key.');
            }
            if (!shortKey.startsWith('1'))
                shortKey = `1${shortKey}`;
            const cookieHeader = page.setCookies
                .map((c) => c.split(';')[0] ?? '')
                .filter(Boolean)
                .join('; ');
            const html = page.body.toString('utf8');
            let jsToken = /jsToken['"]?\s*[:=]\s*['"]([^"']{8,})/.exec(html)?.[1];
            if (!jsToken) {
                const evalMatch = /eval\s*\(\s*decodeURIComponent\s*\(\s*['"`]([^'"`]+)/i.exec(html)?.[1];
                if (evalMatch) {
                    try {
                        const decoded = decodeURIComponent(evalMatch);
                        jsToken = /fn\s*\(\s*['"]([^'"]{8,})['"]\s*\)/i.exec(decoded)?.[1];
                    }
                    catch {
                        // ignore
                    }
                }
            }
            const info = await this.api(buildApiUrl(`https://${finalUrl.hostname}/api/shorturlinfo`, {
                app_id: APP_ID,
                web: '1',
                channel: 'dubox',
                clienttype: '0',
                shorturl: shortKey,
                root: '1',
            }), cookieHeader, finalUrl.hostname);
            if (Number(info.errno) !== 0)
                throw mapTeraboxErrno(Number(info.errno), info);
            const shareid = info.shareid;
            const uk = info.uk;
            const randsk = info.randsk;
            const browseridCookie = page.setCookies
                .map((c) => c.split(';')[0] ?? '')
                .find((c) => c.toLowerCase().startsWith('browserid='))
                ?.split('=')[1] ?? '';
            const cookiesWithBoxClnd = [...page.setCookies.map((c) => c.split(';')[0]), `BOXCLND=${randsk}`].join('; ');
            const originalDlinkUrl = new URL(dlink);
            const fid = originalDlinkUrl.searchParams.get('fid') ?? '';
            if (!fid)
                throw appErrors.temporaryProviderError('The file ID was not found in the streaming URL.');
            // Gather full duration HLS segments by iterating start_ply offsets (Terabox returns 30s chunks per call)
            const segHeaders = {
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'accept': '*/*',
                'referer': `https://${finalUrl.hostname}/sharing/link?surl=${shortKey.substring(1)}`,
                'cookie': cookiesWithBoxClnd,
            };
            const clienttype = '0';
            const channel = 'dubox';
            const saltKey = 'iuuPc64E4Fhn0rTXEzrnbLph0o5qyEEa';
            const segUrls = [];
            const seenSegSet = new Set();
            let hasMoreSegs = true;
            let segAttempts = 0;
            while (hasMoreSegs && segAttempts < 1500) {
                segAttempts++;
                const loopTime = Math.floor(Date.now() / 1000);
                const loopMsg = `${clienttype}${channel}${browseridCookie}${loopTime}`;
                const loopSig = crypto.createHmac('sha1', saltKey).update(loopMsg).digest('hex');
                const streamUrl = buildApiUrl(`https://${finalUrl.hostname}/share/streaming`, {
                    uk: String(uk),
                    shareid: String(shareid),
                    type: 'M3U8_AUTO_480',
                    fid: String(fid),
                    sign: loopSig,
                    timestamp: String(loopTime),
                    ...(jsToken ? { jsToken } : {}),
                    esl: '1',
                    isplayer: '1',
                    ehps: '1',
                    clienttype,
                    app_id: APP_ID,
                    channel,
                });
                const playlistRes = await fetch(streamUrl, { headers: segHeaders });
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
                if (addedCount === 0 || text.includes('#EXT-X-ENDLIST')) {
                    hasMoreSegs = false;
                }
            }
            if (segUrls.length === 0)
                throw appErrors.temporaryProviderError('Playlist contains no segments.');
            const segDir = `${ctx.workDir}/segs-${Math.random().toString(36).slice(2, 8)}`;
            try {
                const { mkdirSync: mk } = await import('node:fs');
                mk(segDir, { recursive: true });
            }
            catch { /* ignore */ }
            const localSegs = new Array(segUrls.length);
            // Fetch segment files in controlled parallel batches (5 concurrent downloads) to avoid Terabox CDN throttling
            const sBatchSize = 5;
            for (let i = 0; i < segUrls.length; i += sBatchSize) {
                const batch = segUrls.slice(i, i + sBatchSize);
                await Promise.all(batch.map(async (segUrl, idxInBatch) => {
                    const globalIdx = i + idxInBatch;
                    const segRes = await fetch(segUrl, { headers: segHeaders });
                    if (!segRes.ok)
                        throw appErrors.temporaryProviderError(`Failed to fetch segment ${globalIdx}: ${segRes.status}`);
                    const buf = Buffer.from(await segRes.arrayBuffer());
                    if (buf.length < 100)
                        throw appErrors.temporaryProviderError('Segment too small');
                    const head = buf.slice(0, 200).toString('utf8');
                    if (head.includes('<!DOCTYPE') || head.includes('"errno"'))
                        throw appErrors.temporaryProviderError('Provider error in segment');
                    const segPath = `${segDir}/seg-${String(globalIdx).padStart(5, '0')}.ts`;
                    writeFileSync(segPath, buf);
                    localSegs[globalIdx] = segPath;
                }));
            }
            const concatPath = `${segDir}/concat.txt`;
            writeFileSync(concatPath, localSegs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
            return new Promise((resolvePromise, rejectPromise) => {
                const ffmpegArgs = [
                    '-f', 'concat', '-safe', '0',
                    '-i', concatPath,
                    '-c', 'copy',
                    '-movflags', 'faststart',
                    '-y',
                    destPath
                ];
                const proc = spawn('ffmpeg', ffmpegArgs);
                ctx.signal?.addEventListener('abort', () => {
                    proc.kill();
                });
                proc.on('close', async (code) => {
                    try {
                        // Cleanup segments and concat
                        const { rmSync: rm } = await import('node:fs');
                        rm(segDir, { recursive: true, force: true });
                    }
                    catch { /* ignore */ }
                    if (code === 0) {
                        const fInfo = await stat(destPath).catch(() => null);
                        resolvePromise({
                            filePath: destPath,
                            fileName,
                            sizeBytes: fInfo?.size ?? 0,
                            isAudio: false,
                        });
                    }
                    else {
                        rejectPromise(appErrors.temporaryProviderError(`FFmpeg failed to download stream, exit code: ${code}`));
                    }
                });
                proc.on('error', (err) => {
                    import('node:fs').then(({ rmSync: rm }) => { try {
                        rm(segDir, { recursive: true, force: true });
                    }
                    catch { /* ignore */ } }).catch(() => { });
                    rejectPromise(toAppError(err));
                });
            });
        }
        const result = await guardedDownloadToFile({
            url: dlink,
            destPath,
            maxBytes: request.maxFileSizeBytes,
            signal: ctx.signal,
            onProgress: (p) => void ctx.onProgress(p),
            headers: {
                'user-agent': 'netdisk;',
                referer: 'https://www.terabox.com/',
            },
        }).catch((err) => {
            throw err instanceof Error && err.name === 'AppError' ? err : toAppError(err);
        });
        return {
            filePath: destPath,
            fileName,
            sizeBytes: result.sizeBytes,
            isAudio: false,
        };
    }
    async api(url, cookie, hostname) {
        const response = await guardedFetch(url, {
            timeoutMs: 15_000,
            maxBytes: 8 * 1024 * 1024,
            headers: {
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'accept': 'application/json, text/plain, */*',
                'referer': `https://${hostname}/`,
                ...(cookie ? { cookie } : {}),
            },
        });
        let parsed;
        try {
            parsed = JSON.parse(response.body.toString('utf8'));
        }
        catch {
            throw appErrors.temporaryProviderError('The provider returned an unreadable response.');
        }
        return parsed;
    }
}
function buildApiUrl(base, params) {
    const u = new URL(base);
    for (const [key, value] of Object.entries(params))
        u.searchParams.set(key, value);
    return u.toString();
}
/** Map provider errno onto stable error codes; fail closed otherwise. NOT_PUBLIC only when proven. */
export function mapTeraboxErrno(errno, rawInfo) {
    const safeErrno = Number(errno);
    switch (safeErrno) {
        case 2:
        case -2:
            return appErrors.notPublic('This link is password-protected or requires an extraction code, which is not supported.');
        case -9:
        case -3:
        case -12:
            return appErrors.notPublic('This share is not publicly accessible (it may have been deleted or restricted).');
        case 105:
        case -5:
            return appErrors.unsupported('This share link is invalid or does not exist. Check the URL and try again.');
        case -20:
            return appErrors.rateLimited('The provider is rate limiting this share. Try again later.');
        case -7:
            return appErrors.unsupported('This share requires an account; anonymous access is not available.');
        case 800:
        case -6:
            // Provider verification / CAPTCHA required
            return appErrors.temporaryProviderError('The provider requires verification. Try again later or open the link in a browser first.');
        default: {
            // Unknown errno – do NOT falsely claim NOT_PUBLIC. Expose as temporary provider error
            // and log safe diagnostic for future mapping (TERABOX_RESPONSE_UNRECOGNIZED).
            console.error(`[terabox] TERABOX_RESPONSE_UNRECOGNIZED errno=${safeErrno} rawKeys=${rawInfo && typeof rawInfo === 'object' ? Object.keys(rawInfo).join(',') : 'no-info'}`);
            return appErrors.temporaryProviderError('The provider rejected this request. It may have expired or changed.');
        }
    }
}
function formatBytes(bytes) {
    if (bytes >= 1024 ** 3)
        return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2)
        return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    if (bytes >= 1024)
        return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}
export function detectTeraboxMediaType(filename, category) {
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    const videoExtensionsPlayable = {
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
        m4v: 'video/x-m4v',
    };
    const audioExtensions = {
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        aac: 'audio/aac',
        ogg: 'audio/ogg',
        wav: 'audio/wav',
        flac: 'audio/flac',
    };
    if (ext === 'mkv') {
        return {
            kind: 'video',
            playable: false,
        };
    }
    if (ext in videoExtensionsPlayable) {
        return {
            kind: 'video+audio',
            playable: true,
            mimeType: videoExtensionsPlayable[ext],
        };
    }
    if (ext in audioExtensions) {
        return {
            kind: 'audio',
            playable: true,
            mimeType: audioExtensions[ext],
        };
    }
    // Terabox categories: 1 is Video, 2 is Audio, 3 is Image, 4 is Document, 5 is App, 6 is Other.
    const catNum = typeof category === 'string' ? parseInt(category, 10) : typeof category === 'number' ? category : NaN;
    if (catNum === 1) {
        if (ext === 'mkv' || ext === 'avi' || ext === 'flv' || ext === 'wmv') {
            return {
                kind: 'video',
                playable: false,
            };
        }
        return {
            kind: 'video+audio',
            playable: true,
            mimeType: 'video/mp4',
        };
    }
    if (catNum === 2) {
        return {
            kind: 'audio',
            playable: true,
            mimeType: 'audio/mpeg',
        };
    }
    return {
        kind: 'file',
        playable: false,
    };
}
//# sourceMappingURL=terabox.js.map