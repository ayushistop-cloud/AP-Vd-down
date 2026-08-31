import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveYtDlpEngine } from './ytdlp/binary.js';
import { getValidCookiesPath, sanitizeStderr } from './ytdlp/base.js';
const execFileAsync = promisify(execFile);
export async function runSelfDiagnostics(testUrl) {
    const result = {
        timestamp: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        nodeEnv: process.env.NODE_ENV || 'development',
        isRender: !!process.env.RENDER,
        nodeRuntime: {
            execPath: process.execPath,
            version: process.version,
        },
        ytDlp: {
            binaryPath: null,
            version: null,
            source: null,
            jsRuntimeNodeSupported: false,
            jsRuntimeTestError: null,
        },
        cookies: {
            configuredPath: getValidCookiesPath() || null,
        },
        testUrlResult: null,
    };
    try {
        const engine = await resolveYtDlpEngine();
        result.ytDlp.binaryPath = engine.path;
        result.ytDlp.version = engine.version;
        result.ytDlp.source = engine.source;
        // Test --js-runtimes node
        try {
            const { stdout } = await execFileAsync(engine.path, ['--js-runtimes', 'node', '--version'], { timeout: 10000 });
            result.ytDlp.jsRuntimeNodeSupported = true;
            result.ytDlp.versionWithJsRuntime = stdout.trim();
        }
        catch (jsErr) {
            result.ytDlp.jsRuntimeNodeSupported = false;
            result.ytDlp.jsRuntimeTestError = jsErr.message;
        }
        // Optional test dump for YouTube URL
        if (testUrl) {
            const testResult = {
                url: testUrl,
                success: false,
                durationMs: 0,
                exitCode: null,
                sanitizedStdoutTail: null,
                sanitizedStderr: null,
                title: null,
                formatsCount: 0,
            };
            const startTime = Date.now();
            const cookiesPath = getValidCookiesPath();
            const cookieArgs = cookiesPath ? ['--cookies', cookiesPath] : [];
            try {
                const { stdout } = await execFileAsync(engine.path, ['--dump-single-json', '--no-warnings', '--js-runtimes', 'node', ...cookieArgs, testUrl], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
                testResult.durationMs = Date.now() - startTime;
                testResult.success = true;
                testResult.exitCode = 0;
                const parsed = JSON.parse(stdout.trim());
                testResult.title = parsed.title;
                testResult.formatsCount = parsed.formats ? parsed.formats.length : 0;
                testResult.sanitizedStdoutTail = sanitizeStderr(stdout.trim().slice(-500));
            }
            catch (dumpErr) {
                testResult.durationMs = Date.now() - startTime;
                testResult.success = false;
                testResult.exitCode = dumpErr.code ?? 1;
                testResult.sanitizedStderr = sanitizeStderr(dumpErr.stderr || dumpErr.message);
            }
            result.testUrlResult = testResult;
        }
    }
    catch (err) {
        result.ytDlpError = err.message;
    }
    return result;
}
//# sourceMappingURL=diagnostics.js.map