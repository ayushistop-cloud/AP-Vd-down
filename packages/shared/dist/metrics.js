/**
 * Lightweight in-process metrics registry (docs/27-OBSERVABILITY.md).
 * Counters, gauges and simple histograms exposed via GET /metrics.
 * For a 100–5,000 user deployment this avoids heavy metric infrastructure
 * while still enabling queue-depth / adapter-failure dashboards.
 */
function seriesKey(name, labels) {
    if (!labels || Object.keys(labels).length === 0)
        return name;
    const parts = Object.keys(labels)
        .sort()
        .map((k) => `${k}=${String(labels[k])}`)
        .join(',');
    return `${name}{${parts}}`;
}
const DEFAULT_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
export class MetricsRegistry {
    series = new Map();
    counter(name, help = '', labels) {
        let s = this.series.get(name);
        if (!s) {
            s = { help, type: 'counter', values: new Map(), counts: [], bounds: [], sum: 0, totalCount: 0 };
            this.series.set(name, s);
        }
        const key = seriesKey(name, labels);
        s.values.set(key, (s.values.get(key) ?? 0) + 1);
    }
    gauge(name, value, help = '', labels) {
        let s = this.series.get(name);
        if (!s) {
            s = { help, type: 'gauge', values: new Map(), counts: [], bounds: [], sum: 0, totalCount: 0 };
            this.series.set(name, s);
        }
        s.values.set(seriesKey(name, labels), value);
    }
    observe(name, valueMs, help = '') {
        let s = this.series.get(name);
        if (!s || s.type !== 'histogram') {
            s = {
                help,
                type: 'histogram',
                values: new Map(),
                counts: new Array(DEFAULT_BOUNDS.length + 1).fill(0),
                bounds: DEFAULT_BOUNDS,
                sum: 0,
                totalCount: 0,
            };
            this.series.set(name, s);
        }
        let bucket = s.bounds.findIndex((b) => valueMs <= b);
        if (bucket === -1)
            bucket = s.bounds.length;
        s.counts[bucket] = (s.counts[bucket] ?? 0) + 1;
        s.sum += valueMs;
        s.totalCount += 1;
    }
    snapshot() {
        const out = {};
        for (const [name, s] of this.series) {
            if (s.type === 'histogram') {
                let acc = 0;
                const cumulative = {};
                s.bounds.forEach((b, i) => {
                    acc += s.counts[i] ?? 0;
                    cumulative[`le_${b}`] = acc;
                });
                cumulative['le_inf'] = s.totalCount;
                out[name] = { type: s.type, count: s.totalCount, sumMs: Math.round(s.sum * 100) / 100, buckets: cumulative };
            }
            else {
                for (const [key, value] of s.values)
                    out[key] = value;
            }
        }
        return out;
    }
}
//# sourceMappingURL=metrics.js.map