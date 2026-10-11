import { describe, expect, test } from 'bun:test';

import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { SmartRouter } from '../src/core/router/smart-router.ts';

function slow(id: string, extra: number, delayMs: number): Provider {
  return {
    id,
    ownedBy: id,
    supports: model => model === `${id}-model`,
    listModels: async () => [`${id}-model`],
    capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
    health: () => ({ available: true }),
    extraTimeMs: () => extra,
    async stream() {
      await Bun.sleep(delayMs);
      return { chunks: (async function* (): AsyncGenerator<ChatChunk> { yield { type: 'content', text: `${id} answered` }; })() };
    },
  };
}

describe('extra time for long sends', () => {
  test('waits longer for providers that need extra time for a request', async () => {
    const registry = new ProviderRegistry();
    registry.register(slow('parts', 400, 150));
    registry.register(slow('plain', 0, 150));
    registry.register(slow('backup', 0, 0));
    const router = new SmartRouter(registry, ['parts-model', 'backup-model'], Date.now, { firstChunkTimeoutMs: 50 });
    const open = () => router.open('auto', route => ({ model: route.model, messages: [] }));
    expect((await open()).route.model).toBe('parts-model');
    router.setAutoModels(['plain-model', 'backup-model']);
    expect((await open()).route.model).toBe('backup-model');
  });
});
