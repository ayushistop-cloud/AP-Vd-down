import { MAX_QUALITY_HEIGHT } from '@3ap/shared';
import { YtDlpBaseAdapter } from './ytdlp/base.js';
/**
 * TikTok adapter (docs/16-TIKTOK-SPEC.md): single public video URLs only.
 * No watermark-removal transformation is performed — the provider's default
 * public rendition is delivered as-is (compliance boundary in docs/16).
 */
export class TikTokAdapter extends YtDlpBaseAdapter {
    platform = 'tiktok';
    constructor() {
        super({
            platform: 'tiktok',
            capabilities: {
                supportsAudioOnly: true,
                supportsQualitySelection: false,
                supportsPlaylists: false,
                maxQualityHeight: MAX_QUALITY_HEIGHT,
            },
        });
    }
}
//# sourceMappingURL=tiktok.js.map