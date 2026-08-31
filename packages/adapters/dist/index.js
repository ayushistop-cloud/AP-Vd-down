export * from './contract.js';
export * from './registry.js';
export * from './youtube.js';
export * from './tiktok.js';
export * from './instagram.js';
export * from './facebook.js';
export * from './terabox.js';
export * from './http-download.js';
export { checkEngineAtBoot, resolveYtDlpEngine, resetBinaryCache, EngineUnavailableError, requireBinary, runYtDlp, detectJsRuntime, } from './ytdlp/binary.js';
export { isValidNetscapeCookieFile, getValidCookiesPath, classifyYtDlpStderr } from './ytdlp/base.js';
import { FacebookAdapter } from './facebook.js';
import { InstagramAdapter } from './instagram.js';
import { TikTokAdapter } from './tiktok.js';
import { YouTubeAdapter } from './youtube.js';
import { TeraboxAdapter } from './terabox.js';
import { createAdapterRegistry } from './registry.js';
/** Default production registry covering all MVP platforms. */
export function createDefaultAdapters() {
    return createAdapterRegistry([
        new YouTubeAdapter(),
        new TikTokAdapter(),
        new InstagramAdapter(),
        new FacebookAdapter(),
        new TeraboxAdapter(),
    ]);
}
//# sourceMappingURL=index.js.map