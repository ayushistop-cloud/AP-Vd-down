/**
 * Server-side URL intake helpers layered on the pure detection module.
 * (Browser bundles import @3ap/shared/web instead of this barrel.)
 */
export { PLATFORM_URL_PATTERNS, normalizeUrlInput, detectPlatform, canonicalizeUrl, } from './platform-detect.js';
import { appErrors } from './errors.js';
import { assertPublicHttpUrl } from './urls.js';
import { detectPlatform } from './platform-detect.js';
/** Require a known platform for a URL or throw INVALID_URL / UNSUPPORTED. */
export function requirePlatform(url) {
    assertPublicHttpUrl(url);
    const platform = detectPlatform(url);
    if (!platform)
        throw appErrors.unsupported();
    return platform;
}
//# sourceMappingURL=platform-patterns.js.map