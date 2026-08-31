import type { AppConfig, JobStore, Logger, MetricsRegistry } from '@3ap/shared';
import type { AdapterRegistry } from '@3ap/adapters';
import type { JobQueue } from '@3ap/queue';
export * from './processor.js';
export * from './storage.js';
export type { ArtifactStore } from './storage.js';
export interface WorkerDeps {
    config: AppConfig;
    store: JobStore;
    adapters: AdapterRegistry;
    queue: JobQueue;
    log: Logger;
    metrics: MetricsRegistry;
}
/**
 * Start the worker loop against injected dependencies (used both by the
 * standalone worker service and by the API's embedded dev worker).
 * Returns a stop function that ends consumption + cleanup scheduling.
 */
export declare function startEmbeddedWorker(deps: WorkerDeps): Promise<{
    stop: () => Promise<void>;
}>;
//# sourceMappingURL=index.d.ts.map