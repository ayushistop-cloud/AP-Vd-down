import { type AdapterCapabilities, type AppError } from '@3ap/shared';
import type { DownloadRequest, DownloadTaskContext, DownloadTaskResult, MediaAdapter, ResolveOutput } from '../contract.js';
/**
 * Sanitizes stderr text to ensure tokens, signatures, and cookies are never logged.
 */
export declare function sanitizeStderr(stderr: string): string;
/**
 * Validates whether a file path exists, is a readable file, non-empty, and has a valid Netscape HTTP Cookie format structure.
 * Never logs cookie contents or sensitive secrets.
 */
export declare function isValidNetscapeCookieFile(filePath: string): boolean;
/**
 * Resolves a valid Netscape cookie file path from env vars or standard Render secret location.
 * Returns undefined if missing, empty, malformed, or unreadable.
 */
export declare function getValidCookiesPath(): string | undefined;
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
export declare function classifyYtDlpStderr(stderrTail: string, timedOut: boolean): AppError;
//# sourceMappingURL=base.d.ts.map