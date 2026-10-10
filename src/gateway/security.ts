import crypto from 'node:crypto';

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

export function bearerToken(header: unknown) {
    if (typeof header !== 'string') return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match?.[1]?.trim() || null;
}

export function tokenMatches(token: string | null, expected: string | undefined) {
    if (!expected) return true;
    if (!token) return false;
    const actual = Buffer.from(token);
    const reference = Buffer.from(expected);
    if (actual.length !== reference.length) {
        crypto.timingSafeEqual(reference, reference);
        return false;
    }
    return crypto.timingSafeEqual(actual, reference);
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(value: string) {
    try {
        return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
    } catch {
        return null;
    }
}

function isLocalHostname(hostname: string | null) {
    return hostname !== null && (LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost'));
}

export function isLocalRequest(headers: { get(name: string): string | null }) {
    const host = headers.get('host');
    if (!host || !isLocalHostname(hostnameOf(host))) return false;
    const origin = headers.get('origin');
    return !origin || isLocalHostname(hostnameOf(origin));
}

export function isForwardableResponseHeader(name: string) {
    return !HOP_BY_HOP_HEADERS.has(name.toLowerCase());
}
