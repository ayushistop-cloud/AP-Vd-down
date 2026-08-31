/**
 * SSRF-hardened fetch used for all outbound HTTP the service performs on
 * behalf of user input (docs/22-SECURITY.md):
 *  - scheme/host validation on every hop
 *  - DNS resolution checked against private/reserved IP space
 *  - bounded redirects, total timeout, response size cap
 */
export interface FetchLimits {
    timeoutMs?: number;
    maxRedirects?: number;
    maxBytes?: number;
    /** Extra request headers (e.g. provider cookies). Validated URL always wins over Host. */
    headers?: Record<string, string>;
}
export declare const DEFAULT_FETCH_LIMITS: Required<Omit<FetchLimits, 'headers'>>;
export interface GuardedResponse {
    finalUrl: string;
    status: number;
    contentType: string | undefined;
    headers: Record<string, string>;
    body: Buffer;
    /** Raw Set-Cookie values (needed by adapters that must echo provider cookies). */
    setCookies: string[];
}
export declare function guardedFetch(url: string, limits?: FetchLimits, fetchImpl?: typeof fetch): Promise<GuardedResponse>;
//# sourceMappingURL=http.d.ts.map