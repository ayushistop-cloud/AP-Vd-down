import { MAX_QUALITY_HEIGHT } from '@3ap/shared';
import { YtDlpBaseAdapter } from './ytdlp/base.js';
/**
 * Facebook adapter (docs/18-FACEBOOK-SPEC.md): public videos with the best
 * available quality up to 2K where a valid source option exists.
 */
export class FacebookAdapter extends YtDlpBaseAdapter {
    platform = 'facebook';
    constructor() {
        super({
            platform: 'facebook',
            capabilities: {
                supportsAudioOnly: false,
                supportsQualitySelection: false,
                supportsPlaylists: false,
                maxQualityHeight: MAX_QUALITY_HEIGHT,
            },
        });
    }
}
//# sourceMappingURL=facebook.js.map