import { BASE_BACKOFF_MS, MAX_ATTEMPTS } from './types.js';
/**
 * In-process FIFO queue used when REDIS_URL is not configured (single-node
 * dev/small deployments). Implements the same retry/backoff semantics as the
 * BullMQ driver so worker behavior is identical across drivers.
 */
export class MemoryQueue {
    options;
    name;
    waiting = [];
    active = 0;
    running = false;
    closed = false;
    inFlight = new Set();
    timer = null;
    constructor(name, options) {
        this.options = options;
        this.name = name;
        if (options.maxAttempts !== MAX_ATTEMPTS || options.baseBackoffMs !== BASE_BACKOFF_MS) {
            options.logger.debug('queue retry policy overridden', { maxAttempts: options.maxAttempts });
        }
    }
    async enqueue(payload, opts) {
        if (this.closed)
            throw new Error('queue is closed');
        const runAt = Date.now() + (opts?.delayMs ?? 0);
        this.waiting.push({ payload: { ...payload, attempt: 0 }, runAt });
    }
    async process(handler) {
        if (this.running)
            throw new Error('process already registered');
        this.running = true;
        for (;;) {
            if (this.closed)
                break;
            const now = Date.now();
            const index = this.waiting.findIndex((entry) => entry.runAt <= now);
            if (index === -1 || this.active >= this.options.concurrency) {
                await this.waitForNext(index === -1 ? this.nextRunDelay() : 25);
                continue;
            }
            const entry = this.waiting.splice(index, 1)[0];
            this.active += 1;
            const run = this.runWithRetry(entry.payload, handler)
                .catch(() => undefined) // retries/failures are fully handled inside
                .finally(() => {
                this.active -= 1;
                this.inFlight.delete(run);
            });
            this.inFlight.add(run);
        }
        await Promise.allSettled([...this.inFlight]);
    }
    async depth() {
        return { waiting: this.waiting.length, active: this.active };
    }
    async close() {
        this.closed = true;
        if (this.timer)
            clearTimeout(this.timer);
        await Promise.allSettled([...this.inFlight]);
    }
    nextRunDelay() {
        if (this.waiting.length === 0)
            return 200;
        return Math.max(10, Math.min(...this.waiting.map((w) => w.runAt)) - Date.now());
    }
    waitForNext(delayMs) {
        return new Promise((resolve) => {
            this.timer = setTimeout(resolve, delayMs);
            this.timer.unref?.();
        });
    }
    async runWithRetry(payload, handler) {
        let current = payload;
        for (;;) {
            try {
                await handler(current);
                return;
            }
            catch (err) {
                const retryable = err.retryable === true;
                if (!retryable || current.attempt + 1 >= this.options.maxAttempts) {
                    this.options.logger.warn('job dropped after final attempt', {
                        jobId: current.jobId,
                        itemId: current.itemId,
                        attempt: current.attempt + 1,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    return;
                }
                const delay = this.options.baseBackoffMs * 2 ** current.attempt;
                this.options.logger.info('retrying job with backoff', {
                    jobId: current.jobId,
                    itemId: current.itemId,
                    nextAttempt: current.attempt + 1,
                    delayMs: delay,
                });
                current = { ...current, attempt: current.attempt + 1 };
                await new Promise((resolve) => setTimeout(resolve, delay).unref?.());
            }
        }
    }
}
//# sourceMappingURL=memory.js.map