import type { Locator, Page } from 'playwright-core';

import { autoSolveCaptcha } from './captcha/index.ts';
import type { ChatSite } from './browser-chat.ts';
import { launchCdpBrowser, type CdpBrowser, type LaunchOptions } from './cdp.ts';
import { pageState } from './key-harvest.ts';
import { decodeJwtPayload, readSignIn, readSignInValue, type SignInResult, type SignInRule } from './sign-in.ts';

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

export interface AutoLoginDashboard {
  id: string;
  url: string;
}

export interface AutoLoginOptions {
  sites: ChatSite[];
  dashboards?: AutoLoginDashboard[];
  credentials?: AutoLoginCredentials;
  profileDir?: string;
  viaGoogle?: boolean;
  launch?: (options: LaunchOptions) => Promise<CdpBrowser>;
  closeBrowser?: boolean;
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
const GOOGLE_SELECTORS = ['button:has-text("Google")', 'a:has-text("Google")', '[role="button"]:has-text("Google")', '[aria-label*="Google" i]'];
const GOOGLE_AUTH_HOST = /(^|\.)accounts\.google\.com$/;
const CONSENT_SELECTORS = [
  'button:has-text("No thanks")',
  'button:has-text("Reject all")',
  'button:has-text("Only necessary")',
  'button:has-text("Reject")',
  'button:has-text("Decline")',
  'button:has-text("Accept all")',
  'button:has-text("Allow all")',
  'button:has-text("Allow analytics")',
  'button:has-text("I agree")',
  'button:has-text("Got it")',
  '[aria-label="Close"]',
];
const GOOGLE_EMAIL_SELECTORS = ['input[type="email"]', '#identifierId'];
const PASSWORD_TOGGLE_SELECTORS = ['button:has-text("password")', 'a:has-text("password")'];
const GOOGLE_PROCEED_SELECTORS = [
  'button:has-text("Continue")',
  'button:has-text("Allow")',
  'button:has-text("Продолжить")',
  'button:has-text("Continuer")',
  'button:has-text("Weiter")',
  'button:has-text("Continuar")',
  'button:has-text("继续")',
];
const SITE_OAUTH_TEXT = /google|github|discord|apple|microsoft|email|passkey|guest/i;
const NEEDS_CREDENTIALS = 'sign-in needs an email and password';
const EMPTY_CREDENTIALS: AutoLoginCredentials = { email: '', password: '' };

function loginFailure(site: string, failure: string): AutoLoginResult {
  if (failure === NEEDS_CREDENTIALS) {
    return { site, status: 'skipped', detail: 'needs an email and password; sign the account in or set LOGIN_EMAIL/LOGIN_PASSWORD' };
  }
  return { site, status: 'failed', detail: failure };
}

async function firstVisible(page: Page, selectors: string[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const selector of selectors) {
      const matches = page.locator(selector);
      const count = Math.min(await matches.count().catch(() => 0), 5);
      for (let index = 0; index < count; index++) {
        const locator = matches.nth(index);
        if (await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => false)) return locator;
      }
    }
    if (Date.now() >= deadline) break;
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  return null;
}

