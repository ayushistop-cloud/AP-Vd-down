import type { JobApiResponse, JobItemApiView, JobItemRow, JobRow, MediaFormat, ResolveRecord, ResolveResponse } from '@3ap/shared';
export type { JobApiResponse, JobItemApiView, ResolveResponse };
/** Public format view (excludes adapter-internal fields, includes API-generated fields). */
export interface PublicFormatView extends Omit<MediaFormat, 'sourceSelector'> {
    /** Streaming URL for in-browser playback (requires valid token). */
    streamUrl?: string;
}
/** Strip adapter-internal fields before exposing formats to clients. */
export declare function publicFormats(formats: MediaFormat[]): PublicFormatView[];
export interface ResolveUrlContext {
    tokenFactory(resolveId: string, itemId: string, formatId: string): string;
}
export declare function resolveRecordToView(record: ResolveRecord, resolveCtx?: ResolveUrlContext): ResolveResponse;
export interface DownloadUrlContext {
    tokenFactory(jobId: string, itemId: string): string;
}
export declare function jobItemToView(item: JobItemRow, download?: DownloadUrlContext): JobItemApiView;
export declare function jobToView(job: JobRow, items: JobItemRow[], download?: DownloadUrlContext): JobApiResponse;
//# sourceMappingURL=views.d.ts.map