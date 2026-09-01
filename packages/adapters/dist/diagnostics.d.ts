export interface SelfDiagnosticsResult {
    timestamp: string;
    platform: string;
    arch: string;
    nodeEnv: string;
    isRender: boolean;
    nodeRuntime: {
        execPath: string;
        version: string;
    };
    ytDlp: {
        binaryPath: string | null;
        version: string | null;
        source: string | null;
        jsRuntimeNodeSupported: boolean;
        jsRuntimeTestError?: string | null;
        versionWithJsRuntime?: string | null;
    };
    cookies: {
        configuredPath: string | null;
        cookiesConfigured: boolean;
        cookiesReadable: boolean;
    };
    testUrlResult?: {
        url: string;
        success: boolean;
        durationMs: number;
        exitCode: number | null;
        sanitizedStdoutTail?: string | null;
        sanitizedStderr?: string | null;
        title?: string | null;
        formatsCount?: number;
    } | null;
    ytDlpError?: string;
}
export declare function runSelfDiagnostics(testUrl?: string): Promise<SelfDiagnosticsResult>;
//# sourceMappingURL=diagnostics.d.ts.map