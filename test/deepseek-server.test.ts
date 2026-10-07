import { describe, expect, test } from 'bun:test';

import { ProviderError } from '../src/core/providers/errors.ts';
import { DEEPSEEK_MODELS } from '../src/providers/deepseek/openapi.ts';
import { createDeepSeekApp } from '../src/providers/deepseek/server.ts';

type Complete = NonNullable<Parameters<typeof createDeepSeekApp>[0]>['complete'];

const answer = (text: string): Complete => (async () => ({
  response: new Response(`data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"${text}"}]}}}\n\ndata: {"p":"response/status","v":"FINISHED"}\n\n`),
  sessionId: 'session-1',
  key: 'key',
  accountId: 'account',
})) as unknown as Complete;

const failing = (error: Error): Complete => (async () => { throw error; }) as unknown as Complete;

const chat = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const ask = { model: 'deepseek-default', messages: [{ role: 'user', content: 'ping' }] };

describe('DeepSeek web API', () => {
  test('lists the web models and serves an OpenAPI 3.1 description of its routes', async () => {
    const app = createDeepSeekApp({ ready: () => true });
    const models = await (await app.fetch(new Request('http://localhost/api/v1/models'))).json() as { data: Array<{ id: string }> };
    expect(models.data.map(model => model.id)).toEqual([...DEEPSEEK_MODELS]);

    const spec = await (await app.fetch(new Request('http://localhost/api/v1/openapi.json'))).json() as Record<string, any>;
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers[0].url).toBe('http://localhost/api/v1');
    expect(Object.keys(spec.paths)).toEqual(['/models', '/chat/completions', '/health']);
    expect(spec.components.schemas.ModelObject.properties.id.enum).toEqual([...DEEPSEEK_MODELS]);
  });

  test('answers a chat completion with the DeepSeek chat id', async () => {
    const app = createDeepSeekApp({ complete: answer('pong'), ready: () => true });
    const body = await (await app.fetch(chat(ask))).json() as Record<string, any>;
    expect(body.choices[0].message.content).toBe('pong');
    expect(body.x_deepseek_chat_id).toBe('session-1');
  });

  test('rejects bad requests and unknown models with OpenAI-style errors', async () => {
    const app = createDeepSeekApp({ complete: answer('never'), ready: () => true });
    const empty = await app.fetch(chat({ model: 'deepseek-default', messages: [] }));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: { message: 'messages must be a non-empty array', type: 'invalid_request_error', param: null, code: 'invalid_request' } });

    const unknown = await app.fetch(chat({ ...ask, model: 'deepseek-v9' }));
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as Record<string, any>).error).toMatchObject({ type: 'model_not_found', code: 'model_unavailable' });
  });

  test('maps upstream limits to 429 with Retry-After and verifications to captcha_required', async () => {
    const limited = await createDeepSeekApp({ complete: failing(new ProviderError('DeepSeek is busy', 'rate_limit', 429, 30)) }).fetch(chat(ask));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
    expect((await limited.json() as Record<string, any>).error).toMatchObject({ type: 'rate_limit_exceeded', code: 'rate_limit' });

    const verification = await createDeepSeekApp({ complete: failing(new ProviderError('DeepSeek asks for a security verification', 'unavailable')) }).fetch(chat(ask));
    expect(verification.status).toBe(429);
    expect((await verification.json() as Record<string, any>).error.code).toBe('captcha_required');
  });

  test('requires the bearer token when GATEWAY_API_KEY is set, except for health and the spec', async () => {
    const app = createDeepSeekApp({ apiKey: 'secret', complete: answer('pong'), ready: () => false });
    expect((await app.fetch(new Request('http://localhost/api/v1/models'))).status).toBe(401);
    expect((await app.fetch(new Request('http://localhost/api/v1/models', { headers: { authorization: 'Bearer secret' } }))).status).toBe(200);
    expect((await app.fetch(new Request('http://localhost/api/openapi.json'))).status).toBe(200);
    expect((await app.fetch(new Request('http://localhost/health'))).status).toBe(503);
    expect((await app.fetch(chat(ask, { authorization: 'Bearer secret' }))).status).toBe(200);
  });
});
