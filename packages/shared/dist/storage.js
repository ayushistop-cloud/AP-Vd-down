import { isAbsolute, join } from 'node:path';
/**
 * Artifact keys are `${jobId}/${itemId}/${fileName}`. This helper guarantees
 * the resolved path stays inside the artifact root (path-traversal defense,
 * docs/22-SECURITY.md) before any filesystem access.
 */
export function safeArtifactPath(root, key) {
    if (!key)
        return null;
    const normalized = key.replace(/\\/g, '/');
    // Reject traversal, absolute paths, and anything outside a conservative charset.
    if (normalized.startsWith('/') || normalized.split('/').some((seg) => seg === '..' || seg === ''))
        return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9/_.\- ]{0,300}$/.test(normalized))
        return null;
    const full = join(root, ...normalized.split('/'));
    if (isAbsolute(key))
        return null;
    return full;
}
/** Build a canonical artifact key from its parts (all parts get validated). */
export function artifactKeyOf(jobId, itemId, fileName) {
    const safeName = fileName.replace(/[^A-Za-z0-9._\- ]+/g, '_');
    if (!jobId || !itemId || !safeName || safeName === '.' || safeName === '..')
        return null;
    return `${jobId}/${itemId}/${safeName}`;
}
//# sourceMappingURL=storage.js.map