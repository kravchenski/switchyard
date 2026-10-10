import { launchCdpBrowser, type CdpBrowser } from './cdp.ts';
import { KEY_ADAPTERS, type ProviderKeyAdapter } from '../providers/key-adapters.ts';

export type HarvestStatus = 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed';

export interface HarvestResult {
  provider: string;
  status: HarvestStatus;
  detail: string;
  keyPreview?: string;
}

interface HarvestLocator {
  count(): Promise<number>;
  first(): HarvestLocator;
  click(options?: { timeout?: number }): Promise<void>;
  inputValue(options?: { timeout?: number }): Promise<string>;
  textContent(options?: { timeout?: number }): Promise<string | null>;
  isVisible(): Promise<boolean>;
  fill(value: string): Promise<void>;
  evaluate<R, A>(fn: (el: Element, arg?: A) => R | Promise<R>, arg?: A): Promise<R>;
}

export interface HarvestPage {
  goto(url: string, options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>;
  url(): string;
  locator(selector: string): HarvestLocator;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
}

interface HarvestStoreEntry {
  id: string;
  provider: string;
  email: string;
  method?: string;
  token?: string;
}

export interface HarvestStore {
  list(provider?: string): HarvestStoreEntry[];
  addApiKey(input: { provider: string; label: string; apiKey: string }): unknown;
  remove(id: string): boolean;
}

export interface HarvestOptions {
  label: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const LOGIN_HOSTS = /(^|\.)accounts\.google\.com$/;
const LOGIN_PATH = /\/(login|signin|sign_?in|sign-in|auth|oauth|authorize|authenticate|challenge)(\/|$)/i;
const FORBIDDEN_BUTTON = /\b(pay|buy|upgrade|subscribe|billing)\b/i;
const CREATE_WAIT_MS = 15_000;
const UI_WAIT_MS = 10_000;

const DISMISS_SELECTORS = [
  'button:has-text("No thanks")',
  'button:has-text("Save My Preferences")',
  'button:has-text("Reject all")',
  'button:has-text("Only necessary")',
  'button:has-text("Reject")',
  'button:has-text("Decline")',
  'button:has-text("Accept all")',
  'button:has-text("Allow all")',
  'button:has-text("Allow analytics")',
  'button:has-text("I agree")',
  'button:has-text("Got it")',
  'button:has-text("Maybe later")',
  '[aria-label="Close"]',
];
const DIALOG_PROCEED_SELECTORS = [
  '[role="dialog"] button:has-text("Continue")',
  '[role="dialog"] button:has-text("Accept and continue")',
  '[role="dialog"] button:has-text("Save")',
];

export function validateKey(candidate: string | null | undefined, pattern: RegExp): string | null {
  const value = candidate?.trim();
  if (!value || value.length < 16 || /\s/.test(value) || !pattern.test(value)) return null;
  return value;
}

export function keyPreview(key: string): string {
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

export function storeHarvestedKey(store: HarvestStore, provider: string, label: string, apiKey: string): 'created' | 'updated' | 'unchanged' {
  const existing = store.list(provider);
  if (existing.some(entry => entry.token === apiKey)) return 'unchanged';
  const normalized = label.trim().toLowerCase();
  const sameLabel = existing.find(entry => entry.method === 'api-key' && entry.email === normalized);
  if (sameLabel) store.remove(sameLabel.id);
  store.addApiKey({ provider, label: normalized, apiKey });
  return sameLabel ? 'updated' : 'created';
}

export function pageState(pageUrl: string, keyUrl: string): { ok: boolean; detail?: string } {
  const page = new URL(pageUrl);
  const key = new URL(keyUrl);
  if (LOGIN_HOSTS.test(page.hostname) || LOGIN_PATH.test(page.pathname)) {
    return { ok: false, detail: 'not signed in (bun run account connect)' };
  }
  if (page.hostname === key.hostname || page.hostname.endsWith(`.${key.hostname}`)) return { ok: true };
  return { ok: false, detail: `redirected to ${page.hostname}` };
}

async function readCandidate(locator: HarvestLocator): Promise<string | null> {
  try {
    return await locator.inputValue({ timeout: 1_500 });
  } catch {}
  try {
    return await locator.textContent({ timeout: 1_500 });
  } catch {}
  return null;
}

const COPY_SELECTORS = [
  'button:has-text("content_copy")',
  '[aria-label*="content_copy" i]',
  '[aria-label*="copy key" i]',
  '[aria-label*="copy" i]',
  'button:has-text("Copy key")',
  'button:has-text("Copy API key")',
  'button:has-text("Copy")',
];

async function readViaCopy(page: HarvestPage, pattern: RegExp, sleep: (ms: number) => Promise<void>): Promise<string | null> {
  const target = await visibleLocator(page, COPY_SELECTORS);
  if (!target) return null;
  await target.locator.click({ timeout: 2_000 }).catch(() => {});
  await sleep(300);
  const read = page.evaluate(() => navigator.clipboard.readText().catch(() => ''), 'clipboard').catch(() => '');
  const text = await Promise.race([read, sleep(4_000).then(() => '')]);
  return validateKey(typeof text === 'string' ? text : '', pattern);
}

async function scanDom(page: HarvestPage, pattern: RegExp): Promise<string[]> {
  const scan = page.evaluate(
    ({ source }) => {
      const re = new RegExp(source);
      const found: string[] = [];
      const push = (raw: string | null | undefined) => {
        if (!raw) return;
        for (const token of raw.split(/[\s"'`]+/)) if (re.test(token)) found.push(token);
      };
      for (const element of Array.from(document.querySelectorAll('input, textarea, code, pre, [data-key], [data-api-key]'))) {
        const input = element as HTMLInputElement;
        push(input.value || input.textContent);
      }
      push(document.body?.innerText);
      return [...new Set(found)];
    },
    { source: pattern.source },
  ).catch(() => [] as string[]);
  return await Promise.race([scan, Bun.sleep(8_000).then(() => [] as string[])]);
}

async function visibleLocator(page: HarvestPage, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return { locator, selector };
  }
  return undefined;
}

async function settleUrl(page: HarvestPage, now: () => number, sleep: (ms: number) => Promise<void>): Promise<void> {
  const deadline = now() + 3_000;
  let previous = page.url();
  for (;;) {
    await sleep(300);
    const current = page.url();
    if (current === previous) return;
    previous = current;
    if (now() >= deadline) return;
  }
}

async function looksLikeAuthWall(page: HarvestPage): Promise<boolean> {
  const scan = page
    .evaluate(() => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const AUTH_BUTTON = /^(continue with\b|sign in\b|log in\b|login\b|sign up\b|登录|登入|注册|登陸|회원가입|ログイン)/i;
      const inputs = Array.from(document.querySelectorAll('input[type="password"], input[type="email"]')).some(visible);
      const onInteractive = (element: Element) => {
        if (element.matches('button, [role="button"], a') && visible(element)) {
          return AUTH_BUTTON.test((element.textContent || '').trim().slice(0, 60));
        }
        if (!inputs || !element.matches('div, span') || !visible(element)) return false;
        const text = (element.textContent || '').trim();
        return text.length < 80 && AUTH_BUTTON.test(text);
      };
      const hasPassword = Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
      const hasAuthText = Array.from(document.querySelectorAll('button, [role="button"], a, div, span')).some(onInteractive);
      return hasPassword || hasAuthText;
    }, undefined)
    .catch(() => false);
  return await Promise.race([scan, Bun.sleep(6_000).then(() => false)]);
}

async function fillEmptyNameFields(page: HarvestPage): Promise<boolean> {
  const filled = await page
    .evaluate((selector: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      let count = 0;
      for (const element of Array.from(document.querySelectorAll(selector))) {
        const input = element as HTMLInputElement;
        const rect = input.getBoundingClientRect();
        if (!rect.width || !rect.height || input.value) continue;
        setter?.call(input, 'free-qwen-api');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        count++;
      }
      return count;
    }, ['input[name="name"]', 'input[placeholder*="name" i]', 'input[placeholder*="e.g." i]'].join(','))
    .catch(() => 0);
  return typeof filled === 'number' ? filled > 0 : Boolean(filled);
}

async function waitForTurnstile(page: HarvestPage, now: () => number, sleep: (ms: number) => Promise<unknown>): Promise<boolean> {
  const holder = '#cf-turnstile';
  const token = 'input[name="cf-turnstile-response"]';
  let present = await page.locator(`${holder}, ${token}`).count().catch(() => 0);
  const mountDeadline = now() + 2_000;
  while (!present && now() < mountDeadline) {
    await sleep(150);
    present = await page.locator(`${holder}, ${token}`).count().catch(() => 0);
  }
  if (!present) return true;
  const deadline = now() + 15_000;
  while (now() < deadline) {
    const solved = (await page.locator(token).first().inputValue().catch(() => '')) !== '';
    if (solved) return true;
    if ((await page.locator(holder).count().catch(() => 0)) === 0) return true;
    await sleep(250);
  }
  return false;
}

async function clearBlockingUi(page: HarvestPage): Promise<void> {
  const selectors = [...DIALOG_PROCEED_SELECTORS, ...DISMISS_SELECTORS];
  let checkboxSeen = false;
  for (let round = 0; round < 8; round++) {
    let clicked = await fillEmptyNameFields(page);
    const dialogCheckbox = page.locator('[role="dialog"] input[type="checkbox"]:not(:checked)').first();
    if (await dialogCheckbox.isVisible().catch(() => false)) {
      await dialogCheckbox.click({ timeout: 1_500 }).catch(() => {});
      checkboxSeen = true;
      clicked = true;
    }
    const skip = await visibleLocator(page, ['button:has-text("Skip this step")', 'button:has-text("Skip")']);
    if (skip) {
      await skip.locator.click({ timeout: 1_500 }).catch(() => {});
      clicked = true;
    }
    const pageContinue = await visibleLocator(page, [
      'button:has-text("Continue")',
      '[role="button"]:has-text("Continue")',
      'button:has-text("Accept and continue")',
    ]);
    if (pageContinue) {
      if (round > 0 && !checkboxSeen) {
        const pageCheckbox = page.locator('input[type="checkbox"]:not(:checked)').first();
        if (await pageCheckbox.isVisible().catch(() => false)) {
          await pageCheckbox.click({ timeout: 1_500 }).catch(() => {});
          checkboxSeen = true;
          clicked = true;
        }
      }
      await pageContinue.locator.click({ timeout: 1_500 }).catch(() => {});
      clicked = true;
    }
    const workflowUi = await page
      .evaluate(() => {
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        return Array.from(document.querySelectorAll('button, [role="button"]')).some(
          button => visible(button) && /^(create|confirm|generate|save|submit)\b/i.test((button.textContent || '').trim()),
        );
      }, undefined)
      .catch(() => false);
    for (const selector of selectors) {
      if (workflowUi && selector.includes('aria-label="Close"')) continue;
      const button = page.locator(selector).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 1_500 }).catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) return;
    await Bun.sleep(400);
  }
}

async function clickSafe(page: HarvestPage, keyUrl: string, target: { locator: HarvestLocator; selector: string }) {
  const state = pageState(page.url(), keyUrl);
  if (state.detail?.startsWith('not signed in')) throw new Error(state.detail);
  const text = ((await target.locator.textContent().catch(() => '')) ?? '').trim();
  if (FORBIDDEN_BUTTON.test(text)) throw new Error(`refusing to click "${text}"`);
  await target.locator.click({ timeout: 5_000 });
}

async function waitForVisible(
  page: HarvestPage,
  selectors: string[],
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
): Promise<{ locator: HarvestLocator; selector: string } | undefined> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const found = await visibleLocator(page, selectors);
    if (found) return found;
    if (now() >= deadline) return undefined;
    await sleep(250);
  }
}

