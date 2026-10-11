import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { websocket } from 'hono/bun';

import { BrowserHub, type BridgeSocket, type BrowserToolDefinition } from '../src/browser-bridge/hub.ts';
import { handleMcpPost } from '../src/browser-bridge/mcp.ts';

const tools: BrowserToolDefinition[] = [
    { name: 'tabs_list', description: 'List tabs', inputSchema: { type: 'object', properties: {} } },
];

function fakeSocket() {
    const sent: any[] = [];
    let closed: [number?, string?] | undefined;
    const socket: BridgeSocket = {
        send: data => sent.push(JSON.parse(data)),
        close: (code, reason) => {
            closed = [code, reason];
        },
    };
    return { socket, sent, closed: () => closed };
}

function connectedHub(timeoutMs?: number) {
    const hub = new BrowserHub(undefined, timeoutMs);
    const extension = fakeSocket();
    hub.open(extension.socket);
    hub.message(extension.socket, JSON.stringify({ type: 'hello', version: '0.1.0', tools }));
    return { hub, extension };
}

describe('BrowserHub', () => {
    test('reports a clear error when no extension is connected', async () => {
        const result = await new BrowserHub().call('tabs_list', {});
        expect(result.isError).toBeTrue();
        expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('not connected') });
    });

    test('forwards calls and resolves them with the matching result', async () => {
        const { hub, extension } = connectedHub();
        expect(hub.status()).toEqual({ connected: true, extensionVersion: '0.1.0', tools: 1 });
        const pending = hub.call('tabs_list', { scope: 'all' });
        expect(extension.sent).toEqual([{ type: 'call', id: '1', name: 'tabs_list', args: { scope: 'all' } }]);
        hub.message(extension.socket, JSON.stringify({ type: 'result', id: '1', result: { content: [{ type: 'text', text: 'ok' }] } }));
        expect(await pending).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    });

    test('answers pings', () => {
        const { hub, extension } = connectedHub();
        hub.message(extension.socket, JSON.stringify({ type: 'ping' }));
        expect(extension.sent).toEqual([{ type: 'pong' }]);
    });

    test('times out calls the browser never answers', async () => {
        const { hub } = connectedHub(10);
        const result = await hub.call('tabs_list', {});
        expect(result.isError).toBeTrue();
        expect(result.content[0]).toMatchObject({ text: expect.stringContaining('did not answer tabs_list') });
    });

    test('fails pending calls when the extension disconnects', async () => {
        const { hub, extension } = connectedHub();
        const pending = hub.call('tabs_list', {});
        hub.close(extension.socket);
        expect((await pending).isError).toBeTrue();
        expect(hub.connected).toBeFalse();
    });

    test('a new connection replaces the old one', () => {
        const { hub, extension } = connectedHub();
        const next = fakeSocket();
        hub.open(next.socket);
        expect(extension.closed()).toEqual([4000, 'Replaced by a newer connection']);
        hub.close(extension.socket);
        expect(hub.connected).toBeTrue();
    });

    test('remembers the tool list in the store', () => {
        let saved: string | undefined;
        const store = { load: () => saved, save: (value: string) => { saved = value; } };
        const hub = new BrowserHub(store);
        const extension = fakeSocket();
        hub.open(extension.socket);
        hub.message(extension.socket, JSON.stringify({ type: 'hello', tools }));
        expect(new BrowserHub(store).tools()).toEqual(tools);
        expect(new BrowserHub({ load: () => '{broken', save: () => {} }).tools()).toEqual([]);
    });
});

describe('MCP handler', () => {
    const post = async (body: unknown, hub = connectedHub().hub) => {
        const response = await handleMcpPost(body, hub, '9.9.9');
        return { status: response.status, body: response.status === 202 ? undefined : await response.json() as any };
    };

    test('initialize negotiates the protocol version', async () => {
        const known = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
        expect(known.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'switchyard-browser', version: '9.9.9' } });
        const unknown = await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
        expect(unknown.body.result.protocolVersion).toBe('2025-11-25');
    });

    test('notifications are accepted without a body', async () => {
        expect(await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({ status: 202, body: undefined });
    });

    test('lists and calls tools', async () => {
        const { hub, extension } = connectedHub();
        expect((await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, hub)).body.result).toEqual({ tools });
        const call = post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tabs_list', arguments: {} } }, hub);
        await Bun.sleep(0);
        hub.message(extension.socket, JSON.stringify({ type: 'result', id: extension.sent[0].id, result: { content: [{ type: 'text', text: 'tabs' }] } }));
        expect((await call).body).toEqual({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'tabs' }] } });
    });

    test('rejects unknown methods and bad calls', async () => {
        expect((await post({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).body.error.code).toBe(-32601);
        expect((await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} })).body.error.code).toBe(-32602);
        expect((await post({ nope: true })).body.error.code).toBe(-32600);
    });

    test('answers batches and skips notifications in them', async () => {
        const { body } = await post([{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
        expect(body).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }]);
    });
});

describe('bridge over the unified server', () => {
    let server: ReturnType<typeof Bun.serve>;
    let key = '';

    beforeAll(async () => {
        key = process.env.GATEWAY_API_KEY ||= 'test-key';
        process.env.DATA_DIR ||= mkdtempSync(join(tmpdir(), 'gateway-test-'));
        const { app } = await import('../src/unified/server.ts');
        server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch, websocket });
    });

    afterAll(() => server?.stop(true));

    const mcp = (body: unknown) => fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
    });

    test('rejects a WebSocket without the key', async () => {
        const response = await fetch(`http://127.0.0.1:${server.port}/browser/ws`, { headers: { upgrade: 'websocket' } });
        expect(response.status).toBe(401);
    });

    test('routes an MCP tool call to a connected extension and back', async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}/browser/ws?key=${encodeURIComponent(key)}`);
        await new Promise((resolve, reject) => {
            socket.onopen = resolve;
            socket.onerror = reject;
        });
        socket.onmessage = (event) => {
            const message = JSON.parse(String(event.data));
            if (message.type !== 'call') return;
            socket.send(JSON.stringify({ type: 'result', id: message.id, result: { content: [{ type: 'text', text: `ran ${message.name} ${JSON.stringify(message.args)}` }] } }));
        };
        socket.send(JSON.stringify({ type: 'hello', version: 'test', tools }));
        await Bun.sleep(20);

        const status = await fetch(`http://127.0.0.1:${server.port}/v1/gateway/browser`, { headers: { authorization: `Bearer ${key}` } });
        expect(await status.json()).toEqual({ connected: true, extensionVersion: 'test', tools: 1 });

        const listed = await (await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json() as any;
        expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['tabs_list']);

        const called = await (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tabs_list', arguments: { scope: 'all' } } })).json() as any;
        expect(called.result).toEqual({ content: [{ type: 'text', text: 'ran tabs_list {"scope":"all"}' }] });

        socket.close();
        await Bun.sleep(20);
        const after = await (await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tabs_list' } })).json() as any;
        expect(after.result.isError).toBeTrue();
    });

    test('GET /mcp is not supported', async () => {
        const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, { headers: { authorization: `Bearer ${key}` } });
        expect(response.status).toBe(405);
    });
});
