import type { Locator, Page } from 'playwright-core';

import { autoSolveCaptcha } from './captcha/index.ts';
import type { ChatSite } from './browser-chat.ts';
import { launchCdpBrowser, type CdpBrowser, type LaunchOptions } from './cdp.ts';
import { decodeJwtPayload, readSignIn, type SignInResult, type SignInRule } from './sign-in.ts';

export type AutoLoginStatus = 'signed-in' | 'logged-in' | 'skipped' | 'failed';

export interface AutoLoginResult {
  site: string;
  status: AutoLoginStatus;
  detail: string;
}

interface AutoLoginCredentials {
  email: string;
  password: string;
}

export interface AutoLoginOptions {
  sites: ChatSite[];
  credentials?: AutoLoginCredentials;
  profileDir?: string;
  viaGoogle?: boolean;
  launch?: (options: LaunchOptions) => Promise<CdpBrowser>;
  now?: () => number;
  waitForSignInMs?: number;
  onSignIn?: (site: string, result: SignInResult) => void;
}

const NAV_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 8_000;
const SHORT_TIMEOUT_MS = 3_000;
const DEFAULT_WAIT_MS = 20_000;
const POLL_MS = 500;

const EMAIL_SELECTORS = ['input[type="email"]', 'input[name="email"]', 'input[autocomplete="username"]'];
const PASSWORD_SELECTORS = ['input[type="password"]'];
const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Sign in")',
  'button:has-text("Log in")',
  'button:has-text("Continue")',
];
const ENTRY_SELECTORS = [
  'button:has-text("Sign in")',
  'button:has-text("Log in")',
  'a:has-text("Sign in")',
  'a:has-text("Log in")',
  'button:has-text("Continue with email")',
  'button:has-text("Continue with Google")',
];
const GOOGLE_SELECTORS = ['button:has-text("Google")', 'a:has-text("Google")', '[aria-label*="Google" i]'];
const GOOGLE_EMAIL_SELECTORS = ['input[type="email"]', '#identifierId'];
const PASSWORD_TOGGLE_SELECTORS = ['button:has-text("password")', 'a:has-text("password")'];

