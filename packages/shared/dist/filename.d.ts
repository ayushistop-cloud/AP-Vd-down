import type { Platform } from './types.js';
/**
 * Filesystem-safe filename generation across Windows/macOS/Linux.
 * Deterministic and predictable per docs/03-FEATURE-SPECIFICATION.md.
 */
export declare function sanitizeFilename(name: string, maxLength?: number): string;
export interface FileNameParts {
    platform: Platform;
    title: string;
    creator?: string;
    heightOrLabel?: number | string;
    container: string;
}
/** Build "Creator - Title [1080p].mp4" style names with safe fallbacks. */
export declare function buildFileName(parts: FileNameParts): string;
//# sourceMappingURL=filename.d.ts.map