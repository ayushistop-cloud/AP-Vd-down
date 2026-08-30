import { TERABOX_DOMAINS } from './provider-config.js';
export { TERABOX_DOMAINS };
const teraboxDomainPattern = TERABOX_DOMAINS.map((d) => d.replace(/\./g, '\\.')).join('|');
export const PLATFORM_URL_PATTERNS = {
    youtube: [
        /^https?:\/\/(www\.|m\.|music\.)?youtube\.com\/watch\/?(?:[?#].*)?$/i,
        /^https?:\/\/(www\.|m\.)?youtube\.com\/playlist\/?(?:[?#].*)?$/i,
        /^https?:\/\/(www\.|m\.)?youtube\.com\/shorts\/[A-Za-z0-9_-]{5,32}(?:[?#].*)?$/i,
        /^https?:\/\/(www\.|m\.)?youtube\.com\/live\/[A-Za-z0-9_-]{5,32}(?:[?#].*)?$/i,
        /^https?:\/\/(www\.|m\.)?youtube\.com\/(?:embed|v)\/[A-Za-z0-9_-]{5,32}(?:[?#].*)?$/i,
        /^https?:\/\/youtu\.be\/[A-Za-z0-9_-]{5,32}(?:[?#].*)?$/i,
    ],
    tiktok: [
        /^https?:\/\/(www\.|m\.)?tiktok\.com\/@[A-Za-z0-9._-]{1,64}\/video\/\d{6,25}(?:[?#].*)?$/i,
        /^https?:\/\/(www\.|m\.)?tiktok\.com\/t\/[A-Za-z0-9_-]{4,20}\/?(?:[?#].*)?$/i,
        /^https?:\/\/(vm|vt)\.tiktok\.com\/[A-Za-z0-9]{4,20}\/?(?:[?#].*)?$/i,
    ],
    instagram: [
        /^https?:\/\/(www\.|m\.)?instagr(\.am|am\.com)\/reels?\/[A-Za-z0-9_-]{3,32}\/?(?:[?#].*)?$/i,
        /^https?:\/\/(www\.|m\.)?instagr(\.am|am\.com)\/p\/[A-Za-z0-9_-]{3,32}\/?(?:[?#].*)?$/i,
        /^https?:\/\/(www\.|m\.)?instagr(\.am|am\.com)\/tv\/[A-Za-z0-9_-]{3,32}\/?(?:[?#].*)?$/i,
        /^https?:\/\/(www\.|m\.)?instagr(\.am|am\.com)\/stories\/[A-Za-z0-9._-]{1,64}\/\d{6,25}\/?(?:[?#].*)?$/i,
    ],
    facebook: [
        /^https?:\/\/(www\.|m\.|web\.)?facebook\.com\/watch\/?(?:\?[^#]*|\/)?$/i,
        /^https?:\/\/(www\.|m\.|web\.)?facebook\.com\/[A-Za-z0-9._-]{2,80}\/videos\/(?:[A-Za-z0-9._%-]+\/)?\d{6,25}\/?(?:[?#].*)?$/i,
        /^https?:\/\/(www\.|m\.|web\.)?facebook\.com\/reel\/\d{6,25}(?:[?#].*)?$/i,
        /^https?:\/\/(www\.|m\.|web\.)?facebook\.com\/share\/(?:v|r|p)?\/[A-Za-z0-9_-]+\/?(?:[?#].*)?$/i,
        /^https?:\/\/(www\.|m\.|web\.)?facebook\.com\/story\.php(?:\?[^#]*)?$/i,
        /^https?:\/\/fb\.watch\/[A-Za-z0-9_-]{4,24}\/?(?:[?#].*)?$/i,
    ],
    terabox: [
        new RegExp(`^https?:\\/\\/(?:[A-Za-z0-9_-]+\\.)*(${teraboxDomainPattern})\\/s\\/[A-Za-z0-9_-]{4,40}(?:[?#].*)?$`, 'i'),
        new RegExp(`^https?:\\/\\/(?:[A-Za-z0-9_-]+\\.)*(${teraboxDomainPattern})\\/sharing\\/(?:link|common)(?:[?#].*)?$`, 'i'),
    ],
};
/** Strip whitespace/zero-width characters and guarantee an https scheme. */
export function normalizeUrlInput(raw) {
    const cleaned = raw.replace(/[\u200B-\u200D\uFEFF\s]+/g, '').trim();
    if (!cleaned)
        return cleaned;
    if (!/^https?:\/\//i.test(cleaned))
        return `https://${cleaned}`;
    return cleaned;
}
/** Detect the platform for a user-supplied URL; null = not allowlisted. */
export function detectPlatform(rawOrNormalizedUrl) {
    let candidate = rawOrNormalizedUrl;
    if (!/^https?:\/\//i.test(candidate))
        candidate = `https://${candidate}`;
    for (const [platform, patterns] of Object.entries(PLATFORM_URL_PATTERNS)) {
        for (const pattern of patterns) {
            if (pattern.test(candidate))
                return platform;
        }
    }
    return null;
}
const TRACKING_PARAM_KEYS = new Set([
    'si',
    'fbclid',
    'gclid',
    'feature',
    '_r',
    '_t',
    'is_from_webapp',
    'sender_device',
    'web_id',
    'share_app_id',
    'tt_from',
    'ref',
    'referrer',
]);
function isTrackingParam(key) {
    const lower = key.toLowerCase();
    return TRACKING_PARAM_KEYS.has(lower) || lower.startsWith('utm_');
}
export function canonicalizeUrl(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const toDrop = [];
        u.searchParams.forEach((_value, key) => {
            if (isTrackingParam(key) && !['v', 'list'].includes(key))
                toDrop.push(key);
        });
        for (const key of toDrop)
            u.searchParams.delete(key);
        // Strip YouTube Mix playlist parameters (list=RD...) when a video ID (v=) is present
        const host = u.hostname.toLowerCase();
        if (host.includes('youtube.com') || host.includes('youtu.be')) {
            const v = u.searchParams.get('v');
            const list = u.searchParams.get('list');
            if (v && list && /^RD/i.test(list.trim())) {
                u.searchParams.delete('list');
                u.searchParams.delete('start_radio');
                u.searchParams.delete('radio');
            }
        }
        u.hash = '';
        return u.toString();
    }
    catch {
        return rawUrl;
    }
}
export function parsePlatformUrl(rawUrl) {
    try {
        const normalized = canonicalizeUrl(normalizeUrlInput(rawUrl));
        const platform = detectPlatform(normalized);
        if (!platform)
            return null;
        const u = new URL(normalized);
        const host = u.hostname.toLowerCase();
        let shareId = '';
        if (platform === 'terabox') {
            let shortKey = u.searchParams.get('surl') ?? '';
            if (!shortKey) {
                const match = /\/s\/(1[\w-]+)/i.exec(u.pathname) || /\/s\/([\w-]+)/i.exec(u.pathname) || u.pathname.split('/').filter(Boolean).pop();
                shortKey = typeof match === 'string' ? match : (match?.[1] ?? match?.[0] ?? '');
            }
            shareId = shortKey;
        }
        else if (platform === 'youtube') {
            shareId = u.searchParams.get('v') || u.searchParams.get('list') || '';
            if (!shareId && u.pathname.includes('/shorts/')) {
                shareId = u.pathname.split('/shorts/')[1]?.split('/')[0] || '';
            }
            else if (!shareId && u.pathname.includes('/live/')) {
                shareId = u.pathname.split('/live/')[1]?.split('/')[0] || '';
            }
            else if (!shareId && u.hostname.toLowerCase().includes('youtu.be')) {
                shareId = u.pathname.split('/').filter(Boolean)[0] || '';
            }
        }
        else if (platform === 'tiktok') {
            const match = /\/video\/(\d+)/i.exec(u.pathname);
            shareId = match?.[1] || u.pathname.split('/').filter(Boolean).pop() || '';
        }
        else if (platform === 'instagram') {
            const match = /\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i.exec(u.pathname);
            shareId = match?.[1] || u.pathname.split('/').filter(Boolean).pop() || '';
        }
        else if (platform === 'facebook') {
            shareId = u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop() || '';
        }
        return {
            provider: platform,
            host,
            shareId,
            originalUrl: rawUrl,
        };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=platform-detect.js.map