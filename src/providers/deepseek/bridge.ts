import type { Page } from 'playwright-core';

import { launchCdpBrowser, type CdpBrowser } from '../../browser/cdp.ts';

const BRIDGE_NAME = '__freeapiDeepSeekBridge';
const JSON_TIMEOUT_MS = 15_000;
const FORBIDDEN_HEADERS = /^(host|cookie|content-length|user-agent|sec-ch-ua|sec-fetch-.*|connection|accept-encoding)$/i;

export type BridgeAccount = {
    id: string;
    token?: string;
    cookies?: Array<Record<string, any>>;
} | null;

export type BridgePart = {
    name: string;
    text?: string;
    filename?: string;
    type?: string;
    base64?: string;
};

export type BridgeInit = {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    parts?: BridgePart[];
};

type PendingBridge = {
    resolveMeta: (meta: { status: number; headers: Array<[string, string]> }) => void;
    fail: (error: Error) => void;
    controller: ReadableStreamDefaultController<Uint8Array> | null;
};

let cdp: CdpBrowser | null = null;
let page: Page | null = null;
let cookiesFor: string | null = null;
let counter = 0;
let pending = new Map<number, PendingBridge>();
let lock: Promise<unknown> = Promise.resolve();
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let fetchOverride: FetchLike | null = null;

export function setDeepSeekFetch(fn: FetchLike | null) {
    fetchOverride = fn;
}

export function deepSeekFetchOverride(): FetchLike | null {
    return fetchOverride;
}

function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
}

async function ensurePage(baseUrl: string): Promise<Page> {
    if (page && !page.isClosed()) return page;
    cdp = await launchCdpBrowser({ headless: true });
    const context = cdp.browser.contexts()[0];
    if (!context) throw new Error('deepseek bridge: browser context is missing');
    page = await context.newPage();
    cookiesFor = null;
    await page.exposeFunction(BRIDGE_NAME, (id: number, kind: string, data: unknown) => {
        const entry = pending.get(Number(id));
        if (!entry) return;
        if (kind === 'meta') {
            entry.resolveMeta(data as { status: number; headers: Array<[string, string]> });
            return;
        }
        if (kind === 'chunk') {
            entry.controller?.enqueue(new TextEncoder().encode(String(data)));
            return;
        }
        if (kind === 'end') {
            entry.controller?.close();
            pending.delete(Number(id));
            return;
        }
        entry.fail(new Error(String(data)));
        pending.delete(Number(id));
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    return page;
}

const CONTEXT_ERRORS = /context was destroyed|frame was detached|execution context|most likely because of a navigation/i;

async function reload(page: Page, baseUrl: string) {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

async function evaluateStable<T>(page: Page, baseUrl: string, run: () => Promise<T>, retries = 2): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await run();
        } catch (error) {
            lastError = error;
            if (!CONTEXT_ERRORS.test(String(error)) || attempt === retries) throw error;
            await reload(page, baseUrl);
        }
    }
    throw lastError;
}

async function syncCookies(account: BridgeAccount) {
    if (!cdp || !account) return;
    const context = cdp.browser.contexts()[0];
    if (!context) return;
    if (cookiesFor === account.id) return;
    await context.clearCookies();
    const cookies = (account.cookies ?? []).filter(cookie => cookie && cookie.name && cookie.value && cookie.domain);
    if (cookies.length) await context.addCookies(cookies as never);
    cookiesFor = account.id;
}

function requestHeaders(account: BridgeAccount, headers: Record<string, string> = {}): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (FORBIDDEN_HEADERS.test(name)) continue;
        merged[name.toLowerCase()] = value;
    }
    if (account?.token) merged.authorization = `Bearer ${account.token}`;
    return merged;
}

function publicHeaders(headers: Array<[string, string]>): Headers {
    const result = new Headers();
    for (const [name, value] of headers) {
        if (/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(name)) continue;
        try { result.set(name, value); } catch {}
    }
    return result;
}

