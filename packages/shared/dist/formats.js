/** Default quality ceiling: 2K = 1440p (product decision, docs/15-YOUTUBE-SPEC.md). */
export const MAX_QUALITY_HEIGHT = 1440;
export function normalizeHeight(height) {
    if (!height)
        return undefined;
    if (height >= 1800)
        return 2160;
    if (height >= 1200)
        return 1440;
    if (height >= 900)
        return 1080;
    if (height >= 600)
        return 720;
    if (height >= 400)
        return 480;
    if (height >= 300)
        return 360;
    return 240;
}
export function heightToLabel(height) {
    if (!height)
        return 'Video';
    const norm = normalizeHeight(height);
    if (norm === 2160)
        return '2160p (4K)';
    if (norm === 1440)
        return '1440p (2K)';
    if (norm)
        return `${norm}p`;
    return `${height}p`;
}
const KIND_ORDER = {
    'video+audio': 0,
    audio: 1,
    video: 2,
    file: 3,
};
/**
 * Sort formats for display: ready-to-play (muxed) first by resolution,
 * then audio options, then adaptive-video-only last.
 */
export function sortFormatsForDisplay(formats) {
    return [...formats].sort((a, b) => {
        const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
        if (kindDiff !== 0)
            return kindDiff;
        const heightDiff = (b.height ?? 0) - (a.height ?? 0);
        if (heightDiff !== 0)
            return heightDiff;
        const fpsDiff = (b.fps ?? 0) - (a.fps ?? 0);
        if (fpsDiff !== 0)
            return fpsDiff;
        return (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0);
    });
}
/**
 * Enforce the product quality ceiling: drop video renditions above
 * maxQualityHeight. Audio-only formats are unaffected. If filtering would
 * remove every video option, keep nothing above the ceiling — callers then
 * surface audio-only or the generic ladder instead of breaking the promise.
 */
export function capFormatsToMaxHeight(formats, maxHeight = MAX_QUALITY_HEIGHT) {
    return formats.filter((f) => f.kind === 'audio' || !f.height || f.height <= maxHeight);
}
/**
 * Deduplicate rawExtractor formats into clean user-facing options:
 * - For Video: Groups by normalized height (1080p, 720p, etc.), selects ONE best MP4 format per resolution using
 *   compatibility ranking (video+audio muxed > video-only, avc1/h264 > vp9/vp09, higher fps/bitrate),
 *   and produces clean labels like "1080p MP4 · 30 fps · Best quality".
 * - For Audio: Exposes clean MP3 audio formats.
 * - Sorts video from highest resolution (1080p) to lowest resolution (240p).
 */
export function dedupeFormats(formats) {
    const videoByHeight = new Map();
    const audioFormats = [];
    const otherFormats = [];
    for (const f of formats) {
        if (f.kind === 'audio') {
            const existing = audioFormats.find(a => (a.bitrateKbps ?? 0) === (f.bitrateKbps ?? 0));
            if (!existing) {
                audioFormats.push({
                    ...f,
                    container: 'mp3',
                    label: `MP3 Audio · ${f.bitrateKbps ? `${f.bitrateKbps} kbps` : '192 kbps'} · High quality`,
                    mimeType: 'audio/mpeg',
                });
            }
            continue;
        }
        if (f.kind === 'video' || f.kind === 'video+audio') {
            const normHeight = normalizeHeight(f.height) ?? f.height ?? 0;
            const existing = videoByHeight.get(normHeight);
            if (!existing) {
                videoByHeight.set(normHeight, f);
            }
            else {
                // Ranking score for choosing the single best format per resolution:
                // 1. Muxed video+audio > video-only
                // 2. H.264/avc1/mp4 > VP9/VP09/WebM
                // 3. Higher FPS
                // 4. Higher bitrate
                const getScore = (item) => {
                    let score = 0;
                    if (item.kind === 'video+audio')
                        score += 1000;
                    const container = (item.container ?? '').toLowerCase();
                    const codec = (item.codec ?? '').toLowerCase();
                    if (container === 'mp4')
                        score += 500;
                    if (codec.includes('avc') || codec.includes('h264') || codec.includes('mp4v'))
                        score += 1000;
                    if (codec.includes('bytevc1') || codec.includes('hevc') || codec.includes('h265') || codec.includes('265'))
                        score -= 4000;
                    if (container === 'm3u8' || container.includes('hls') || (item.formatId ?? '').includes('620') || (item.sourceSelector ?? '') === '620')
                        score -= 5000;
                    score += (item.fps ?? 30);
                    score += Math.min((item.bitrateKbps ?? 0) / 100, 100);
                    return score;
                };
                if (getScore(f) > getScore(existing)) {
                    videoByHeight.set(normHeight, f);
                }
            }
            continue;
        }
        otherFormats.push(f);
    }
    // Build clean user-facing video options sorted from highest resolution to lowest resolution
    const sortedHeights = [...videoByHeight.keys()].sort((a, b) => b - a);
    const cleanVideoFormats = sortedHeights.map((h) => {
        const raw = videoByHeight.get(h);
        const normHeight = normalizeHeight(raw.height) ?? h;
        const fps = raw.fps ? Math.round(raw.fps) : 30;
        return {
            ...raw,
            container: 'mp4',
            label: `${normHeight}p MP4 · ${fps} fps · Best quality`,
            mimeType: 'video/mp4',
            playable: raw.playable ?? (raw.kind === 'video+audio' || raw.kind === 'video'),
        };
    });
    return [...cleanVideoFormats, ...audioFormats, ...otherFormats];
}
/**
 * Honest generic quality ladder for collections/playlists where per-item
 * formats are not known up front. Labels describe a ceiling, never a promise.
 */
