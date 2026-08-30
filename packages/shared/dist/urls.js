import { isIP } from 'node:net';
import { appErrors } from './errors.js';
/** Hard cap on accepted URL length (docs/22-SECURITY.md input security). */
export const MAX_URL_LENGTH = 2048;
const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback',
]);
function ipv4ToLong(ip) {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
function isPrivateIPv4(ip) {
    const n = ipv4ToLong(ip);
    // 0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16, 172.16/12,
    // 192.0.0/24, 192.168/16, 198.18/15 (benchmarks), 224/4 multicast, 240/4 reserved
    const ranges = [
        [0x00000000, 0xff000000],
        [0x0a000000, 0xff000000],
        [0x64400000, 0xffc00000],
        [0x7f000000, 0xff000000],
        [0xa9fe0000, 0xffff0000],
        [0xac100000, 0xfff00000],
        [0xc0000000, 0xffffff00],
        [0xc0a80000, 0xffff0000],
        [0xc6120000, 0xfffe0000],
        [0xe0000000, 0xf0000000],
        [0xf0000000, 0xf0000000],
    ];
    return ranges.some(([base, mask]) => (n & mask) >>> 0 === base >>> 0);
}
function isPrivateIPv6(ip) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1')
        return true;
    // IPv4-mapped ::ffff:a.b.c.d
    if (lower.startsWith('::ffff:')) {
        const v4 = lower.slice(7);
        return isIP(v4) === 4 ? isPrivateIPv4(v4) : true;
    }
    // fc00::/7 unique local, fe80::/10 link local, ff00::/8 multicast
    if (/^f[cd][0-9a-f]{2}:/.test(lower))
        return true;
    if (/^fe[89ab][0-9a-f]:/.test(lower))
        return true;
    if (/^ff[0-9a-f]{2}:/.test(lower))
        return true;
    if (lower.startsWith('64:ff9b:'))
        return true; // NAT64 — treat as infrastructure
    return false;
}
/** True when the given host is an IP literal in private/reserved space. */
export function isPrivateIpLiteral(host) {
    const kind = isIP(host);
    if (kind === 4)
        return isPrivateIPv4(host);
    if (kind === 6)
        return isPrivateIPv6(host);
    return false;
}
/**
 * Validate that a URL is a public http(s) URL suitable for server-side fetch.
 * Implements docs/22-SECURITY.md: scheme allowlist, SSRF guards against
 * localhost / private networks, credential stripping rejection.
 * Throws AppError(INVALID_URL) on violation.
 */
export function assertPublicHttpUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    }
    catch {
        throw appErrors.invalidUrl('The URL could not be parsed.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw appErrors.invalidUrl('Only http and https links are supported.');
    }
    if (rawUrl.length > MAX_URL_LENGTH) {
        throw appErrors.invalidUrl('The URL is too long.');
    }
    if (parsed.username || parsed.password) {
        throw appErrors.invalidUrl('URLs with embedded credentials are not allowed.');
    }
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        throw appErrors.invalidUrl('This address is not allowed.');
    }
    if (isPrivateIpLiteral(host)) {
        throw appErrors.invalidUrl('This address is not allowed.');
    }
    if (parsed.port && !['80', '443'].includes(parsed.port)) {
        throw appErrors.invalidUrl('Non-standard ports are not allowed.');
    }
    return parsed;
}
/** Check an IP returned by DNS resolution before connecting (SSRF defense). */
export function assertPublicIp(ip) {
    if (isPrivateIpLiteral(ip)) {
        throw appErrors.invalidUrl('This address is not allowed.');
    }
}
/**
 * Build a display-safe redacted form of a URL for persistence:
 * scheme + host + path (trimmed), query and hash dropped.
 */
export function redactUrl(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const path = u.pathname.length > 64 ? `${u.pathname.slice(0, 61)}...` : u.pathname;
        return `${u.protocol}//${u.host}${path}`;
    }
    catch {
        return '(unparseable)';
    }
}
//# sourceMappingURL=urls.js.map