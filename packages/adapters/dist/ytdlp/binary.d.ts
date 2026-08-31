import { type Logger } from '@3ap/shared';
/**
 * Safe yt-dlp process integration.
 *
 * Binary discovery is deterministic and validated (docs/22-SECURITY.md,
 * operator runbook in README.md):
 *   1. YT_DLP_PATH environment variable
 *   2. project-local ./bin directory (populated by scripts/fetch-yt-dlp.mjs)
 *   3. system PATH scan
 * Every candidate must pass a live `--version` probe before it is trusted.
 * Arguments are ALWAYS passed as arrays; the shell is never used, so paths
 * with spaces and user-controlled URLs can never become command syntax.
 */
export interface JsRuntimeInfo {
    name: string;
    available: boolean;
    path?: string;
}
export declare function detectJsRuntime(): JsRuntimeInfo;
/**
 * Builds an augmented environment where PATH is guaranteed to include the
 * directory containing process.execPath so yt-dlp can locate Node.js as its
 * JS runtime (--js-runtimes node) across all deployment environments.
 */
export declare function getAugmentedEnv(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export interface EngineResolution {
    path: string;
    version: string;
    source: 'env' | 'local' | 'path';
    jsRuntime: JsRuntimeInfo;
}
export declare class EngineUnavailableError extends Error {
    readonly checked: readonly string[];
    constructor(message: string, checked: readonly string[]);
}
export interface ResolveEngineOptions {
    /** Override project-local bin discovery (tests). */
    localBinDirs?: readonly string[];
    /**
     * Version-string predicate applied to `--version` stdout. Defaults to
     * yt-dlp's CalVer format; tests may relax it when substituting another
     * executable for the probe. Production code must never loosen this.
     */
    isValidVersion?: (version: string) => boolean;
}
/**
 * Resolve and validate the yt-dlp engine.
 * Deterministic order: YT_DLP_PATH -> project-local bin -> PATH.
 * A successful resolution is cached per YT_DLP_PATH value; failures are NOT
 * cached so recovery after installation needs no restart.
 */
export declare function resolveYtDlpEngine(env?: NodeJS.ProcessEnv, options?: ResolveEngineOptions): Promise<EngineResolution>;
/** Ensure the engine exists or fail closed with a normalized user-safe error. */
export declare function requireBinary(configuredPath: string | undefined, log: Logger): Promise<string>;
/** Non-throwing startup check used by api/worker boot for operator logging. */
export declare function checkEngineAtBoot(log: Logger): Promise<void>;
export declare function resetBinaryCache(): void;
export declare function findFfmpegBinary(configuredPath?: string): Promise<string | null>;
export declare class YtDlpError extends Error {
    readonly exitCode: number | null;
    readonly stderrTail: string;
    readonly timedOut: boolean;
    constructor(message: string, exitCode: number | null, stderrTail: string, timedOut: boolean);
}
export interface RunYtDlpOptions {
    timeoutMs: number;
    abort?: AbortSignal;
    maxStdoutBytes?: number;
    cwd?: string;
    onStdoutLine?(line: string): void;
    onStderrLine?(line: string): void;
}
export interface RunYtDlpResult {
    stdout: string;
    durationMs: number;
}
export declare function runYtDlp(binary: string, args: string[], options: RunYtDlpOptions): Promise<RunYtDlpResult>;
//# sourceMappingURL=binary.d.ts.map