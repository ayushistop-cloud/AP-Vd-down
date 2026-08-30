import { heightToLabel } from './formats.js';
const WINDOWS_RESERVED = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    ...Array.from({ length: 9 }, (_v, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_v, i) => `LPT${i + 1}`),
]);
/**
 * Filesystem-safe filename generation across Windows/macOS/Linux.
 * Deterministic and predictable per docs/03-FEATURE-SPECIFICATION.md.
 */
export function sanitizeFilename(name, maxLength = 120) {
    // NFKD + strip combining marks → friendly ASCII-ish transliteration
    let out = name.normalize('NFKD').replace(/[\u0300-\u036F]/g, '');
    // eslint-disable-next-line no-control-regex -- control chars are exactly what we strip
    out = out.replace(/[\u0000-\u001F<>:"/\\|?*]/g, ' ');
    out = out.replace(/\.{2,}/g, '.'); // collapse traversal-looking dot runs
    out = out.replace(/\s+/g, ' ').trim();
    out = out.replace(/[. ]+$/g, ''); // Windows: no trailing dots/spaces
    if (WINDOWS_RESERVED.has(out.toUpperCase().split('.')[0] ?? ''))
        out = `_${out}`;
    if (out.length > maxLength)
        out = out.slice(0, maxLength).trimEnd().replace(/[. ]+$/g, '');
    return out;
}
/** Build "Creator - Title [1080p].mp4" style names with safe fallbacks. */
export function buildFileName(parts) {
    const segments = [];
    if (parts.creator)
        segments.push(sanitizeFilename(parts.creator, 60));
    segments.push(sanitizeFilename(parts.title || `${parts.platform}-media`, 100));
    let base = segments.filter(Boolean).join(' - ') || `${parts.platform}-media`;
    if (parts.heightOrLabel) {
        const label = typeof parts.heightOrLabel === 'number' ? heightToLabel(parts.heightOrLabel) : parts.heightOrLabel;
        base = `${base} [${sanitizeFilename(label, 20)}]`;
    }
    const ext = sanitizeFilename(parts.container || 'mp4', 10).replace(/\./g, '') || 'mp4';
    return `${base}.${ext}`;
}
//# sourceMappingURL=filename.js.map