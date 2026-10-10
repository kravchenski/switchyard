import { describe, expect, test } from 'bun:test';

import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { apiKeyProvider, createApiProvider, setCustomProviders } from '../src/providers/catalog.ts';
import { customProviderDefinition, readCustomProviders, validateCustomProvider, type CustomProvider } from '../src/providers/custom.ts';

const free = () => false;

describe('custom providers', () => {
  test('accepts https and local http base URLs and normalizes them', () => {
    expect(validateCustomProvider({ id: 'My-Lab', label: ' Lab ', baseUrl: 'https://llm.example.com/v1/' }, free))
      .toEqual({ id: 'my-lab', label: 'Lab', baseUrl: 'https://llm.example.com/v1' });
    expect(validateCustomProvider({ id: 'ollama', baseUrl: 'http://localhost:11434/v1' }, free))
      .toEqual({ id: 'ollama', label: 'ollama', baseUrl: 'http://localhost:11434/v1' });
  });

  test('rejects bad ids, taken ids, plain http to remote hosts and credentials in the URL', () => {
    expect(() => validateCustomProvider({ id: 'x', baseUrl: 'https://a.example' }, free)).toThrow('lowercase letters');
    expect(() => validateCustomProvider({ id: 'nvidia', baseUrl: 'https://a.example' }, id => id === 'nvidia')).toThrow('already in use');
    expect(() => validateCustomProvider({ id: 'lab', baseUrl: 'http://llm.example.com/v1' }, free)).toThrow('https://');
    expect(() => validateCustomProvider({ id: 'lab', baseUrl: 'https://user:secret@llm.example.com' }, free)).toThrow('key field');
    expect(() => validateCustomProvider({ id: 'lab', baseUrl: 'https://llm.example.com/v1?key=1' }, free)).toThrow('? or #');
    expect(() => validateCustomProvider({ id: 'lab', baseUrl: 'not a url' }, free)).toThrow('Not a valid URL');
  });

  test('reads stored providers and skips broken or duplicate entries', () => {
    const stored = JSON.stringify([
      { id: 'lab', label: 'Lab', baseUrl: 'https://llm.example.com/v1' },
      { id: 'lab', label: 'Again', baseUrl: 'https://other.example.com' },
      { id: 'bad', baseUrl: 'ftp://x' },
      'junk',
    ]);
    expect(readCustomProviders(stored)).toEqual([{ id: 'lab', label: 'Lab', baseUrl: 'https://llm.example.com/v1' }]);
    expect(readCustomProviders('not json')).toEqual([]);
    expect(readCustomProviders(undefined)).toEqual([]);
  });

  test('becomes a namespaced API key provider the registry can register and remove', () => {
    const definition = customProviderDefinition({ id: 'my-lab', label: 'Lab', baseUrl: 'https://llm.example.com/v1' });
    expect(definition).toMatchObject({ apiKeyEnv: 'MY_LAB_API_KEY', keyOptional: true, namespace: true, custom: true });
    setCustomProviders([definition]);
    try {
      expect(apiKeyProvider('my-lab')?.label).toBe('Lab');
      const registry = new ProviderRegistry().register(createApiProvider(definition, { env: {} }));
      expect(registry.resolve('my-lab/some-model')?.id).toBe('my-lab');
      registry.unregister('my-lab');
      expect(registry.resolve('my-lab/some-model')).toBeUndefined();
    } finally {
      setCustomProviders([]);
    }
    expect(apiKeyProvider('my-lab')).toBeUndefined();
  });
});

describe('accounts CLI custom command', () => {
  function cli() {
    const lines: string[] = [];
    let providers: CustomProvider[] = [];
    const deps: AccountsCliDeps = {
      store: { list: () => [], addApiKey: () => { throw new Error('unused'); }, remove: () => false },
      askHidden: async () => '',
      log: line => lines.push(line),
      customProviders: {
        list: () => providers,
        add: input => {
          const added = validateCustomProvider(input, id => providers.some(provider => provider.id === id));
          providers = [...providers, added];
          return added;
        },
        remove: id => {
          const before = providers.length;
          providers = providers.filter(provider => provider.id !== id);
          return providers.length < before;
        },
      },
    };
    return { lines, deps };
  }

  test('adds, lists and removes a provider', async () => {
    const { lines, deps } = cli();
    expect(await runAccountsCommand(['custom'], deps)).toBe(0);
    expect(await runAccountsCommand(['custom', 'add', 'lab', '--url', 'https://llm.example.com/v1', '--name', 'Lab'], deps)).toBe(0);
    expect(await runAccountsCommand(['custom'], deps)).toBe(0);
    expect(await runAccountsCommand(['custom', 'remove', 'lab'], deps)).toBe(0);
    expect(lines).toEqual(['No custom providers', 'Added custom provider lab (https://llm.example.com/v1)', 'lab\tLab\thttps://llm.example.com/v1', 'Removed custom provider lab']);
  });

  test('refuses a missing URL and an unknown provider', async () => {
    const { deps } = cli();
    await expect(runAccountsCommand(['custom', 'add', 'lab'], deps)).rejects.toThrow('Usage: bun run account custom add');
    await expect(runAccountsCommand(['custom', 'remove', 'ghost'], deps)).rejects.toThrow('Unknown custom provider: ghost');
  });
});
