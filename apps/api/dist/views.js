import { evaluatePlaybackCandidate, } from '@3ap/shared';
/** Strip adapter-internal fields before exposing formats to clients. */
export function publicFormats(formats) {
    return formats.map(({ sourceSelector: _ignored, ...rest }) => rest);
}
export function resolveRecordToView(record, resolveCtx) {
    // Helper to build proxied thumbnail URL for Terabox (requires auth, avoids CORS/referer issues)
    const thumbTokenFactory = resolveCtx
        ? (itemId) => `/api/v1/resolve/${record.resolveId}/items/${itemId}/thumbnail?token=${encodeURIComponent(resolveCtx.tokenFactory(record.resolveId, itemId, 'thumb'))}`
        : undefined;
    // Record-level thumbnail: for Terabox use proxied item thumbnail, else direct
    let recordThumb = record.thumbnailUrl;
    if (record.platform === 'terabox' && record.items[0]?.thumbnailUrl && thumbTokenFactory) {
        recordThumb = thumbTokenFactory(record.items[0].id);
    }
    return {
        resolveId: record.resolveId,
        platform: record.platform,
        kind: record.kind,
        title: record.title,
        creator: record.creator,
        thumbnailUrl: recordThumb,
        durationSeconds: record.durationSeconds,
        capabilities: record.capabilities,
        expiresAt: new Date(record.expiresAt || (Date.now() + 900_000)).toISOString(),
        items: record.items.map((item) => {
            const publicFormatsList = (item.formats ?? []).map(({ sourceSelector: _ignored, ...rest }) => {
                const view = rest;
                if (view.playable && resolveCtx) {
                    view.streamUrl =
                        `/api/v1/resolve/${record.resolveId}/items/${item.id}/stream` +
                            `?format=${encodeURIComponent(view.formatId)}` +
                            `&token=${encodeURIComponent(resolveCtx.tokenFactory(record.resolveId, item.id, view.formatId))}`;
                }
                return view;
            });
            const isAudioItem = publicFormatsList.length > 0 && publicFormatsList.every((f) => f.kind === 'audio');
            const downloadFormats = [...publicFormatsList];
            const directCandidates = publicFormatsList
                .filter((f) => f.directPlayCompatible === true && (isAudioItem || (f.kind !== 'audio' && f.hasVideo !== false)))
                .sort((a, b) => evaluatePlaybackCandidate(b).compatibilityScore - evaluatePlaybackCandidate(a).compatibilityScore);
            const fallbackCandidates = publicFormatsList
                .filter((f) => f.playable && (isAudioItem || (f.kind !== 'audio' && f.hasVideo !== false)))
                .sort((a, b) => evaluatePlaybackCandidate(b).compatibilityScore - evaluatePlaybackCandidate(a).compatibilityScore);
            const playbackCandidates = directCandidates.length > 0 ? directCandidates : fallbackCandidates;
            const recommendedPlaybackFormat = playbackCandidates[0] ??
                publicFormatsList.find((f) => f.playable && f.kind !== 'audio' && f.container?.toLowerCase() === 'mp4') ??
                publicFormatsList.find((f) => isAudioItem || (f.playable && f.kind !== 'audio'));
            const playbackFallbackCandidates = playbackCandidates.length > 1 ? playbackCandidates.slice(1) : [];
            // Proxy thumbnail for Terabox
            let itemThumb = item.thumbnailUrl;
            if (record.platform === 'terabox' && item.thumbnailUrl && thumbTokenFactory) {
                itemThumb = thumbTokenFactory(item.id);
            }
            return {
                id: item.id,
                title: item.title,
                durationSeconds: item.durationSeconds,
                thumbnailUrl: itemThumb,
                formats: publicFormatsList,
                downloadFormats,
                playbackCandidates: playbackCandidates.length > 0 ? playbackCandidates : (recommendedPlaybackFormat ? [recommendedPlaybackFormat] : []),
                recommendedPlaybackFormat,
                playbackFallbackCandidates,
                streamUrl: recommendedPlaybackFormat?.streamUrl,
                playbackUrl: recommendedPlaybackFormat?.streamUrl,
            };
        }),
    };
}
function isoOrNull(date) {
    return date ? date.toISOString() : undefined;
}
export function jobItemToView(item, download) {
    const downloadable = item.status === 'completed' && !!item.artifactKey && !!item.artifactName && download !== undefined;
    return {
        id: item.id,
        ordinal: item.ordinal,
        title: item.title,
        status: item.status,
        progress: item.progress,
        sizeBytes: item.artifactSizeBytes ?? undefined,
        errorCode: item.errorCode ?? undefined,
        errorMessage: item.errorMessage ?? undefined,
        ...(downloadable
            ? {
                downloadUrl: `/api/v1/jobs/${item.jobId}/items/${item.id}/download` +
                    `?token=${encodeURIComponent(download.tokenFactory(item.jobId, item.id))}`,
                streamUrl: `/api/v1/jobs/${item.jobId}/items/${item.id}/stream` +
                    `?token=${encodeURIComponent(download.tokenFactory(item.jobId, item.id))}`,
            }
            : {}),
    };
}
export function jobToView(job, items, download) {
    const aggregate = items.length > 0
        ? Math.round(items.reduce((sum, item) => sum + item.progress, 0) / items.length)
        : job.progress;
    return {
        id: job.id,
        status: job.status,
        platform: job.platform,
        kind: job.kind,
        title: job.title ?? undefined,
        creator: job.creator ?? undefined,
        requestedFormatId: job.requestedFormatId,
        requestedQualityLabel: job.requestedQualityLabel,
        progress: job.status === 'completed' ? 100 : aggregate,
        errorCode: job.errorCode ?? undefined,
        errorMessage: job.errorMessage ?? undefined,
        createdAt: isoOrNull(job.createdAt),
        startedAt: isoOrNull(job.startedAt),
        completedAt: isoOrNull(job.completedAt),
        expiresAt: isoOrNull(job.expiresAt),
        items: items.map((item) => jobItemToView(item, download)),
    };
}
//# sourceMappingURL=views.js.map