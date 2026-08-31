import type { MediaAdapter } from './contract.js';
export interface AdapterRegistry {
    all(): readonly MediaAdapter[];
    get(platform: MediaAdapter['platform']): MediaAdapter;
    /** Route a URL to its adapter or fail closed with UNSUPPORTED. */
    forUrl(url: string): MediaAdapter;
}
export declare function createAdapterRegistry(adapters: readonly MediaAdapter[]): AdapterRegistry;
//# sourceMappingURL=registry.d.ts.map