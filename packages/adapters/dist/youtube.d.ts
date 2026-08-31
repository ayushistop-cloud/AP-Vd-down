import { YtDlpBaseAdapter, type YtDlpExtractionStrategy } from './ytdlp/base.js';
/**
 * YouTube adapter (docs/15-YOUTUBE-SPEC.md):
 * public videos, public playlists ≤50 items, quality up to 2K,
 * audio option where the provider exposes one.
 *
 * Implements a 5-tier safe extraction strategy pipeline using official yt-dlp
 * player client parameters before exhausting to PLATFORM_VERIFICATION.
 */
export declare class YouTubeAdapter extends YtDlpBaseAdapter {
    readonly platform: "youtube";
    constructor();
    protected getExtractionStrategies(): YtDlpExtractionStrategy[];
}
//# sourceMappingURL=youtube.d.ts.map