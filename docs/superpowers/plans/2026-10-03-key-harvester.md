# Key Harvester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `bun run account harvest` command (plus a desktop button) that opens each provider's key dashboard in the signed-in browser profile, creates or refreshes API keys, and stores them encrypted — with one explicit consent question.

**Architecture:** Data-only per-provider adapter configs feed a provider-agnostic browser engine (playwright over CDP, one browser per run, one page per provider). The engine extracts or creates a key, validates it, and writes it through the existing `CredentialStore`. The CLI owns consent, report and exit codes; the desktop app shells out to the CLI with `--yes`.

**Tech Stack:** Bun + TypeScript (strict), playwright-core over CDP, bun:test, Rust/GPUI desktop app (cargo test).

**Spec:** `docs/superpowers/specs/2026-10-03-key-harvester-design.md`

## Global Constraints

- No code comments anywhere; 2-space indent; ES modules; strict TypeScript.
- CLI/user-facing strings are English; commit messages Conventional Commits (`type(scope): description`).
- Every task ends with `bun run ci` green (`check && typecheck && test`) before its commit; desktop tasks also need `cargo test`/`cargo check` green.
- Browser-dependent tests are gated: `describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1' || !findBrowserExecutable())`.
- Never print full keys; only `keyPreview` = first 5 chars + `…` + last 4 chars.
- Base branch: `feat/key-harvester` (already has the spec commits).

---

### Task 1: Adapter registry + integrity test

**Files:**
- Create: `src/providers/key-adapters.ts`
- Test: `test/key-adapters.test.ts`

**Interfaces:**
- Consumes: `API_KEY_PROVIDERS` from `src/providers/catalog.ts` (each entry has required `id: string` and `keyUrl: string`).
- Produces: `ProviderKeyAdapter { provider: string; keyUrl: string; keyPattern: RegExp; createSelectors: string[]; nameFieldSelectors: string[]; confirmSelectors: string[]; keySelectors: string[] }`, exported `KEY_ADAPTERS: ProviderKeyAdapter[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';

import { API_KEY_PROVIDERS } from '../src/providers/catalog.ts';
import { KEY_ADAPTERS } from '../src/providers/key-adapters.ts';

describe('key adapters', () => {
  test('cover every catalog provider with a matching key url', () => {
    const ids = KEY_ADAPTERS.map(adapter => adapter.provider).sort();
    expect(ids).toEqual(API_KEY_PROVIDERS.map(provider => provider.id).sort());
    for (const provider of API_KEY_PROVIDERS) {
      const adapter = KEY_ADAPTERS.find(entry => entry.provider === provider.id);
      if (!adapter) throw new Error(`Missing adapter: ${provider.id}`);
      expect(adapter.keyUrl).toBe(provider.keyUrl);
      expect(adapter.keyPattern.source.length).toBeGreaterThan(5);
      expect(adapter.createSelectors.length).toBeGreaterThan(0);
      expect(adapter.keySelectors.length).toBeGreaterThan(0);
    }
  });

  test('are unique, https and pattern-anchored', () => {
    const ids = KEY_ADAPTERS.map(adapter => adapter.provider);
    expect(new Set(ids).size).toBe(ids.length);
    for (const adapter of KEY_ADAPTERS) {
      expect(adapter.keyUrl.startsWith('https://')).toBe(true);
      expect(adapter.keyPattern.source.startsWith('^')).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test ./test/key-adapters.test.ts`
Expected: FAIL — module `src/providers/key-adapters.ts` not found.

- [ ] **Step 3: Write the adapter registry**

`src/providers/key-adapters.ts`:

