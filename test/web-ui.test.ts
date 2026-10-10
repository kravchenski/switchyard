import { describe, expect, test } from 'bun:test';

import { app } from '../src/web/server.ts';

async function pageFormatter() {
  const html = await (await app.fetch(new Request('http://localhost/'))).text();
  const source = html.slice(html.indexOf('function escapeHtml'), html.indexOf('prompt.focus();'));
  return new Function(`${source}; return formatHTML;`)() as (text: string) => string;
}

describe('web UI', () => {
  test('refuses API calls from other sites and hosts', async () => {
    const chat = (url: string, headers: Record<string, string> = {}) =>
      app.fetch(new Request(url, { method: 'POST', headers: { 'content-type': 'text/plain', ...headers }, body: '{"message":"hi"}' }));
    expect((await chat('http://localhost:3000/api/chat', { origin: 'https://attacker.example' })).status).toBe(403);
    expect((await chat('http://attacker.example:3000/api/chat')).status).toBe(403);
  });

  test('serves a script the browser can parse', async () => {
    const html = await (await app.fetch(new Request('http://localhost/'))).text();
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
  });

  test('escapes HTML in model output before formatting it', async () => {
    const formatHTML = await pageFormatter();
    expect(formatHTML('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(formatHTML('**bold** and `<b>`')).toBe('<strong>bold</strong> and <code>&lt;b&gt;</code>');
    expect(formatHTML('```ts\nconst a = 1;\n```')).toBe('<pre><code>const a = 1;<br></code></pre>');
  });
});
