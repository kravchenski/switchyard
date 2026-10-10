import { describe, expect, test } from 'bun:test';

import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import { ModelStats } from '../src/core/models/stats.ts';
import { ProviderError } from '../src/core/providers/errors.ts';
import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { buildAutoChain } from '../src/core/router/auto-chain.ts';
import { SmartRouter } from '../src/core/router/smart-router.ts';
import { GatewaySettings } from '../src/core/settings/gateway-settings.ts';
import { loadGatewaySetting, openDatabase, saveGatewaySetting } from '../src/core/store/database.ts';
import { collectChunks } from '../src/core/streaming/sse.ts';

const nvidia = (ids: string[]) => ids.map(id => ({ id, provider: 'nvidia', fallback: true }));

describe('web chat order', () => {
  test('puts the web chats in the chosen order ahead of the API models', () => {
    const web = (provider: string, ...ids: string[]) => ids.map(id => ({ id, provider, fallback: false }));
    const candidates = [...nvidia(['meta/llama-4']), ...web('glm-chat', 'glm-chat'), ...web('deepseek', 'deepseek-default', 'deepseek-reasoner'), ...web('qwen-chat', 'qwen-chat')];
    expect(buildAutoChain(candidates, new ModelStats(), () => true, ['qwen-chat', 'deepseek', 'glm-chat'])).toEqual(['qwen-chat', 'deepseek-default', 'glm-chat', 'meta/llama-4']);
    expect(buildAutoChain(candidates, new ModelStats(), () => true, ['glm-chat', 'qwen-chat'])).toEqual(['glm-chat', 'qwen-chat', 'deepseek-default', 'meta/llama-4']);
  });
});

describe('gateway settings', () => {
  test('defaults to the built-in web order, validates changes and persists them', () => {
    const db = openDatabase(':memory:');
    const settings = new GatewaySettings({ load: key => loadGatewaySetting(db, key), save: (key, value) => saveGatewaySetting(db, key, value) });
    expect(settings.webOrder()).toEqual(['qwen-chat', 'deepseek', 'glm-chat', 'kimi-chat', 'arena-chat']);
    settings.setWebOrder('kimi-chat, qwen-chat');
    expect(loadGatewaySetting(db, 'auto.web-order')).toBe('kimi-chat,qwen-chat');
    expect(new GatewaySettings({ load: key => loadGatewaySetting(db, key), save: () => {} }).webOrder()).toEqual(['kimi-chat', 'qwen-chat', 'deepseek', 'glm-chat', 'arena-chat']);
    expect(() => settings.setWebOrder('poetry')).toThrow('Unknown web chat: poetry');
    expect(() => settings.setWebOrder(' , ')).toThrow('Give at least one web chat');
  });

  test('ignores unknown stored values and store failures', () => {
    expect(new GatewaySettings({ load: () => 'weird,glm-chat', save: () => {} }).webOrder()[0]).toBe('glm-chat');
    expect(new GatewaySettings({ load: () => { throw new Error('locked'); }, save: () => {} }).webOrder()[0]).toBe('qwen-chat');
  });
});

function racer(id: string, delayMs: number, events: string[], fail = false, web = false): Provider {
  return {
    id,
    ownedBy: id,
    fallback: !web,
    supports: model => model === `${id}-model`,
    listModels: async () => [`${id}-model`],
    capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
    health: () => ({ available: true }),
    async stream(request, context) {
      events.push(`start ${id}`);
      context?.signal?.addEventListener('abort', () => events.push(`abort ${id}`));
      await Bun.sleep(delayMs);
      if (fail) throw new ProviderError(`${id} broke`, 'upstream', 502);
      return {
        chunks: (async function* (): AsyncGenerator<ChatChunk> {
          try {
            yield { type: 'content', text: request.model };
          } finally {
            events.push(`closed ${id}`);
          }
        })(),
      };
    },
  };
}

describe('pinned conversations', () => {
  test('go to their own route first and fall back to the chain in order when it fails', async () => {
    const events: string[] = [];
    const registry = new ProviderRegistry().register(racer('a', 5, events)).register(racer('b', 5, events)).register(racer('c', 20, events));
    const router = new SmartRouter(registry, ['a-model', 'b-model', 'c-model'], Date.now);
    expect((await router.open('auto', route => ({ model: route.model, messages: [] }), 'c-model')).route.model).toBe('c-model');
    expect(events.filter(event => event.startsWith('start'))).toEqual(['start c']);

    const failing: string[] = [];
    const broken = new ProviderRegistry().register(racer('a', 5, failing)).register(racer('b', 30, failing)).register(racer('c', 5, failing, true));
    const fallback = new SmartRouter(broken, ['a-model', 'b-model', 'c-model'], Date.now);
    expect((await fallback.open('auto', route => ({ model: route.model, messages: [] }), 'c-model')).route.model).toBe('a-model');
    expect(failing.filter(event => event.startsWith('start'))).toEqual(['start c', 'start a']);
  });
});