```ts
import { API_KEY_PROVIDERS } from './catalog.ts';

export interface ProviderKeyAdapter {
  provider: string;
  keyUrl: string;
  keyPattern: RegExp;
  createSelectors: string[];
  nameFieldSelectors: string[];
  confirmSelectors: string[];
  keySelectors: string[];
}

function keyUrl(id: string) {
  const provider = API_KEY_PROVIDERS.find(entry => entry.id === id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider.keyUrl;
}

const NAME_FIELDS = [
  'input[name="name"]',
  'input[placeholder*="name" i]',
  'input[placeholder*="Name" i]',
  'input[name="description"]',
  '#token-name',
];

const CONFIRMS = [
  'button:has-text("Confirm")',
  'button:has-text("I agree")',
  'button:has-text("Got it")',
  'button:has-text("OK")',
];

const CREATORS = [
  'button:has-text("Create")',
  'a:has-text("Create")',
  'button:has-text("Generate")',
  'button:has-text("Get API Key")',
  'button:has-text("New")',
];

const READABLE = ['code', 'input[readonly]', 'pre [data-key]', '[data-api-key]'];

const common = {
  createSelectors: CREATORS,
  nameFieldSelectors: NAME_FIELDS,
  confirmSelectors: CONFIRMS,
  keySelectors: READABLE,
};

export const KEY_ADAPTERS: ProviderKeyAdapter[] = [
  { provider: 'nvidia', keyUrl: keyUrl('nvidia'), keyPattern: /^nvapi-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'xkiro', keyUrl: keyUrl('xkiro'), keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'openrouter', keyUrl: keyUrl('openrouter'), keyPattern: /^sk-or-v1-[A-Za-z0-9_-]{32,}$/, ...common },
  { provider: 'groq', keyUrl: keyUrl('groq'), keyPattern: /^gsk_[A-Za-z0-9]{20,}$/, ...common },
  { provider: 'gemini', keyUrl: keyUrl('gemini'), keyPattern: /^AIza[A-Za-z0-9_-]{30,}$/, ...common },
  { provider: 'cerebras', keyUrl: keyUrl('cerebras'), keyPattern: /^csk-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'mistral', keyUrl: keyUrl('mistral'), keyPattern: /^[a-f0-9]{32}$/, ...common },
  { provider: 'sambanova', keyUrl: keyUrl('sambanova'), keyPattern: /^[A-Za-z0-9]{32,64}$/, ...common },
  {
    provider: 'github-models',
    keyUrl: keyUrl('github-models'),
    keyPattern: /^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}$|^github_pat_[A-Za-z0-9_]{20,}$/,
    ...common,
  },
  { provider: 'huggingface', keyUrl: keyUrl('huggingface'), keyPattern: /^hf_[A-Za-z0-9]{30,}$/, ...common },
  { provider: 'bigmodel', keyUrl: keyUrl('bigmodel'), keyPattern: /^[a-f0-9]{32}(?:\.[A-Za-z0-9_-]{8,})?$/, ...common },
  { provider: 'cohere', keyUrl: keyUrl('cohere'), keyPattern: /^[A-Za-z0-9]{34,}$/, ...common },
  { provider: 'aion', keyUrl: keyUrl('aion'), keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'ovhcloud', keyUrl: keyUrl('ovhcloud'), keyPattern: /^[A-Za-z0-9]{32,64}$/, ...common },
  { provider: 'llm7', keyUrl: keyUrl('llm7'), keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'zai', keyUrl: keyUrl('zai'), keyPattern: /^[A-Za-z0-9]{32,64}$/, ...common },
  { provider: 'ollama-cloud', keyUrl: keyUrl('ollama-cloud'), keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'opencode-zen', keyUrl: keyUrl('opencode-zen'), keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'kilo', keyUrl: keyUrl('kilo'), keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'cloudflare', keyUrl: keyUrl('cloudflare'), keyPattern: /^[A-Za-z0-9]{40}$/, ...common },
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test ./test/key-adapters.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Run full CI and commit**

Run: `bun run ci` → green.

```bash
git add src/providers/key-adapters.ts test/key-adapters.test.ts
git commit -m "feat(providers): add key page adapters for every api key provider"
```

---

### Task 2: Engine core — extract, host guard, store

**Files:**
- Create: `src/browser/key-harvest.ts`
- Test: `test/key-harvest.test.ts`

**Interfaces:**
- Consumes: `ProviderKeyAdapter` (Task 1); `Credential`/`ApiKeyCredential` shapes from `src/core/accounts/credential-store.ts` (field names `id`, `provider`, `email`, `method`, `token`).
- Produces (later tasks rely on these exact names):
  - `type HarvestStatus = 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed'`
  - `interface HarvestResult { provider: string; status: HarvestStatus; detail: string; keyPreview?: string }`
  - `interface HarvestPage`, `interface HarvestLocator`, `interface HarvestStore` (structural subsets of playwright / `CredentialStore`)
  - `validateKey(candidate, pattern): string | null`
  - `keyPreview(key): string`
  - `storeHarvestedKey(store, provider, label, apiKey): 'created' | 'updated' | 'unchanged'`
  - `harvestOne(adapter, page, store, options): Promise<HarvestResult>` with `options: { label: string; now?: () => number; sleep?: (ms: number) => Promise<void> }`

- [ ] **Step 1: Write the failing tests**

`test/key-harvest.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { harvestOne, keyPreview, storeHarvestedKey, validateKey, type HarvestPage, type HarvestStore } from '../src/browser/key-harvest.ts';
import type { ProviderKeyAdapter } from '../src/providers/key-adapters.ts';

const KEY = 'sk-live-1234567890abcdefghij';
const adapter: ProviderKeyAdapter = {
  provider: 'fake',
  keyUrl: 'https://keys.example.com/dashboard',
  keyPattern: /^sk-[A-Za-z0-9-]{20,}$/,
  createSelectors: ['button:has-text("Create")'],
  nameFieldSelectors: ['input[name="name"]'],
  confirmSelectors: ['button:has-text("Confirm")'],
  keySelectors: ['#the-key'],
};

interface FakeElement {
  visible?: boolean;
  text?: string;
  value?: string;
  click?: () => void;
}

interface FakeState {
  finalUrl?: string;
  elements?: Record<string, FakeElement>;
  scanned?: string[];
  gotoError?: string;
}

interface FakeRow {
  id: string;
  provider: string;
  email: string;
  password?: string;
  method?: string;
  token?: string;
}

function fakeStore(initial: FakeRow[] = []): HarvestStore & { rows: FakeRow[]; removed: string[] } {
  const rows: FakeRow[] = [...initial];
  const removed: string[] = [];
  return {
    rows,
    removed,
    list: provider => rows.filter(row => !provider || row.provider === provider),
    addApiKey: input => {
      const row: FakeRow = { id: `${input.provider}-${rows.length + 1}`, provider: input.provider, email: input.label, password: '', method: 'api-key', token: input.apiKey };
      rows.push(row);
      return row;
    },
    remove: id => {
      const index = rows.findIndex(row => row.id === id);
      if (index === -1) return false;
      removed.push(id);
      rows.splice(index, 1);
      return true;
    },
  };
}

function fakePage(state: FakeState = {}): HarvestPage {
  let current = '';
  const locator = (selector: string) => {
    const element = () => state.elements?.[selector];
    const self = {
      count: async () => (element() ? 1 : 0),
      first: () => self,
      click: async () => {
        const target = element();
        if (!target) throw new Error(`No element matches ${selector}`);
        target.click?.();
      },
      inputValue: async () => {
        const target = element();
        if (target?.value === undefined) throw new Error(`${selector} is not an input`);
        return target.value;
      },
      textContent: async () => element()?.text ?? null,
      isVisible: async () => Boolean(element()?.visible),
      fill: async (value: string) => {
        const target = element();
        if (!target || target.value === undefined) throw new Error(`${selector} is not fillable`);
        target.value = value;
      },
    };
    return self;
  };
  return {
    goto: async url => {
      if (state.gotoError) throw new Error(state.gotoError);
      current = state.finalUrl ?? url;
    },
    url: () => current,
    locator,
    evaluate: async (_fn, arg) => {
      const re = new RegExp((arg as { source: string }).source);
      return (state.scanned ?? []).flatMap(text => text.split(/[\s"'`]+/)).filter(token => re.test(token)) as never;
    },
  };
}

