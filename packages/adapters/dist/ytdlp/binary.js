import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appErrors } from '@3ap/shared';
export function detectJsRuntime() {
    if (process.execPath) {
        return { name: 'node', available: true, path: process.execPath };
    }
    return { name: 'none', available: false };
}
/**
 * Builds an augmented environment where PATH is guaranteed to include the
 * directory containing process.execPath so yt-dlp can locate Node.js as its
 * JS runtime (--js-runtimes node) across all deployment environments.
 */
export function getAugmentedEnv(baseEnv = process.env) {
    const env = { ...baseEnv };
    if (process.execPath) {
        const nodeDir = dirname(process.execPath);
        const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
        const currentPath = env[pathKey] || '';
        const sep = process.platform === 'win32' ? ';' : ':';
        if (!currentPath.split(sep).includes(nodeDir)) {
            env[pathKey] = currentPath ? `${nodeDir}${sep}${currentPath}` : nodeDir;
        }
    }
    return env;
}
export class EngineUnavailableError extends Error {
    checked;
    constructor(message, checked) {
        super(message);
        this.checked = checked;
        this.name = 'EngineUnavailableError';
    }
}
/** Run `<binary> --version` and require exit 0 plus a plausible version line. */
function probeVersion(binary, timeoutMs = 10_000) {
    return new Promise((resolve) => {
        let stdout = '';
        let settled = false;
        const done = (result) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(result);
            }
        };
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            }
            catch {
                /* already gone */
            }
            done({ ok: false, reason: 'version probe timed out' });
        }, timeoutMs);
        let child;
        try {
            // shell:false is mandatory — the path may contain spaces; args are an array.
            child = spawn(binary, ['--version'], { shell: false, windowsHide: true, env: getAugmentedEnv() });
        }
        catch (err) {
            done({ ok: false, reason: `could not start process (${err.message})` });
            return;
        }
        child.stdout?.on('data', (chunk) => {
            if (stdout.length < 4096)
                stdout += chunk.toString('utf8');
        });
        child.on('error', (err) => done({ ok: false, reason: err.message }));
        child.on('close', (code) => {
            const version = stdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
            if (code === 0 && version.length > 0) {
                // Version-format policy is applied by the caller (isYtDlpVersion).
                done({ ok: true, version });
            }
            else if (code === 0) {
                done({ ok: false, reason: 'empty --version output' });
            }
            else {
                done({ ok: false, reason: `exited with code ${code}` });
            }
        });
    });
}
/* ── candidate enumeration ───────────────────────────────────────────────── */
const WINDOWS = process.platform === 'win32';
/** Strip surrounding quotes ("copy as path" on Windows adds them). */
function unquote(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
/**
 * Project-local bin directory: walk upward from process.cwd() and this module
 * so source layouts (src via tsx), compiled layouts (dist), and subpackage
 * workdirs (apps/api, apps/worker) all reliably locate the repo root ./bin.
 */
function localBinDirs() {
    const dirs = [];
    const addIfExist = (dir) => {
        if (existsSync(dir) && !dirs.includes(dir)) {
            dirs.push(dir);
        }
    };
    try {
        let cwd = process.cwd();
        for (let depth = 0; depth < 8; depth++) {
            addIfExist(join(cwd, 'bin'));
            const parent = dirname(cwd);
            if (parent === cwd)
                break;
            cwd = parent;
        }
    }
    catch {
        /* ignore */
    }
    try {
        let dir = dirname(fileURLToPath(import.meta.url));
        for (let depth = 0; depth < 8; depth++) {
            addIfExist(join(dir, 'bin'));
            const parent = dirname(dir);
            if (parent === dir)
                break;
            dir = parent;
        }
    }
    catch {
        /* ignore */
    }
    return dirs;
}
function* candidatePaths(env, localDirs = localBinDirs()) {
    const configured = env.YT_DLP_PATH ? unquote(env.YT_DLP_PATH) : '';
    if (configured)
        yield { path: configured, source: 'env' };
    const localNames = WINDOWS
        ? ['yt-dlp.exe', 'yt-dlp', 'yt-dlp_win32.exe']
        : ['yt-dlp', 'yt-dlp_linux', 'yt-dlp_macos'];
    for (const binDir of localDirs) {
        for (const name of localNames) {
            yield { path: join(binDir, name), source: 'local' };
        }
    }
    const pathEntry = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH');
    const rawPath = pathEntry ? pathEntry[1] ?? '' : '';
    const seenDirs = new Set();
    for (const dir of rawPath.split(WINDOWS ? ';' : ':')) {
        if (!dir || seenDirs.has(dir))
            continue;
        seenDirs.add(dir);
        // Only real executables are considered. .cmd/.bat shims are deliberately
        // skipped: spawning them safely requires a shell, which this service never
        // uses (docs/22-SECURITY.md). pip/winget installs provide native binaries.
        for (const name of WINDOWS ? ['yt-dlp.exe', 'yt-dlp'] : ['yt-dlp']) {
            yield { path: join(dir, name), source: 'path' };
        }
    }
}
/* ── resolution ──────────────────────────────────────────────────────────── */
const cache = new Map();
/** yt-dlp releases are CalVer (YYYY.MM.DD[.N]). */
function isYtDlpVersion(version) {
    return /^\d{4}\.\d{2}\.\d{2}/.test(version);
}
/**
 * Resolve and validate the yt-dlp engine.
 * Deterministic order: YT_DLP_PATH -> project-local bin -> PATH.
 * A successful resolution is cached per YT_DLP_PATH value; failures are NOT
 * cached so recovery after installation needs no restart.
 */
export async function resolveYtDlpEngine(env = process.env, options = {}) {
    const cacheKey = `${env.YT_DLP_PATH ?? ''}|${options.localBinDirs ? 'custom' : 'default'}`;
    const cached = cache.get(cacheKey);
    if (cached && !options.localBinDirs)
        return cached;
    const versionOk = options.isValidVersion ?? isYtDlpVersion;
    const checked = [];
    const problems = [];
    for (const { path, source } of candidatePaths(env, options.localBinDirs)) {
        checked.push(`${path} (${source})`);
        if (!existsSync(path)) {
            problems.push(`not found: ${path}`);
            continue;
        }
        const probe = await probeVersion(path);
        if (!probe.ok) {
            problems.push(`not usable: ${path} (${probe.reason})`);
            continue;
        }
        if (!versionOk(probe.version)) {
            problems.push(`not a yt-dlp executable: ${path} (reported "${probe.version.slice(0, 60)}")`);
            continue;
        }
        const resolution = { path, version: probe.version, source, jsRuntime: detectJsRuntime() };
        cache.set(cacheKey, resolution);
        return resolution;
    }
    throw new EngineUnavailableError([
        'yt-dlp executable was not found or could not be executed.',
        'Checked:',
        ...(checked.length > 0
            ? checked.map((c) => `  - ${c}`)
            : ['  - (no candidates configured; PATH empty and no YT_DLP_PATH)']),
        ...problems.map((p) => `    ${p}`),
        'Fix: install yt-dlp (https://github.com/yt-dlp/yt-dlp#installation),',
        "run 'npm run setup:engine', or set YT_DLP_PATH to the full executable path.",
    ].join('\n'), checked);
}
/** Ensure the engine exists or fail closed with a normalized user-safe error. */
export async function requireBinary(configuredPath, log) {
    try {
        const engine = await resolveYtDlpEngine({ ...process.env, ...(configuredPath ? { YT_DLP_PATH: configuredPath } : {}) });
        log.info('download engine ready', { version: engine.version, source: engine.source, jsRuntime: engine.jsRuntime.name });
        return engine.path;
    }
    catch (err) {
        if (err instanceof EngineUnavailableError) {
            log.error(err.message); // full diagnostics stay in server logs
            throw appErrors.engineUnavailable();
        }
        throw err;
    }
}
/** Non-throwing startup check used by api/worker boot for operator logging. */
export async function checkEngineAtBoot(log) {
    try {
        const engine = await resolveYtDlpEngine();
        log.info('download engine available', { version: engine.version, source: engine.source, jsRuntime: engine.jsRuntime.name });
    }
    catch (err) {
        if (err instanceof EngineUnavailableError) {
            log.warn('download engine unavailable at boot; resolve/download requests will fail until it is installed', {
                hint: "install yt-dlp or run 'npm run setup:engine' or set YT_DLP_PATH",
                checked: err.checked.length,
            });
        }
        else {
            log.error('download engine check failed unexpectedly', { message: err.message });
        }
    }
}
export function resetBinaryCache() {
    cache.clear();
    cachedFfmpeg = undefined;
}
/* ── ffmpeg (unchanged semantics, kept minimal) ──────────────────────────── */
let cachedFfmpeg;
async function probeOk(binary, args, timeoutMs = 8000) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (ok) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(ok);
            }
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        try {
            const child = spawn(binary, args, { shell: false, windowsHide: true });
            child.on('error', () => done(false));
            child.on('close', (code) => done(code === 0));
        }
        catch {
            done(false);
        }
    });
}
export async function findFfmpegBinary(configuredPath) {
    if (cachedFfmpeg !== undefined)
        return cachedFfmpeg;
    const candidates = [];
    if (configuredPath)
        candidates.push(unquote(configuredPath));
    for (const binDir of localBinDirs()) {
        candidates.push(join(binDir, WINDOWS ? 'ffmpeg.exe' : 'ffmpeg'));
    }
    candidates.push(WINDOWS ? 'ffmpeg' : 'ffmpeg');
    for (const candidate of candidates) {
        if (candidate.includes('\\') || candidate.includes('/')) {
            if (!existsSync(candidate))
                continue;
        }
        if (await probeOk(candidate, ['-version'])) {
            cachedFfmpeg = candidate;
            return cachedFfmpeg;
        }
    }
    cachedFfmpeg = null;
    return cachedFfmpeg;
}
export class YtDlpError extends Error {
    exitCode;
    stderrTail;
    timedOut;
    constructor(message, exitCode, stderrTail, timedOut) {
        super(message);
        this.exitCode = exitCode;
        this.stderrTail = stderrTail;
        this.timedOut = timedOut;
        this.name = 'YtDlpError';
    }
}
export async function runYtDlp(binary, args, options) {
    const maxStdout = options.maxStdoutBytes ?? 64 * 1024 * 1024;
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { shell: false, windowsHide: true, cwd: options.cwd, env: getAugmentedEnv() });
        let stdout = Buffer.alloc(0);
        let stderrTail = '';
        let killedForTimeout = false;
        let settled = false;
        const finish = (fn) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                options.abort?.removeEventListener('abort', onAbort);
                clearInterval(cancelPoller);
                fn();
            }
        };
        const kill = () => {
            try {
                child.kill('SIGTERM');
                setTimeout(() => child.kill('SIGKILL'), 3000).unref();
            }
            catch {
                /* already gone */
            }
        };
        const timer = setTimeout(() => {
            killedForTimeout = true;
            kill();
        }, options.timeoutMs);
        const onAbort = () => kill();
        options.abort?.addEventListener('abort', onAbort, { once: true });
        // Cancellation is polled because adapters may rely on store state.
        const cancelPoller = setInterval(() => {
            if (options.abort?.aborted)
                kill();
        }, 500);
        cancelPoller.unref?.();
        child.stdout.on('data', (chunk) => {
            stdout = Buffer.concat([stdout, chunk]);
            if (stdout.byteLength > maxStdout) {
                kill();
                finish(() => reject(new YtDlpError('stdout limit exceeded', null, '', false)));
                return;
            }
        });
        let lineBuf = '';
        child.stdout.on('data', (chunk) => {
            lineBuf += chunk.toString('utf8');
            let idx;
            while ((idx = lineBuf.indexOf('\n')) >= 0) {
                const line = lineBuf.slice(0, idx).replace(/\r$/, '');
                lineBuf = lineBuf.slice(idx + 1);
                options.onStdoutLine?.(line);
            }
        });
        child.stdout.on('end', () => {
            if (lineBuf)
                options.onStdoutLine?.(lineBuf.replace(/\r$/, ''));
        });
        child.stderr.on('data', (chunk) => {
            stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
            options.onStderrLine?.(chunk.toString('utf8'));
        });
        child.on('error', (err) => {
            finish(() => reject(new YtDlpError(`spawn failed: ${err.message}`, null, '', false)));
        });
        child.on('close', (code) => {
            if (killedForTimeout) {
                finish(() => reject(new YtDlpError('process timed out', code, stderrTail, true)));
            }
            else if (code === 0 || (code === null && stdout.length > 0)) {
                finish(() => resolve({ stdout: stdout.toString('utf8'), durationMs: Date.now() - started }));
            }
            else {
                finish(() => reject(new YtDlpError(`exit ${code}`, code, stderrTail, false)));
            }
        });
    });
}
//# sourceMappingURL=binary.js.map