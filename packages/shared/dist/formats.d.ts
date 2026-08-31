import type { MediaFormat } from './types.js';
/** Default quality ceiling: 2K = 1440p (product decision, docs/15-YOUTUBE-SPEC.md). */
export declare const MAX_QUALITY_HEIGHT = 1440;
export declare function normalizeHeight(height?: number): number | undefined;
export declare function heightToLabel(height?: number): string;
/**
 * Sort formats for display: ready-to-play (muxed) first by resolution,
 * then audio options, then adaptive-video-only last.
 */
export declare function sortFormatsForDisplay(formats: MediaFormat[]): MediaFormat[];
/**
 * Enforce the product quality ceiling: drop video renditions above
 * maxQualityHeight. Audio-only formats are unaffected. If filtering would
 * remove every video option, keep nothing above the ceiling — callers then
 * surface audio-only or the generic ladder instead of breaking the promise.
 */
export declare function capFormatsToMaxHeight(formats: MediaFormat[], maxHeight?: number): MediaFormat[];
/**
 * Deduplicate rawExtractor formats into clean user-facing options:
 * - For Video: Groups by normalized height (1080p, 720p, etc.), selects ONE best MP4 format per resolution using
 *   compatibility ranking (video+audio muxed > video-only, avc1/h264 > vp9/vp09, higher fps/bitrate),
 *   and produces clean labels like "1080p MP4 · 30 fps · Best quality".
 * - For Audio: Exposes clean MP3 audio formats.
 * - Sorts video from highest resolution (1080p) to lowest resolution (240p).
 */
export declare function dedupeFormats(formats: MediaFormat[]): MediaFormat[];
/**
 * Honest generic quality ladder for collections/playlists where per-item
 * formats are not known up front. Labels describe a ceiling, never a promise.
 */
export declare function genericQualityLadder(maxHeight?: number): MediaFormat[];
export interface PlaybackCandidateScore {
    formatId: string;
    container: string;
    videoCodec?: string;
    audioCodec?: string;
    hasVideo: boolean;
    hasAudio: boolean;
    protocol?: string;
    isProgressive: boolean;
    directPlayCompatible: boolean;
    compatibilityScore: number;
    incompatibilityReasons: string[];
}
/**
 * Evaluates whether a format candidate is directly playable in HTML5 video/audio elements
 * based on REAL format metadata (codecs, container, audio/video channels, manifest protocol).
 */
export declare function evaluatePlaybackCandidate(format: MediaFormat): PlaybackCandidateScore;
/**
 * Evaluates whether a media format is directly playable in standard browser HTML5 video/audio elements.
 * Checks container, codecs, and video+audio presence.
 */
export declare function isDirectPlayCompatible(format: MediaFormat): boolean;
export interface SeparatedFormats {
    downloadFormats: MediaFormat[];
    playbackCandidates: MediaFormat[];
    recommendedPlaybackFormat?: MediaFormat;
    playbackFallbackCandidates: MediaFormat[];
}
export declare function separateFormats(formats: MediaFormat[]): SeparatedFormats;
export declare function findFormatById(formats: MediaFormat[], formatId: string): MediaFormat | undefined;
/**
 * Filter formats for genuine Direct Play browser playback capability.
 * Requires playable video with audio or progressive muxed MP4 formats, excluding HLS manifests.
 */
export declare function getDirectPlayFormats(formats: MediaFormat[]): MediaFormat[];
/**
 * Select the HIGHEST genuinely playable representation for Direct Play (up to maxQualityHeight).
 * Prefers the highest available browser-compatible resolution (e.g. 1440p > 1080p > 720p > 480p).
 */
export declare function getBestDirectPlaybackRepresentation(formats: MediaFormat[], maxHeight?: number): MediaFormat | undefined;
/**
 * Direct Play resolution selection:
 * Defaults to highest resolution available (getBestDirectPlaybackRepresentation).
 * If targetHeight is explicitly supplied, attempts exact or closest target match.
 */
export declare function getInitialPlayableFormat(formats: MediaFormat[], targetHeight?: number): MediaFormat | undefined;
/**
 * Strictly select the best playable stream suitable for Direct Play (highest quality first).
 */
export declare function getBestPlayableStream(formats: MediaFormat[]): MediaFormat | undefined;
//# sourceMappingURL=formats.d.ts.map