export function genericQualityLadder(maxHeight = MAX_QUALITY_HEIGHT) {
    const heights = [2160, 1440, 1080, 720, 480].filter((h) => h <= maxHeight);
    const ladder = heights.map((h) => ({
        formatId: `best<=${h}`,
        kind: 'video+audio',
        container: 'mp4',
        label: h >= 2160 ? 'Up to 4K (best available)' : h >= 1440 ? 'Up to 2K (best available)' : `Up to ${heightToLabel(h)} (best available)`,
        height: h,
    }));
    ladder.push({
        formatId: 'audio',
        kind: 'audio',
        container: 'm4a',
        label: 'Audio only (best available)',
    });
    return ladder;
}
/**
 * Evaluates whether a media format is directly playable in standard browser HTML5 video/audio elements.
 * Checks container, codecs, and video+audio presence.
 */
export function isDirectPlayCompatible(format) {
    if (format.directPlayCompatible !== undefined) {
        return format.directPlayCompatible;
    }
    const container = (format.extension ?? format.container ?? '').toLowerCase();
    if (container === 'm3u8' || container.includes('hls') || container.includes('dash')) {
        return false;
    }
    const vcodec = (format.videoCodec ?? format.codec ?? '').toLowerCase();
    const isNonBrowserCodec = vcodec.includes('bytevc1') ||
        vcodec.includes('hevc') ||
        vcodec.includes('h265') ||
        vcodec.includes('265') ||
        vcodec.includes('av01') ||
        vcodec.includes('av1');
    if (isNonBrowserCodec) {
        return false;
    }
    const hasVideo = format.hasVideo ?? (format.kind === 'video+audio' || format.kind === 'video');
    const hasAudio = format.hasAudio ?? (format.kind === 'video+audio' || format.kind === 'audio');
    if (format.kind === 'audio') {
        return hasAudio;
    }
    // For HTML5 video playback, primary candidate MUST have combined video + audio
    return hasVideo && hasAudio;
}
export function separateFormats(formats) {
    const downloadFormats = [...formats];
    const playbackCandidates = formats.filter((f) => isDirectPlayCompatible(f));
    // Sort playback candidates: MP4 with H.264 + AAC first, then higher height, fps, bitrate
    playbackCandidates.sort((a, b) => {
        const hA = normalizeHeight(a.height) ?? a.height ?? 0;
        const hB = normalizeHeight(b.height) ?? b.height ?? 0;
        if (hB !== hA)
            return hB - hA;
        const fpsA = a.fps ?? 30;
        const fpsB = b.fps ?? 30;
        if (fpsB !== fpsA)
            return fpsB - fpsA;
        return (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0);
    });
    const recommendedPlaybackFormat = playbackCandidates[0];
    const playbackFallbackCandidates = playbackCandidates.slice(1);
    return {
        downloadFormats,
        playbackCandidates,
        recommendedPlaybackFormat,
        playbackFallbackCandidates,
    };
}
export function findFormatById(formats, formatId) {
    return formats.find((f) => f.formatId === formatId);
}
/**
 * Filter formats for genuine Direct Play browser playback capability.
 * Requires playable video with audio or progressive muxed MP4 formats, excluding HLS manifests.
 */
export function getDirectPlayFormats(formats) {
    const deduped = dedupeFormats(formats);
    const eligible = deduped.filter((f) => isDirectPlayCompatible(f));
    if (eligible.length > 0)
        return eligible;
    // Fallback: any video format that is marked playable
    return deduped.filter((f) => f.kind !== 'audio' && f.playable !== false);
}
/**
 * Select the HIGHEST genuinely playable representation for Direct Play (up to maxQualityHeight).
 * Prefers the highest available browser-compatible resolution (e.g. 1440p > 1080p > 720p > 480p).
 */
export function getBestDirectPlaybackRepresentation(formats, maxHeight = MAX_QUALITY_HEIGHT) {
    const candidates = getDirectPlayFormats(formats).filter((f) => (normalizeHeight(f.height) ?? f.height ?? 0) <= maxHeight);
    if (candidates.length === 0)
        return formats.find((f) => f.playable && f.kind !== 'audio') ?? formats.find((f) => f.playable);
    const sorted = [...candidates].sort((a, b) => {
        const hA = normalizeHeight(a.height) ?? a.height ?? 0;
        const hB = normalizeHeight(b.height) ?? b.height ?? 0;
        if (hB !== hA)
            return hB - hA;
        if ((b.fps ?? 0) !== (a.fps ?? 0))
            return (b.fps ?? 0) - (a.fps ?? 0);
        return (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0);
    });
    return sorted[0];
}
/**
 * Direct Play resolution selection:
 * Defaults to highest resolution available (getBestDirectPlaybackRepresentation).
 * If targetHeight is explicitly supplied, attempts exact or closest target match.
 */
export function getInitialPlayableFormat(formats, targetHeight) {
    if (targetHeight === undefined) {
        return getBestDirectPlaybackRepresentation(formats);
    }
    const candidates = getDirectPlayFormats(formats);
    if (candidates.length === 0)
        return formats.find((f) => f.playable && f.kind !== 'audio') ?? formats.find((f) => f.playable);
    const exact = candidates.find((f) => (normalizeHeight(f.height) ?? f.height) === targetHeight);
    if (exact)
        return exact;
    return getBestDirectPlaybackRepresentation(formats);
}
/**
 * Strictly select the best playable stream suitable for Direct Play (highest quality first).
 */
export function getBestPlayableStream(formats) {
    return getBestDirectPlaybackRepresentation(formats);
}
//# sourceMappingURL=formats.js.map