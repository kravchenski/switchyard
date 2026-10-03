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
