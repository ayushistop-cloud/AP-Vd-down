import { YtDlpBaseAdapter } from './ytdlp/base.js';
/**
 * TikTok adapter (docs/16-TIKTOK-SPEC.md): single public video URLs only.
 * No watermark-removal transformation is performed — the provider's default
 * public rendition is delivered as-is (compliance boundary in docs/16).
 */
export declare class TikTokAdapter extends YtDlpBaseAdapter {
    readonly platform: "tiktok";
    constructor();
}
//# sourceMappingURL=tiktok.d.ts.map