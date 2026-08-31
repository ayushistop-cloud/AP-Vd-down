import { type FastifyInstance } from 'fastify';
import { type AppConfig, type JobStore, type Logger, type MetricsRegistry } from '@3ap/shared';
import { type AdapterRegistry } from '@3ap/adapters';
import type { JobQueue } from '@3ap/queue';
export interface AppDependencies {
    config: AppConfig;
    store: JobStore;
    adapters: AdapterRegistry;
    queue: JobQueue;
    log: Logger;
    metrics: MetricsRegistry;
}
/** Build a fully wired API instance. Dependencies are injected for tests. */
export declare function buildApp(deps: AppDependencies): Promise<FastifyInstance>;
//# sourceMappingURL=app.d.ts.map