/**
 * In-memory sliding-window rate limiter (docs/24-RATE-LIMITING-ABUSE.md).
 * Keys are ephemeral and never persisted; memory is bounded by periodic sweep.
 */
export class SlidingWindowRateLimiter {
    options;
    buckets = new Map();
    sweepTimer = null;
    constructor(options) {
        this.options = options;
        this.sweepTimer = setInterval(() => this.sweep(), Math.max(30_000, options.windowMs));
        this.sweepTimer.unref?.();
    }
    get max() {
        return this.options.max;
    }
    check(key, now = Date.now()) {
        const windowStart = now - this.options.windowMs;
        let hits = this.buckets.get(key);
        if (!hits) {
            hits = [];
            this.buckets.set(key, hits);
        }
        while (hits.length > 0 && hits[0] <= windowStart)
            hits.shift();
        if (hits.length >= this.options.max) {
            const oldest = hits[0];
            return {
                allowed: false,
                remaining: 0,
                retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.options.windowMs - now) / 1000)),
            };
        }
        hits.push(now);
        return { allowed: true, remaining: this.options.max - hits.length, retryAfterSeconds: 0 };
    }
    /** Drop stale buckets so memory stays bounded under churn. */
    sweep(now = Date.now()) {
        const cutoff = now - this.options.windowMs * 2;
        for (const [key, hits] of this.buckets) {
            const recent = hits.filter((t) => t > cutoff);
            if (recent.length === 0)
                this.buckets.delete(key);
            else
                this.buckets.set(key, recent);
        }
    }
    stop() {
        if (this.sweepTimer)
            clearInterval(this.sweepTimer);
        this.sweepTimer = null;
        this.buckets.clear();
    }
}
//# sourceMappingURL=rate-limit.js.map