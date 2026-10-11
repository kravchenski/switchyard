import { describe, expect, test } from 'bun:test';

import { bearerToken, isForwardableResponseHeader, isLocalRequest, parseOrigins, tokenMatches } from '../src/gateway/security.ts';

describe('security boundaries', () => {
    test('protects the gateway with timing-safe bearer checks', () => {
        expect(bearerToken('Bearer local-secret')).toBe('local-secret');
        expect(bearerToken('Basic local-secret')).toBeNull();
        expect(tokenMatches('local-secret', 'local-secret')).toBeTrue();
        expect(tokenMatches('wrong', 'local-secret')).toBeFalse();
        expect(tokenMatches(null, undefined)).toBeTrue();
    });

    test('does not forward hop-by-hop upstream headers', () => {
        expect(isForwardableResponseHeader('content-type')).toBeTrue();
        expect(isForwardableResponseHeader('transfer-encoding')).toBeFalse();
        expect(isForwardableResponseHeader('Content-Length')).toBeFalse();
    });
});

describe('tokenMatches edge cases', () => {
    test('rejects tokens of different length and prefixes', () => {
        expect(tokenMatches('local', 'local-secret')).toBeFalse();
        expect(tokenMatches('local-secret-extra', 'local-secret')).toBeFalse();
        expect(tokenMatches('', 'local-secret')).toBeFalse();
    });

    test('compares multibyte tokens by bytes', () => {
        expect(tokenMatches('key-✓-€', 'key-✓-€')).toBeTrue();
        expect(tokenMatches('key-x-€', 'key-✓-€')).toBeFalse();
    });
});

describe('isLocalRequest', () => {
    const request = (headers: Record<string, string>) => isLocalRequest(new Request('http://unknown.invalid/', { headers }));

    test('accepts loopback hosts without a foreign origin', () => {
        expect(request({ host: 'localhost:3260' })).toBeTrue();
        expect(request({ host: '127.0.0.1:3260' })).toBeTrue();
        expect(request({ host: '[::1]:3260' })).toBeTrue();
        expect(request({ host: 'localhost:3260', origin: 'http://localhost:3000' })).toBeTrue();
    });

    test('rejects other hosts and rebinding names', () => {
        expect(request({ host: '192.168.1.20:3260' })).toBeFalse();
        expect(request({ host: 'attacker.example:3260' })).toBeFalse();
        expect(request({})).toBeFalse();
    });

    test('falls back to the request URL when there is no Host header', () => {
        expect(isLocalRequest(new Request('http://localhost/v1/models'))).toBeTrue();
        expect(isLocalRequest(new Request('http://gateway.lan/v1/models'))).toBeFalse();
    });

    test('rejects pages from other origins', () => {
        expect(request({ host: 'localhost:3260', origin: 'https://attacker.example' })).toBeFalse();
        expect(request({ host: '127.0.0.1:3260', origin: 'null' })).toBeFalse();
    });
});

describe('trusted extension origins', () => {
    const extension = 'chrome-extension://dammhajbcgfiiaokdhfchhncfaknaemj';
    const trusted = parseOrigins(` ${extension}/ , chrome-extension://other `);
    const request = (headers: Record<string, string>) => isLocalRequest(new Request('http://unknown.invalid/', { headers }), trusted);

    test('parses a comma-separated list', () => {
        expect([...trusted]).toEqual([extension, 'chrome-extension://other']);
        expect(parseOrigins('none').size).toBe(0);
        expect(parseOrigins(undefined).size).toBe(0);
    });

    test('accepts a trusted extension calling localhost', () => {
        expect(request({ host: '127.0.0.1:3260', origin: extension })).toBeTrue();
        expect(request({ host: 'localhost:3260', origin: 'chrome-extension://DAMMHAJBCGFIIAOKDHFCHHNCFAKNAEMJ' })).toBeTrue();
    });

    test('still rejects other extensions and non-local hosts', () => {
        expect(request({ host: '127.0.0.1:3260', origin: 'chrome-extension://someoneelse' })).toBeFalse();
        expect(request({ host: 'gateway.lan:3260', origin: extension })).toBeFalse();
        expect(isLocalRequest(new Request('http://localhost/', { headers: { origin: extension } }))).toBeFalse();
    });
});
