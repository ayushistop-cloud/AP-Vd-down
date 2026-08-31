import { YtDlpBaseAdapter } from './ytdlp/base.js';
/**
 * YouTube adapter (docs/15-YOUTUBE-SPEC.md):
 * public videos, public playlists ≤50 items, quality up to 2K,
 * audio option where the provider exposes one.
 */
export declare class YouTubeAdapter extends YtDlpBaseAdapter {
    readonly platform: "youtube";
    constructor();
}
//# sourceMappingURL=youtube.d.ts.map