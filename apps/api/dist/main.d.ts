/**
 * API service entrypoint (docs/09-ARCHITECTURE.md — stateless API tier).
 * Supports two production modes:
 * - DOWNLOAD_EXECUTION_MODE=embedded: API + in-process download worker in one Render service (Free mode).
 * - DOWNLOAD_EXECUTION_MODE=distributed: Separate API and Redis/BullMQ worker services (Paid mode).
 */
export declare function startApi(): Promise<{
    stop: () => Promise<void>;
}>;
//# sourceMappingURL=main.d.ts.map