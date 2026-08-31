/**
 * Minimal structured JSON logger (docs/27-OBSERVABILITY.md).
 * Every line is a single JSON object on stdout with timestamp, service,
 * correlation ids and a normalized error code when applicable.
 * Secret-looking fields are redacted defensively.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
    child(bindings: Record<string, unknown>): Logger;
}
export interface LoggerOptions {
    service: string;
    level?: LogLevel;
    base?: Record<string, unknown>;
}
export declare function createLogger(options: LoggerOptions): Logger;
/** No-op logger for tests. */
export declare function silentLogger(): Logger;
//# sourceMappingURL=logger.d.ts.map