async function firstProceed(page: Page): Promise<Locator | null> {
  const deadline = Date.now() + SHORT_TIMEOUT_MS;
  do {
    const matches = page.locator(GOOGLE_PROCEED_SELECTORS.join(', '));
    const count = Math.min(await matches.count().catch(() => 0), 5);
    for (let index = 0; index < count; index++) {
      const locator = matches.nth(index);
      if (!(await locator.isVisible().catch(() => false)) || !(await locator.isEnabled().catch(() => false))) continue;
      const text = ((await locator.textContent().catch(() => '')) ?? '').trim();
      if (SITE_OAUTH_TEXT.test(text)) continue;
      return locator;
    }
    if (Date.now() >= deadline) break;
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  return null;
}

async function fillDirectForm(page: Page, credentials: AutoLoginCredentials): Promise<string | undefined> {
  if (!credentials.email || !credentials.password) return NEEDS_CREDENTIALS;
  const email = await firstVisible(page, EMAIL_SELECTORS, STEP_TIMEOUT_MS);
  if (!email) return 'login form not found';
  await email.fill(credentials.email, { timeout: 5_000 });
  let password = await firstVisible(page, PASSWORD_SELECTORS, STEP_TIMEOUT_MS);
  if (!password) {
    const toggle = await firstVisible(page, PASSWORD_TOGGLE_SELECTORS, SHORT_TIMEOUT_MS);
    if (toggle) {
      await toggle.click().catch(() => {});
      password = await firstVisible(page, PASSWORD_SELECTORS, STEP_TIMEOUT_MS);
    }
  }
  if (!password) {
    const advance = await firstVisible(page, ENTRY_SELECTORS, SHORT_TIMEOUT_MS);
    if (advance) {
      await advance.click().catch(() => {});
      password = await firstVisible(page, PASSWORD_SELECTORS, STEP_TIMEOUT_MS);
    }
  }
  if (!password) return 'password field not found';
  await password.fill(credentials.password, { timeout: 5_000 });
  const submit = await firstVisible(page, SUBMIT_SELECTORS, SHORT_TIMEOUT_MS);
  if (submit) await submit.click().catch(() => {});
  else await password.press('Enter').catch(() => {});
  return undefined;
}

async function fillGoogleAuth(target: Page, credentials: AutoLoginCredentials): Promise<string> {
  let email = false;
  let password = false;
  let chooser = false;
  try {
    const emailInput = await firstVisible(target, GOOGLE_EMAIL_SELECTORS, STEP_TIMEOUT_MS);
    let passwordInput: Locator | null = null;
    if (emailInput && (credentials.email || (await emailInput.inputValue().catch(() => '')) !== '')) {
      email = true;
      if (credentials.email) await emailInput.fill(credentials.email, { timeout: 5_000 });
      const next = await firstVisible(target, ['#identifierNext', 'button:has-text("Next")'], SHORT_TIMEOUT_MS);
      if (next) await next.click().catch(() => {});
      else await emailInput.press('Enter').catch(() => {});
      passwordInput = await firstVisible(target, PASSWORD_SELECTORS, STEP_TIMEOUT_MS);
    } else if (emailInput) {
      return NEEDS_CREDENTIALS;
    }
    if (!passwordInput) {
      const account = await firstVisible(target, ['[data-identifier]'], STEP_TIMEOUT_MS);
      if (account) {
        chooser = true;
        await account.click().catch(() => {});
        passwordInput = await firstVisible(target, PASSWORD_SELECTORS, STEP_TIMEOUT_MS);
      }
    }
    if (passwordInput) {
      if (!credentials.password) return NEEDS_CREDENTIALS;
      password = true;
      await passwordInput.fill(credentials.password, { timeout: 5_000 });
      const next = await firstVisible(target, ['#passwordNext', 'button:has-text("Next")'], SHORT_TIMEOUT_MS);
      if (next) await next.click().catch(() => {});
      else await passwordInput.press('Enter').catch(() => {});
    }
    if (email || chooser || password || GOOGLE_AUTH_HOST.test(new URL(target.url()).hostname)) {
      const proceed = await firstProceed(target);
      if (proceed) await proceed.click().catch(() => {});
    }
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 80);
    return `email=${email} password=${password} chooser=${chooser} error=${message}`;
  }
  return `email=${email} password=${password} chooser=${chooser}`;
}

