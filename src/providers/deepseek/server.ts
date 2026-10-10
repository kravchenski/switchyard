import { Hono, type Context } from 'hono';
import { serve } from 'bun';
import crypto from 'crypto';

import { ProviderError, toHttpError } from '../../core/providers/errors.ts';
import { isLocalRequest } from '../../gateway/security.ts';
import { DEEPSEEK_MODELS, deepSeekOpenApi } from './openapi.ts';

import { deepSeekCompletion, isEmptyToolCallResponse, parseDeepSeekEvent } from './client.ts';
import { conversationalShellText, parseToolCallJson, recoverBrokenBashToolCall, toolsToPrompt } from '../../core/tools/tool-calls.ts';
import { hasValidDeepSeekAccounts } from './accounts.ts';
import { runDeepSeekAccountMenu } from './auth.ts';

const port = Number(process.env.DEEPSEEK_PORT || 3265);
const host = process.env.HOST || '127.0.0.1';
const VERIFICATION = /verification|captcha|verify you are human/i;

type ErrorStatus = 400 | 401 | 403 | 404 | 429 | 502 | 503;

function apiError(c: Context, status: ErrorStatus, type: string, code: string, message: string, retryAfterSeconds?: number) {
    if (retryAfterSeconds !== undefined) c.header('Retry-After', String(retryAfterSeconds));
    return c.json({ error: { message, type, param: null, code } }, status);
}

function upstreamFailure(c: Context, error: unknown) {
    const { status, type, message, retryAfterSeconds } = toHttpError(error);
    const kind = error instanceof ProviderError ? error.kind : 'upstream';
    if (VERIFICATION.test(message)) return apiError(c, 429, 'rate_limit_error', 'captcha_required', message, retryAfterSeconds);
    return apiError(c, status, type, kind, message, retryAfterSeconds);
}

function modelList() {
    return { object: 'list', data: DEEPSEEK_MODELS.map(id => ({ id, object: 'model', created: 0, owned_by: 'deepseek-web' })) };
}

function isCodebaseActionRequest(messages: Array<Record<string, any>>) {
    const lastUser = [...messages].reverse().find(message => message?.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content.toLowerCase() : '';
    return /рефактор|исправ|измени|добав|удал|проверь|тест|review|refactor|implement|fix|change|inspect|test/.test(text);
}

function fallbackInspectionToolCall(tools: Array<Record<string, any>> | null) {
    if (!Array.isArray(tools)) return null;
    const names = new Set(tools.map(tool => (tool?.function || tool)?.name));
    if (names.has('ls')) return { name: 'ls', arguments: { path: '.' } };
    if (names.has('bash')) return { name: 'bash', arguments: { command: 'ls -la' } };
    if (names.has('find')) return { name: 'find', arguments: { path: '.', pattern: '*' } };
    return null;
}

async function collectResponse(response: Response, onEvent?: (event: Record<string, any>) => void) {
    const state = {
        phase: 'content' as const,
        fragment: undefined as string | undefined,
        contentSnapshot: '',
        thinkingSnapshot: ''
    };
    const reader = response.body?.getReader();
    if (!reader) throw new Error('DeepSeek returned an empty response body');
    const decoder = new TextDecoder();
    let pending = '';
    let content = '';
    let reasoning = '';

    while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
            const event = parseDeepSeekEvent(line.trim(), state);
            if (event?.content) content += event.content;
            if (event?.reasoning) reasoning += event.reasoning;
            if (event) onEvent?.(event);
        }
        if (done) break;
    }
    return { content, reasoning };
}

