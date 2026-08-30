import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
/**
 * Random unguessable identifiers (docs/22-SECURITY.md — job security).
 */
export function newId() {
    return randomUUID();
}
export function newOpaqueToken(bytes = 32) {
    return randomBytes(bytes).toString('base64url');
}
/** Privacy-aware hashing of IPs (docs/24-RATE-LIMITING-ABUSE.md). */
export function hashWithPepper(value, pepper) {
    return createHash('sha256').update(`${pepper}:${value}`).digest('hex');
}
function b64url(input) {
    return Buffer.from(input).toString('base64url');
}
/**
 * Create an HMAC-signed token that self-contains its expiry:
 *   token = base64url(payloadJson) + "." + base64url(hmac)
 * The payload never contains secrets or URLs, only a scope string and expiry.
 */
export function signExpiringToken(scope, secret, ttlSeconds, now = Date.now()) {
    const payload = { scope, exp: now + ttlSeconds * 1000 };
    const body = b64url(JSON.stringify(payload));
    const mac = createHmac('sha256', secret).update(body).digest();
    return `${body}.${b64url(mac)}`;
}
/** Verify a signed token; returns the scope when valid+unexpired, else null. */
export function verifyExpiringToken(token, secret, now = Date.now()) {
    const dot = token.lastIndexOf('.');
    if (dot <= 0)
        return null;
    const body = token.slice(0, dot);
    const macPart = token.slice(dot + 1);
    let expected;
    try {
        expected = createHmac('sha256', secret).update(body).digest();
        const given = Buffer.from(macPart, 'base64url');
        if (given.length !== expected.length || !timingSafeEqual(given, expected))
            return null;
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (typeof payload.scope !== 'string' || typeof payload.exp !== 'number')
            return null;
        if (payload.exp <= now)
            return null;
        return payload.scope;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=ids.js.map