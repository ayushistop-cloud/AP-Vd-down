import { type JobStore, type Logger, type MetricsRegistry, type ResolveRecord } from '@3ap/shared';
import type { AdapterRegistry } from '@3ap/adapters';
/**
 * Resolve orchestration (docs/12-API-SPEC.md POST /resolve).
 * Validates → detects platform → delegates to the adapter → caches a
 * short-lived resolve record that POST /jobs references.
 */
export interface ResolveOutcome {
    record: ResolveRecord;
    latencyMs: number;
}
export declare class ResolveService {
    private readonly adapters;
    private readonly store;
    private readonly options;
    constructor(adapters: AdapterRegistry, store: JobStore, options: {
        resolveTtlMs: number;
        ipPepper: string;
        log: Logger;
        metrics: MetricsRegistry;
    });
    resolve(rawUrl: string): Promise<ResolveOutcome>;
}
//# sourceMappingURL=resolve-service.d.ts.map