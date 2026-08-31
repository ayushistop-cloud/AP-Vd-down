import type { TaskProgress } from './contract.js';
export interface DownloadToFileOptions {
    url: string;
    destPath: string;
    maxBytes: number;
    timeoutMs?: number;
    maxRedirects?: number;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    onProgress?(progress: TaskProgress): void;
}
export interface DownloadToFileResult {
    finalUrl: string;
    sizeBytes: number;
}
export declare function guardedDownloadToFile(options: DownloadToFileOptions): Promise<DownloadToFileResult>;
//# sourceMappingURL=http-download.d.ts.map