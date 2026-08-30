import { lookup } from 'node:dns/promises';
import { AppError, appErrors } from './errors.js';
import { assertPublicHttpUrl, assertPublicIp } from './urls.js';
export const DEFAULT_FETCH_LIMITS = {
    timeoutMs: 15_000,
    maxRedirects: 5,
    maxBytes: 20 * 1024 * 1024,
};
const USER_AGENT = '3AP-Video-Downloader/0.1';
export async function guardedFetch(url, limits = {}, fetchImpl = fetch) {
    const { timeoutMs, maxRedirects, maxBytes } = { ...DEFAULT_FETCH_LIMITS, ...limits };
    const deadline = Date.now() + timeoutMs;
    const accumulatedCookies = [];
    let currentUrl = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        assertPublicHttpUrl(currentUrl);
        const parsed = new URL(currentUrl);
        const addresses = await lookup(parsed.hostname, { all: true, verbatim: true }).catch(() => {
            throw appErrors.temporaryProviderError('The target host could not be reached.');
        });
        if (addresses.length === 0) {
            throw appErrors.temporaryProviderError('The target host could not be reached.');
        }
        for (const addr of addresses)
            assertPublicIp(addr.address);
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0)
            throw appErrors.temporaryProviderError('The request timed out.');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remainingMs);
        let response;
        const parsedCookies = accumulatedCookies
            .map((c) => c.split(';')[0] ?? '')
            .filter(Boolean);
        const accumulatedCookieHeader = parsedCookies.join('; ');
        const headersToSend = {
            'user-agent': USER_AGENT,
            accept: '*/*',
            ...(limits.headers ?? {}),
        };
        if (accumulatedCookieHeader) {
            const existingCookie = limits.headers?.cookie || limits.headers?.Cookie || '';
            headersToSend['cookie'] = existingCookie
                ? `${existingCookie}; ${accumulatedCookieHeader}`
                : accumulatedCookieHeader;
        }
        try {
            console.log(`[guardedFetch Hop ${hop}] Request URL:`, currentUrl);
            console.log(`[guardedFetch Hop ${hop}] Cookie length:`, headersToSend['cookie']?.length ?? 0);
            response = await fetchImpl(currentUrl, {
                method: 'GET',
                redirect: 'manual',
                signal: controller.signal,
                headers: headersToSend,
            });
        }
        catch (err) {
            clearTimeout(timer);
            if (err instanceof Error && err.name === 'AbortError') {
                throw appErrors.temporaryProviderError('The request timed out.');
            }
            throw appErrors.temporaryProviderError('The target host could not be reached.');
        }
        clearTimeout(timer);
        console.log(`[guardedFetch Hop ${hop}] Status:`, response.status);
        const hopCookies = typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : [];
        accumulatedCookies.push(...hopCookies);
        console.log(`[guardedFetch Hop ${hop}] New cookies set count:`, hopCookies.length);
        // Follow redirects manually so every hop re-enters validation.
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            console.log(`[guardedFetch Hop ${hop}] Redirect location:`, location);
            if (!location)
                throw appErrors.temporaryProviderError('The provider returned an invalid redirect.');
            void response.body?.cancel();
            currentUrl = new URL(location, currentUrl).toString();
            continue;
        }
        const headers = {};
        response.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
        });
        if (response.status >= 400) {
            void response.body?.cancel();
            throw mapHttpStatus(response.status);
        }
        const declaredLength = Number.parseInt(headers['content-length'] ?? '', 10);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            void response.body?.cancel();
            throw appErrors.tooLarge();
        }
        const reader = response.body?.getReader();
        if (!reader) {
            return {
                finalUrl: currentUrl,
                status: response.status,
                contentType: response.headers.get('content-type') ?? undefined,
                headers,
                body: Buffer.alloc(0),
                setCookies: accumulatedCookies,
            };
        }
        const chunks = [];
        let received = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                received += value.byteLength;
                if (received > maxBytes) {
                    await reader.cancel().catch(() => undefined);
                    throw appErrors.tooLarge();
                }
                chunks.push(Buffer.from(value));
            }
        }
        catch (err) {
            if (err instanceof AppError)
                throw err;
            throw appErrors.temporaryProviderError('The response could not be read.');
        }
        return {
            finalUrl: currentUrl,
            status: response.status,
            contentType: response.headers.get('content-type') ?? undefined,
            headers,
            body: Buffer.concat(chunks),
            setCookies: accumulatedCookies,
        };
    }
    throw appErrors.temporaryProviderError('Too many redirects.');
}
function mapHttpStatus(status) {
    if (status === 401 || status === 403)
        return appErrors.notPublic();
    if (status === 404 || status === 410)
        return appErrors.unsupported('This content is no longer available at the source.');
    if (status === 429)
        return appErrors.rateLimited('The platform is rate limiting this request. Try again later.');
    if (status >= 500)
        return appErrors.temporaryProviderError();
    return appErrors.temporaryProviderError(`The platform responded with an unexpected status (${status}).`);
}
//# sourceMappingURL=http.js.map