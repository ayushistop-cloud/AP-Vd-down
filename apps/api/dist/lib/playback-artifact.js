import { createReadStream } from 'node:fs';
import { stat, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const PLAYBACK_DIR = join(tmpdir(), '3ap-playback');
export const PLAYBACK_TTL_MS = 10 * 60 * 1000; // 10 minutes for playback artifacts (shorter than download TTL)
export const MAX_PLAYBACK_BYTES = 500 * 1024 * 1024;
export const playbackInFlight = new Map();
export const playbackActiveCount = new Map();
export const playbackLastTouch = new Map();
export function getPlaybackArtifactPath(resolveId, itemId, formatId) {
    const safe = `${resolveId}-${itemId}-${formatId}`.replace(/[^a-zA-Z0-9-_.]/g, '_');
    return join(PLAYBACK_DIR, `${safe}.mp4`);
}
export function playbackCacheKey(resolveId, itemId, formatId) {
    return `${resolveId}:${itemId}:${formatId}`;
}
export function isPlaybackArtifactFresh(info) {
    if (!info || info.size < 1024)
        return false;
    return Date.now() - info.mtimeMs < PLAYBACK_TTL_MS;
}
export function incrementActive(path) {
    playbackActiveCount.set(path, (playbackActiveCount.get(path) ?? 0) + 1);
    playbackLastTouch.set(path, Date.now());
}
export function decrementActive(path) {
    const cur = (playbackActiveCount.get(path) ?? 1) - 1;
    if (cur <= 0)
        playbackActiveCount.delete(path);
    else
        playbackActiveCount.set(path, cur);
    playbackLastTouch.set(path, Date.now());
}
export function parseRangeHeader(header, size) {
    if (!header || !header.startsWith('bytes='))
        return { start: 0, end: size - 1, valid: true, isRange: false };
    const m = /bytes=(\d*)-(\d*)/.exec(header);
    if (!m)
        return { start: 0, end: size - 1, valid: false, isRange: true };
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start >= size || end >= size || start > end || start < 0 || end < 0) {
        return { start, end, valid: false, isRange: true };
    }
    return { start, end, valid: true, isRange: true };
}
export async function ensurePlaybackDir() {
    await mkdir(PLAYBACK_DIR, { recursive: true }).catch(() => { });
}
export async function cleanupStalePlaybackArtifacts(log) {
    const { readdir } = await import('node:fs/promises');
    let files = [];
    try {
        files = await readdir(PLAYBACK_DIR);
    }
    catch {
        return 0;
    }
    let cleaned = 0;
    const now = Date.now();
    for (const name of files) {
        if (!name.endsWith('.mp4'))
            continue;
        const full = join(PLAYBACK_DIR, name);
        if (playbackActiveCount.get(full) ?? 0 > 0)
            continue; // never delete active
        if (playbackInFlight.has(full))
            continue;
        try {
            const info = await stat(full);
            const age = now - info.mtimeMs;
            if (age > PLAYBACK_TTL_MS || info.size < 1024) {
                await unlink(full).catch(() => { });
                playbackLastTouch.delete(full);
                cleaned++;
                log?.info?.('playback artifact expired and removed', { path: full, ageMs: age });
            }
        }
        catch { }
    }
    return cleaned;
}
// Serve helper — unified Range/HEAD/GET with required headers
export async function servePlaybackFile(request, reply, filePath, opts) {
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
        throw new Error('playback artifact missing');
    }
    const size = info.size;
    const rangeHeader = request.headers.range;
    const isHead = request.method === 'HEAD';
    const range = parseRangeHeader(rangeHeader, size);
    const contentType = opts.contentType ?? 'video/mp4';
    // Common headers
    reply.header('content-type', contentType);
    reply.header('accept-ranges', 'bytes');
    reply.header('content-disposition', 'inline');
    reply.header('cache-control', 'private, no-store');
    reply.header('access-control-expose-headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type, Content-Disposition');
    if (range.isRange && !range.valid) {
        reply.header('content-range', `bytes */${size}`);
        // Structured diagnostics for invalid range
        // Do not expose file path directly? sanitized
        void reply.code(416);
        if (isHead)
            return null;
        return { error: { code: 'INVALID_RANGE', message: 'Requested range not satisfiable' } };
    }
    if (range.isRange && range.valid) {
        const chunkSize = range.end - range.start + 1;
        reply.header('content-range', `bytes ${range.start}-${range.end}/${size}`);
        reply.header('content-length', chunkSize);
        void reply.code(206);
        if (isHead)
            return null;
        // Active stream tracking — not inside helper? Caller should increment/decrement around stream
        incrementActive(filePath);
        const stream = createReadStream(filePath, { start: range.start, end: range.end });
        // Decrement when stream closes or request disconnects
        const cleanup = () => decrementActive(filePath);
        stream.on('close', cleanup);
        stream.on('error', cleanup);
        request.raw.on('close', cleanup);
        return stream;
    }
    // Full file 200
    reply.header('content-length', size);
    void reply.code(200);
    if (isHead)
        return null;
    incrementActive(filePath);
    const stream = createReadStream(filePath);
    const cleanup = () => decrementActive(filePath);
    stream.on('close', cleanup);
    stream.on('error', cleanup);
    request.raw.on('close', cleanup);
    return stream;
}
export async function removeIncompleteArtifact(path) {
    await unlink(path).catch(() => { });
    await unlink(`${path}.incomplete`).catch(() => { });
    await unlink(`${path}.incomplete.mp4`).catch(() => { });
    await unlink(path.replace(/\.mp4$/, '.incomplete.mp4')).catch(() => { });
    await unlink(path.replace(/\.mp4$/, '.transcode.incomplete.mp4')).catch(() => { });
    playbackInFlight.delete(path);
}
//# sourceMappingURL=playback-artifact.js.map