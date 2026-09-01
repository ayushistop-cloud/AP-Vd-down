import { type AdapterCapabilities, type AppError } from '@3ap/shared';
import type { DownloadRequest, DownloadTaskContext, DownloadTaskResult, MediaAdapter, ResolveOutput } from '../contract.js';
import { DISABLED_COOKIE_PREP, getValidCookiesPath, isValidNetscapeCookieFile, prepareYtDlpCookies } from './cookies.js';
export { DISABLED_COOKIE_PREP, getValidCookiesPath, isValidNetscapeCookieFile, prepareYtDlpCookies };
/**
 * Sanitizes stderr text to ensure tokens, signatures, and cookies are never logged.
 */
export declare function sanitizeStderr(stderr: string): string;
export interface YtDlpPlatformOptions {
    platform: MediaAdapter['platform'];
    capabilities: AdapterCapabilities;
}
/**
 * Shared implementation of the adapter contract for all platforms whose
 * extraction is delegated to yt-dlp. Platform subclasses declare identity
 * and capabilities; URL allowlists come from the shared pattern registry.
 */
export interface YtDlpExtractionStrategy {
    name: string;
    args: string[];
}
export declare abstract class YtDlpBaseAdapter implements MediaAdapter {
    protected readonly options: YtDlpPlatformOptions;
    abstract readonly platform: MediaAdapter['platform'];
    protected constructor(options: YtDlpPlatformOptions);
    getCapabilities(): AdapterCapabilities;
    canHandle(url: string): boolean;
    normalizeError(error: unknown): AppError;
    protected getExtractionStrategies(): YtDlpExtractionStrategy[];
    /**
     * Per-platform cookie policy (docs/22-SECURITY.md).
     * By default, yt-dlp adapters do NOT receive global cookies. Subclasses
     * (e.g. YouTubeAdapter) override this to return true when configured.
     */
    protected shouldUseCookies(): boolean;
    resolve(rawUrl: string): Promise<ResolveOutput>;
    private resolvePlaylist;
    private resolveSingleOrCollection;
    protected getPlatformExtraArgs(): string[];
    private dumpJson;
    createDownloadTask(request: DownloadRequest, ctx: DownloadTaskContext): Promise<DownloadTaskResult>;
}
export interface Selection {
    selector?: string;
    audioOnly: boolean;
    height?: number;
}
/** Map the requested formatId onto a concrete yt-dlp format selector. */
export declare function selectSelector(request: DownloadRequest): Selection;
export interface ClassifyYtDlpErrorOptions {
    platform?: MediaAdapter['platform'];
    stderr: string;
    exitCode?: number | null;
    timedOut?: boolean;
}
export declare function classifyYtDlpError(options: ClassifyYtDlpErrorOptions): AppError;
export declare function classifyYtDlpStderr(stderrTail: string, timedOut: boolean, platform?: MediaAdapter['platform']): AppError;
//# sourceMappingURL=base.d.ts.map