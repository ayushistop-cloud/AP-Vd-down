/**
 * Validates whether a file path exists, is a readable file, non-empty, and has a valid Netscape HTTP Cookie format structure.
 * Never logs cookie contents or sensitive secrets.
 */
export declare function isValidNetscapeCookieFile(filePath: string): boolean;
/**
 * Helper to inspect the raw configured cookie file path from environment or default Render secret path.
 */
export declare function getRawConfiguredCookiesPath(): string | undefined;
/**
 * Resolves a valid Netscape cookie file path from env vars or standard Render secret location.
 * Returns undefined if missing, empty, malformed, or unreadable.
 */
export declare function getValidCookiesPath(): string | undefined;
export interface YtDlpCookiePreparation {
    enabled: boolean;
    runtimeCookiePath?: string;
    configuredPath?: string;
    sourceReadable?: boolean;
    runtimeWritable?: boolean;
    cleanup?: () => Promise<void>;
}
/**
 * Central utility for preparing yt-dlp cookie files.
 *
 * NEVER passes a read-only secret path directly to yt-dlp.
 * Instead:
 * 1. Checks if configured cookie file exists & is valid Netscape format.
 * 2. Creates a unique, isolated writable temporary directory.
 * 3. Copies the source file into the temporary directory.
 * 4. Returns the temporary writable path and a cleanup function.
 *
 * If cookies are undefined, missing, unreadable, or malformed, returns { enabled: false }.
 */
export declare function prepareYtDlpCookies(): Promise<YtDlpCookiePreparation>;
export interface CookieStartupDiagnostics {
    cookiesConfigured: boolean;
    cookiesReadable: boolean;
    configuredPath: string | null;
}
/**
 * Performs a safe read-only check of configured cookie file at application startup.
 * Never writes to or modifies the source file.
 */
export declare function performCookieStartupCheck(): CookieStartupDiagnostics;
//# sourceMappingURL=cookies.d.ts.map