async function bridgeJson(account: BridgeAccount, baseUrl: string, url: string, init: BridgeInit): Promise<Response> {
    const target = await withLock(async () => {
        const active = await ensurePage(baseUrl);
        await syncCookies(account);
        return active;
    });
    const result = await evaluateStable(target, baseUrl, () => target.evaluate(async args => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), args.timeoutMs);
        try {
            let body: BodyInit | undefined;
            if (args.parts) {
                const form = new FormData();
                for (const part of args.parts) {
                    if (part.text !== undefined) form.append(part.name, part.text);
                    else if (part.base64 !== undefined) {
                        const binary = atob(part.base64);
                        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
                        form.append(part.name, new Blob([bytes], { type: part.type || 'application/octet-stream' }), part.filename || part.name);
                    }
                }
                body = form;
            } else {
                body = args.body;
            }
            const response = await fetch(args.url, {
                method: args.method,
                headers: args.headers,
                body,
                signal: controller.signal,
            });
            const text = await response.text();
            return { ok: true as const, status: response.status, headers: [...response.headers.entries()], body: text };
        } catch (error) {
            return { ok: false as const, error: String(error) };
        } finally {
            clearTimeout(timer);
        }
    }, {
        url,
        method: init.method ?? 'GET',
        headers: requestHeaders(account, init.headers),
        body: init.body,
        parts: init.parts && init.parts.length ? init.parts : undefined,
        timeoutMs: JSON_TIMEOUT_MS,
    }));
    if (!result.ok) throw new Error(`deepseek bridge: request to ${url} failed: ${result.error}`);
    return new Response(result.body, { status: result.status, headers: publicHeaders(result.headers as Array<[string, string]>) });
}

async function bridgeStream(account: BridgeAccount, baseUrl: string, url: string, init: BridgeInit): Promise<Response> {
    const target = await withLock(async () => {
        const active = await ensurePage(baseUrl);
        await syncCookies(account);
        return active;
    });
    const id = ++counter;
    let resolveMeta!: (meta: { status: number; headers: Array<[string, string]> }) => void;
    let rejectMeta!: (error: Error) => void;
    const meta = new Promise<{ status: number; headers: Array<[string, string]> }>((resolve, reject) => {
        resolveMeta = resolve;
        rejectMeta = reject;
    });
    let resolveStart!: () => void;
    const started = new Promise<void>(resolve => { resolveStart = resolve; });
    const entry: PendingBridge = {
        resolveMeta: metaValue => {
            resolveStart();
            resolveMeta(metaValue);
        },
        fail: error => {
            resolveStart();
            rejectMeta(error);
        },
        controller: null,
    };
    pending.set(id, entry);
    await evaluateStable(target, baseUrl, () => target.evaluate(() => location.href), 1);
    target.evaluate(async args => {
        const bridge = (window as unknown as Record<string, (id: number, kind: string, data?: unknown) => void>)[args.name];
        try {
            const response = await fetch(args.url, {
                method: args.method,
                headers: args.headers,
                body: args.body,
            });
            bridge(args.id, 'meta', { status: response.status, headers: [...response.headers.entries()] });
            if (!response.body) {
                bridge(args.id, 'end');
                return;
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bridge(args.id, 'chunk', decoder.decode(value, { stream: true }));
            }
            bridge(args.id, 'end');
        } catch (error) {
            bridge(args.id, 'error', String(error));
        }
    }, {
        name: BRIDGE_NAME,
        id,
        url,
        method: init.method ?? 'GET',
        headers: requestHeaders(account, init.headers),
        body: init.body,
    }).catch(error => entry.fail(new Error(String(error))));
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            entry.controller = controller;
        },
    });
    const [metaValue] = await Promise.all([meta, started]);
    return new Response(stream, { status: metaValue.status, headers: publicHeaders(metaValue.headers) });
}

export function bridgeFetch(account: BridgeAccount, baseUrl: string, url: string, init: BridgeInit = {}, stream = false): Promise<Response> {
    return stream
        ? bridgeStream(account, baseUrl, url, init)
        : bridgeJson(account, baseUrl, url, init);
}

export async function closeDeepSeekBridge() {
    const active = cdp;
    cdp = null;
    page = null;
    cookiesFor = null;
    pending = new Map();
    if (active) await active.close().catch(() => {});
}
