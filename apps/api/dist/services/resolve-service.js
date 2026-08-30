import { appErrors, canonicalizeUrl, parsePlatformUrl, newId, normalizeUrlInput, assertPublicHttpUrl, } from '@3ap/shared';
const RESOLVE_HARD_TIMEOUT_MS = 60_000;
export class ResolveService {
    adapters;
    store;
    options;
    constructor(adapters, store, options) {
        this.adapters = adapters;
        this.store = store;
        this.options = options;
    }
    async resolve(rawUrl) {
        const started = Date.now();
        // 1. Normalize & validate (fail fast before any network work).
        const normalized = normalizeUrlInput(rawUrl);
        if (!normalized)
            throw appErrors.invalidUrl('Paste a link to get started.');
        const platformInfo = parsePlatformUrl(normalized);
        if (!platformInfo)
            throw appErrors.unsupported();
        const platform = platformInfo.provider;
        assertPublicHttpUrl(normalized);
        // 2. Route to adapter (fails closed with UNSUPPORTED).
        const canonical = canonicalizeUrl(normalized);
        const adapter = this.adapters.forUrl(canonical);
        if (!adapter.canHandle(canonical))
            throw appErrors.unsupported();
        // 3. Resolve metadata through the adapter with a hard timeout.
        let output;
        try {
            output = await Promise.race([
                adapter.resolve(canonical),
                new Promise((_resolve, reject) => setTimeout(() => reject(appErrors.temporaryProviderError('Resolving this link took too long.')), RESOLVE_HARD_TIMEOUT_MS)),
            ]);
        }
        catch (err) {
            const appErr = adapter.normalizeError(err);
            this.options.metrics.counter('adapter_events_total', 'adapter outcomes', {
                platform,
                event: 'resolve',
                outcome: appErr.code,
            });
            throw appErr;
        }
        const latencyMs = Date.now() - started;
        const record = {
            resolveId: newId(),
            platform: output.platform,
            canonicalUrl: output.canonicalUrl,
            title: output.title,
            creator: output.creator,
            thumbnailUrl: output.thumbnailUrl,
            durationSeconds: output.durationSeconds,
            kind: output.kind,
            items: output.items,
            capabilities: output.capabilities,
            createdAt: Date.now(),
            expiresAt: Date.now() + this.options.resolveTtlMs,
        };
        await this.store.saveResolve(record);
        await this.store.recordAdapterEvent({
            platform,
            eventType: 'resolve',
            jobId: null,
            latencyMs,
            success: true,
            errorCode: null,
        });
        this.options.metrics.counter('resolve_total', 'resolve attempts', { platform, outcome: 'ok' });
        this.options.metrics.observe('resolve_latency_ms', latencyMs, 'time to resolve provider metadata');
        return { record, latencyMs };
    }
}
//# sourceMappingURL=resolve-service.js.map