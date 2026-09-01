import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@3ap/shared';
const logger = createLogger({ service: 'yt-dlp-cookies', level: 'error' });
/**
 * Validates whether a file path exists, is a readable file, non-empty, and has a valid Netscape HTTP Cookie format structure.
 * Never logs cookie contents or sensitive secrets.
 */
export function isValidNetscapeCookieFile(filePath) {
    if (!filePath || typeof filePath !== 'string')
        return false;
    try {
        const stats = statSync(filePath);
        if (!stats.isFile() || stats.size === 0) {
            return false;
        }
        // Prevent reading arbitrarily huge non-cookie files (10MB limit)
        if (stats.size > 10 * 1024 * 1024) {
            return false;
        }
        const content = readFileSync(filePath, 'utf8');
        const trimmed = content.trim();
        if (!trimmed)
            return false;
        const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length === 0)
            return false;
        // Check 1: Standard Netscape cookie header comment
        const hasHeader = lines.some((line) => /^#\s*(Netscape HTTP Cookie File|HTTP Cookie File|curl cookie file)/i.test(line));
        // Check 2: Valid tab-separated cookie line (domain \t flag \t path \t secure \t expiration \t name \t value)
        const hasValidCookieLine = lines.some((line) => {
            if (line.startsWith('#'))
                return false;
            const fields = line.split('\t');
            if (fields.length >= 6) {
                const flag = fields[1]?.trim().toUpperCase();
                const secure = fields[3]?.trim().toUpperCase();
                if ((flag === 'TRUE' || flag === 'FALSE') && (secure === 'TRUE' || secure === 'FALSE')) {
                    return true;
                }
                if (fields.length >= 7)
                    return true;
            }
            return false;
        });
        return hasHeader || hasValidCookieLine;
    }
    catch {
        return false;
    }
}
/**
 * Helper to inspect the raw configured cookie file path from environment or default Render secret path.
 */
export function getRawConfiguredCookiesPath() {
    const envCandidates = [
        process.env.YTDLP_COOKIES_PATH,
        process.env.COOKIES_PATH,
        process.env.YTDLP_COOKIES,
        process.env.COOKIES_FILE,
    ];
    for (const cand of envCandidates) {
        if (cand && cand.trim()) {
            return cand.trim();
        }
    }
    const renderSecretsPath = '/etc/secrets/cookies.txt';
    if (existsSync(renderSecretsPath)) {
        return renderSecretsPath;
    }
    return undefined;
}
/**
 * Resolves a valid Netscape cookie file path from env vars or standard Render secret location.
 * Returns undefined if missing, empty, malformed, or unreadable.
 */
export function getValidCookiesPath() {
    const envCandidates = [
        process.env.YTDLP_COOKIES_PATH,
        process.env.COOKIES_PATH,
        process.env.YTDLP_COOKIES,
        process.env.COOKIES_FILE,
    ];
    for (const cand of envCandidates) {
        if (cand && cand.trim()) {
            const trimmed = cand.trim();
            if (isValidNetscapeCookieFile(trimmed)) {
                return trimmed;
            }
        }
    }
    const renderSecretsPath = '/etc/secrets/cookies.txt';
    if (isValidNetscapeCookieFile(renderSecretsPath)) {
        return renderSecretsPath;
    }
    return undefined;
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
export async function prepareYtDlpCookies() {
    const rawPath = getRawConfiguredCookiesPath();
    const validSourcePath = getValidCookiesPath();
    if (!validSourcePath) {
        return {
            enabled: false,
            configuredPath: rawPath,
            sourceReadable: rawPath ? existsSync(rawPath) : false,
            runtimeWritable: false,
        };
    }
    let tempDir = '';
    try {
        tempDir = await mkdtemp(join(tmpdir(), '3ap-yt-dlp-cookies-'));
        const targetPath = join(tempDir, 'cookies.txt');
        await copyFile(validSourcePath, targetPath);
        await chmod(targetPath, 0o666).catch(() => undefined);
        return {
            enabled: true,
            runtimeCookiePath: targetPath,
            configuredPath: validSourcePath,
            sourceReadable: true,
            runtimeWritable: true,
            cleanup: async () => {
                if (tempDir) {
                    try {
                        await rm(tempDir, { recursive: true, force: true });
                    }
                    catch {
                        /* ignore cleanup failures */
                    }
                }
            },
        };
    }
    catch (err) {
        logger.warn('Failed to prepare writable temporary copy of cookie file; proceeding without cookies', {
            configuredPath: validSourcePath,
            error: err.message,
        });
        if (tempDir) {
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
        return {
            enabled: false,
            configuredPath: validSourcePath,
            sourceReadable: true,
            runtimeWritable: false,
        };
    }
}
/**
 * Performs a safe read-only check of configured cookie file at application startup.
 * Never writes to or modifies the source file.
 */
export function performCookieStartupCheck() {
    const rawPath = getRawConfiguredCookiesPath();
    const validPath = getValidCookiesPath();
    return {
        cookiesConfigured: !!rawPath,
        cookiesReadable: !!validPath,
        configuredPath: rawPath || null,
    };
}
//# sourceMappingURL=cookies.js.map