async function firstVisible(page: Page, selectors: string[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  return null;
}

async function fillDirectForm(page: Page, credentials: AutoLoginCredentials): Promise<string | undefined> {
  const email = await firstVisible(page, EMAIL_SELECTORS, STEP_TIMEOUT_MS);
  if (!email) return 'login form not found';
  await email.fill(credentials.email);
  let password = await firstVisible(page, PASSWORD_SELECTORS, STEP_TIMEOUT_MS);
  if (!password) {
    const toggle = await firstVisible(page, PASSWORD_TOGGLE_SELECTORS, SHORT_TIMEOUT_MS);
    if (toggle) {
      await toggle.click().catch(() => {});
      password = await firstVisible(page, PASSWORD_SELECTORS, STEP_TIMEOUT_MS);
    }
  }
  if (!password) return 'password field not found';
  await password.fill(credentials.password);
  const submit = await firstVisible(page, SUBMIT_SELECTORS, SHORT_TIMEOUT_MS);
  if (submit) await submit.click().catch(() => {});
  else await password.press('Enter').catch(() => {});
  return undefined;
}

async function fillGoogleAuth(target: Page, credentials: AutoLoginCredentials): Promise<void> {
  try {
    const email = await firstVisible(target, GOOGLE_EMAIL_SELECTORS, STEP_TIMEOUT_MS);
    let password: Locator | null = null;
    if (email) {
      await email.fill(credentials.email);
      const next = await firstVisible(target, ['#identifierNext', 'button:has-text("Next")'], SHORT_TIMEOUT_MS);
      if (next) await next.click().catch(() => {});
      else await email.press('Enter').catch(() => {});
      password = await firstVisible(target, PASSWORD_SELECTORS, STEP_TIMEOUT_MS);
    }
    if (!password) {
      const account = await firstVisible(target, ['[data-identifier]'], STEP_TIMEOUT_MS);
      if (account) {
        await account.click().catch(() => {});
        password = await firstVisible(target, PASSWORD_SELECTORS, STEP_TIMEOUT_MS);
      }
    }
    if (password) {
      await password.fill(credentials.password);
      const next = await firstVisible(target, ['#passwordNext', 'button:has-text("Next")'], SHORT_TIMEOUT_MS);
      if (next) await next.click().catch(() => {});
      else await password.press('Enter').catch(() => {});
    }
  } catch {}
}

async function loginWithGoogle(page: Page, credentials: AutoLoginCredentials): Promise<string | undefined> {
  const popup = page.waitForEvent('popup', { timeout: 16_000 }).catch(() => null);
  const google = await firstVisible(page, GOOGLE_SELECTORS, STEP_TIMEOUT_MS);
  if (google) {
    await google.click().catch(() => {});
  } else {
    const entry = await firstVisible(page, ENTRY_SELECTORS, STEP_TIMEOUT_MS);
    if (!entry) return 'Google sign-in button not found';
    await entry.click().catch(() => {});
    const openedEarly = await Promise.race([popup, Bun.sleep(2_000).then(() => null)]);
    if (!openedEarly) {
      const onSurface = await firstVisible(page, GOOGLE_SELECTORS, 5_000);
      if (onSurface) await onSurface.click().catch(() => {});
    }
  }
  const opened = await popup;
  if (opened) await fillGoogleAuth(opened, credentials);
  else await fillGoogleAuth(page, credentials);
  return undefined;
}

async function login(page: Page, credentials: AutoLoginCredentials, viaGoogle: boolean): Promise<string | undefined> {
  if (viaGoogle) return loginWithGoogle(page, credentials);
  if (await firstVisible(page, GOOGLE_SELECTORS, 4_000)) return loginWithGoogle(page, credentials);
  if (await firstVisible(page, EMAIL_SELECTORS, 2_000)) return fillDirectForm(page, credentials);
  const entry = await firstVisible(page, ENTRY_SELECTORS, STEP_TIMEOUT_MS);
  if (!entry) return 'login form not found';
  await entry.click().catch(() => {});
  if (await firstVisible(page, GOOGLE_SELECTORS, 5_000)) return loginWithGoogle(page, credentials);
  if (await firstVisible(page, EMAIL_SELECTORS, 5_000)) return fillDirectForm(page, credentials);
  return 'login form not found';
}

async function waitForSignIn(page: Page, rule: SignInRule, waitMs: number, now: () => number): Promise<SignInResult> {
  const deadline = now() + waitMs;
  let last: SignInResult = { signedIn: false, reason: 'not signed in after the login attempt' };
  while (now() < deadline) {
    last = await readSignIn(page, rule, now());
    if (last.signedIn) return last;
    await Bun.sleep(POLL_MS);
  }
  return last;
}

async function signedInDetail(page: Page, rule: SignInRule): Promise<string> {
  const value = await page.evaluate(key => localStorage.getItem(key), rule.storageKey).catch(() => null);
  const payload = value ? decodeJwtPayload(value) : undefined;
  const claim = rule.claim && payload ? payload[rule.claim] : undefined;
  return typeof claim === 'string' && claim ? `signed in as ${claim}` : 'signed in';
}

async function clearStaleToken(page: Page, rule: SignInRule): Promise<boolean> {
  return page.evaluate(key => {
    const value = localStorage.getItem(key);
    if (!value) return false;
    const part = value.split('.')[1];
    let readable = false;
    if (part) {
      try {
        JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
        readable = true;
      } catch {}
    }
    if (!readable) localStorage.removeItem(key);
    return !readable;
  }, rule.storageKey).catch(() => false);
}

async function attemptSite(
  page: Page,
  site: ChatSite,
  options: AutoLoginOptions,
): Promise<AutoLoginResult> {
  if (!site.signIn) return { site: site.id, status: 'skipped', detail: 'sign-in is optional' };
  const now = options.now ?? Date.now;
  await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  const already = await readSignIn(page, site.signIn, now());
  if (already.signedIn) return { site: site.id, status: 'signed-in', detail: 'already signed in' };
  if (!options.credentials) return { site: site.id, status: 'skipped', detail: 'no credentials given' };
  const stale = await clearStaleToken(page, site.signIn);
  if (site.authUrl) await page.goto(site.authUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  else if (stale) await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await autoSolveCaptcha(page, site.captcha);
  const failure = await login(page, options.credentials, Boolean(options.viaGoogle));
  if (failure) return { site: site.id, status: 'failed', detail: failure };
  const waitMs = options.waitForSignInMs ?? DEFAULT_WAIT_MS;
  const result = await waitForSignIn(page, site.signIn, waitMs, now);
  if (!result.signedIn) {
    const reason = result.reason && result.reason !== 'not signed in' ? result.reason : 'not signed in after the login attempt';
    return { site: site.id, status: 'failed', detail: reason };
  }
  return { site: site.id, status: 'logged-in', detail: await signedInDetail(page, site.signIn) };
}

export async function autoSignIn(options: AutoLoginOptions): Promise<AutoLoginResult[]> {
  const launch = options.launch ?? launchCdpBrowser;
  const browser = await launch({ profileDir: options.profileDir });
  const results: AutoLoginResult[] = [];
  try {
    const context = browser.browser.contexts()[0];
    if (!context) throw new Error('Browser context is not available');
    for (const site of options.sites) {
      const page = await context.newPage();
      try {
        const result = await attemptSite(page, site, options);
        results.push({ ...result, detail: result.detail.slice(0, 200) });
        if (site.signIn) {
          const signedIn = result.status === 'signed-in' || result.status === 'logged-in';
          options.onSignIn?.(site.id, { signedIn, ...(signedIn ? {} : { reason: result.detail }) });
        }
      } catch (error) {
        const detail = (error instanceof Error ? error.message : String(error)).slice(0, 200);
        results.push({ site: site.id, status: 'failed', detail });
        if (site.signIn) options.onSignIn?.(site.id, { signedIn: false, reason: detail });
      } finally {
        await page.close().catch(() => {});
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}
