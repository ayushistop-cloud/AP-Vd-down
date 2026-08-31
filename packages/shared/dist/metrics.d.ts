/**
 * Lightweight in-process metrics registry (docs/27-OBSERVABILITY.md).
 * Counters, gauges and simple histograms exposed via GET /metrics.
 * For a 100–5,000 user deployment this avoids heavy metric infrastructure
 * while still enabling queue-depth / adapter-failure dashboards.
 */
type Labels = Record<string, string | number | undefined>;
export declare class MetricsRegistry {
    private readonly series;
    counter(name: string, help?: string, labels?: Labels): void;
    gauge(name: string, value: number, help?: string, labels?: Labels): void;
    observe(name: string, valueMs: number, help?: string): void;
    snapshot(): Record<string, unknown>;
}
export {};
//# sourceMappingURL=metrics.d.ts.map