import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { findBrowserExecutable } from '../src/platform/browserExecutable.ts';
import { bridgeFetch, closeDeepSeekBridge } from '../src/providers/deepseek/bridge.ts';

let server: ReturnType<typeof Bun.serve>;
let origin = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/plain') {
        return Response.json({ hello: 'bridge', ua: request.headers.get('user-agent') ?? '', auth: request.headers.get('authorization') ?? '' });
      }
      if (url.pathname === '/stream') {
        const parts = ['data: one\n\n', 'data: two\n\n', 'data: [DONE]\n\n'];
        return new Response(new ReadableStream({
          async start(controller) {
            for (const part of parts) {
              controller.enqueue(new TextEncoder().encode(part));
              await Bun.sleep(30);
            }
            controller.close();
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.pathname === '/upload') {
        const form = await request.formData();
        const file = form.get('file');
        const caption = form.get('caption');
        const body = file instanceof File ? `${file.name}:${await file.text()}` : 'no-file';
        return Response.json({ body, caption: String(caption ?? '') });
      }
      return new Response('not found', { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await closeDeepSeekBridge();
  server?.stop(true);
});

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1' || !findBrowserExecutable())('deepseek browser bridge', () => {
  test('sends JSON requests with a real browser user agent', async () => {
    const response = await bridgeFetch({ id: 'acct', token: 'secret-token', cookies: [] }, origin, `${origin}/plain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Bun/1.0.0' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { hello: string; ua: string; auth: string };
    expect(body.hello).toBe('bridge');
    expect(body.ua).toContain('Chrome/');
    expect(body.ua).not.toContain('Bun/');
    expect(body.auth).toBe('Bearer secret-token');
  }, 60_000);

  test('streams server sent events chunk by chunk', async () => {
    const response = await bridgeFetch(null, origin, `${origin}/stream`, {});
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toBe('data: one\n\ndata: two\n\ndata: [DONE]\n\n');
  }, 60_000);

  test('uploads multipart bodies built from file parts', async () => {
    const response = await bridgeFetch(null, origin, `${origin}/upload`, {
      method: 'POST',
      headers: { referer: `${origin}/` },
      parts: [
        { name: 'file', filename: 'note.txt', type: 'text/plain', base64: Buffer.from('file-body').toString('base64') },
        { name: 'caption', text: 'hello upload' },
      ],
    });
    const body = await response.json() as { body: string; caption: string };
    expect(body.body).toBe('note.txt:file-body');
    expect(body.caption).toBe('hello upload');
  }, 60_000);

  test('reports upstream failures with the original status', async () => {
    const response = await bridgeFetch(null, origin, `${origin}/missing`, {});
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('not found');
  }, 60_000);
});