describe('accounts CLI auto command', () => {
  test('shows and changes the web chat order', async () => {
    const lines: string[] = [];
    let current = { order: ['qwen-chat', 'deepseek'] };
    const deps: AccountsCliDeps = {
      store: { list: () => [], addApiKey: () => { throw new Error('unused'); }, remove: () => false },
      askHidden: async () => '',
      log: line => lines.push(line),
      autoSettings: change => {
        current = { order: change.order?.split(',') ?? current.order };
        return current;
      },
    };
    await runAccountsCommand(['auto', '--order', 'deepseek,qwen-chat'], deps);
    expect(lines).toEqual(['web order: deepseek,qwen-chat']);
  });
});

describe('web chat models', () => {
  const web = (provider: string, ...ids: string[]) => ids.map(id => ({ id, provider, fallback: false }));
  const candidates = [...web('qwen-chat', 'qwen-chat', 'qwen-chat/qwen3.8-max'), ...web('deepseek', 'deepseek-default', 'deepseek-reasoner')];

  test('uses the chosen model of a web chat and falls back to the fastest one when it is gone', () => {
    const order = ['qwen-chat', 'deepseek'];
    expect(buildAutoChain(candidates, new ModelStats(), () => true, order, { 'qwen-chat': 'qwen-chat/qwen3.8-max', deepseek: 'deepseek-reasoner' }))
      .toEqual(['qwen-chat/qwen3.8-max', 'deepseek-reasoner']);
    expect(buildAutoChain(candidates, new ModelStats(), model => model !== 'qwen-chat/qwen3.8-max', order, { 'qwen-chat': 'qwen-chat/qwen3.8-max' }))
      .toEqual(['qwen-chat', 'deepseek-default']);
  });

  test('stores a model per web chat, resets it with fastest and rejects unknown chats', () => {
    const db = openDatabase(':memory:');
    const settings = new GatewaySettings({ load: key => loadGatewaySetting(db, key), save: (key, value) => saveGatewaySetting(db, key, value) });
    expect(settings.webModels()).toEqual({});
    settings.setWebModel('qwen-chat', 'qwen-chat/qwen3.8-max');
    settings.setWebModel('deepseek', 'deepseek-reasoner');
    expect(new GatewaySettings({ load: key => loadGatewaySetting(db, key), save: () => {} }).webModels()).toEqual({ 'qwen-chat': 'qwen-chat/qwen3.8-max', deepseek: 'deepseek-reasoner' });
    settings.setWebModel('deepseek', 'fastest');
    expect(settings.webModels()).toEqual({ 'qwen-chat': 'qwen-chat/qwen3.8-max' });
    expect(() => settings.setWebModel('nvidia', 'x')).toThrow('Unknown web chat: nvidia');
    expect(() => settings.setWebModel('qwen-chat', ' ')).toThrow('Give a model id');
    expect(new GatewaySettings({ load: () => '["broken"]', save: () => {} }).webModels()).toEqual({});
  });

  test('the accounts CLI sets a web chat model', async () => {
    const lines: string[] = [];
    const seen: unknown[] = [];
    const deps: AccountsCliDeps = {
      store: { list: () => [], addApiKey: () => { throw new Error('unused'); }, remove: () => false },
      askHidden: async () => '',
      log: line => lines.push(line),
      autoSettings: change => {
        seen.push(change.model);
        return { order: ['qwen-chat'], models: change.model ? { [change.model.chat]: change.model.model } : {} };
      },
    };
    await runAccountsCommand(['auto', '--model', 'qwen-chat=qwen-chat/qwen3.8-max'], deps);
    expect(seen).toEqual([{ chat: 'qwen-chat', model: 'qwen-chat/qwen3.8-max' }]);
    expect(lines).toEqual(['web order: qwen-chat', 'web model qwen-chat: qwen-chat/qwen3.8-max']);
    await expect(runAccountsCommand(['auto', '--model', 'qwen-chat'], deps)).rejects.toThrow('Use --model <chat>=<model>');
  });
});