function streamChunk(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: string | null = null) {
    return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

export function createDeepSeekApp(options: { apiKey?: string; complete?: typeof deepSeekCompletion; ready?: () => boolean } = {}) {
    const app = new Hono();
    const complete = options.complete ?? deepSeekCompletion;
    const ready = options.ready ?? (() => hasValidDeepSeekAccounts() || Boolean(process.env.DEEPSEEK_TOKEN));
    const open = new Set(['/health', '/api/openapi.json', '/api/v1/openapi.json']);

    app.use('*', async (c, next) => {
        if (open.has(c.req.path)) return next();
        if (!options.apiKey) {
            return isLocalRequest(c.req.raw) ? next() : apiError(c, 403, 'permission_error', 'local_only', 'Set GATEWAY_API_KEY to accept requests from other hosts or web pages');
        }
        if (c.req.header('authorization') !== `Bearer ${options.apiKey}`) return apiError(c, 401, 'authentication_error', 'invalid_api_key', 'Missing or wrong bearer token');
        return next();
    });

    app.get('/api/openapi.json', (c) => c.json(deepSeekOpenApi(new URL('/api', c.req.url).href)));
    app.get('/api/v1/openapi.json', (c) => c.json(deepSeekOpenApi(new URL('/api/v1', c.req.url).href)));

    app.get('/health', (c) => {
        const signedIn = ready();
        return c.json({ status: signedIn ? 'ok' : 'unauthenticated', service: 'deepseek' }, signedIn ? 200 : 503);
    });

    app.get('/api/models', (c) => c.json(modelList()));

    app.get('/api/v1/models', (c) => c.json(modelList()));

    app.post('/api/chat/completions', async (c) => {
        let body: Record<string, any>;
        try {
            body = await c.req.json();
        } catch {
            return apiError(c, 400, 'invalid_request_error', 'invalid_json', 'Invalid JSON body');
        }
        try {
            const { messages, model = 'deepseek-default', stream = false, tools, functions } = body || {};
            if (!Array.isArray(messages) || messages.length === 0) {
                return apiError(c, 400, 'invalid_request_error', 'invalid_request', 'messages must be a non-empty array');
            }
            if (!(DEEPSEEK_MODELS as readonly string[]).includes(model)) {
                return apiError(c, 404, 'model_not_found', 'model_unavailable', `Unknown model: ${model}. Available: ${DEEPSEEK_MODELS.join(', ')}`);
            }
            const conversationId = body.conversation_id || body.chat_id || c.req.header('x-conversation-id') || undefined;
            const combinedTools = tools || (Array.isArray(functions) ? functions.map((fn: Record<string, unknown>) => ({ type: 'function', function: fn })) : null);
            const toolPrompt = toolsToPrompt(combinedTools);
            const upstreamMessages = toolPrompt ? [{ role: 'system', content: toolPrompt }, ...messages] : messages;
            const { response, sessionId } = await complete({ messages: upstreamMessages, model, conversationId });
            const id = `chatcmpl-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
            const created = Math.floor(Date.now() / 1000);
            const captureToolCalls = Array.isArray(combinedTools) && combinedTools.length > 0;

            if (stream) {
                const encoder = new TextEncoder();
                const readable = new ReadableStream({
                    async start(controller) {
                        controller.enqueue(encoder.encode(streamChunk(id, created, model, { role: 'assistant' })));
                        let { content, reasoning } = await collectResponse(response, event => {
                            if (!captureToolCalls && event.content) controller.enqueue(encoder.encode(streamChunk(id, created, model, { content: event.content })));
                            if (!captureToolCalls && event.reasoning) controller.enqueue(encoder.encode(streamChunk(id, created, model, { reasoning_content: event.reasoning })));
                        });
                        if (captureToolCalls && isEmptyToolCallResponse(content) && !isCodebaseActionRequest(messages)) {
                            const retry = await complete({ messages, model, conversationId });
                            ({ content, reasoning } = await collectResponse(retry.response));
                        }
                        const recoveredShell = captureToolCalls ? recoverBrokenBashToolCall(content) : null;
                        const conversationalText = recoveredShell ? conversationalShellText(recoveredShell.name, recoveredShell.arguments) : null;
                        if (conversationalText) content = conversationalText;
                        let toolCalls = captureToolCalls && !conversationalText ? parseToolCallJson(content, combinedTools) : null;
                        if (!toolCalls?.length && captureToolCalls && isCodebaseActionRequest(messages)) {
                            const fallback = fallbackInspectionToolCall(combinedTools);
                            if (fallback) toolCalls = [{ id: `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`, type: 'function', function: { name: fallback.name, arguments: JSON.stringify(fallback.arguments) }, index: 0 }];
                        }
                        if (toolCalls?.length) {
                            for (const call of toolCalls) controller.enqueue(encoder.encode(streamChunk(id, created, model, { tool_calls: [{ index: call.index, id: call.id, type: call.type, function: call.function }] })));
                            controller.enqueue(encoder.encode(streamChunk(id, created, model, {}, 'tool_calls')));
                        } else {
                            if (captureToolCalls && reasoning) controller.enqueue(encoder.encode(streamChunk(id, created, model, { reasoning_content: reasoning })));
                            if (captureToolCalls && content) controller.enqueue(encoder.encode(streamChunk(id, created, model, { content })));
                            controller.enqueue(encoder.encode(streamChunk(id, created, model, {}, 'stop')));
                        }
                        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                        controller.close();
                    }
                });
                return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
            }

            let { content, reasoning } = await collectResponse(response);
            if (captureToolCalls && isEmptyToolCallResponse(content) && !isCodebaseActionRequest(messages)) {
                const retry = await complete({ messages, model, conversationId });
                ({ content, reasoning } = await collectResponse(retry.response));
            }
            const recoveredShell = captureToolCalls ? recoverBrokenBashToolCall(content) : null;
            const conversationalText = recoveredShell ? conversationalShellText(recoveredShell.name, recoveredShell.arguments) : null;
            if (conversationalText) content = conversationalText;
            let toolCalls = captureToolCalls && !conversationalText ? parseToolCallJson(content, combinedTools) : null;
            if (!toolCalls?.length && captureToolCalls && isCodebaseActionRequest(messages)) {
                const fallback = fallbackInspectionToolCall(combinedTools);
                if (fallback) toolCalls = [{ id: `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`, type: 'function', function: { name: fallback.name, arguments: JSON.stringify(fallback.arguments) }, index: 0 }];
            }

            return c.json({
                id, object: 'chat.completion', created, model,
                choices: [{ index: 0, message: toolCalls?.length ? { role: 'assistant', content: null, tool_calls: toolCalls.map(({ index: _index, ...call }) => call) } : { role: 'assistant', content, reasoning_content: reasoning || undefined }, finish_reason: toolCalls?.length ? 'tool_calls' : 'stop' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                x_deepseek_chat_id: sessionId
            });
        } catch (error) {
            return upstreamFailure(c, error);
        }
    });

    app.post('/api/v1/chat/completions', async (c) => {
        return app.fetch(new Request(c.req.url.replace('/v1', ''), { method: 'POST', headers: c.req.raw.headers, body: c.req.raw.body }));
    });

    return app;
}

function enabled(value: string | undefined) {
    return ['1', 'true', 'yes', 'on'].includes((value || '').trim().toLowerCase());
}

async function start() {
    console.log(`\n=====================================================\n   FREE DEEPSEEK WEB API\n   Browser-backed proxy for https://chat.deepseek.com/\n=====================================================\n`);
    const skipMenu = enabled(process.env.SKIP_ACCOUNT_MENU) || enabled(process.env.NON_INTERACTIVE);
    if (skipMenu) {
        if (!hasValidDeepSeekAccounts() && !process.env.DEEPSEEK_TOKEN) throw new Error('No active DeepSeek accounts.');
    } else {
        await runDeepSeekAccountMenu();
    }
    const app = createDeepSeekApp({ apiKey: process.env.GATEWAY_API_KEY || undefined });
    serve({ fetch: app.fetch, port, hostname: host, idleTimeout: 255 });
    console.log(`DeepSeek web proxy listening on http://${host}:${port}/api`);
    console.log(`Models: ${DEEPSEEK_MODELS.join(', ')}`);
    console.log(`OpenAPI: http://${host}:${port}/api/openapi.json`);
}

if (import.meta.main) start().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
