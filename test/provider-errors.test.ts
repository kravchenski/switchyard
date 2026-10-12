import { describe, expect, test } from 'bun:test';

import { classifyStatus, ProviderError, toHttpError, upstreamError } from '../src/core/providers/errors.ts';

describe('provider errors', () => {
  test('classifies upstream statuses', () => {
    expect(classifyStatus(429, 'Too many requests')).toBe('rate_limit');
    expect(classifyStatus(429, 'You exceeded your current quota')).toBe('quota_exhausted');
    expect(classifyStatus(402, '')).toBe('quota_exhausted');
    expect(classifyStatus(401, '')).toBe('auth');
    expect(classifyStatus(403, '')).toBe('auth');
    expect(classifyStatus(503, '')).toBe('unavailable');
    expect(classifyStatus(500, '')).toBe('upstream');
    expect(classifyStatus(500, '{"error":{"message":"Token has expired, please log in again."}}')).toBe('auth');
    expect(classifyStatus(400, 'Invalid token')).toBe('auth');
  });

  test('builds errors from responses with retry-after and a bounded body', async () => {
    const error = await upstreamError('GLM completion', new Response('x'.repeat(2_000), {
      status: 429,
      headers: { 'retry-after': '42' },
    }));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('rate_limit');
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(42);
    expect(error.message.startsWith('GLM completion failed: 429 ')).toBeTrue();
    expect(error.message.length).toBeLessThan(600);
  });

  test('reports an HTML error page by its title instead of its markup', async () => {
    const page = '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n<head><title>tokenharbor.ai | 502: Bad gateway</title></head><body>log in again</body></html>';
    const error = await upstreamError('Token Harbor completion', new Response(page, { status: 502 }));
    expect(error.message).toBe('Token Harbor completion failed: 502 HTML page "tokenharbor.ai | 502: Bad gateway"');
    expect(error.kind).toBe('upstream');
    expect((await upstreamError('X', new Response('<html><body>down</body></html>', { status: 503 }))).message).toBe('X failed: 503 HTML error page');
    expect((await upstreamError('X', new Response('{"error":"<b>bad</b>"}', { status: 400 }))).message).toBe('X failed: 400 {"error":"<b>bad</b>"}');
  });

  test('maps errors to gateway http responses', () => {
    expect(toHttpError(new ProviderError('slow', 'rate_limit', 429, 5))).toEqual({
      status: 429, type: 'rate_limit_exceeded', message: 'slow', retryAfterSeconds: 5,
    });
    expect(toHttpError(new ProviderError('empty', 'quota_exhausted', 429))).toMatchObject({ status: 429, type: 'insufficient_quota' });
    expect(toHttpError(new ProviderError('no key', 'unavailable'))).toMatchObject({ status: 503, type: 'provider_unavailable' });
    expect(toHttpError(new ProviderError('denied', 'auth', 401))).toMatchObject({ status: 502, type: 'upstream_auth_error' });
    expect(toHttpError(new Error('boom'))).toEqual({ status: 502, type: 'upstream_error', message: 'boom' });
  });
});
