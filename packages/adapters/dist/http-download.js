import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { appErrors, assertPublicHttpUrl, assertPublicIp } from '@3ap/shared';
/**
 * Streaming file download with the same SSRF posture as guardedFetch:
 * per-hop URL validation + DNS IP checks, bounded redirects, total timeout
 * and a hard size cap enforced mid-stream. Progress is reported incrementally.
 */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
export async function guardedDownloadToFile(options) {
    const { url, destPath, maxBytes } = options;
    const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
    const maxRedirects = options.maxRedirects ?? 5;
    const deadline = Date.now() + timeoutMs;
    let currentUrl = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        assertPublicHttpUrl(currentUrl);
        const parsed = new URL(currentUrl);
        const addresses = await lookup(parsed.hostname, { all: true }).catch(() => null);
        if (!addresses || addresses.length === 0)
            throw appErrors.temporaryProviderError('The target host could not be reached.');
        for (const addr of addresses)
            assertPublicIp(addr.address);
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            throw appErrors.temporaryProviderError('The download timed out.');
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), remaining);
        try {
            const response = await fetch(currentUrl, {
                redirect: 'manual',
                signal: controller.signal,
                headers: { 'user-agent': USER_AGENT, ...(options.headers ?? {}) },
            });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get('location');
                void response.body?.cancel();
                if (!location)
                    throw appErrors.temporaryProviderError('The provider returned an invalid redirect.');
                currentUrl = new URL(location, currentUrl).toString();
                continue;
            }
            if (response.status >= 400) {
                void response.body?.cancel();
                if (response.status === 403 || response.status === 401)
                    throw appErrors.notPublic();
                if (response.status === 429)
                    throw appErrors.rateLimited();
                if (response.status >= 500)
                    throw appErrors.temporaryProviderError();
                throw appErrors.processingFailed('The platform refused to serve this file.');
            }
            const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
            if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
                void response.body?.cancel();
                throw appErrors.tooLarge();
            }
            const reader = response.body?.getReader();
            if (!reader)
                throw appErrors.temporaryProviderError('The provider returned an empty response.');
            const total = Number.isFinite(declaredLength) ? declaredLength : undefined;
            const fileStream = createWriteStream(destPath);
            let received = 0;
            let lastEmit = 0;
            try {
                for (;;) {
                    if (controller.signal.aborted)
                        throw new Error('aborted');
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    received += value.byteLength;
                    if (received > maxBytes)
                        throw appErrors.tooLarge();
                    if (!writeChunk(fileStream, value)) {
                        await drain(fileStream).catch(() => undefined);
                        throw appErrors.processingFailed('The temporary storage rejected the write.');
                    }
                    const now = Date.now();
                    if (now - lastEmit > 500) {
                        lastEmit = now;
                        options.onProgress?.({
                            stage: 'downloading',
                            downloadedBytes: received,
                            totalBytes: total,
                            percent: total ? Math.min(99, Math.round((received / total) * 100)) : undefined,
                        });
                    }
                }
                await drain(fileStream);
            }
            catch (err) {
                await reader.cancel().catch(() => undefined);
                await unlink(destPath).catch(() => undefined);
                if (err instanceof Error && err.message === 'aborted') {
                    throw appErrors.cancelled();
                }
                throw err;
            }
            options.onProgress?.({ stage: 'finalizing', percent: 100 });
            return { finalUrl: currentUrl, sizeBytes: received };
        }
        catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                await unlink(destPath).catch(() => undefined);
                if (options.signal?.aborted)
                    throw appErrors.cancelled();
                throw appErrors.temporaryProviderError('The download timed out.');
            }
            throw err;
        }
        finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
        }
    }
    throw appErrors.temporaryProviderError('Too many redirects while downloading.');
}
function writeChunk(stream, chunk) {
    return stream.write(chunk);
}
function drain(stream) {
    return new Promise((resolve, reject) => {
        stream.on('error', reject);
        stream.end(() => resolve());
    });
}
//# sourceMappingURL=http-download.js.map