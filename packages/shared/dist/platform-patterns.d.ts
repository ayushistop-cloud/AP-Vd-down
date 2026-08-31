/**
 * Server-side URL intake helpers layered on the pure detection module.
 * (Browser bundles import @3ap/shared/web instead of this barrel.)
 */
export { PLATFORM_URL_PATTERNS, normalizeUrlInput, detectPlatform, canonicalizeUrl, } from './platform-detect.js';
import type { Platform } from './types.js';
/** Require a known platform for a URL or throw INVALID_URL / UNSUPPORTED. */
export declare function requirePlatform(url: string): Platform;
//# sourceMappingURL=platform-patterns.d.ts.map