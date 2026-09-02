import { capFormatsToMaxHeight, dedupeFormats, getBestPlayableStream, heightToLabel, normalizeHeight, sortFormatsForDisplay, } from '@3ap/shared';
export { getBestPlayableStream };
function isStoryboard(format) {
    const note = (format.format_note ?? '').toLowerCase();
    return note.includes('storyboard') || ((format.vcodec === 'none' || !format.vcodec) && (format.acodec === 'none' || !format.acodec));
}
function getMimeType(container, kind) {
    const c = container.toLowerCase();
    if (kind === 'audio') {
        if (c === 'mp3')
            return 'audio/mpeg';
        if (c === 'm4a')
            return 'audio/mp4';
        if (c === 'aac')
            return 'audio/aac';
        if (c === 'ogg' || c === 'opus')
            return 'audio/ogg';
        return 'audio/mp4';
    }
    else {
        if (c === 'webm')
            return 'video/webm';
        if (c === 'mkv')
            return 'video/x-matroska';
        if (c === 'mov')
            return 'video/quicktime';
        return 'video/mp4';
    }
}
/** Convert raw provider formats into normalized MediaFormat objects. */
export function normalizeYtDlpFormats(raw, maxHeight) {
    const formats = [];
    let bestAudio;
    for (const f of raw) {
        if (!f?.format_id || isStoryboard(f) || f.ext === 'm3u8' || (f.format_note ?? '').toLowerCase().includes('hls'))
            continue;
        const vcodec = f.vcodec ?? 'none';
        const acodec = f.acodec ?? 'none';
        const hasVideo = vcodec !== 'none' && vcodec !== '';
        const hasAudio = acodec !== 'none' && acodec !== '';
        if (!hasVideo && !hasAudio)
            continue;
        const container = (f.ext ?? 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
        const protocol = f.protocol ?? 'https';
        const sel = (f.url && /^https?:\/\//i.test(f.url)) ? f.url : f.format_id;
        if (!hasVideo) {
            // audio-only candidate
            const candidate = {
                formatId: `a:${f.format_id}`,
                kind: 'audio',
                container,
                extension: container,
                protocol,
                label: '',
                bitrateKbps: Math.round(f.abr ?? f.tbr ?? 0) || undefined,
                estimatedSizeBytes: f.filesize ?? f.filesize_approx,
                filesizeApprox: f.filesize_approx,
                codec: acodec,
                audioCodec: acodec,
                hasVideo: false,
                hasAudio: true,
                sourceSelector: sel,
                playable: true,
                directPlayCompatible: false,
                mimeType: getMimeType(container, 'audio'),
            };
            if (!bestAudio || (candidate.bitrateKbps ?? 0) > (bestAudio.bitrateKbps ?? 0))
                bestAudio = candidate;
            continue;
        }
        if (f.height && f.height > maxHeight)
            continue; // quality ceiling (2K)
        const normHeight = normalizeHeight(f.height);
        const muxed = hasVideo && hasAudio;
        const kind = muxed ? 'video+audio' : 'video';
        const isBrowserCodec = vcodec.includes('avc') || vcodec.includes('h264') || vcodec.includes('vp8') || vcodec.includes('vp9') || vcodec.includes('mp4v');
        const isNonBrowserCodec = vcodec.includes('bytevc1') || vcodec.includes('hevc') || vcodec.includes('h265') || vcodec.includes('265') || vcodec.includes('av01') || vcodec.includes('av1');
        const isPlayable = !isNonBrowserCodec && (muxed || isBrowserCodec || container === 'mp4');
        const directPlayCompatible = muxed && !isNonBrowserCodec && (isBrowserCodec || container === 'mp4' || container === 'webm');
        formats.push({
            formatId: `${muxed ? 'f' : 'v'}:${f.format_id}`,
            kind,
            container,
            extension: container,
            protocol,
            label: heightToLabel(normHeight),
            width: f.width,
            height: normHeight,
            fps: f.fps ? Math.round(f.fps) : undefined,
            codec: vcodec.split('.')[0],
            videoCodec: vcodec,
            audioCodec: acodec !== 'none' ? acodec : undefined,
            hasVideo: true,
            hasAudio,
            bitrateKbps: Math.round(f.tbr ?? 0) || undefined,
            estimatedSizeBytes: f.filesize ?? f.filesize_approx,
            filesizeApprox: f.filesize_approx,
            sourceSelector: sel,
            playable: isPlayable,
            directPlayCompatible,
            mimeType: getMimeType(container, kind),
        });
    }
    return { formats, bestAudio };
}
/** Final display list: capped, deduped, sorted, with the best-audio option. */
export function buildDisplayFormats(normalized, maxHeight) {
    const list = [...capFormatsToMaxHeight(normalized.formats, maxHeight)];
    if (normalized.bestAudio) {
        list.push({ ...normalized.bestAudio, label: `Audio only (${normalized.bestAudio.container})` });
    }
    return sortFormatsForDisplay(dedupeFormats(list));
}
//# sourceMappingURL=formats.js.map