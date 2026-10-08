import type { Page } from 'playwright-core';

import type { ChatSite } from './browser-chat.ts';
import { launchCdpBrowser, type CdpBrowser, type LaunchOptions } from './cdp.ts';
import { evaluateSignIn, readSignIn, type SignInResult, type SignInRule } from './sign-in.ts';

const SETTLE_MS = 5_000;
const NAVIGATION_RETRIES = 3;

export interface TokenCheck extends SignInResult {
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

export function supportsTokenSignIn(site: ChatSite) {
  return Boolean(site.signIn?.storageKey);
}

export async function checkTokenWithSite(page: Page, path: string, token: string, rule: SignInRule): Promise<TokenCheck> {
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
  if (!rule?.storageKey) throw new Error(`${site.id} does not support signing in with a token`);
  const local = evaluateSignIn(rule, token);
  if (!local.signedIn) return { signedIn: false, reason: `the token is not usable: ${local.reason}` };
  const cdp = await (options.launch ?? launchCdpBrowser)({ profileDir: options.profileDir });
  try {
    const context = cdp.browser.contexts()[0];
    if (!context) throw new Error('Browser profile has no default context');
    const page = await context.newPage();
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    let saved = token;
    if (site.tokenCheck) {
      const checked = await checkTokenWithSite(page, site.tokenCheck, token, rule);
      if (!checked.signedIn) return checked;
      saved = checked.token ?? token;
    }
    await settled(page, () => page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: rule.storageKey!, value: saved }));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(options.settleMs ?? SETTLE_MS);
    return await readSignIn(page, rule);
  } finally {
    await cdp.close();
  }
}
