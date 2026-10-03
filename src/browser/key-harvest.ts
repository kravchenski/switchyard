import { launchCdpBrowser } from './cdp.ts';
import { KEY_ADAPTERS, type ProviderKeyAdapter } from '../providers/key-adapters.ts';

export type HarvestStatus = 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed';

export interface HarvestResult {
  provider: string;
  status: HarvestStatus;
  detail: string;
  keyPreview?: string;
}

export interface HarvestLocator {
  count(): Promise<number>;
  first(): HarvestLocator;
  click(options?: { timeout?: number }): Promise<void>;
  inputValue(): Promise<string>;
  textContent(): Promise<string | null>;
  isVisible(): Promise<boolean>;
  fill(value: string): Promise<void>;
}

export interface HarvestPage {
  goto(url: string, options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>;
  url(): string;
  locator(selector: string): HarvestLocator;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
}

export interface HarvestStoreEntry {
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
const LOGIN_PATH = /\/(login|signin|sign-in|auth|oauth|challenge)\//i;

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
  const sameLabel = existing.find(entry => entry.method === 'api-key' && entry.email === label);
  if (sameLabel) store.remove(sameLabel.id);
  store.addApiKey({ provider, label, apiKey });
  return sameLabel ? 'updated' : 'created';
}

export function pageState(pageUrl: string, keyUrl: string): { ok: boolean; detail?: string } {
  const page = new URL(pageUrl);
  const key = new URL(keyUrl);
  if (page.hostname === key.hostname || page.hostname.endsWith(`.${key.hostname}`)) return { ok: true };
  const login = LOGIN_HOSTS.test(page.hostname) || LOGIN_PATH.test(page.pathname);
  return { ok: false, detail: login ? 'not signed in (bun run account connect)' : `redirected to ${page.hostname}` };
}

async function readCandidate(locator: HarvestLocator): Promise<string | null> {
  try {
    return await locator.inputValue();
  } catch {}
  try {
    return await locator.textContent();
  } catch {}
  return null;
}

async function scanDom(page: HarvestPage, pattern: RegExp): Promise<string[]> {
  return page.evaluate(
    ({ source }) => {
      const re = new RegExp(source);
      const found: string[] = [];
      const push = (raw: string | null | undefined) => {
        if (!raw) return;
        for (const token of raw.split(/[\s"'`]+/)) if (re.test(token)) found.push(token);
      };
      for (const element of Array.from(document.querySelectorAll('input, code, pre, [data-key], [data-api-key]'))) {
        const input = element as HTMLInputElement;
        push(input.value || input.textContent);
      }
      push(document.body?.innerText);
      return [...new Set(found)];
    },
    { source: pattern.source },
  );
}

export async function harvestOne(adapter: ProviderKeyAdapter, page: HarvestPage, store: HarvestStore, options: HarvestOptions): Promise<HarvestResult> {
  const failed = (detail: string): HarvestResult => ({ provider: adapter.provider, status: 'failed', detail });
  const skipped = (detail: string): HarvestResult => ({ provider: adapter.provider, status: 'skipped', detail });
  try {
    await page.goto(adapter.keyUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const state = pageState(page.url(), adapter.keyUrl);
    if (!state.ok) return skipped(state.detail!);

    const findKey = async (): Promise<string | null> => {
      for (const selector of adapter.keySelectors) {
        const found = validateKey(await readCandidate(page.locator(selector).first()), adapter.keyPattern);
        if (found) return found;
      }
      for (const token of await scanDom(page, adapter.keyPattern).catch(() => [])) {
        const found = validateKey(token, adapter.keyPattern);
        if (found) return found;
      }
      return null;
    };

    const key = await findKey();
    if (!key) return failed(`no key found; create one manually at ${adapter.keyUrl}`);
    const stored = storeHarvestedKey(store, adapter.provider, options.label, key);
    const detail = stored === 'created' ? 'created' : stored === 'updated' ? 'replaced the saved key' : 'already saved';
    return { provider: adapter.provider, status: stored, detail, keyPreview: keyPreview(key) };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}
