/**
 * In-memory sliding-window rate limiter (docs/24-RATE-LIMITING-ABUSE.md).
 * Keys are ephemeral and never persisted; memory is bounded by periodic sweep.
 */
export interface RateLimitDecision {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
}
export interface RateLimiterOptions {
    windowMs: number;
    max: number;
}
export declare class SlidingWindowRateLimiter {
    private readonly options;
    private readonly buckets;
    private sweepTimer;
    constructor(options: RateLimiterOptions);
    get max(): number;
    check(key: string, now?: number): RateLimitDecision;
    /** Drop stale buckets so memory stays bounded under churn. */
    sweep(now?: number): void;
    stop(): void;
}
//# sourceMappingURL=rate-limit.d.ts.map