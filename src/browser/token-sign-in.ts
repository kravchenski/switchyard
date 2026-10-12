import type { Page } from 'playwright-core';

import type { ChatSite } from './browser-chat.ts';
import { launchCdpBrowser, type CdpBrowser, type LaunchOptions } from './cdp.ts';
import { evaluateSignIn, readSignIn, signInToken, type SignInResult, type SignInRule } from './sign-in.ts';

const SETTLE_MS = 5_000;
const NAVIGATION_RETRIES = 3;
const COOKIE_CHUNK = 3180;
const COOKIE_LIFETIME_S = 400 * 24 * 60 * 60;

interface TokenCheck extends SignInResult {
  token?: string;
}

async function settled<T>(page: Page, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    try {
      return await run();
    } catch (error) {
      if (attempt >= NAVIGATION_RETRIES || !/context was destroyed|navigat/i.test(String(error))) throw error;
    }
  }
}

export function supportsTokenSignIn(site: Pick<ChatSite, 'signIn'>) {
  return Boolean(site.signIn?.storageKey || site.signIn?.cookie);
}

export function tokenLocation(site: Pick<ChatSite, 'url' | 'signIn'>) {
  const origin = new URL(site.url).origin;
  const cookie = site.signIn?.cookie;
  if (!cookie) return `Local Storage > ${origin} and copy "${site.signIn?.storageKey}"`;
  const base = cookieBase(cookie);
  return base === cookie
    ? `Cookies > ${origin} and copy "${cookie}"`
    : `Cookies > ${origin} and copy "${base}.0" (paste "${base}.1" and further parts, if any, right after it)`;
}

function cookieBase(cookie: string) {
  return cookie.replace(/\.0$/, '');
}

export function cookieChunks(cookie: string, value: string) {
  const base = cookieBase(cookie);
  if (base === cookie) return [{ name: cookie, value }];
  const chunks = [];
  for (let start = 0; start < value.length; start += COOKIE_CHUNK) chunks.push({ name: `${base}.${chunks.length}`, value: value.slice(start, start + COOKIE_CHUNK) });
  return chunks;
}

async function checkTokenWithSite(page: Page, path: string, token: string, rule: SignInRule): Promise<TokenCheck> {
  const answer = await settled(page, () => page.evaluate(async ({ path, token }) => {
    const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: response.ok ? await response.json().catch(() => null) : null };
  }, { path, token }));
  if (answer.status >= 400) return { signedIn: false, reason: `the site rejected the token (HTTP ${answer.status})` };
  const user = (answer.body ?? {}) as Record<string, unknown>;
  if (typeof user.access_token === 'string') return { signedIn: true, ...(typeof user.refresh_token === 'string' ? { token: user.refresh_token } : {}) };
  const identity = String(user.email ?? user.id ?? '');
  if (!identity) return { signedIn: false, reason: 'the site did not return an account for the token' };
  if (user.role === 'guest' || rule.guestPattern?.test(identity)) return { signedIn: false, reason: 'the site treats the token as a guest' };
  return { signedIn: true };
}

export async function signInWithToken(options: {
  site: ChatSite;
  token: string;
  profileDir: string;
  launch?: (options: LaunchOptions) => Promise<CdpBrowser>;
  settleMs?: number;
}): Promise<SignInResult> {
  const { site, token } = options;
  const rule = site.signIn;
  if (!rule || !supportsTokenSignIn(site)) throw new Error(`${site.id} does not support signing in with a token`);
  const local = rule.cookie ? evaluateSignIn({ ...rule, expiring: false }, signInToken(rule, token)) : evaluateSignIn(rule, token);
  if (!local.signedIn) return { signedIn: false, reason: `the token is not usable: ${local.reason}` };
  const cdp = await (options.launch ?? launchCdpBrowser)({ profileDir: options.profileDir });
  try {
    const context = cdp.browser.contexts()[0];
    if (!context) throw new Error('Browser profile has no default context');
    const page = await context.newPage();
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (rule.cookie) {
      const base = cookieBase(rule.cookie).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await context.clearCookies({ name: new RegExp(`^${base}(?:\\.\\d+)?$`) });
      const secure = new URL(site.url).protocol === 'https:';
      const expires = Math.floor(Date.now() / 1000) + COOKIE_LIFETIME_S;
      await context.addCookies(cookieChunks(rule.cookie, token).map(chunk => ({ ...chunk, url: site.url, secure, sameSite: 'Lax' as const, expires })));
    } else {
      let saved = token;
      if (site.tokenCheck) {
        const checked = await checkTokenWithSite(page, site.tokenCheck, token, rule);
        if (!checked.signedIn) return checked;
        saved = checked.token ?? token;
      }
      await settled(page, () => page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: rule.storageKey!, value: saved }));
    }
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(options.settleMs ?? SETTLE_MS);
    return await readSignIn(page, rule);
  } finally {
    await cdp.close();
  }
}
