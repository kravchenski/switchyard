import { describe, expect, test } from 'bun:test';
import { browserFingerprint, browserHeaders } from '../src/platform/browserUa.ts';

describe('browser fingerprint', () => {
  test('advertises a Chrome user agent', () => {
    expect(browserFingerprint().userAgent).toMatch(/Mozilla.*Chrome\/\d+\./);
  });

  test('keeps sec-ch-ua major version in sync with the user agent', () => {
    const fp = browserFingerprint();
    expect(fp.secChUa).toContain(`"Google Chrome";v="${fp.major}"`);
    expect(fp.userAgent).toContain(`Chrome/${fp.version}`);
  });

  test('returns browser-shaped request headers', () => {
    const headers = browserHeaders();
    expect(headers['sec-fetch-mode']).toBe('cors');
    expect(headers['sec-fetch-site']).toBe('same-origin');
    expect(headers['sec-ch-ua-mobile']).toBe('?0');
    expect(headers['user-agent']).toMatch(/Chrome\//);
    expect(headers.accept).toContain('application/json');
  });
});
