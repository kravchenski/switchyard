import { describe, expect, test, beforeEach } from 'bun:test';

import { harvestOne, keyPreview, type HarvestResult, type HarvestStore, type HarvestPage } from '../src/browser/key-harvest.ts';
import type { ProviderKeyAdapter } from '../src/providers/key-adapters.ts';
import type { ApiProviderDefinition } from '../src/providers/catalog.ts';
import { API_KEY_PROVIDERS } from '../src/providers/catalog.ts';

const KEY = 'sk-live-1234567890abcdefghij';

const BROWSER_GATE = !!(
  Bun.env.RUN_BROWSER_TESTS === '1' &&
  !!(
    typeof process !== 'undefined' &&
    (process as any).env?.RUN_BROWSER_TESTS === '1'
  )
);

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
    const self: any = {
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

function makeAdapter(def: ApiProviderDefinition): ProviderKeyAdapter {
  return {
    provider: def.id,
    keyUrl: def.keyUrl,
    keyPattern: /^sk-[A-Za-z0-9-]{20,}$/,
    createSelectors: ['button:has-text("Create")'],
    nameFieldSelectors: ['input[name="name"]'],
    confirmSelectors: ['button:has-text("Confirm")'],
    keySelectors: ['#the-key'],
  };
}

const browserTests = API_KEY_PROVIDERS
  .filter((p): p is ApiProviderDefinition => p.keyUrl.includes('dashboard') || p.keyUrl.includes('keys'))
  .slice(0, 3)
  .map(makeAdapter);

function describeIf(condition: boolean, name: string, fn: () => void) {
  if (condition) describe(name, fn);
  else test.skip(name, () => {});
}

describeIf(BROWSER_GATE, 'E2E browser harvest', () => {
  describe.each(browserTests)('%s', (adapter) => {
    test('reads an existing key through the adapter selectors', async () => {
      const store = fakeStore();
      const page = fakePage({ finalUrl: adapter.keyUrl, elements: { '#the-key': { text: KEY } } });
      const result = await harvestOne(adapter, page, store, { label: 'default' });
      expect(result).toEqual({ provider: adapter.provider, status: 'created', detail: 'created', keyPreview: 'sk-li…ghij' });
      expect(store.list(adapter.provider)).toHaveLength(1);
    });

    test('scans the DOM when the selectors find nothing', async () => {
      const store = fakeStore();
      const page = fakePage({ finalUrl: adapter.keyUrl, scanned: [`prefix ${KEY} suffix`] });
      const result = await harvestOne(adapter, page, store, { label: 'default' });
      expect(result.status).toBe('created');
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
      expect(result.detail).toBe('no key found; create one manually at ' + adapter.keyUrl);
    });
  });
});