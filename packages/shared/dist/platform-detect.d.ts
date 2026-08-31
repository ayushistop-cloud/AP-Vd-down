import type { Platform } from './types.js';
import { TERABOX_DOMAINS } from './provider-config.js';
export { TERABOX_DOMAINS };
export interface NormalizedPlatformUrl {
    provider: Platform;
    host: string;
    shareId: string;
    originalUrl: string;
}
export declare const PLATFORM_URL_PATTERNS: Record<Platform, RegExp[]>;
/** Strip whitespace/zero-width characters and guarantee an https scheme. */
export declare function normalizeUrlInput(raw: string): string;
/** Detect the platform for a user-supplied URL; null = not allowlisted. */
export declare function detectPlatform(rawOrNormalizedUrl: string): Platform | null;
export declare function canonicalizeUrl(rawUrl: string): string;
export declare function parsePlatformUrl(rawUrl: string): NormalizedPlatformUrl | null;
//# sourceMappingURL=platform-detect.d.ts.map