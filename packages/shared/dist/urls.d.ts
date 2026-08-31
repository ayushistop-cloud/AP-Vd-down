/** Hard cap on accepted URL length (docs/22-SECURITY.md input security). */
export declare const MAX_URL_LENGTH = 2048;
/** True when the given host is an IP literal in private/reserved space. */
export declare function isPrivateIpLiteral(host: string): boolean;
/**
 * Validate that a URL is a public http(s) URL suitable for server-side fetch.
 * Implements docs/22-SECURITY.md: scheme allowlist, SSRF guards against
 * localhost / private networks, credential stripping rejection.
 * Throws AppError(INVALID_URL) on violation.
 */
export declare function assertPublicHttpUrl(rawUrl: string): URL;
/** Check an IP returned by DNS resolution before connecting (SSRF defense). */
export declare function assertPublicIp(ip: string): void;
/**
 * Build a display-safe redacted form of a URL for persistence:
 * scheme + host + path (trimmed), query and hash dropped.
 */
export declare function redactUrl(rawUrl: string): string;
//# sourceMappingURL=urls.d.ts.map