import { type AppConfig, type JobStore, type Logger, type MetricsRegistry } from '@3ap/shared';
import type { AdapterRegistry } from '@3ap/adapters';
import { type QueuePayload } from '@3ap/queue';
import type { ArtifactStore } from './storage.js';
/**
 * Worker pipeline (docs/20-DOWNLOAD-PIPELINE.md stages 7–13).
 *
 * Retry protocol with the queue: the handler throws a `retryable` error only
 * for transient failures while attempts remain; terminal failures are
 * persisted here and swallowed so the queue does not re-run them.
 */
export interface ProcessorDeps {
    config: AppConfig;
    store: JobStore;
    adapters: AdapterRegistry;
    artifacts: ArtifactStore;
    log: Logger;
    metrics: MetricsRegistry;
}
export declare function createJobHandler(deps: ProcessorDeps): (payload: QueuePayload) => Promise<void>;
/**
 * When every item reached a terminal state, close out the job:
 * completed (≥1 succeeded), cancelled, or failed. Completed jobs get their
 * expiration timestamp and lose raw source URLs immediately (privacy).
 */
export declare function finalizeIfDone(deps: ProcessorDeps, jobId: string): Promise<void>;
//# sourceMappingURL=processor.d.ts.map