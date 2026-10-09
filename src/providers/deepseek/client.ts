import path from 'node:path';

import { solveDeepSeekPow } from './pow.ts';
import { getAvailableDeepSeekAccount, markDeepSeekAccountInvalid, type DeepSeekAccount } from './accounts.ts';
import { PersistentStringMap } from '../../utils/persistentMap.ts';
import { ProviderError, upstreamError } from '../../core/providers/errors.ts';
import { collectImageUrls, messagesToPrompt, toWebPrompt } from '../../core/providers/prompt.ts';
import { browserHeaders } from '../../platform/browserUa.ts';
import { bridgeFetch, deepSeekFetchOverride, type BridgeInit } from './bridge.ts';
import { toAttachFiles, type AttachFile } from '../../browser/browser-chat.ts';

export { messagesToPrompt };

const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com';
const SESSION_MAP_FILE = process.env.DEEPSEEK_SESSION_MAP_FILE || path.join(process.cwd(), 'session', 'deepseek', 'chat-sessions.json');

const HARDCODED_DEEPSEEK_MODELS = ['deepseek-default', 'deepseek-reasoner', 'deepseek-expert', 'deepseek-search'];
let cachedDeepSeekModels: string[] | null = null;

type ApiInit = {
    method?: string;
    headers?: Record<string, string>;
    body?: string | FormData;
    signal?: AbortSignal;
    stream?: boolean;
};

const nativeFetch = globalThis.fetch;

async function apiFetch(account: DeepSeekAccount | null, url: string, init: ApiInit = {}): Promise<Response> {
    const override = deepSeekFetchOverride();
    if (override) return override(url, init as RequestInit);
    if (globalThis.fetch !== nativeFetch) return fetch(url, init as RequestInit);
    const bridgeInit: BridgeInit = { method: init.method, headers: init.headers };
    if (typeof init.body === 'string') bridgeInit.body = init.body;
    else if (init.body instanceof FormData) {
        bridgeInit.parts = [];
        const entries = init.body.entries() as Iterable<[string, string | File]>;
        for (const [name, value] of entries) {
            if (typeof value === 'string') bridgeInit.parts.push({ name, text: value });
            else bridgeInit.parts.push({ name, filename: value.name, type: value.type, base64: Buffer.from(await value.arrayBuffer()).toString('base64') });
        }
    }
    try {
        return await bridgeFetch(account, BASE_URL, url, bridgeInit, init.stream);
    } catch (error) {
        if (process.env.DEEPSEEK_DIRECT_FETCH === '1') throw error;
        return fetch(url, {
            method: init.method,
            headers: init.headers,
            body: init.body,
            signal: init.signal,
        });
    }
}

