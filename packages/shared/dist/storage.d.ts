/**
 * Artifact keys are `${jobId}/${itemId}/${fileName}`. This helper guarantees
 * the resolved path stays inside the artifact root (path-traversal defense,
 * docs/22-SECURITY.md) before any filesystem access.
 */
export declare function safeArtifactPath(root: string, key: string): string | null;
/** Build a canonical artifact key from its parts (all parts get validated). */
export declare function artifactKeyOf(jobId: string, itemId: string, fileName: string): string | null;
//# sourceMappingURL=storage.d.ts.map