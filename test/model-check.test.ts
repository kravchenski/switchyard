import { describe, expect, test } from 'bun:test';

import { ModelAvailability } from '../src/core/models/availability.ts';
import { checkAllModels, checkProviderModels } from '../src/core/models/model-check.ts';
import { ModelStats } from '../src/core/models/stats.ts';
import { classifyStatus, ProviderError } from '../src/core/providers/errors.ts';
import { loadUnavailableModels, openDatabase, replaceUnavailableModels } from '../src/core/store/database.ts';
import type { ChatChunk, Provider } from '../src/core/providers/provider.ts';
import { createApiProvider, apiKeyProvider } from '../src/providers/catalog.ts';

function fakeProvider(behaviour: Record<string, 'ok' | 'denied' | 'slow' | 'broken' | 'limited'>, seen: string[] = [], id = 'fake'): Provider {
  return {
    id,
    ownedBy: id,
    supports: () => true,
    listModels: async () => Object.keys(behaviour),
    capabilities: () => ({ nativeTools: false, reasoning: false, vision: false }),
    health: () => ({ available: true }),
    async stream(request, context) {
      seen.push(request.model);
      const kind = behaviour[request.model];
      if (kind === 'denied') throw new ProviderError('Model is unavailable for this key', 'model_unavailable', 404);
      if (kind === 'broken') throw new ProviderError('upstream broke', 'upstream', 502);
      if (kind === 'limited') throw new ProviderError('rate limited', 'rate_limit', 429);
      return {
        chunks: (async function* (): AsyncGenerator<ChatChunk> {
          if (kind === 'slow') await new Promise(resolve => context?.signal?.addEventListener('abort', resolve));
          yield { type: 'content', text: 'ok' };
        })(),
      };
    },
  };
}

