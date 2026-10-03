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
    const result = await harvestOne(adapter, page, store, { label: 'default' });
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

  test('validates candidates and previews keys', () => {
    expect(validateKey(KEY, adapter.keyPattern)).toBe(KEY);
    expect(validateKey(`  ${KEY}  `, adapter.keyPattern)).toBe(KEY);
    expect(validateKey('short', adapter.keyPattern)).toBeNull();
    expect(validateKey(`${KEY} tail`, adapter.keyPattern)).toBeNull();
    expect(validateKey('nvapi-abcdefghijklmnopqrstuvwxyz123456', adapter.keyPattern)).toBeNull();
    expect(validateKey(null, adapter.keyPattern)).toBeNull();
    expect(keyPreview(KEY)).toBe('sk-li…ghij');
  });

  test('normalizes the label before matching and storing', () => {
    const store = fakeStore();
    expect(storeHarvestedKey(store, 'fake', '  DEFAULT ', KEY)).toBe('created');
    expect(store.list('fake')[0]?.email).toBe('default');
    expect(storeHarvestedKey(store, 'fake', 'Default', 'sk-other-1234567890abcdefgh')).toBe('updated');
    expect(store.list('fake')).toHaveLength(1);
  });
});

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
});
