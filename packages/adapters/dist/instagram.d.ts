import { YtDlpBaseAdapter } from './ytdlp/base.js';
/**
 * Instagram adapter (docs/17-INSTAGRAM-SPEC.md): public reels, posts and
 * carousels. Private accounts/stories are never requested; provider
 * responses for private content normalize to NOT_PUBLIC. Carousels resolve
 * as a collection of individual public media items.
 */
export declare class InstagramAdapter extends YtDlpBaseAdapter {
    readonly platform: "instagram";
    constructor();
}
//# sourceMappingURL=instagram.d.ts.map