describe('harvest engine', () => {
  test('reads an existing key through the adapter selectors', async () => {
    const store = fakeStore();
    const page = fakePage({ finalUrl: adapter.keyUrl, elements: { '#the-key': { text: KEY } } });
    const result = await harvestOne(adapter, page, store, { label: 'default' });
    expect(result).toEqual({ provider: 'fake', status: 'created', detail: 'created', keyPreview: 'sk-li…ghij' });
    expect(store.list('fake')).toHaveLength(1);
  });

  test('scans the DOM when the selectors find nothing', async () => {
    const store = fakeStore();
    const page = fakePage({ finalUrl: adapter.keyUrl, scanned: [`prefix ${KEY} suffix`] });
    const result = await harvestOne(adapter, page, store, { label: 'default' });
    expect(result.status).toBe('created');
  });

  test('skips a page that landed on a google login', async () => {
    const store = fakeStore();
    const page = fakePage({ finalUrl: 'https://accounts.google.com/signin/v2/challenge/pwd' });
    const result = await harvestOne(adapter, page, store, { label: 'default' });
    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('not signed in');
    expect(result.detail).toContain('bun run account connect');
  });

  test('skips a page redirected to another host', async () => {
    const store = fakeStore();
    const page = fakePage({ finalUrl: 'https://evil.example.com/phish' });
    const result = await harvestOne(adapter, page, store, { label: 'default' });
    expect(result.status).toBe('skipped');
    expect(result.detail).toBe('redirected to evil.example.com');
  });

  test('falls back to manual instructions when no key and no create button', async () => {
    const store = fakeStore();
    const page = fakePage({ finalUrl: adapter.keyUrl });
    const virtual = { now: 0 };
    const result = await harvestOne(adapter, page, store, {
      label: 'default',
      now: () => virtual.now,
      sleep: async ms => {
        virtual.now += ms;
      },
    });
    expect(result.status).toBe('failed');
    expect(result.detail).toBe('no key found; create one manually at https://keys.example.com/dashboard');
  });

  test('reports a navigation failure as failed', async () => {
    const store = fakeStore();
    const page = fakePage({ gotoError: 'Timeout 30000ms exceeded' });
    const result = await harvestOne(adapter, page, store, { label: 'default' });
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('Timeout');
  });

  test('stores created, replaced and unchanged outcomes', () => {
    const store = fakeStore();
    expect(storeHarvestedKey(store, 'fake', 'default', KEY)).toBe('created');
    expect(storeHarvestedKey(store, 'fake', 'default', KEY)).toBe('unchanged');
    expect(storeHarvestedKey(store, 'fake', 'default', 'sk-other-1234567890abcdefgh')).toBe('updated');
    expect(store.removed).toEqual(['fake-1']);
    expect(store.list('fake')).toHaveLength(1);
    expect(store.list('fake')[0]?.token).toBe('sk-other-1234567890abcdefgh');
  });

  test('normalizes the label before matching and storing', () => {
    const store = fakeStore();
    expect(storeHarvestedKey(store, 'fake', '  DEFAULT ', KEY)).toBe('created');
    expect(store.list('fake')[0]?.email).toBe('default');
    expect(storeHarvestedKey(store, 'fake', 'Default', 'sk-other-1234567890abcdefgh')).toBe('updated');
    expect(store.list('fake')).toHaveLength(1);
  });

  test('validates candidates and previews keys', () => {
    expect(validateKey(KEY, adapter.keyPattern)).toBe(KEY);
    expect(validateKey(`  ${KEY}  `, adapter.keyPattern)).toBe(KEY);
    expect(validateKey('short', adapter.keyPattern)).toBeNull();
    expect(validateKey(`${KEY} tail`, adapter.keyPattern)).toBeNull();
    expect(validateKey('nvapi-abcdefghijklmnopqrstuvwxyz123456', adapter.keyPattern)).toBeNull();
    expect(validateKey(null, adapter.keyPattern)).toBeNull();
    expect(keyPreview(KEY)).toBe('sk-li…ghij');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./test/key-harvest.test.ts`
Expected: FAIL — module `src/browser/key-harvest.ts` not found.

- [ ] **Step 3: Write the engine core**

`src/browser/key-harvest.ts`:

```ts
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
  const normalized = label.trim().toLowerCase();
  const sameLabel = existing.find(entry => entry.method === 'api-key' && entry.email === normalized);
  if (sameLabel) store.remove(sameLabel.id);
  store.addApiKey({ provider, label: normalized, apiKey });
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./test/key-harvest.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Run full CI and commit**

Run: `bun run ci` → green.

```bash
git add src/browser/key-harvest.ts test/key-harvest.test.ts
git commit -m "feat(browser): extract and store api keys from provider dashboards"
```

---

### Task 3: Engine create flow + click safety

**Files:**
- Modify: `src/browser/key-harvest.ts` (no new exports; `harvestOne` behaviour only)
- Test: `test/key-harvest.test.ts` (add tests)

**Interfaces:**
- Consumes: everything from Task 2 unchanged.
- Produces: same signatures; create-flow behaviour per spec (name field, confirm dialog, 15s wait, refusal to click billing buttons).

- [ ] **Step 1: Write the failing tests**

Append to `test/key-harvest.test.ts`:

```ts
describe('harvest create flow', () => {
  test('creates a missing key, fills the name and confirms the dialog', async () => {
    const store = fakeStore();
    const elements: Record<string, FakeElement> = {};
    const state: FakeState = { finalUrl: adapter.keyUrl, elements, scanned: [] };
    elements['input[name="name"]'] = { visible: true, value: '' };
    elements['button:has-text("Create")'] = {
      visible: true,
      text: 'Create API key',
      click: () => {
        state.scanned = [KEY];
        elements['button:has-text("Confirm")'] = { visible: true, text: 'Confirm', click: () => { confirmed = true; } };
      },
    };
    let confirmed = false;
    const page = fakePage(state);
    const virtual = { now: Date.parse('2026-10-03T10:00:00Z') };
    const result = await harvestOne(adapter, page, store, {
      label: 'default',
      now: () => virtual.now,
      sleep: async ms => {
        virtual.now += ms;
      },
    });
    expect(result.status).toBe('created');
    expect(result.keyPreview).toBe('sk-li…ghij');
    expect(elements['input[name="name"]']?.value).toBe('free-qwen-api-20261003');
    expect(confirmed).toBe(true);
    expect(store.list('fake')[0]?.token).toBe(KEY);
  });

  test('refuses to click a button that mentions billing', async () => {
    const store = fakeStore();
    const elements: Record<string, FakeElement> = {
      'button:has-text("Create")': { visible: true, text: 'Upgrade plan', click: () => {} },
    };
    const page = fakePage({ finalUrl: adapter.keyUrl, elements });
    const result = await harvestOne(adapter, page, store, { label: 'default' });
    expect(result.status).toBe('failed');
    expect(result.detail).toBe('refusing to click "Upgrade plan"');
  });

  test('fails when the key never appears before the deadline', async () => {
    const store = fakeStore();
    const elements: Record<string, FakeElement> = {
      'button:has-text("Create")': { visible: true, text: 'Create', click: () => {} },
    };
    const page = fakePage({ finalUrl: adapter.keyUrl, elements });
    const virtual = { now: 0 };
    const result = await harvestOne(adapter, page, store, {
      label: 'default',
      now: () => virtual.now,
      sleep: async ms => {
        virtual.now += ms;
      },
    });
    expect(result.status).toBe('failed');
    expect(result.detail).toBe('key did not appear after creating; check https://keys.example.com/dashboard');
  });

  test('waits for a create button that appears after hydration', async () => {
    const store = fakeStore();
    const elements: Record<string, FakeElement> = {};
    const state: FakeState = { finalUrl: adapter.keyUrl, elements, scanned: [] };
    const virtual = { now: 0 };
    let elapsed = 0;
    const page = fakePage(state);
    const result = await harvestOne(adapter, page, store, {
      label: 'default',
      now: () => virtual.now,
      sleep: async ms => {
        virtual.now += ms;
        elapsed += ms;
        if (elapsed >= 1000) {
          state.elements!['button:has-text("Create")'] = {
            visible: true,
            text: 'Create',
            click: () => {
              state.scanned = [KEY];
            },
          };
        }
      },
    });
    expect(result.status).toBe('created');
    expect(elapsed).toBeGreaterThanOrEqual(1000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./test/key-harvest.test.ts`
Expected: the 3 new tests FAIL — `harvestOne` currently returns `failed: no key found; create one manually at …` because the create flow does not exist yet (the old tests still pass).

- [ ] **Step 3: Implement the create flow**

In `src/browser/key-harvest.ts`:

1. Add consts next to the login consts:

```ts
const FORBIDDEN_BUTTON = /\b(pay|buy|upgrade|subscribe|billing)\b/i;
const CREATE_WAIT_MS = 15_000;
const UI_WAIT_MS = 5_000;
```

2. Add the helpers above `harvestOne`:

```ts
async function visibleLocator(page: HarvestPage, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return { locator, selector };
  }
  return undefined;
}

async function clickSafe(page: HarvestPage, keyUrl: string, target: { locator: HarvestLocator; selector: string }) {
  const state = pageState(page.url(), keyUrl);
  if (!state.ok) throw new Error(state.detail);
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
```

3. At the top of `harvestOne`'s body add:

```ts
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
```

4. Replace

```ts
    const key = await findKey();
    if (!key) return failed(`no key found; create one manually at ${adapter.keyUrl}`);
```

with

```ts
    let key = await findKey();
    if (!key) {
      const create = await waitForVisible(page, adapter.createSelectors, now, sleep, UI_WAIT_MS);
      if (!create) return failed(`no key found; create one manually at ${adapter.keyUrl}`);
      await clickSafe(page, adapter.keyUrl, create);
      const uiDeadline = now() + UI_WAIT_MS;
      let filled = false;
      for (;;) {
        if (!filled) {
          const name = await visibleLocator(page, adapter.nameFieldSelectors);
          if (name) {
            await name.locator.fill(`free-qwen-api-${new Date(now()).toISOString().slice(0, 10).replaceAll('-', '')}`);
            filled = true;
          }
        }
        const confirm = await visibleLocator(page, adapter.confirmSelectors);
        if (confirm) {
          await clickSafe(page, adapter.keyUrl, confirm);
          break;
        }
        if (now() >= uiDeadline) break;
        await sleep(250);
      }
      const keyDeadline = now() + CREATE_WAIT_MS;
      while (!(key = await findKey())) {
        if (now() >= keyDeadline) return failed(`key did not appear after creating; check ${adapter.keyUrl}`);
        await sleep(250);
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./test/key-harvest.test.ts`
Expected: PASS (13 tests — 9 existing incl. the label-normalization test from Task 2's fix round, plus 4 new)

- [ ] **Step 5: Run full CI and commit**

Run: `bun run ci` → green.

```bash
git add src/browser/key-harvest.ts test/key-harvest.test.ts
git commit -m "feat(browser): create missing api keys through the dashboard flow"
```

---

### Task 4: `harvestKeys` — one browser, many providers

**Files:**
- Modify: `src/browser/key-harvest.ts`
- Test: `test/key-harvest.test.ts` (add tests)

**Interfaces:**
- Consumes: `harvestOne`, `KEY_ADAPTERS`.
- Produces:

```ts
export interface HarvestContext {
  newPage(): Promise<HarvestPage & { close(): Promise<void> }>;
}
export interface HarvestBrowser {
  contexts(): HarvestContext[];
  close(): Promise<void>;
}
export async function harvestKeys(options: {
  profileDir: string;
  store: HarvestStore;
  label: string;
  providers?: string[];
  adapters?: ProviderKeyAdapter[];
  launch?: (options: { profileDir: string }) => Promise<HarvestBrowser>;
}): Promise<HarvestResult[]>;
```

- [ ] **Step 1: Write the failing test**

Append to `test/key-harvest.test.ts`:

```ts
describe('harvestKeys', () => {
  const alpha: ProviderKeyAdapter = {
    provider: 'alpha',
    keyUrl: 'https://alpha.example/keys',
    keyPattern: /^sk-[A-Za-z0-9-]{20,}$/,
    createSelectors: ['button:has-text("Create")'],
    nameFieldSelectors: [],
    confirmSelectors: [],
    keySelectors: ['#the-key'],
  };
  const beta: ProviderKeyAdapter = { ...alpha, provider: 'beta', keyUrl: 'https://beta.example/keys' };
  const gamma: ProviderKeyAdapter = { ...alpha, provider: 'gamma', keyUrl: 'https://gamma.example/keys' };

  test('walks providers in one browser session and isolates failures', async () => {
    const store = fakeStore();
    const entries = [
      { page: fakePage({ finalUrl: alpha.keyUrl, elements: { '#the-key': { text: KEY } } }), closed: false },
      { page: fakePage({ finalUrl: 'https://accounts.google.com/signin' }), closed: false },
      { page: fakePage({ gotoError: 'boom' }), closed: false },
    ];
    let closed = false;
    const results = await harvestKeys({
      profileDir: '/tmp/unused',
      store,
      label: 'default',
      adapters: [alpha, beta, gamma],
      launch: async () => ({
        contexts: () => [
          {
            newPage: async () => {
              const entry = entries.shift();
              if (!entry) throw new Error('no more pages');
              return Object.assign(entry.page, { close: async () => { entry.closed = true; } });
            },
          },
        ],
        close: async () => {
          closed = true;
        },
      }),
    });
    expect(results.map(result => [result.provider, result.status])).toEqual([
      ['alpha', 'created'],
      ['beta', 'skipped'],
      ['gamma', 'failed'],
    ]);
    expect(entries.every(entry => entry.closed)).toBe(true);
    expect(closed).toBe(true);
  });

  test('filters providers through the --provider list', async () => {
    const store = fakeStore();
    const results = await harvestKeys({
      profileDir: '/tmp/unused',
      store,
      label: 'default',
      providers: ['alpha'],
      adapters: [alpha, beta],
      launch: async () => ({
        contexts: () => [{ newPage: async () => Object.assign(fakePage({ finalUrl: alpha.keyUrl, elements: { '#the-key': { text: KEY } } }), { close: async () => {} }) }],
        close: async () => {},
      }),
    });
    expect(results.map(result => result.provider)).toEqual(['alpha']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./test/key-harvest.test.ts`
Expected: FAIL — `harvestKeys` is not exported.

- [ ] **Step 3: Implement `harvestKeys`**

Append to `src/browser/key-harvest.ts`:

```ts
export interface HarvestContext {
  newPage(): Promise<HarvestPage & { close(): Promise<void> }>;
}

export interface HarvestBrowser {
  contexts(): HarvestContext[];
  close(): Promise<void>;
}

async function defaultLaunch({ profileDir }: { profileDir: string }): Promise<HarvestBrowser> {
  const cdp = await launchCdpBrowser({ profileDir });
  return {
    contexts: () =>
      cdp.browser.contexts().map(context => ({
        newPage: async () => (await context.newPage()) as unknown as HarvestPage & { close(): Promise<void> },
      })),
    close: () => cdp.close(),
  };
}

export async function harvestKeys(options: {
  profileDir: string;
  store: HarvestStore;
  label: string;
  providers?: string[];
  adapters?: ProviderKeyAdapter[];
  launch?: (options: { profileDir: string }) => Promise<HarvestBrowser>;
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
        results.push(await harvestOne(adapter, page, options.store, { label: options.label }));
      } catch (error) {
        results.push({ provider: adapter.provider, status: 'failed', detail: error instanceof Error ? error.message : String(error) });
      } finally {
        await page.close().catch(() => {});
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./test/key-harvest.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Run full CI and commit**

Run: `bun run ci` → green.

```bash
git add src/browser/key-harvest.ts test/key-harvest.test.ts
git commit -m "feat(browser): walk provider dashboards in one browser session"
```

---

### Task 5: CLI `harvest` command + wiring

**Files:**
- Modify: `src/cli/accounts.ts` (deps interface, `ACCOUNTS_USAGE`, new command branch)
- Modify: `scripts/accounts.ts` (wire `harvest`)
- Test: `test/accounts-cli.test.ts`

**Interfaces:**
- Consumes: `harvestKeys`, `HarvestResult` from `src/browser/key-harvest.ts`; `profileDir` (already imported in `scripts/accounts.ts`).
- Produces: `AccountsCliDeps.harvest?: (options: { profile: string; providers?: string[] }) => Promise<HarvestResult[]>`; command `account harvest [--profile <id>] [--provider <id>] [--yes]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/accounts-cli.test.ts` inside `describe('accounts CLI', ...)`:

```ts
test('asks for consent before harvesting and cancels on no', async () => {
  const { deps, lines } = harness();
  const calls: Array<{ profile: string; providers?: string[] }> = [];
  deps.askHidden = async () => 'n';
  deps.harvest = async options => {
    calls.push(options);
    return [{ provider: 'gemini', status: 'created', detail: 'created', keyPreview: 'AIza…1234' }];
  };
  expect(await runAccountsCommand(['harvest'], deps)).toBe(0);
  expect(calls).toEqual([]);
  expect(lines).toEqual(['Cancelled.']);
});

test('runs the harvest with --yes, prints the report and the summary last', async () => {
  const { deps, lines } = harness();
  const calls: Array<{ profile: string; providers?: string[] }> = [];
  deps.askHidden = async () => {
    throw new Error('must not ask when --yes is set');
  };
  deps.harvest = async options => {
    calls.push(options);
    return [
      { provider: 'gemini', status: 'created', detail: 'created', keyPreview: 'AIza…1234' },
      { provider: 'groq', status: 'unchanged', detail: 'already saved', keyPreview: 'gsk_…7890' },
      { provider: 'mistral', status: 'skipped', detail: 'not signed in (bun run account connect)' },
      { provider: 'zai', status: 'failed', detail: 'refusing to click "Upgrade plan"' },
    ];
  };
  expect(await runAccountsCommand(['harvest', '--yes'], deps)).toBe(0);
  expect(calls).toEqual([{ profile: 'default', providers: undefined }]);
  expect(lines.at(-1)).toBe('created: 1, updated: 0, unchanged: 1, skipped: 1, failed: 1');
  expect(lines.some(line => line.includes('gemini') && line.includes('created') && line.includes('AIza…1234'))).toBe(true);
  expect(lines.some(line => line.includes('zai') && line.includes('refusing to click'))).toBe(true);
});

test('passes --provider through and rejects unknown providers and accounts', async () => {
  const { deps } = harness();
  const calls: Array<{ profile: string; providers?: string[] }> = [];
  deps.harvest = async options => {
    calls.push(options);
    return [];
  };
  deps.profiles = { list: () => [{ id: 'default', label: 'Main' }], add: label => ({ id: 'acct-1', label }), remove: () => true };
  expect(await runAccountsCommand(['harvest', '--yes', '--provider', 'gemini'], deps)).toBe(0);
  expect(calls).toEqual([{ profile: 'default', providers: ['gemini'] }]);
  await expect(runAccountsCommand(['harvest', '--yes', '--provider', 'nope'], deps)).rejects.toThrow('Unknown provider: nope');
  await expect(runAccountsCommand(['harvest', '--yes', '--profile', 'acct-zzz'], deps)).rejects.toThrow('Unknown account: acct-zzz');
});

test('fails the run when everything attempted failed, but not when all skipped', async () => {
  const { deps } = harness();
  deps.harvest = async () => [{ provider: 'zai', status: 'failed', detail: 'timeout' }];
  expect(await runAccountsCommand(['harvest', '--yes'], deps)).toBe(1);
  deps.harvest = async () => [{ provider: 'zai', status: 'skipped', detail: 'not signed in (bun run account connect)' }];
  expect(await runAccountsCommand(['harvest', '--yes'], deps)).toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./test/accounts-cli.test.ts`
Expected: FAIL — unknown property `harvest` on `AccountsCliDeps`, harvest falls through to usage (exit 1).

- [ ] **Step 3: Implement the CLI**

In `src/cli/accounts.ts`:

1. Add import at top:

```ts
import type { HarvestResult } from '../browser/key-harvest.ts';
```

2. Add to `AccountsCliDeps`:

```ts
  harvest?: (options: { profile: string; providers?: string[] }) => Promise<HarvestResult[]>;
```

3. Add to `ACCOUNTS_USAGE` after the `status` line:

```
  harvest [--profile <id>] [--provider <id>] [--yes]
                                                  Visit provider dashboards and create/update API keys from your
                                                  signed-in browser accounts (asks for consent unless --yes)
```

4. Add command branch after the `status` branch (`if (command === 'status' ...)` block), before the `add` branch:

```ts
  if (command === 'harvest' && deps.harvest) {
    const profile = profileOption(args, deps);
    const providerOption = option(args, '--provider');
    const provider = providerOption ? requireProvider(providerOption) : undefined;
    if (!args.includes('--yes')) {
      const answer = (await deps.askHidden('This will open provider dashboards in your browser session and create/update API keys for your logged-in accounts. Continue? (y/n) ')).trim().toLowerCase();
      if (!answer.startsWith('y')) {
        deps.log('Cancelled.');
        return 0;
      }
    }
    const results = await deps.harvest({ profile, providers: provider ? [provider] : undefined });
    for (const result of results) {
      const preview = result.keyPreview ? `  ${result.keyPreview}` : '';
      deps.log(`${result.provider.padEnd(14)} ${result.status.padEnd(10)} ${result.detail}${preview}`);
    }
    const count = (status: HarvestStatus) => results.filter(entry => entry.status === status).length;
    deps.log(`created: ${count('created')}, updated: ${count('updated')}, unchanged: ${count('unchanged')}, skipped: ${count('skipped')}, failed: ${count('failed')}`);
    const good = count('created') + count('updated') + count('unchanged');
    return count('failed') > 0 && good === 0 ? 1 : 0;
  }
```

Also extend the type-only import to include the status type:

```ts
import type { HarvestResult, HarvestStatus } from '../browser/key-harvest.ts';
```

If `command === 'harvest'` and `deps.harvest` is missing, flow falls through to usage + exit 1 (matches existing style for missing deps).

In `scripts/accounts.ts`:

1. Add import:

```ts
import { harvestKeys } from '../src/browser/key-harvest.ts';
```

2. Add to the deps object (e.g. after `checkSignIns`):

```ts
    harvest: ({ profile, providers }) => harvestKeys({ profileDir: profileDir(profile), label: profile, providers, store }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./test/accounts-cli.test.ts`
Expected: PASS (all existing + 4 new)

- [ ] **Step 5: Smoke the declined path from the real CLI**

Run: `echo n | bun run account harvest`
Expected: prints the consent prompt and `Cancelled.`, exit 0 (no browser launched).

- [ ] **Step 6: Run full CI and commit**

Run: `bun run ci` → green.

```bash
git add src/cli/accounts.ts scripts/accounts.ts test/accounts-cli.test.ts
git commit -m "feat(cli): add account harvest with consent, report and summary"
```

---

### Task 6: End-to-end browser test against a fake dashboard

**Files:**
- Create: `test/key-harvest-browser.test.ts`

**Interfaces:**
- Consumes: `harvestOne`, `HarvestStore` (Task 2), `launchCdpBrowser` (`src/browser/cdp.ts`), `findBrowserExecutable` (`src/platform/browserExecutable.ts`).
- Produces: gated integration coverage of the real playwright path.

- [ ] **Step 1: Write the test**

`test/key-harvest-browser.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { harvestOne, type HarvestStore } from '../src/browser/key-harvest.ts';
import { launchCdpBrowser } from '../src/browser/cdp.ts';
import { findBrowserExecutable } from '../src/platform/browserExecutable.ts';
import type { ProviderKeyAdapter } from '../src/providers/key-adapters.ts';

const KEY = 'sk-live-1234567890abcdefghij';
const CREATED = 'sk-made-1234567890abcdefg';

const keyPage = `<!doctype html><html><body><code id="the-key">${KEY}</code></body></html>`;
const createPage = `<!doctype html><html><body>
<button id="make" onclick="document.getElementById('out').textContent='${CREATED}'">Create API key</button>
<code id="out"></code>
</body></html>`;

function memoryStore(): HarvestStore & { rows: HarvestStoreEntryLike[] } {
  const rows: HarvestStoreEntryLike[] = [];
  return {
    rows,
    list: provider => rows.filter(row => !provider || row.provider === provider),
    addApiKey: input => {
      const row = { id: `${input.provider}-${rows.length + 1}`, provider: input.provider, email: input.label, method: 'api-key', token: input.apiKey };
      rows.push(row);
      return row;
    },
    remove: id => {
      const index = rows.findIndex(row => row.id === id);
      if (index === -1) return false;
      rows.splice(index, 1);
      return true;
    },
  };
}

interface HarvestStoreEntryLike {
  id: string;
  provider: string;
  email: string;
  method: string;
  token: string;
}

let server: ReturnType<typeof Bun.serve>;
let origin = '';

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1' || !findBrowserExecutable())('key harvester browser', () => {
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const html = url.pathname === '/empty' ? createPage : keyPage;
        return new Response(html, { headers: { 'content-type': 'text/html' } });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test('extracts an existing key and stores it', async () => {
    const cdp = await launchCdpBrowser({});
    try {
      const context = cdp.browser.contexts()[0];
      if (!context) throw new Error('no context');
      const page = await context.newPage();
      const store = memoryStore();
      const adapter: ProviderKeyAdapter = {
        provider: 'fake-extract',
        keyUrl: `${origin}/keys`,
        keyPattern: /^sk-[A-Za-z0-9-]{20,}$/,
        createSelectors: ['button:has-text("Create")'],
        nameFieldSelectors: [],
        confirmSelectors: [],
        keySelectors: ['#the-key'],
      };
      const first = await harvestOne(adapter, page as never, store, { label: 'default' });
      expect(first.status).toBe('created');
      expect(first.keyPreview).toBe('sk-li…ghij');
      const second = await harvestOne(adapter, page as never, store, { label: 'default' });
      expect(second.status).toBe('unchanged');
      await page.close();
    } finally {
      await cdp.close();
    }
  });

  test('clicks create on a dashboard that has no key yet', async () => {
    const cdp = await launchCdpBrowser({});
    try {
      const context = cdp.browser.contexts()[0];
      if (!context) throw new Error('no context');
      const page = await context.newPage();
      const store = memoryStore();
      const adapter: ProviderKeyAdapter = {
        provider: 'fake-create',
        keyUrl: `${origin}/empty`,
        keyPattern: /^sk-[A-Za-z0-9-]{20,}$/,
        createSelectors: ['#make'],
        nameFieldSelectors: [],
        confirmSelectors: [],
        keySelectors: ['#out'],
      };
      const result = await harvestOne(adapter, page as never, store, { label: 'default' });
      expect(result.status).toBe('created');
      expect(store.rows[0]?.token).toBe(CREATED);
      await page.close();
    } finally {
      await cdp.close();
    }
  });
});
```

Note: the host guard compares `127.0.0.1` page host with `127.0.0.1` keyUrl host — equal, so the guard passes. `page as never` avoids the structural type mismatch between playwright's `Page` and `HarvestPage` in the test; production code uses the same cast inside `defaultLaunch`.

- [ ] **Step 2: Run the test without the gate**

Run: `bun test ./test/key-harvest-browser.test.ts`
Expected: PASS with 0 tests executed (skipped by the gate).

- [ ] **Step 3: Run the test with the browser**

Run: `RUN_BROWSER_TESTS=1 bun test ./test/key-harvest-browser.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 4: Run full CI and the browser suite, then commit**

Run: `bun run ci` → green. Run: `RUN_BROWSER_TESTS=1 bun run test` → green.

```bash
git add test/key-harvest-browser.test.ts
git commit -m "test(browser): harvest keys from a fake dashboard end to end"
```

---

### Task 7: Desktop — "Get API keys automatically" button

**Files:**
- Modify: `desktop/src/accounts.rs` (method + existing argv test)
- Modify: `desktop/src/main.rs` (button in `key_card`, banner line order)

**Interfaces:**
- Consumes: existing `AccountsCli::run`, `Shell::run_key_command`, `Shell::browser_blocked`, `button(id, label, icon, tone, enabled)` from `desktop/src/ui.rs`.
- Produces: `AccountsCli::harvest(&self) -> Result<String, String>` running `account harvest --yes`.

- [ ] **Step 1: Write the failing test**

In `desktop/src/accounts.rs`, inside the existing `passes_web_chat_commands_to_the_cli` test, add:

```rust
        assert_eq!(cli.harvest().unwrap(), "args:harvest --yes");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path desktop/Cargo.toml passes_web_chat_commands`
Expected: FAIL — no method `harvest` on `AccountsCli`.

- [ ] **Step 3: Implement `harvest`**

In `desktop/src/accounts.rs`, add after `check_profile`:

```rust
    pub fn harvest(&self) -> Result<String, String> {
        self.run(&["harvest", "--yes"], None)
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path desktop/Cargo.toml passes_web_chat_commands`
Expected: PASS

- [ ] **Step 5: Add the button**

In `desktop/src/main.rs`, in the `key_card` builder, insert a new child between the `get-key` button group and `.child(div().flex_1())`:

```rust
                    .child(
                        button("harvest-keys", if self.busy { "Working…" } else { "Get API keys automatically" }, None, Tone::Outline, !self.browser_blocked())
                            .when(!self.browser_blocked(), |this| this.on_click(cx.listener(|shell, _, _, cx| {
                                shell.run_key_command(cx, |cli| cli.harvest());
                                cx.notify();
                            }))),
                    )
```

- [ ] **Step 6: Make the harvest summary the banner's last line**

In `desktop/src/main.rs` `run_command_then`, swap the order so the command's own final line wins `last_line`:

```rust
                            Ok(count) => Ok(format!("Models reloaded: {count} available.\n{}", output.trim_end())),
                            Err(error) => Ok(format!("Saved, but the models could not be reloaded yet: {error}\n{}", output.trim_end())),
```

- [ ] **Step 7: Verify desktop compiles and tests pass**

Run: `cargo test --manifest-path desktop/Cargo.toml` → all PASS.
Run: `cargo check --manifest-path desktop/Cargo.toml` → no errors.

- [ ] **Step 8: Commit**

```bash
git add desktop/src/accounts.rs desktop/src/main.rs
git commit -m "feat(desktop): add get api keys automatically button"
```

---

### Task 8: Full verification + desktop demo

**Files:** none (verification only).

- [ ] **Step 1: Run the whole CI**

Run: `bun run ci` → green (`check && typecheck && test`).

- [ ] **Step 2: Run the browser-gated suite**

Run: `RUN_BROWSER_TESTS=1 bun run test` → green (expect the Task 6 tests among them).

- [ ] **Step 3: Run desktop tests**

Run: `cargo test --manifest-path desktop/Cargo.toml` → green.

- [ ] **Step 4: Demo the consent flow**

Run: `echo n | bun run account harvest` → prints prompt + `Cancelled.`.
Run: `bun run account --help 2>&1 | grep harvest` or `bun run account` → usage lists `harvest`.

- [ ] **Step 5: Show the desktop button**

```bash
cargo build --manifest-path desktop/Cargo.toml
DISPLAY=:1 ./desktop/target/debug/freeapi-desktop &
sleep 6
import -window root /tmp/key-harvester-desktop-1.png
xdotool search --name "" 2>/dev/null | head
```

Navigate to the API keys page: locate the window with `xdotool search --name "Switchyard"` (fallback: any `freeapi` name), then click the "API keys" sidebar item by coordinates (sidebar items are ~40px tall starting near y≈200 in this app's layout — verify with the first screenshot before clicking), take a second screenshot `/tmp/key-harvester-desktop-2.png` showing the `key_card` with the new button, and present both screenshots to the user.

If navigation by coordinates proves unreliable, fall back to: take the first screenshot, report the exact button location, and ask the user to click "API keys" once so the second screenshot can be captured.

- [ ] **Step 6: Report**

Summarize: commits made, CI/browser/desktop test results, screenshots, and the CLI demo output.

---

## Self-Review (done at writing time)

- **Spec coverage:** consent + `--yes` + report + summary + exit (Task 5); adapters/20/`keyUrl` (Task 1); engine host guard/extract/create/validate/safety (Tasks 2-3); one-browser loop + isolation (Task 4); storage dedup/replace (Task 2); desktop button/run_key_command/banner/gate/argv test (Task 7); browser E2E (Task 6); spec fixes already committed as `3b91d75`.
- **Placeholders:** none — every step carries exact code or commands.
- **Type consistency:** `HarvestResult`/`HarvestStatus`/`harvestOne`/`harvestKeys`/`AccountsCliDeps.harvest`/`AccountsCli::harvest` names are identical across tasks.
