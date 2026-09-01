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
    getExtractionStrategies() {
        return [
            { name: 'tiktok_default', args: [] },
            {
                name: 'tiktok_web_useragent',
                args: [
                    '--user-agent',
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    '--referer',
                    'https://www.tiktok.com/',
                ],
            },
        ];
    }
}
//# sourceMappingURL=tiktok.js.map