/**
 * Browser-safe entry: types + pure platform detection only.
 * Guarantees no node:* imports enter client bundles.
 */
export type * from './types.js';
export type * from './api-types.js';
export { PLATFORM_URL_PATTERNS, normalizeUrlInput, detectPlatform, canonicalizeUrl, TERABOX_DOMAINS, parsePlatformUrl, } from './platform-detect.js';
export type { NormalizedPlatformUrl } from './platform-detect.js';
export { dedupeFormats, normalizeHeight, heightToLabel, sortFormatsForDisplay, getInitialPlayableFormat, getBestDirectPlaybackRepresentation, getDirectPlayFormats, getBestPlayableStream, } from './formats.js';
//# sourceMappingURL=web.d.ts.map