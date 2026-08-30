import { z } from 'zod';
/**
 * Environment configuration for api + worker (docs/28-DEPLOYMENT.md).
 * Secrets only via environment; sensible local defaults; explicit failure
 * when a required production setting is missing.
 */
const boolSchema = z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1');
const intSchema = (fallback, min, max) => z
    .string()
    .optional()
    .transform((v) => {
    if (v === undefined || v.trim() === '')
        return fallback;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, n));
});
const envSchema = z.object({
    NODE_ENV: z.enum(['local', 'staging', 'production']).default('local'),
    DOWNLOAD_EXECUTION_MODE: z.enum(['embedded', 'distributed']).default('distributed'),
    API_PORT: intSchema(8787, 1, 65535),
    API_HOST: z.string().default('127.0.0.1'),
    WEB_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
    PUBLIC_APP_URL: z.string().optional(),
    TRUST_PROXY: boolSchema,
    DOWNLOAD_TOKEN_SECRET: z.string().min(16).default('dev-only-secret-change-me'),
    IP_HASH_PEPPER: z.string().min(8).default('dev-only-pepper-change-me'),
    DATABASE_URL: z.string().optional(),
    REDIS_URL: z.string().optional(),
    ARTIFACT_STORAGE: z.enum(['local', 's3']).default('local'),
    ARTIFACT_ROOT: z.string().default('./data/artifacts'),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    ARTIFACT_TTL_MINUTES: intSchema(30, 5, 24 * 60),
    RESOLVE_TTL_MINUTES: intSchema(15, 1, 60),
    MAX_FILE_SIZE_MB: intSchema(500, 1, 4096),
    MAX_PLAYLIST_ITEMS: intSchema(50, 1, 50),
    JOB_TIMEOUT_SECONDS: intSchema(600, 30, 3600),
    MAX_CONCURRENT_JOBS_PER_IP: intSchema(3, 1, 20),
    RATE_RESOLVE_PER_MINUTE: intSchema(20, 1, 1000),
    RATE_JOB_CREATE_PER_MINUTE: intSchema(10, 1, 500),
    RATE_DOWNLOAD_PER_MINUTE: intSchema(60, 1, 2000),
    WORKER_CONCURRENCY_GLOBAL: intSchema(4, 1, 32),
    WORKER_CONCURRENCY_YOUTUBE: intSchema(2, 1, 16),
    WORKER_CONCURRENCY_TIKTOK: intSchema(2, 1, 16),
    WORKER_CONCURRENCY_INSTAGRAM: intSchema(2, 1, 16),
    WORKER_CONCURRENCY_FACEBOOK: intSchema(2, 1, 16),
    WORKER_CONCURRENCY_TERABOX: intSchema(1, 1, 8),
    YT_DLP_PATH: z.string().optional(),
    FFMPEG_PATH: z.string().optional(),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});
let cached;
export function loadConfig(env = process.env) {
    if (cached && env === process.env)
        return cached;
    // Support Render's standard PORT environment variable as API_PORT fallback
    const normalizedEnv = { ...env };
    if (env.PORT && !env.API_PORT) {
        normalizedEnv.API_PORT = env.PORT;
    }
    const parsed = envSchema.parse(normalizedEnv);
    if (parsed.NODE_ENV === 'production' || parsed.NODE_ENV === 'staging') {
        const missing = [];
        if (!env.DATABASE_URL || env.DATABASE_URL.trim() === '') {
            missing.push('DATABASE_URL (PostgreSQL connection string)');
        }
        // REDIS_URL is mandatory ONLY in distributed execution mode.
        // In embedded mode, single Render service processes jobs in-process without Redis.
        if (parsed.DOWNLOAD_EXECUTION_MODE === 'distributed') {
            if (!env.REDIS_URL || env.REDIS_URL.trim() === '') {
                missing.push('REDIS_URL (required when DOWNLOAD_EXECUTION_MODE=distributed)');
            }
        }
        if (!env.DOWNLOAD_TOKEN_SECRET || env.DOWNLOAD_TOKEN_SECRET.startsWith('dev-only') || env.DOWNLOAD_TOKEN_SECRET.length < 16) {
            missing.push('DOWNLOAD_TOKEN_SECRET (must be a strong random secret of at least 16 characters)');
        }
        if (!env.IP_HASH_PEPPER || env.IP_HASH_PEPPER.startsWith('dev-only') || env.IP_HASH_PEPPER.length < 8) {
            missing.push('IP_HASH_PEPPER (must be a strong secret salt of at least 8 characters)');
        }
        if (!env.WEB_ORIGINS || env.WEB_ORIGINS.includes('localhost') || env.WEB_ORIGINS.includes('127.0.0.1')) {
            missing.push('WEB_ORIGINS (must specify production web origin URLs, e.g. https://example.com)');
        }
        if (parsed.ARTIFACT_STORAGE === 's3') {
            if (!env.S3_BUCKET)
                missing.push('S3_BUCKET (required when ARTIFACT_STORAGE=s3)');
            if (!env.S3_ACCESS_KEY_ID)
                missing.push('S3_ACCESS_KEY_ID (required when ARTIFACT_STORAGE=s3)');
            if (!env.S3_SECRET_ACCESS_KEY)
                missing.push('S3_SECRET_ACCESS_KEY (required when ARTIFACT_STORAGE=s3)');
        }
        if (missing.length > 0) {
            const msg = `FATAL: Invalid production configuration for NODE_ENV=${parsed.NODE_ENV}.\nMissing or invalid required settings:\n- ${missing.join('\n- ')}`;
            console.error(msg);
            throw new Error(msg);
        }
    }
    cached = parsed;
    return parsed;
}
/** Per-platform worker concurrency derived from config. */
export function platformConcurrency(config) {
    return {
        youtube: config.WORKER_CONCURRENCY_YOUTUBE,
        tiktok: config.WORKER_CONCURRENCY_TIKTOK,
        instagram: config.WORKER_CONCURRENCY_INSTAGRAM,
        facebook: config.WORKER_CONCURRENCY_FACEBOOK,
        terabox: config.WORKER_CONCURRENCY_TERABOX,
    };
}
//# sourceMappingURL=config.js.map