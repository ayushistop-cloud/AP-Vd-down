import { MAX_QUALITY_HEIGHT } from '@3ap/shared';
import { YtDlpBaseAdapter } from './ytdlp/base.js';
/**
 * YouTube adapter (docs/15-YOUTUBE-SPEC.md):
 * public videos, public playlists ≤50 items, quality up to 2K,
 * audio option where the provider exposes one.
 */
export class YouTubeAdapter extends YtDlpBaseAdapter {
    platform = 'youtube';
    constructor() {
        super({
            platform: 'youtube',
            capabilities: {
                supportsAudioOnly: true,
                supportsQualitySelection: true,
                supportsPlaylists: true,
                playlistMaxItems: 50,
                maxQualityHeight: MAX_QUALITY_HEIGHT,
            },
        });
    }
}
//# sourceMappingURL=youtube.js.map