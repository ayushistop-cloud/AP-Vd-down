import { MAX_QUALITY_HEIGHT } from '@3ap/shared';
import { YtDlpBaseAdapter } from './ytdlp/base.js';
/**
 * Instagram adapter (docs/17-INSTAGRAM-SPEC.md): public reels, posts and
 * carousels. Private accounts/stories are never requested; provider
 * responses for private content normalize to NOT_PUBLIC. Carousels resolve
 * as a collection of individual public media items.
 */
export class InstagramAdapter extends YtDlpBaseAdapter {
    platform = 'instagram';
    constructor() {
        super({
            platform: 'instagram',
            capabilities: {
                supportsAudioOnly: true,
                supportsQualitySelection: false,
                supportsPlaylists: false,
                maxQualityHeight: MAX_QUALITY_HEIGHT,
            },
        });
    }
}
//# sourceMappingURL=instagram.js.map