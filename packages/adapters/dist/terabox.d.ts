import { type AdapterCapabilities, type AppError } from '@3ap/shared';
import type { DownloadRequest, DownloadTaskContext, DownloadTaskResult, MediaAdapter, ResolveOutput } from './contract.js';
export declare function normalizeTeraboxShortKey(raw: string): string;
export declare class TeraboxAdapter implements MediaAdapter {
    readonly platform: "terabox";
    getCapabilities(): AdapterCapabilities;
    canHandle(url: string): boolean;
    normalizeError(error: unknown): AppError;
    resolve(rawUrl: string): Promise<ResolveOutput>;
    createDownloadTask(request: DownloadRequest, ctx: DownloadTaskContext): Promise<DownloadTaskResult>;
    private api;
}
/** Map provider errno onto stable error codes; fail closed otherwise. NOT_PUBLIC only when proven. */
export declare function mapTeraboxErrno(errno: number, rawInfo?: unknown): AppError;
export declare function detectTeraboxMediaType(filename: string, category?: number | string): {
    kind: 'video+audio' | 'video' | 'audio' | 'file';
    playable: boolean;
    mimeType?: string;
};
//# sourceMappingURL=terabox.d.ts.map