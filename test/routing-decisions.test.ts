import { describe, expect, test } from 'bun:test';

import { ProviderError } from '../src/core/providers/errors.ts';
import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { ProviderRegistry } from '../src/core/providers/registry.ts';
import { DecisionLog, type RoutingDecision } from '../src/core/router/decisions.ts';
import { decisionIdOf, SmartRouter } from '../src/core/router/smart-router.ts';

function provider(id: string, behaviour: 'ok' | 'fail' | 'down'): Provider {
  return {
    id,
    ownedBy: id,
    fallback: true,
    supports: model => model === `${id}-model`,
    listModels: async () => [`${id}-model`],
    capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
    health: () => behaviour === 'down' ? { available: false, reason: 'no key' } : { available: true },
    async stream(request) {
      if (behaviour === 'fail') throw new ProviderError(`${id} broke`, 'upstream', 502);
      return { chunks: (async function* (): AsyncGenerator<ChatChunk> { yield { type: 'content', text: request.model }; })() };
    },
  };
}

function setup(providers: Provider[], models: string[]) {
  const log = new DecisionLog(3);
  const registry = new ProviderRegistry();
  for (const entry of providers) registry.register(entry);
  const router = new SmartRouter(registry, models, () => 1_000, { autoEnabled: id => id !== 'off', onDecision: decision => log.add(decision) });
  return { router, log };
}

const build = (route: { model: string }) => ({ model: route.model, messages: [] });

describe('routing decisions', () => {
  test('records skipped candidates, failed attempts and the chosen route', async () => {
    const { router, log } = setup([provider('down', 'down'), provider('off', 'ok'), provider('bad', 'fail'), provider('good', 'ok')], ['down-model', 'off-model', 'bad-model', 'good-model']);
    await router.open('auto', build);
    const [decision] = log.list() as [RoutingDecision];
    expect(decision).toMatchObject({ id: 1, at: 1_000, requestedModel: 'auto', mode: 'fallback', chosen: { model: 'good-model', provider: 'good' } });
    expect(decision.skipped).toEqual([{ model: 'down-model', reason: 'down unavailable: no key' }, { model: 'off-model', reason: 'off is off in auto' }]);
    expect(decision.attempts.map(attempt => [attempt.model, attempt.outcome, attempt.error])).toEqual([['bad-model', 'failed', 'bad broke'], ['good-model', 'chosen', undefined]]);
  });

  test('records failed direct requests and keeps only the newest decisions', async () => {
    const { router, log } = setup([provider('bad', 'fail'), provider('good', 'ok')], ['good-model']);
    await expect(router.open('bad-model', build)).rejects.toThrow('bad broke');
    for (let index = 0; index < 3; index++) await router.open('good-model', build);
    expect(log.list().map(decision => decision.id)).toEqual([4, 3, 2]);
    expect(log.list(10, 'bad-model')).toEqual([]);
    expect(log.list(1)[0]).toMatchObject({ mode: 'direct', chosen: { model: 'good-model' } });
    const failed = setup([provider('bad', 'fail')], []);
    await expect(failed.router.open('bad-model', build)).rejects.toThrow();
    expect(failed.log.list()[0]).toMatchObject({ mode: 'direct', error: 'bad broke', attempts: [{ model: 'bad-model', outcome: 'failed' }] });
  });
});

describe('decision ids', () => {
  test('a routed stream and a failed open carry the id of their decision', async () => {
    const log = new DecisionLog(10, 1_000);
    const registry = new ProviderRegistry().register(provider('good', 'ok')).register(provider('bad', 'fail'));
    const router = new SmartRouter(registry, ['good-model'], () => 1, { onDecision: decision => log.add(decision) });
    const opened = await router.open('good-model', build);
    expect(opened.decisionId).toBe(1_000);
    expect(log.get(1_000)).toMatchObject({ chosen: { model: 'good-model' } });
    const failure = await router.open('bad-model', build).catch(error => error);
    expect(decisionIdOf(failure)).toBe(1_001);
    expect(log.get(1_001)?.error).toContain('bad broke');
    expect(log.get(5)).toBeUndefined();
  });
});
