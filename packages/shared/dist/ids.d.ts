/**
 * Random unguessable identifiers (docs/22-SECURITY.md — job security).
 */
export declare function newId(): string;
export declare function newOpaqueToken(bytes?: number): string;
/** Privacy-aware hashing of IPs (docs/24-RATE-LIMITING-ABUSE.md). */
export declare function hashWithPepper(value: string, pepper: string): string;
/**
 * Create an HMAC-signed token that self-contains its expiry:
 *   token = base64url(payloadJson) + "." + base64url(hmac)
 * The payload never contains secrets or URLs, only a scope string and expiry.
 */
export declare function signExpiringToken(scope: string, secret: string, ttlSeconds: number, now?: number): string;
/** Verify a signed token; returns the scope when valid+unexpired, else null. */
export declare function verifyExpiringToken(token: string, secret: string, now?: number): string | null;
//# sourceMappingURL=ids.d.ts.map