export async function fetchDeepSeekModels(): Promise<string[]> {
    if (cachedDeepSeekModels) return cachedDeepSeekModels;
    try {
        const response = await apiFetch(null, `${BASE_URL}/api/v0/models`, {
            headers: browserHeaders(),
            signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
            const data = await response.json() as any;
            const models: string[] = (data?.data || [])
                .map((m: any) => m.id || m.name)
                .filter(Boolean)
                .sort();
            if (models.length > 0) {
                cachedDeepSeekModels = models;
                return models;
            }
        }
    } catch {
        // API unavailable, use fallback
    }
    cachedDeepSeekModels = HARDCODED_DEEPSEEK_MODELS;
    return HARDCODED_DEEPSEEK_MODELS;
}

export function getDeepSeekModels(): string[] {
    return cachedDeepSeekModels || HARDCODED_DEEPSEEK_MODELS;
}

const sessions = new PersistentStringMap(SESSION_MAP_FILE);

export function envAccount(): DeepSeekAccount | null {
    const token = process.env.DEEPSEEK_TOKEN;
    return token ? { id: 'env', token, cookies: [] } : null;
}

function getAccount() {
    const account = getAvailableDeepSeekAccount() || envAccount();
    if (!account) throw new ProviderError('No active DeepSeek accounts. Add one with bun run auth:deepseek.', 'unavailable');
    return account;
}

function cookieHeader(account: DeepSeekAccount) {
    return account.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function headers(account: DeepSeekAccount, extra: Record<string, string> = {}) {
    return {
        authorization: `Bearer ${account.token}`,
        'content-type': 'application/json',
        ...(account.cookies.length ? { cookie: cookieHeader(account) } : {}),
        origin: BASE_URL,
        referer: `${BASE_URL}/`,
        ...browserHeaders(),
        ...extra
    };
}

async function createSession(account: DeepSeekAccount) {
    const response = await apiFetch(account, `${BASE_URL}/api/v0/chat_session/create`, {
        method: 'POST',
        headers: headers(account),
        body: '{}'
    });
    if (response.status === 401 && account.id !== 'env') markDeepSeekAccountInvalid(account.id);
    if (!response.ok) throw await upstreamError('DeepSeek session create', response);
    const body = await response.json() as any;
    const id = body?.data?.biz_data?.chat_session?.id || body?.data?.biz_data?.id;
    if (id) return id as string;
    const reason = completionRejection(body) ?? 'no chat session id';
    if (INVALID_TOKEN.test(reason)) {
        if (account.id !== 'env') markDeepSeekAccountInvalid(account.id);
        throw new ProviderError(`DeepSeek rejected the account token (${reason}); sign in again: bun run auth:deepseek`, 'auth', 401);
    }
    throw new ProviderError(`DeepSeek did not create a chat session: ${reason}`, 'upstream', 502);
}

async function getSession(account: DeepSeekAccount, key: string) {
    const scopedKey = `${account.id}:${key}`;
    const existing = sessions.get(scopedKey);
    if (existing) return existing;
    const created = await createSession(account);
    sessions.set(scopedKey, created);
    return created;
}

async function getPow(account: DeepSeekAccount, sessionId: string, targetPath = '/api/v0/chat/completion') {
    const response = await apiFetch(account, `${BASE_URL}/api/v0/chat/create_pow_challenge`, {
        method: 'POST',
        headers: headers(account, { referer: `${BASE_URL}/a/chat/s/${sessionId}` }),
        body: JSON.stringify({ target_path: targetPath })
    });
    if (response.status === 401 && account.id !== 'env') markDeepSeekAccountInvalid(account.id);
    if (!response.ok) throw await upstreamError('DeepSeek PoW challenge', response);
    const body = await response.json() as any;
    const challenge = body?.data?.biz_data?.challenge;
    if (!challenge) throw new Error('DeepSeek did not return a PoW challenge');
    return solveDeepSeekPow(challenge);
}

const FILE_UPLOAD_PATH = '/api/v0/file/upload_file';
const FILE_READY_TIMEOUT_MS = 60_000;

function bizData(body: any) {
    return body?.data?.biz_data ?? body?.biz_data ?? body?.data ?? body;
}

export function uploadedFileId(body: unknown): string | undefined {
    const biz = bizData(body);
    const id = biz?.id ?? biz?.file_id ?? biz?.file?.id;
    return typeof id === 'string' && id ? id : undefined;
}

export function fileStatuses(body: unknown): Map<string, string> {
    const biz = bizData(body);
    const list: any[] = Array.isArray(biz) ? biz : Array.isArray(biz?.files) ? biz.files : biz && typeof biz === 'object' ? Object.entries(biz).map(([id, value]) => ({ id, ...(value as object) })) : [];
    return new Map(list.filter(file => typeof file?.id === 'string').map(file => [file.id, String(file.status ?? '').toUpperCase()]));
}

async function uploadImage(account: DeepSeekAccount, sessionId: string, file: AttachFile) {
    const pow = await getPow(account, sessionId, FILE_UPLOAD_PATH);
    const { 'content-type': _json, ...rest } = headers(account, { referer: `${BASE_URL}/a/chat/s/${sessionId}`, 'x-ds-pow-response': pow });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }), file.name);
    const response = await apiFetch(account, `${BASE_URL}${FILE_UPLOAD_PATH}`, { method: 'POST', headers: rest, body: form });
    if (response.status === 401 && account.id !== 'env') markDeepSeekAccountInvalid(account.id);
    if (!response.ok) throw await upstreamError('DeepSeek image upload', response);
    const body = await response.json();
    const id = uploadedFileId(body);
    if (!id) throw new ProviderError(`DeepSeek image upload returned no file id: ${JSON.stringify(body).slice(0, 200)}`, 'upstream', 502);
    return id;
}