export async function harvestOne(adapter: ProviderKeyAdapter, page: HarvestPage, store: HarvestStore, options: HarvestOptions): Promise<HarvestResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const failed = (detail: string): HarvestResult => ({ provider: adapter.provider, status: 'failed', detail });
  const skipped = (detail: string): HarvestResult => ({ provider: adapter.provider, status: 'skipped', detail });
  try {
    await page.goto(adapter.keyUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await settleUrl(page, now, sleep);
    const state = pageState(page.url(), adapter.keyUrl);
    if (state.detail?.startsWith('not signed in')) return skipped(state.detail);
    const password = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    if (password) return skipped('not signed in (bun run account connect)');
    if (await looksLikeAuthWall(page)) return skipped('not signed in (bun run account connect)');

    const findKey = async (): Promise<string | null> => {
      for (const selector of adapter.keySelectors) {
        const found = validateKey(await readCandidate(page.locator(selector).first()), adapter.keyPattern);
        if (found) return found;
      }
      for (const token of await scanDom(page, adapter.keyPattern).catch(() => [])) {
        const found = validateKey(token, adapter.keyPattern);
        if (found) return found;
      }
      const copied = await readViaCopy(page, adapter.keyPattern, sleep);
      if (copied) return copied;
      return null;
    };

    await clearBlockingUi(page);
    let key = await findKey();
    if (!key) {
      let confirm = await visibleLocator(page, adapter.confirmSelectors.filter(selector => selector.includes('[role="dialog"]')));
      if (!confirm) {
        const create = await waitForVisible(page, adapter.createSelectors, now, sleep, UI_WAIT_MS);
        if (!create) {
          if (await looksLikeAuthWall(page)) return skipped('not signed in (bun run account connect)');
          const paymentRequired = await page
            .evaluate(() => /add a payment method|payment method required|requires? a payment method|add a billing method/i.test(document.body?.innerText || ''), undefined)
            .catch(() => false);
          if (paymentRequired) return failed(`the provider requires a payment method; add billing at ${adapter.keyUrl}`);
          return failed(`no key found; create one manually at ${adapter.keyUrl}`);
        }
        try {
          await clickSafe(page, adapter.keyUrl, create);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/not enabled/i.test(message)) {
            await fillEmptyNameFields(page);
            try {
              await clickSafe(page, adapter.keyUrl, create);
            } catch (retry) {
              const retryMessage = retry instanceof Error ? retry.message : String(retry);
              if (/not enabled/i.test(retryMessage)) return failed('create button is disabled (paid plan or onboarding required)');
              if (!/intercepts pointer events/i.test(retryMessage)) throw retry;
              await clearBlockingUi(page);
              await create.locator.evaluate((el: Element) => (el as HTMLElement).click()).catch(() => {});
            }
          } else if (!/intercepts pointer events/i.test(message)) throw error;
          else {
            await clearBlockingUi(page);
            await create.locator.evaluate((el: Element) => (el as HTMLElement).click()).catch(() => {});
          }
        }
        await clearBlockingUi(page);
        const turnstileOk = await waitForTurnstile(page, now, sleep);
        if (!turnstileOk) return failed(`the provider's bot check blocked key creation; create a key manually at ${adapter.keyUrl}`);
        key = await findKey();
        if (!key) confirm = await visibleLocator(page, adapter.confirmSelectors);
      }
      const uiDeadline = now() + UI_WAIT_MS;
      let filled = false;
      for (;;) {
        if (key) break;
        if (!filled) {
          const name = await visibleLocator(page, adapter.nameFieldSelectors);
          if (name) {
            await name.locator.fill(`free-qwen-api-${new Date(now()).toISOString().slice(0, 10).replaceAll('-', '')}`);
            filled = true;
          }
        }
        const current = confirm ?? (confirm = await visibleLocator(page, adapter.confirmSelectors));
        if (current) {
          await clickSafe(page, adapter.keyUrl, current);
          break;
        }
        if (now() >= uiDeadline) break;
        await sleep(250);
      }
      const keyDeadline = now() + CREATE_WAIT_MS;
      while (!(key = await findKey())) {
        const blocked = await page
          .evaluate(() => /bot_verification_failed|couldn't verify this request|error creating/i.test(document.body?.innerText || ''), undefined)
          .catch(() => false);
        if (blocked) return failed(`the provider's bot check blocked key creation; create a key manually at ${adapter.keyUrl}`);
        if (now() >= keyDeadline) return failed(`key did not appear after creating; check ${adapter.keyUrl}`);
        await sleep(250);
      }
    }
    const stored = storeHarvestedKey(store, adapter.provider, options.label, key);
    const detail = stored === 'created' ? 'created' : stored === 'updated' ? 'replaced the saved key' : 'already saved';
    return { provider: adapter.provider, status: stored, detail, keyPreview: keyPreview(key) };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

interface HarvestContext {
  newPage(): Promise<HarvestPage & { close(): Promise<void> }>;
}

export interface HarvestBrowser {
  contexts(): HarvestContext[];
  close(): Promise<void>;
}

export function harvestBrowserFrom(cdp: CdpBrowser, close: () => Promise<void> = async () => {}): HarvestBrowser {
  return {
    contexts: () =>
      cdp.browser.contexts().map(context => ({
        newPage: async () => (await context.newPage()) as unknown as HarvestPage & { close(): Promise<void> },
      })),
    close,
  };
}

async function defaultLaunch({ profileDir }: { profileDir: string }): Promise<HarvestBrowser> {
  const cdp = await launchCdpBrowser({ profileDir });
  await cdp.browser.contexts()[0]?.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  return harvestBrowserFrom(cdp, () => cdp.close());
}

export async function harvestKeys(options: {
  profileDir: string;
  store: HarvestStore;
  label: string;
  providers?: string[];
  adapters?: ProviderKeyAdapter[];
  launch?: (options: { profileDir: string }) => Promise<HarvestBrowser>;
  onResult?: (result: HarvestResult) => void;
}): Promise<HarvestResult[]> {
  const adapters = (options.adapters ?? KEY_ADAPTERS).filter(adapter => !options.providers || options.providers.includes(adapter.provider));
  const browser = await (options.launch ?? defaultLaunch)({ profileDir: options.profileDir });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('Browser profile has no default context');
    const results: HarvestResult[] = [];
    for (const adapter of adapters) {
      const page = await context.newPage();
      try {
        const result = await harvestOne(adapter, page, options.store, { label: options.label });
        results.push(result);
        options.onResult?.(result);
      } catch (error) {
        const result: HarvestResult = { provider: adapter.provider, status: 'failed', detail: error instanceof Error ? error.message : String(error) };
        results.push(result);
        options.onResult?.(result);
      } finally {
        await page.close().catch(() => {});
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}
