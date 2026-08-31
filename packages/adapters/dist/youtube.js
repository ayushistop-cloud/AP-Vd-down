import { MAX_QUALITY_HEIGHT } from '@3ap/shared';
import { YtDlpBaseAdapter } from './ytdlp/base.js';
/**
 * YouTube adapter (docs/15-YOUTUBE-SPEC.md):
 * public videos, public playlists ≤50 items, quality up to 2K,
 * audio option where the provider exposes one.
 *
 * Implements a 5-tier safe extraction strategy pipeline using official yt-dlp
 * player client parameters before exhausting to PLATFORM_VERIFICATION.
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
    getExtractionStrategies() {
        return [
            { name: 'youtube_default', args: [] },
            { name: 'youtube_mweb', args: ['--extractor-args', 'youtube:player_client=mweb,web'] },
            { name: 'youtube_web_safari', args: ['--extractor-args', 'youtube:player_client=web_safari,web'] },
            { name: 'youtube_android', args: ['--extractor-args', 'youtube:player_client=android,web'] },
            { name: 'youtube_tv_embedded', args: ['--extractor-args', 'youtube:player_client=tv_embedded,web_embedded'] },
        ];
    }
}
//# sourceMappingURL=youtube.js.map