async function waitForFiles(account: DeepSeekAccount, ids: string[]) {
    const deadline = Date.now() + FILE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const query = ids.map(id => `file_ids=${encodeURIComponent(id)}`).join('&');
        const response = await apiFetch(account, `${BASE_URL}/api/v0/file/fetch_files?${query}`, { headers: headers(account) });
        if (!response.ok) throw await upstreamError('DeepSeek file status', response);
        const statuses = fileStatuses(await response.json());
        const failed = ids.find(id => /FAIL|ERROR/.test(statuses.get(id) ?? ''));
        if (failed) throw new ProviderError(`DeepSeek could not read the image (${statuses.get(failed)})`, 'upstream', 502);
        if (ids.every(id => statuses.get(id) === 'SUCCESS')) return;
        await Bun.sleep(1_000);
    }
    throw new ProviderError('DeepSeek did not finish reading the image in time', 'unavailable');
}

async function attachImages(account: DeepSeekAccount, sessionId: string, messages: Array<Record<string, any>>) {
    const urls = collectImageUrls(messages);
    if (!urls.length) return [];
    const files = await toAttachFiles(urls);
    const ids: string[] = [];
    for (const file of files) ids.push(await uploadImage(account, sessionId, file));
    await waitForFiles(account, ids);
    return ids;
}

export function isEmptyToolCallResponse(content: string) {
    return /^\s*(?:```json\s*)?\{\s*"tool_calls"\s*:\s*\[\s*\]\s*\}(?:\s*```)?\s*$/i.test(content);
}

export async function deepSeekCompletion(options: {
    messages: Array<Record<string, any>>;
    model?: string;
    conversationId?: string;
    account?: DeepSeekAccount;
}) {
    const account = options.account ?? getAccount();
    const key = options.conversationId || SHARED_CHAT;
    for (let attempt = 0; ; attempt++) {
        const completion = await sendCompletion(account, key, options.messages, options.model || 'deepseek-default');
        if (completion.response.headers.get('content-type')?.includes('text/event-stream')) return completion;
        const reason = completionRejection(await completion.response.json().catch(() => null)) ?? 'DeepSeek returned no answer stream';
        if (attempt === 0 && STALE_SESSION.test(reason)) {
            sessions.delete(`${account.id}:${key}`);
            continue;
        }
        throw new ProviderError(`DeepSeek completion: ${reason}`, 'upstream', 502);
    }
}

const SHARED_CHAT = 'shared';
const STALE_SESSION = /invalid chat session|chat session .*not (?:found|exist)/i;
const INVALID_TOKEN = /invalid token|authorization failed|token expired/i;

export function completionRejection(body: unknown): string | undefined {
    const root = body as { code?: unknown; msg?: unknown; data?: { biz_code?: unknown; biz_msg?: unknown } } | null;
    const code = root?.data?.biz_code || root?.code;
    if (!code) return undefined;
    const message = root?.data?.biz_msg || root?.msg;
    return typeof message === 'string' && message ? message : `error code ${String(code)}`;
}