async function loginWithGoogle(page: Page, credentials: AutoLoginCredentials, trace: string[]): Promise<string | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const popup = page.waitForEvent('popup', { timeout: 16_000 }).catch(() => null);
    const startHost = new URL(page.url()).hostname;
    const navigated = page.waitForURL(url => {
      try {
        return new URL(url).hostname !== startHost;
      } catch {
        return false;
      }
    }, { timeout: 16_000 }).catch(() => null);
    const google = await firstVisible(page, GOOGLE_SELECTORS, STEP_TIMEOUT_MS);
    if (google) {
      await google.click().catch(() => {});
    } else if (attempt === 0) {
      const entry = await firstVisible(page, ENTRY_SELECTORS, STEP_TIMEOUT_MS);
      if (!entry) return 'Google sign-in button not found';
      await entry.click().catch(() => {});
      const openedEarly = await Promise.race([popup, Bun.sleep(2_000).then(() => null)]);
      if (!openedEarly) {
        const onSurface = await firstVisible(page, GOOGLE_SELECTORS, 5_000);
        if (onSurface) await onSurface.click().catch(() => {});
      }
    } else {
      break;
    }
    const opened = await Promise.race([popup, navigated.then(() => null)]);
    const note = opened ? await fillGoogleAuth(opened, credentials) : await fillGoogleAuth(page, credentials);
    if (note === NEEDS_CREDENTIALS) return NEEDS_CREDENTIALS;
    trace.push(`${opened ? 'popup' : 'same page'}${attempt ? ' retry' : ''} ${note}`);
    if (note !== 'email=false password=false chooser=false') break;
    if (!(await firstVisible(page, GOOGLE_SELECTORS, 2_000))) break;
  }
  return undefined;
}

const TERMS_PATTERN = /agree|terms|privacy|consent|policy|\bage\b|18\+|conditions/i;

async function acceptTerms(page: Page): Promise<void> {
  const boxes = page.locator('input[type="checkbox"]:not(:checked), [role="checkbox"][aria-checked="false"]');
  const count = Math.min(await boxes.count().catch(() => 0), 10);
  for (let i = 0; i < count; i++) {
    const box = boxes.nth(i);
    if (!(await box.isVisible().catch(() => false))) continue;
    const text = await box.evaluate(el => {
      const label = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
      return (label?.textContent ?? el.parentElement?.textContent ?? '').trim();
    }).catch(() => '');
    if (!TERMS_PATTERN.test(text)) continue;
    const native = await box.evaluate(el => el.tagName === 'INPUT').catch(() => true);
    if (native) await box.check({ timeout: 2_000 }).catch(async () => {
      await box.click({ timeout: 2_000 }).catch(() => {});
    });
    else await box.click({ timeout: 2_000 }).catch(() => {});
  }
}

async function login(page: Page, credentials: AutoLoginCredentials, viaGoogle: boolean, trace: string[]): Promise<string | undefined> {
  await acceptTerms(page);
  if (GOOGLE_AUTH_HOST.test(new URL(page.url()).hostname)) {
    const note = await fillGoogleAuth(page, credentials);
    if (note === NEEDS_CREDENTIALS) return NEEDS_CREDENTIALS;
    trace.push(note);
    return undefined;
  }
  if (viaGoogle) return loginWithGoogle(page, credentials, trace);
  if (await firstVisible(page, GOOGLE_SELECTORS, 4_000)) return loginWithGoogle(page, credentials, trace);
  if (await firstVisible(page, EMAIL_SELECTORS, 2_000)) {
    const failure = await fillDirectForm(page, credentials);
    if (!failure) trace.push('direct form submitted');
    return failure;
  }
  const entry = await firstVisible(page, ENTRY_SELECTORS, STEP_TIMEOUT_MS);
  if (!entry) return 'login form not found';
  await entry.click().catch(() => {});
  if (await firstVisible(page, GOOGLE_SELECTORS, 5_000)) return loginWithGoogle(page, credentials, trace);
  if (await firstVisible(page, EMAIL_SELECTORS, 5_000)) {
    const failure = await fillDirectForm(page, credentials);
    if (!failure) trace.push('direct form submitted');
    return failure;
  }
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
  const value = await readSignInValue(page, rule);
  const payload = value ? decodeJwtPayload(value) : undefined;
  const claim = rule.claim && payload ? payload[rule.claim] : undefined;
  return typeof claim === 'string' && claim ? `signed in as ${claim}` : 'signed in';
}