describe('model check', () => {
  test('hides models the key cannot use and records the rest', async () => {
    const availability = new ModelAvailability();
    const stats = new ModelStats();
    availability.markUnavailable('fake/a', 'old mark');
    const report = await checkProviderModels(fakeProvider({ 'fake/a': 'ok', 'fake/b': 'denied', 'fake/c': 'slow', 'fake/d': 'broken' }), ['fake/a', 'fake/b', 'fake/c', 'fake/d'], { availability, stats }, { timeoutMs: 50 });
    const byModel = Object.fromEntries(report.results.map(result => [result.model, result]));
    expect(byModel['fake/a']).toMatchObject({ ok: true });
    expect(byModel['fake/b']).toMatchObject({ ok: false, hidden: true });
    expect(byModel['fake/c']).toMatchObject({ ok: false, error: 'no answer within 0s' });
    expect(byModel['fake/d']?.hidden).toBeUndefined();
    expect(availability.isAvailable('fake/a')).toBeTrue();
    expect(availability.isAvailable('fake/b')).toBeFalse();
    expect(availability.isAvailable('fake/c')).toBeTrue();
    expect(stats.get('fake/a')?.lastOutcome).toBe('success');
    expect(stats.get('fake/d')?.lastOutcome).toBe('failure');
  });

  test('keeps going after one model is rate limited and stops after three limits in a row', async () => {
    const seen: string[] = [];
    const single = await checkProviderModels(fakeProvider({ 'fake/a': 'limited', 'fake/b': 'ok' }, seen), ['fake/a', 'fake/b'], { availability: new ModelAvailability(), stats: new ModelStats() }, { concurrency: 1 });
    expect(single.stopped).toBeUndefined();
    expect(single.results.map(result => result.ok)).toEqual([false, true]);
    const models = { 'fake/a': 'limited', 'fake/b': 'limited', 'fake/c': 'limited', 'fake/d': 'ok' } as const;
    seen.length = 0;
    const burst = await checkProviderModels(fakeProvider(models, seen), Object.keys(models), { availability: new ModelAvailability(), stats: new ModelStats() }, { concurrency: 1 });
    expect(burst.stopped).toBe('rate limited');
    expect(seen).toEqual(['fake/a', 'fake/b', 'fake/c']);
  });

  test('a full check also hides models that time out or fail, but not rate limited ones', async () => {
    const availability = new ModelAvailability();
    const stats = new ModelStats();
    const streamed: string[] = [];
    const report = await checkProviderModels(
      fakeProvider({ 'fake/a': 'ok', 'fake/b': 'slow', 'fake/c': 'broken', 'fake/d': 'limited' }),
      ['fake/a', 'fake/b', 'fake/c', 'fake/d'],
      { availability, stats },
      { timeoutMs: 50, hideFailing: true, onResult: result => streamed.push(result.model) },
    );
    expect(streamed.sort()).toEqual(['fake/a', 'fake/b', 'fake/c', 'fake/d']);
    expect(report.results.filter(result => result.hidden).map(result => result.model).sort()).toEqual(['fake/b', 'fake/c']);
    expect(availability.isAvailable('fake/a')).toBeTrue();
    expect(availability.isAvailable('fake/b')).toBeFalse();
    expect(availability.isAvailable('fake/c')).toBeFalse();
    expect(availability.isAvailable('fake/d')).toBeTrue();
  });

  test('a full check hides every model of a provider whose key stopped working', async () => {
    const availability = new ModelAvailability();
    const provider = { ...fakeProvider({ 'p/a': 'ok', 'p/b': 'ok', 'p/c': 'ok' }) };
    let calls = 0;
    provider.stream = async (request) => {
      if (++calls === 1) return { chunks: (async function* (): AsyncGenerator<ChatChunk> { yield { type: 'content', text: request.model }; })() };
      throw new ProviderError('token expired', 'auth', 401);
    };
    const report = await checkProviderModels(provider, ['p/a', 'p/b', 'p/c'], { availability, stats: new ModelStats() }, { concurrency: 1, hideFailing: true });
    expect(report.stopped).toBe('token expired');
    expect(availability.isAvailable('p/a')).toBeTrue();
    expect(availability.isAvailable('p/b')).toBeFalse();
    expect(availability.isAvailable('p/c')).toBeFalse();
    expect(report.results.filter(result => result.hidden).map(result => result.model).sort()).toEqual(['p/b', 'p/c']);
  });

  test('waits out a short rate limit instead of giving up on the model', async () => {
    const availability = new ModelAvailability();
    const provider = { ...fakeProvider({ 'p/a': 'ok' }) };
    let calls = 0;
    provider.stream = async () => {
      if (++calls === 1) throw new ProviderError('slow down', 'rate_limit', 429, 0);
      return { chunks: (async function* (): AsyncGenerator<ChatChunk> { yield { type: 'content', text: 'ok' }; })() };
    };
    const report = await checkProviderModels(provider, ['p/a'], { availability, stats: new ModelStats() }, { hideFailing: true });
    expect(report.results).toMatchObject([{ model: 'p/a', ok: true }]);
    expect(calls).toBe(2);
  });

  test('checks all providers in parallel, skipping browser chats and unavailable providers', async () => {
    const availability = new ModelAvailability();
    const stats = new ModelStats();
    const web = { ...fakeProvider({ 'web/a': 'ok' }, [], 'chat-web') };
    const down = { ...fakeProvider({ 'down/a': 'ok' }, [], 'down'), health: () => ({ available: false, reason: 'no key' }) };
    const seen: string[] = [];
    const reports = await checkAllModels(
      [fakeProvider({ 'one/a': 'ok', 'one/b': 'broken' }, seen, 'one'), fakeProvider({ 'two/a': 'denied' }, seen, 'two'), web, down],
      { availability, stats },
      { timeoutMs: 50, onResult: (provider, result) => seen.push(`${provider}:${result.ok}`) },
    );
    expect(reports.map(report => report.provider)).toEqual(['one', 'two', 'down']);
    expect(reports.find(report => report.provider === 'down')?.skipped).toBe('no key');
    expect(availability.isAvailable('one/b')).toBeFalse();
    expect(availability.isAvailable('two/a')).toBeFalse();
    expect(seen).not.toContain('web/a');
    expect(seen.filter(entry => entry.includes(':')).sort()).toEqual(['one:false', 'one:true', 'two:false']);
  });

  test('treats "model not available for this key" answers as unavailable models', () => {
    expect(classifyStatus(400, '{"error":{"message":"Upstream request failed: Model is unavailable."}}')).toBe('model_unavailable');
    expect(classifyStatus(403, 'You do not have access to the model gpt-5')).toBe('model_unavailable');
    expect(classifyStatus(400, 'Invalid model. Please select a different model')).toBe('model_unavailable');
    expect(classifyStatus(402, '{"error":{"message":"this model is not included in your free usage"}}')).toBe('model_unavailable');
    expect(classifyStatus(403, 'thinkingmachines/inkling-small:free is only available to accounts with credits')).toBe('model_unavailable');
    expect(classifyStatus(403, 'This model is available to paying customers only. Subscribe to a plan')).toBe('model_unavailable');
    expect(classifyStatus(402, 'This model is not in the Free plan. Pro is $20/month')).toBe('model_unavailable');
    expect(classifyStatus(403, 'This model is currently being rolled out and is not yet available to you.')).toBe('model_unavailable');
    expect(classifyStatus(402, 'Insufficient balance')).toBe('quota_exhausted');
    expect(classifyStatus(403, 'Forbidden')).toBe('auth');
    expect(classifyStatus(400, 'max_tokens is too large')).toBe('upstream');
  });

  test('a provider without a key lists no models', async () => {
    const bigmodel = createApiProvider(apiKeyProvider('bigmodel')!, { env: {} });
    expect(await bigmodel.listModels()).toEqual([]);
    const cloudflare = createApiProvider(apiKeyProvider('cloudflare')!, { env: {} }, { list: () => [] });
    expect(await cloudflare.listModels()).toEqual([]);
  });

  test('keeps unavailable models across restarts until they expire', () => {
    const db = openDatabase(':memory:');
    const availability = new ModelAvailability(1_000, () => 5_000);
    availability.markUnavailable('nvidia/old-model', 'Function not found for account');
    replaceUnavailableModels(db, availability.list());
    expect(loadUnavailableModels(db, 5_500)).toEqual([{ model: 'nvidia/old-model', reason: 'Function not found for account', until: 6_000 }]);
    expect(loadUnavailableModels(db, 6_500)).toEqual([]);
    const restarted = new ModelAvailability(1_000, () => 5_500);
    restarted.load(loadUnavailableModels(db, 5_500));
    expect(restarted.isAvailable('nvidia/old-model')).toBeFalse();
  });
});