async function sendCompletion(account: DeepSeekAccount, key: string, messages: Array<Record<string, any>>, model: string) {
    const sessionId = await getSession(account, key);
    const fileIds = await attachImages(account, sessionId, messages);
    const pow = await getPow(account, sessionId);
    const response = await apiFetch(account, `${BASE_URL}/api/v0/chat/completion`, {
        method: 'POST',
        stream: true,
        headers: headers(account, {
            referer: `${BASE_URL}/a/chat/s/${sessionId}`,
            'x-ds-pow-response': pow,
            ...(model.includes('reasoner') || model.includes('r1') ? { 'x-thinking-enabled': 'true' } : {})
        }),
        body: JSON.stringify({
            chat_session_id: sessionId,
            parent_message_id: null,
            prompt: toWebPrompt(messages, fileIds.length > 0),
            ref_file_ids: fileIds,
            thinking_enabled: model.includes('reasoner') || model.includes('r1'),
            search_enabled: model.includes('search'),
            model_type: model.includes('expert') ? 'expert' : 'default'
        })
    });
    if (response.status === 401 && account.id !== 'env') markDeepSeekAccountInvalid(account.id);
    if (!response.ok) throw await upstreamError('DeepSeek completion', response);
    return { response, sessionId, key, accountId: account.id };
}

type DeepSeekParseState = {
    phase: 'content' | 'thinking';
    fragment?: string;
    contentSnapshot?: string;
    thinkingSnapshot?: string;
};

function applyFragments(fragments: Array<Record<string, any>>, state: DeepSeekParseState) {
    let content = '';
    let reasoning = '';
    for (const fragment of fragments) {
        state.fragment = fragment?.type;
        state.phase = fragment?.type === 'THINK' ? 'thinking' : 'content';
        const text = typeof fragment?.content === 'string' ? fragment.content : '';
        if (state.phase === 'thinking') reasoning += text;
        else content += text;
    }
    state.thinkingSnapshot = `${state.thinkingSnapshot || ''}${reasoning}`;
    state.contentSnapshot = `${state.contentSnapshot || ''}${content}`;
    if (!content && !reasoning) return null;
    return { ...(reasoning ? { reasoning } : {}), ...(content ? { content } : {}) };
}

export function parseDeepSeekEvent(line: string, state: DeepSeekParseState) {
    if (!line.startsWith('data:')) return null;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return { done: true };
    const event = JSON.parse(data);
    const path = event.p;
    const value = event.v;
    const snapshot = value?.response;
    if (!path && Array.isArray(snapshot?.fragments)) return applyFragments(snapshot.fragments, state);
    if (path === 'response/fragments' && Array.isArray(value)) return applyFragments(value, state);
    if (!path && snapshot && typeof snapshot === 'object') {
        const snapshotContent = typeof snapshot.content === 'string' ? snapshot.content : '';
        const snapshotThinking = typeof snapshot.thinking_content === 'string' ? snapshot.thinking_content : '';
        if (snapshotThinking && snapshotThinking !== state.thinkingSnapshot) {
            const previous = state.thinkingSnapshot || '';
            state.thinkingSnapshot = snapshotThinking;
            return { reasoning: snapshotThinking.startsWith(previous) ? snapshotThinking.slice(previous.length) : snapshotThinking };
        }
        if (snapshotContent && snapshotContent !== state.contentSnapshot) {
            const previous = state.contentSnapshot || '';
            state.contentSnapshot = snapshotContent;
            return { content: snapshotContent.startsWith(previous) ? snapshotContent.slice(previous.length) : snapshotContent };
        }
        return null;
    }
    if (path === 'response/status' || path?.endsWith('/status')) {
        return value === 'FINISHED' ? { done: true } : null;
    }
    if (path === 'response/fragments/-1/type') state.fragment = value;
    if (path === 'response/thinking_content') state.phase = 'thinking';
    if (path === 'response/content') state.phase = 'content';
    if (path === 'response/fragments/-1/content') {
        state.phase = state.fragment === 'THINK' ? 'thinking' : 'content';
    }
    if (typeof value !== 'string' || path === 'response/fragments/-1/type') return null;
    if (state.phase === 'thinking') {
        state.thinkingSnapshot = `${state.thinkingSnapshot || ''}${value}`;
        return { reasoning: value };
    }
    state.contentSnapshot = `${state.contentSnapshot || ''}${value}`;
    return { content: value };
}