async function clearStaleToken(page: Page, rule: SignInRule): Promise<boolean> {
  if (!rule.storageKey) return false;
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
  await page.goto(site.authUrl ?? site.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  const already = await readSignIn(page, site.signIn, now());
  if (already.signedIn) return { site: site.id, status: 'signed-in', detail: 'already signed in' };
  const stale = await clearStaleToken(page, site.signIn);
  if (stale) await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await autoSolveCaptcha(page, site.captcha);
  await dismissConsent(page);
  const trace: string[] = [];
  const failure = await login(page, options.credentials ?? EMPTY_CREDENTIALS, Boolean(options.viaGoogle), trace);
  if (failure) return loginFailure(site.id, failure);
  const waitMs = options.waitForSignInMs ?? DEFAULT_WAIT_MS;
  const result = await waitForSignIn(page, site.signIn, waitMs, now);
  if (!result.signedIn) {
    const reason = result.reason && result.reason !== 'not signed in' ? result.reason : 'not signed in after the login attempt';
    return { site: site.id, status: 'failed', detail: trace.length ? `${reason} [${trace.join('; ')}]` : reason };
  }
  return { site: site.id, status: 'logged-in', detail: await signedInDetail(page, site.signIn) };
}

async function dismissConsent(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const button = await firstVisible(page, CONSENT_SELECTORS, 1_000);
    if (!button) return;
    await button.click().catch(() => {});
  }
}

async function looksLikeLoginPage(page: Page, url: string): Promise<boolean> {
  const selector = [...EMAIL_SELECTORS, ...PASSWORD_SELECTORS, ...GOOGLE_SELECTORS, ...ENTRY_SELECTORS].map(part => `${part}:visible`).join(', ');
  const visible = async () => page.locator(selector).first().isVisible().catch(() => false);
  const state = pageState(page.url(), url);
  if (state.detail?.startsWith('not signed in')) return true;
  if (!state.ok) {
    const deadline = Date.now() + 3_000;
    do {
      if (await visible()) return true;
      await Bun.sleep(200);
    } while (Date.now() < deadline);
    return false;
  }
  if (await visible()) {
    await Bun.sleep(600);
    if (await visible()) return true;
  }
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
  const deadline = Date.now() + 6_000;
  do {
    if (await visible()) return true;
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  return false;
}

async function attemptDashboard(
  page: Page,
  target: AutoLoginDashboard,
  options: AutoLoginOptions,
): Promise<AutoLoginResult> {
  const now = options.now ?? Date.now;
  await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  if (!(await looksLikeLoginPage(page, target.url))) return { site: target.id, status: 'signed-in', detail: 'already signed in' };
  await autoSolveCaptcha(page);
  await dismissConsent(page);
  const trace: string[] = [];
  const failure = await login(page, options.credentials ?? EMPTY_CREDENTIALS, Boolean(options.viaGoogle), trace);
  if (failure) {
    if (failure === 'login form not found' && !(await looksLikeLoginPage(page, target.url))) return { site: target.id, status: 'signed-in', detail: 'already signed in' };
    return loginFailure(target.id, failure);
  }
  const failed = (): AutoLoginResult => ({
    site: target.id,
    status: 'failed',
    detail: trace.length ? `not signed in after the login attempt [${trace.join('; ')}]` : 'not signed in after the login attempt',
  });
  const deadline = now() + (options.waitForSignInMs ?? DEFAULT_WAIT_MS);
  while (now() < deadline) {
    if (!(await looksLikeLoginPage(page, target.url))) return { site: target.id, status: 'logged-in', detail: 'signed in' };
    await Bun.sleep(POLL_MS);
  }
  await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
  if (!(await looksLikeLoginPage(page, target.url))) return { site: target.id, status: 'logged-in', detail: 'signed in' };
  return failed();
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
    for (const target of options.dashboards ?? []) {
      const page = await context.newPage();
      try {
        const result = await attemptDashboard(page, target, options);
        results.push({ ...result, detail: result.detail.slice(0, 200) });
      } catch (error) {
        const detail = (error instanceof Error ? error.message : String(error)).slice(0, 200);
        results.push({ site: target.id, status: 'failed', detail });
      } finally {
        await page.close().catch(() => {});
      }
    }
    return results;
  } finally {
    if (options.closeBrowser !== false) await browser.close();
  }
}
