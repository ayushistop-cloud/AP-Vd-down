import { Queue, Worker } from 'bullmq';
/**
 * BullMQ-backed queue driver for Redis deployments (docs/10-TECH-STACK.md).
 * Retry/backoff mirrors MemoryQueue so worker behavior is consistent.
 */
const QUEUE_NAME = 'downloads';
export class BullMqQueue {
    options;
    name = QUEUE_NAME;
    queue;
    worker = null;
    constructor(connection, options) {
        this.options = options;
        this.queue = new Queue(QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                attempts: options.maxAttempts,
                backoff: { type: 'exponential', delay: options.baseBackoffMs },
                removeOnComplete: { age: 3600, count: 1000 },
                removeOnFail: { age: 24 * 3600 },
            },
        });
    }
    async waitUntilReady() {
        await this.queue.waitUntilReady();
    }
    async enqueue(payload) {
        await this.queue.add('download', { ...payload, attempt: 0 });
    }
    async process(handler) {
        const connection = (this.queue.opts.connection ?? {});
        this.worker = new Worker(QUEUE_NAME, async (job) => handler({ ...job.data, attempt: job.attemptsMade }), { connection, concurrency: this.options.concurrency });
        this.worker.on('failed', (job, err) => {
            this.options.logger.warn('queue job failed', {
                jobId: job?.data?.jobId,
                itemId: job?.data?.itemId,
                attempt: job?.attemptsMade,
                error: err.message,
            });
        });
        await this.worker.waitUntilReady();
    }
    async depth() {
        const counts = await this.queue.getJobCounts('waiting', 'active');
        return { waiting: counts.waiting ?? 0, active: counts.active ?? 0 };
    }
    async close() {
        await this.worker?.close().catch(() => undefined);
        await this.queue.close();
        this.options.logger.info('bullmq queue closed');
    }
}
//# sourceMappingURL=bullmq.js.map