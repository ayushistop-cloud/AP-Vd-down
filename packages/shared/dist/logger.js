const LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT_KEY_PATTERN = /secret|password|passwd|token|cookie|authorization|api[-_]?key|credential/i;
function redact(value, depth = 0) {
    if (depth > 4)
        return '[deep]';
    if (value === null || value === undefined)
        return value;
    if (Array.isArray(value))
        return value.map((v) => redact(v, depth + 1));
    if (value instanceof Error) {
        return { name: value.name, message: value.message };
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = REDACT_KEY_PATTERN.test(k) ? '[redacted]' : redact(v, depth + 1);
        }
        return out;
    }
    return value;
}
export function createLogger(options) {
    const threshold = LEVEL_WEIGHT[options.level ?? 'info'];
    const base = { service: options.service, ...(options.base ?? {}) };
    function emit(level, msg, fields) {
        if (LEVEL_WEIGHT[level] < threshold)
            return;
        const line = {
            ts: new Date().toISOString(),
            level,
            ...redact(base),
            event: msg,
            ...(fields ? redact(fields) : {}),
        };
        const serialized = JSON.stringify(line);
        if (level === 'error')
            process.stderr.write(serialized + '\n');
        else
            process.stdout.write(serialized + '\n');
    }
    return {
        debug: (msg, fields) => emit('debug', msg, fields),
        info: (msg, fields) => emit('info', msg, fields),
        warn: (msg, fields) => emit('warn', msg, fields),
        error: (msg, fields) => emit('error', msg, fields),
        child: (bindings) => createLogger({
            service: options.service,
            level: options.level,
            base: { ...base, ...bindings },
        }),
    };
}
/** No-op logger for tests. */
export function silentLogger() {
    return createLogger({ service: 'test', level: 'error' });
}
//# sourceMappingURL=logger.js.map