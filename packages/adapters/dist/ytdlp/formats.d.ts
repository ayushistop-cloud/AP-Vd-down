import { getBestPlayableStream, type MediaFormat } from '@3ap/shared';
export { getBestPlayableStream };
/**
 * Raw yt-dlp JSON format entries (subset of fields we rely on).
 */
export interface YtDlpFormatJson {
    format_id?: string;
    url?: string;
    format_note?: string;
    ext?: string;
    vcodec?: string;
    acodec?: string;
    width?: number;
    height?: number;
    fps?: number;
    tbr?: number;
    abr?: number;
    filesize?: number;
    filesize_approx?: number;
}
/** Convert raw provider formats into normalized MediaFormat objects. */
export declare function normalizeYtDlpFormats(raw: YtDlpFormatJson[], maxHeight: number): {
    formats: MediaFormat[];
    bestAudio?: MediaFormat;
};
/** Final display list: capped, deduped, sorted, with the best-audio option. */
export declare function buildDisplayFormats(normalized: {
    formats: MediaFormat[];
    bestAudio?: MediaFormat;
}, maxHeight: number): MediaFormat[];
//# sourceMappingURL=formats.d.ts.map