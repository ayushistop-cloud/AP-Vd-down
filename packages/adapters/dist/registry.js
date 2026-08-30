import { appErrors } from '@3ap/shared';
export function createAdapterRegistry(adapters) {
    const byPlatform = new Map(adapters.map((a) => [a.platform, a]));
    return {
        all: () => adapters,
        get: (platform) => {
            const adapter = byPlatform.get(platform);
            if (!adapter)
                throw appErrors.unsupported();
            return adapter;
        },
        forUrl: (url) => {
            for (const adapter of adapters) {
                if (adapter.canHandle(url))
                    return adapter;
            }
            throw appErrors.unsupported();
        },
    };
}
//# sourceMappingURL=registry.js.map