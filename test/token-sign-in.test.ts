import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatSite } from '../src/browser/browser-chat.ts';
import { launchCdpBrowser } from '../src/browser/cdp.ts';
import { cookieChunks, signInWithToken, supportsTokenSignIn, tokenLocation } from '../src/browser/token-sign-in.ts';
import { signInToken } from '../src/browser/sign-in.ts';
import { ARENA_CHAT_SITE } from '../src/providers/arena/web.ts';
import { findBrowserExecutable } from '../src/platform/browserExecutable.ts';

const jwt = (payload: Record<string, unknown>) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const member = jwt({ id: 'user-1', email: 'me@example.com' });
const guest = jwt({ id: 'anon-1', email: 'anon@example.com' });
const revoked = jwt({ id: 'gone-1', email: 'gone@example.com' });
const refresh = jwt({ sub: 'kimi-user', exp: 4102444800 });
const rotated = jwt({ sub: 'kimi-user', exp: 4102444801 });

let server: ReturnType<typeof Bun.serve>;
let origin = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/api/auth/token/refresh') {
        return request.headers.get('authorization') === `Bearer ${refresh}`
          ? Response.json({ access_token: 'access', refresh_token: rotated })
          : new Response('{"error_type":"auth.token.invalid"}', { status: 401 });
      }
      if (url.pathname === '/api/v1/auths/') {
        const token = (request.headers.get('authorization') ?? '').replace('Bearer ', '');
        if (token === member) return Response.json({ id: 'user-1', email: 'me@example.com', role: 'user' });
        if (token === guest) return Response.json({ id: 'guest-1', email: 'guest-1@guest.com', role: 'guest' });
        return new Response('unauthorized', { status: 401 });
      }
      return new Response('<!doctype html><textarea></textarea>', { headers: { 'content-type': 'text/html' } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const site = (): ChatSite => ({ id: 'fake', url: `${origin}/`, inputSelector: 'textarea', responseUrl: /\/api\/stream/, signIn: { storageKey: 'token', claim: 'id', guestPattern: /guest/i }, tokenCheck: '/api/v1/auths/' });
const profile = () => join(mkdtempSync(join(tmpdir(), 'token-')), 'profile');

describe('token sign-in', () => {
  test('rejects an expired token before opening a browser', async () => {
    const expired = jwt({ id: 'x', exp: 1 });
    const result = await signInWithToken({ site: { ...site(), signIn: { storageKey: 'refresh_token', expiring: true } }, token: expired, profileDir: profile(), launch: () => { throw new Error('should not launch'); } });
    expect(result).toEqual({ signedIn: false, reason: 'the token is not usable: session expired' });
  });

  test('reads the access token out of a pasted Supabase session cookie', () => {
    const session = `base64-${Buffer.from(JSON.stringify({ access_token: member, refresh_token: 'r' })).toString('base64')}`;
    expect(signInToken(ARENA_CHAT_SITE.signIn!, session)).toBe(member);
    expect(signInToken(ARENA_CHAT_SITE.signIn!, 'base64-bm90IGpzb24=')).toBeNull();
    expect(signInToken({ storageKey: 'token' }, member)).toBe(member);
  });

  test('splits a long session cookie into the chunks the site reads back', () => {
    const value = 'x'.repeat(4000);
    expect(cookieChunks('arena-auth-prod-v1.0', value).map(chunk => [chunk.name, chunk.value.length])).toEqual([['arena-auth-prod-v1.0', 3180], ['arena-auth-prod-v1.1', 820]]);
    expect(cookieChunks('arena-auth-prod-v1.0', 'short')).toEqual([{ name: 'arena-auth-prod-v1.0', value: 'short' }]);
    expect(cookieChunks('session', value)).toEqual([{ name: 'session', value }]);
  });

  test('tells where each chat keeps its token', () => {
    expect(supportsTokenSignIn(ARENA_CHAT_SITE)).toBe(true);
    expect(supportsTokenSignIn({ signIn: undefined })).toBe(false);
    expect(tokenLocation(ARENA_CHAT_SITE)).toBe('Cookies > https://arena.ai and copy "arena-auth-prod-v1.0" (paste "arena-auth-prod-v1.1" and further parts, if any, right after it)');
    expect(tokenLocation(site())).toBe(`Local Storage > ${origin} and copy "token"`);
  });

  test('rejects a session cookie without a signed-in account before opening a browser', async () => {
    const anonymous = `base64-${Buffer.from(JSON.stringify({ access_token: jwt({ sub: 'x' }) })).toString('base64')}`;
    const launch = () => { throw new Error('should not launch'); };
    expect(await signInWithToken({ site: ARENA_CHAT_SITE, token: anonymous, profileDir: profile(), launch })).toEqual({ signedIn: false, reason: 'the token is not usable: not signed in' });
    expect(await signInWithToken({ site: ARENA_CHAT_SITE, token: 'garbage', profileDir: profile(), launch })).toEqual({ signedIn: false, reason: 'the token is not usable: not signed in' });
  });

  describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1' || !findBrowserExecutable())('in a browser', () => {
    test('saves a token the site accepts and refuses revoked and guest tokens', async () => {
      expect(await signInWithToken({ site: site(), token: member, profileDir: profile(), settleMs: 200 })).toEqual({ signedIn: true });
      expect(await signInWithToken({ site: site(), token: revoked, profileDir: profile(), settleMs: 200 })).toEqual({ signedIn: false, reason: 'the site rejected the token (HTTP 401)' });
      expect(await signInWithToken({ site: site(), token: guest, profileDir: profile(), settleMs: 200 })).toEqual({ signedIn: false, reason: 'the site treats the token as a guest' });
    }, 120_000);

    test('stores a pasted session cookie in parts the page reads back', async () => {
      const session = `base64-${Buffer.from(JSON.stringify({ access_token: member, user: { bio: 'y'.repeat(3000) } })).toString('base64')}`;
      const cookieSite = { ...site(), signIn: { cookie: 'auth.0', tokenPattern: 'access_token":"([^"]+)', claim: 'email' } };
      expect(await signInWithToken({ site: cookieSite, token: session, profileDir: profile(), settleMs: 200 })).toEqual({ signedIn: true });
    }, 120_000);

    test('stores the refreshed token when the site rotates it', async () => {
      const kimi = { ...site(), signIn: { storageKey: 'refresh_token', expiring: true }, tokenCheck: '/api/auth/token/refresh' };
      const dir = profile();
      expect(await signInWithToken({ site: kimi, token: refresh, profileDir: dir, settleMs: 200 })).toEqual({ signedIn: true });
      const cdp = await launchCdpBrowser({ profileDir: dir });
      try {
        const page = await cdp.browser.contexts()[0]!.newPage();
        await page.goto(`${origin}/`);
        expect(await page.evaluate(() => localStorage.getItem('refresh_token'))).toBe(rotated);
      } finally {
        await cdp.close();
      }
    }, 120_000);
  });
});
