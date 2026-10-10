import http from 'node:http';
import https from 'node:https';

import type { Locator, Page } from 'playwright-core';

import type { AutoLoginResult, SiteLoginOptions } from './auto-login.ts';
import { autoSolveCaptcha, type CaptchaHints } from './captcha/index.ts';
import { assertPublicUrl, publicLookup, type Lookup } from '../core/net/public-url.ts';
import { ProviderError } from '../core/providers/errors.ts';
import { launchCdpBrowser, type CdpBrowser, type LaunchOptions } from './cdp.ts';
import { googleProfileDir } from './google-profile.ts';
import { readSignIn, type SignInResult, type SignInRule } from './sign-in.ts';
import { humanType } from './typing.ts';
import type { ChatMessage } from '../core/providers/provider.ts';

export interface SendContext {
  conversationId?: string;
  messages?: ChatMessage[];
  toPrompt?: (messages: ChatMessage[]) => string;
  extractImages?: (messages: ChatMessage[]) => string[];
}

export interface AttachFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface ChatSite {
  id: string;
  url: string;
  inputSelector: string;
  responseUrl: RegExp;
  verificationText?: RegExp;
  signIn?: SignInRule;
  authUrl?: string;
  challengeResponse?: RegExp;
  ignoredResponse?: RegExp;
  captcha?: CaptchaHints;
  modelFields?: (model: string) => Record<string, unknown>;
  images?: boolean;
  attachImages?: (page: Page, files: AttachFile[]) => Promise<void>;
  modelsResponse?: RegExp;
  parseModels?: (body: unknown) => WebChatModel[];
  pageModels?: (page: Page) => Promise<WebChatModel[]>;
  defaultModels?: WebChatModel[];
  reuseThread?: boolean;
  tokenCheck?: string;
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS = 3;
const IMAGE_TIMEOUT_MS = 30_000;

export interface AttachOptions {
  checkUrl?: (url: string) => void;
  lookup?: Lookup;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function requestImage(url: string, lookup: Lookup) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { lookup: lookup as never, timeout: IMAGE_TIMEOUT_MS }, resolve);
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
  });
}

async function downloadImage(url: string, index: number, checkUrl: (url: string) => void, lookup: Lookup) {
  let target = url;
  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop += 1) {
    try {
      checkUrl(target);
    } catch (error) {
      throw new ProviderError(`Failed to download image ${index}: ${errorText(error)}`, 'invalid_request');
    }
    let response: http.IncomingMessage;
    try {
      response = await requestImage(target, lookup);
    } catch (error) {
      const kind = /private address/.test(errorText(error)) ? 'invalid_request' : 'unavailable';
      throw new ProviderError(`Failed to download image ${index}: ${errorText(error)}`, kind);
    }
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status < 300 || status >= 400 || !location) return response;
    response.destroy();
    target = new URL(location, target).href;
  }
  throw new ProviderError(`Failed to download image ${index}: too many redirects`, 'invalid_request');
}

async function readImage(response: http.IncomingMessage) {
  if (Number(response.headers['content-length'] ?? 0) > MAX_IMAGE_BYTES) {
    response.destroy();
    throw new Error('image is larger than 20 MB');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) {
      response.destroy();
      throw new Error('image is larger than 20 MB');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function toAttachFiles(urls: string[], options: AttachOptions = {}): Promise<AttachFile[]> {
  const checkUrl = options.checkUrl ?? assertPublicUrl;
  const lookup = options.lookup ?? publicLookup;
  const files: AttachFile[] = [];
  let index = 0;
  for (const url of urls) {
    index += 1;
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      const header = url.slice(5, comma);
      const base64 = header.endsWith(';base64');
      const mimeType = (base64 ? header.slice(0, -';base64'.length) : header) || 'application/octet-stream';
      const payload = url.slice(comma + 1);
      const buffer = base64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
      files.push({ name: `image-${index}.${MIME_EXTENSIONS[mimeType] ?? 'png'}`, mimeType, buffer });
      continue;
    }
    const response = await downloadImage(url, index, checkUrl, lookup);
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new ProviderError(`Failed to download image ${index}: HTTP ${status}`, 'unavailable');
    }
    const mimeType = (response.headers['content-type'] ?? '').split(';')[0] || 'image/png';
    let buffer: Buffer;
    try {
      buffer = await readImage(response);
    } catch (error) {
      throw new ProviderError(`Failed to download image ${index}: ${errorText(error)}`, 'invalid_request');
    }
    files.push({ name: `image-${index}.${MIME_EXTENSIONS[mimeType] ?? 'png'}`, mimeType, buffer });
  }
  return files;
}

export interface WebChatModel {
  id: string;
  name: string;
}

export function webChatModelSlug(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

export interface BrowserChatOptions {
  profileDir?: string;
  headless?: boolean;
  firstChunkTimeoutMs?: number;
  idleTimeoutMs?: number;
  minIntervalMs?: number;
  launch?: (options: LaunchOptions) => Promise<CdpBrowser>;
  onSignIn?: (siteId: string, result: SignInResult) => void;
  onModels?: (siteId: string, models: WebChatModel[]) => void;
}

const BINDING = '__freeapiStreamChunk';
const CHALLENGE_GRACE_MS = 120_000;
const THREAD_IDLE_MS = 30 * 60_000;
const MAX_THREADS_PER_SITE = 3;
const SUBMIT_RETRY_MS = 60_000;
const SUBMIT_RETRY_MIN_MS = 1_500;
const SUBMIT_RETRY_JITTER_MS = 1_500;

async function submitPrompt(page: Page, input: Locator, responseUrl: RegExp) {
  let sent = false;
  const watch = (request: { url(): string }) => {
    if (responseUrl.test(request.url())) sent = true;
  };
  page.on('request', watch);
  try {
    await input.press('Enter');
    const deadline = Date.now() + SUBMIT_RETRY_MS;
    while (!sent && Date.now() < deadline) {
      await Bun.sleep(SUBMIT_RETRY_MIN_MS + Math.random() * SUBMIT_RETRY_JITTER_MS);
      if (sent) return;
      const left = await input.inputValue({ timeout: 1_000 }).catch(() => '');
      if (!left.trim()) return;
      await input.press('Enter', { timeout: 2_000 }).catch(() => {});
    }
  } finally {
    page.off('request', watch);
  }
}

interface ChatThread {
  page: Page;
  model?: string;
  conversationId?: string;
  sent: ChatMessage[];
  lastUsed: number;
}

function isHistoryPrefix(sent: ChatMessage[], incoming?: ChatMessage[]) {
  if (!incoming || !sent.length || sent.length > incoming.length) return false;
  for (let index = 0; index < sent.length; index++) {
    if (JSON.stringify(sent[index]) !== JSON.stringify(incoming[index])) return false;
  }
  return true;
}

function teeScript({ pattern, binding, fields, images }: { pattern: string; binding: string; fields?: Record<string, unknown>; images?: string[] }) {
  const matcher = new RegExp(pattern);
  const original = window.fetch;
  const store = window as unknown as Record<string, unknown>;
  if (images?.length) store.__freeapiImages = images;
  const activeImages = () => (Array.isArray(store.__freeapiImages) ? store.__freeapiImages as string[] : []) as string[];
  const setPath = (node: unknown, keys: string[], value: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const [key, ...rest] = keys;
    if (key === '*') {
      if (Array.isArray(node)) for (const child of node) setPath(child, rest, value);
      return;
    }
    const record = node as Record<string, unknown>;
    if (!rest.length) record[key!] = value;
    else setPath(record[key!], rest, value);
  };
  const injectImages = (body: unknown) => {
    const urls = activeImages();
    if (!urls.length || body === null || typeof body !== 'object') return;
    const parts = urls.map(url => ({ type: 'image_url', image_url: { url } }));
    const inject = (message: unknown): boolean => {
      if (message === null || typeof message !== 'object') return false;
      const record = message as Record<string, unknown>;
      if (record.role !== undefined && record.role !== 'user') return false;
      const content = record.content;
      if (typeof content === 'string') record.content = [{ type: 'text', text: content }, ...parts];
      else if (Array.isArray(content)) content.push(...parts);
      else return false;
      return true;
    };
    const record = body as Record<string, unknown>;
    if (Array.isArray(record.messages)) {
      for (let index = record.messages.length - 1; index >= 0; index--) {
        if (inject(record.messages[index])) return;
      }
    } else if (record.message !== null && typeof record.message === 'object') {
      inject(record.message);
    }
  };
  const rewrite = (json: string) => {
    const body = JSON.parse(json);
    for (const [path, value] of Object.entries(fields ?? {})) setPath(body, path.split('.'), value);
    injectImages(body);
    return JSON.stringify(body);
  };
  const rewriteBody = (body: unknown) => {
    if (typeof body === 'string') return rewrite(body);
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      if (bytes.length < 5) return body;
      const length = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0);
      const payload = new TextEncoder().encode(rewrite(new TextDecoder().decode(bytes.subarray(5, 5 + length))));
      const rest = bytes.subarray(5 + length);
      const framed = new Uint8Array(5 + payload.length + rest.length);
      framed[0] = bytes[0]!;
      new DataView(framed.buffer).setUint32(1, payload.length);
      framed.set(payload, 5);
      framed.set(rest, 5 + payload.length);
      return framed;
    }
    return body;
  };
  window.fetch = Object.assign(async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const requested = args[0];
    const requestedUrl = typeof requested === 'string' ? requested : requested instanceof URL ? requested.href : requested.url;
    if ((fields || activeImages().length) && matcher.test(requestedUrl) && args[1]?.body) {
      try {
        args[1] = { ...args[1], body: rewriteBody(args[1].body) as BodyInit };
      } catch {}
    }
    const response = await original.apply(this, args);
    const target = args[0];
    const url = typeof target === 'string' ? target : target instanceof URL ? target.href : target.url;
    if (!matcher.test(url) || !response.body) return response;
    const [forPage, forGateway] = response.body.tee();
    const emit = (window as unknown as Record<string, (chunk: string | null) => void>)[binding]!;
    (async () => {
      const reader = forGateway.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let binary = '';
        for (const byte of value) binary += String.fromCharCode(byte);
        emit(btoa(binary));
      }
      emit(null);
    })().catch(() => emit(null));
    return new Response(forPage, { status: response.status, statusText: response.statusText, headers: response.headers });
  }, original) as typeof fetch;
}

export function notSignedIn(site: Pick<ChatSite, 'url'>, result: SignInResult) {
  return `${new URL(site.url).hostname}: ${result.reason ?? 'not signed in'}; run: bun run account open ${site.url}`;
}

async function drainResponse(queue: ChunkQueue) {
  for (let chunk = await queue.next(5_000); chunk instanceof Uint8Array; chunk = await queue.next(5_000));
}

class ChunkQueue {
  private readonly items: Array<Uint8Array | null> = [];
  private waiter?: () => void;

  push(item: Uint8Array | null) {
    this.items.push(item);
    this.waiter?.();
  }

  async next(timeoutMs?: number): Promise<Uint8Array | null | 'timeout'> {
    if (!this.items.length) {
      await new Promise<void>(resolve => {
        this.waiter = resolve;
        if (timeoutMs !== undefined) setTimeout(resolve, timeoutMs);
      });
      this.waiter = undefined;
    }
    return this.items.length ? this.items.shift()! : 'timeout';
  }
}

export class BrowserChatSession {
  private browser?: Promise<CdpBrowser>;
  private closing?: Promise<void>;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly lastSent = new Map<string, number>();
  private readonly pageQueues = new Map<Page, ChunkQueue>();
  private readonly threads = new Map<string, ChatThread[]>();

  constructor(private readonly options: BrowserChatOptions = {}) {}

  private cdp() {
    if (this.browser) return this.browser;
    const launch = this.options.launch ?? launchCdpBrowser;
    const launched: Promise<CdpBrowser> = (this.closing ?? Promise.resolve()).then(() => launch({
      profileDir: this.options.profileDir ?? googleProfileDir(),
      headless: this.options.headless ?? true,
    })).then(cdp => {
      const forget = () => this.forget(launched, cdp);
      cdp.browser.on('disconnected', forget);
      cdp.exited.then(forget);
      return cdp;
    }).catch(error => {
      if (this.browser === launched) this.browser = undefined;
      throw error;
    });
    this.browser = launched;
    return launched;
  }

  private forget(launched: Promise<CdpBrowser>, cdp: CdpBrowser) {
    if (this.browser !== launched) return;
    this.browser = undefined;
    this.closing = cdp.close().catch(() => {});
  }

  private async context() {
    const current = this.cdp();
    let cdp = await current;
    if (!cdp.browser.isConnected() || !cdp.browser.contexts()[0]) {
      this.forget(current, cdp);
      cdp = await this.cdp();
    }
    const context = cdp.browser.contexts()[0];
    if (!context) throw new ProviderError('Browser profile has no default context', 'unavailable');
    return context;
  }

  async close() {
    const browser = await this.browser?.catch(() => undefined);
    this.browser = undefined;
    this.threads.clear();
    this.pageQueues.clear();
    await browser?.close();
  }

  signIn(site: ChatSite, options: SiteLoginOptions = {}): Promise<AutoLoginResult> {
    return this.withSiteLock(site.id, async () => {
      const { attemptSite } = await import('./auto-login.ts');
      const context = await this.context();
      const page = await context.newPage();
      try {
        return await attemptSite(page, site, options);
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  async solveVerification(site: ChatSite): Promise<void> {
    let created: Page | undefined;
    try {
      let page = (this.threads.get(site.id) ?? []).find(thread => !thread.page.isClosed())?.page;
      if (!page) {
        const context = await this.context();
        page = created = await context.newPage();
        await page.goto(site.authUrl ?? site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
        await Bun.sleep(2_000);
      }
      const deadline = Date.now() + 12_000;
      for (;;) {
        await autoSolveCaptcha(page, site.captcha);
        const verification = site.verificationText;
        const visible = verification
          ? await page.getByText(verification).first().isVisible().catch(() => false)
          : false;
        if (!visible) return;
        if (Date.now() >= deadline) return;
        await Bun.sleep(1_000);
      }
    } catch {} finally {
      await created?.close().catch(() => {});
    }
  }

  private withSiteLock<T>(siteId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(siteId) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(siteId, previous.then(() => done));
    return previous.then(async () => {
      try {
        return await run();
      } finally {
        release();
      }
    });
  }

  send(site: ChatSite, prompt: string, model?: string, conversation?: SendContext): Promise<AsyncGenerator<Uint8Array>> {
    const previous = this.queues.get(site.id) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(site.id, previous.then(() => done));
    return previous.then(async () => {
      try {
        await this.pace(site.id);
        const { page, queue } = await this.prepare(site, prompt, model, conversation);
        return this.stream(site, { page, queue }, release);
      } catch (error) {
        release();
        throw error;
      }
    });
  }

  private async pace(siteId: string) {
    const wait = (this.lastSent.get(siteId) ?? -Infinity) + (this.options.minIntervalMs ?? 0) - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    this.lastSent.set(siteId, Date.now());
  }

  private async prepare(site: ChatSite, prompt: string, model?: string, conversation?: SendContext) {
    const thread = this.matchThread(site, model, conversation);
    if (thread) {
      try {
        return await this.resumeThread(thread, site, conversation!);
      } catch {
        this.dropThread(site.id, thread);
      }
    }
    return this.openPage(site, prompt, model, conversation);
  }

  private matchThread(site: ChatSite, model: string | undefined, conversation?: SendContext): ChatThread | undefined {
    const list = this.threads.get(site.id) ?? [];
    const alive: ChatThread[] = [];
    const stale: ChatThread[] = [];
    let matched: ChatThread | undefined;
    const hasConversationId = Boolean(conversation?.conversationId);
    for (const thread of list) {
      if (thread.page.isClosed() || Date.now() - thread.lastUsed > THREAD_IDLE_MS) {
        stale.push(thread);
        continue;
      }
      alive.push(thread);
      const modelMatches = thread.model === model;
      const conversationIdMatches = !thread.conversationId || !hasConversationId || thread.conversationId === conversation?.conversationId;
      const historyMatches = isHistoryPrefix(thread.sent, conversation?.messages);
      if (!matched && modelMatches && conversationIdMatches && historyMatches) {
        matched = thread;
      }
    }
    if (!matched && site.reuseThread !== false && !hasConversationId) {
      for (const thread of alive) {
        if (!thread.conversationId && thread.model === model && (!matched || thread.lastUsed > matched.lastUsed)) {
          matched = thread;
        }
      }
    }
    for (const thread of stale) {
      this.pageQueues.delete(thread.page);
      thread.page.close().catch(() => {});
    }
    this.threads.set(site.id, alive);
    return matched;
  }

  private registerThread(siteId: string, thread: ChatThread) {
    const list = this.threads.get(siteId) ?? [];
    list.push(thread);
    this.threads.set(siteId, list);
    while (list.length > MAX_THREADS_PER_SITE) {
      let oldest = list[0]!;
      for (const entry of list) if (entry.lastUsed < oldest.lastUsed) oldest = entry;
      this.dropThread(siteId, oldest);
    }
  }

  private dropThread(siteId: string, thread: ChatThread) {
    const list = this.threads.get(siteId) ?? [];
    const index = list.indexOf(thread);
    if (index >= 0) list.splice(index, 1);
    this.pageQueues.delete(thread.page);
    thread.page.close().catch(() => {});
  }

  private async resumeThread(thread: ChatThread, site: ChatSite, conversation: SendContext) {
    const messages = conversation.messages!;
    let delta = isHistoryPrefix(thread.sent, messages) ? messages.slice(thread.sent.length) : messages;
    if (!delta.length) {
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'user') throw new Error(`${site.id} thread cannot continue`);
      delta = [last];
    }
    if (thread.page.isClosed() || !conversation.toPrompt) {
      throw new Error(`${site.id} thread cannot continue`);
    }
    const queue = new ChunkQueue();
    this.pageQueues.set(thread.page, queue);
    thread.sent = messages.slice();
    thread.lastUsed = Date.now();
    const images = conversation.extractImages?.(delta) ?? [];
    await thread.page.evaluate(urls => {
      (window as unknown as Record<string, unknown>).__freeapiImages = urls;
    }, site.attachImages ? [] : images);
    if (site.attachImages && images.length) await site.attachImages(thread.page, await toAttachFiles(images));
    const input = thread.page.locator(site.inputSelector).first();
    await input.waitFor({ timeout: 30_000 });
    await input.fill('');
    await input.click();
    await humanType(thread.page, conversation.toPrompt(delta));
    await submitPrompt(thread.page, input, site.responseUrl);
    return { page: thread.page, queue };
  }

  private finishThread(siteId: string, page: Page) {
    this.pageQueues.delete(page);
    const thread = (this.threads.get(siteId) ?? []).find(entry => entry.page === page);
    if (thread) {
      thread.lastUsed = Date.now();
      return;
    }
    page.close().catch(() => {});
  }

  private watchModels(site: ChatSite, page: Page) {
    const report = (models: WebChatModel[]) => {
      if (models.length) this.options.onModels?.(site.id, models);
    };
    if (site.modelsResponse && site.parseModels) {
      const pattern = site.modelsResponse;
      const parse = site.parseModels;
      page.waitForResponse(response => pattern.test(response.url()) && response.ok(), { timeout: 30_000 })
        .then(response => response.json())
        .then(body => report(parse(body)))
        .catch(() => {});
    }
    return () => {
      if (site.pageModels) site.pageModels(page).then(report).catch(() => {});
    };
  }

  private async openPage(site: ChatSite, prompt: string, model?: string, conversation?: SendContext) {
    const context = await this.context();
    const page = await context.newPage();
    const queue = new ChunkQueue();
    this.pageQueues.set(page, queue);
    await page.exposeFunction(BINDING, (chunk: string | null) => {
      this.pageQueues.get(page)?.push(chunk === null ? null : Buffer.from(chunk, 'base64'));
    });
    const fields = model && site.modelFields ? site.modelFields(model) : undefined;
    const images = conversation?.extractImages?.(conversation.messages ?? []) ?? [];
    const attached = site.attachImages && images.length ? await toAttachFiles(images) : [];
    await page.addInitScript(teeScript, {
      pattern: site.responseUrl.source,
      binding: BINDING,
      ...(fields ? { fields } : {}),
      ...(!site.attachImages && images.length ? { images } : {}),
    });
    const readPageModels = this.options.onModels ? this.watchModels(site, page) : () => {};
    try {
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      readPageModels();
      if (site.signIn) {
        const signIn = await readSignIn(page, site.signIn);
        this.options.onSignIn?.(site.id, signIn);
        if (!signIn.signedIn) throw new ProviderError(notSignedIn(site, signIn), 'auth');
      }
      const captcha = await autoSolveCaptcha(page, site.captcha);
      if (captcha === 'solved') await Bun.sleep(500);
      if (captcha === 'failed' && site.verificationText
        && await page.getByText(site.verificationText).first().isVisible().catch(() => false)) {
        throw new ProviderError(`${site.id} asks for a security verification; complete it in the browser window`, 'unavailable');
      }
      const input = page.locator(site.inputSelector).first();
      await input.waitFor({ timeout: 30_000 });
      if (attached.length && site.attachImages) await site.attachImages(page, attached);
      await input.fill('');
      await input.click();
      await humanType(page, prompt);
      await submitPrompt(page, input, site.responseUrl);
      if (conversation?.messages?.length) {
        this.registerThread(site.id, {
          page,
          model,
          conversationId: conversation.conversationId,
          sent: conversation.messages.slice(),
          lastUsed: Date.now(),
        });
      }
      return { page, queue };
    } catch (error) {
      this.pageQueues.delete(page);
      await page.close().catch(() => {});
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(`${site.id} chat page is not ready: ${error instanceof Error ? error.message : error}`, 'unavailable');
    }
  }

  private async *stream(site: ChatSite, prepared: { page: Page; queue: ChunkQueue }, release: () => void): AsyncGenerator<Uint8Array> {
    const { page, queue } = prepared;
    let deadline = Date.now() + (this.options.firstChunkTimeoutMs ?? 60_000);
    let challenged = false;
    let verificationAttempted = false;
    let clean = false;
    let failed = false;
    const verification = site.verificationText;
    try {
      let first: Uint8Array | null | 'timeout' = 'timeout';
      while (first === 'timeout') {
        if (Date.now() > deadline) {
          throw new ProviderError(challenged
            ? `${site.id} asked for a security verification that was not completed in time; complete it in the browser window and retry`
            : `${site.id} did not answer in time`, 'unavailable');
        }
        if (verification && await page.getByText(verification).first().isVisible().catch(() => false)) {
          if (!verificationAttempted) {
            verificationAttempted = true;
            const outcome = await autoSolveCaptcha(page, site.captcha);
            if (outcome === 'solved') {
              deadline = Math.max(deadline, Date.now() + 30_000);
              await Bun.sleep(1_000);
              if (!(await page.getByText(verification).first().isVisible().catch(() => false))) continue;
            }
          }
          throw new ProviderError(`${site.id} asks for a security verification; complete it in the browser window`, 'unavailable');
        }
        first = await queue.next(500);
        if (first instanceof Uint8Array && site.ignoredResponse?.test(new TextDecoder().decode(first))) {
          await drainResponse(queue);
          first = 'timeout';
          continue;
        }
        if (first instanceof Uint8Array && site.challengeResponse?.test(new TextDecoder().decode(first))) {
          if (!challenged) {
            challenged = true;
            deadline = Math.max(deadline, Date.now() + CHALLENGE_GRACE_MS);
            await autoSolveCaptcha(page, site.captcha);
          }
          await drainResponse(queue);
          first = 'timeout';
        }
      }
      if (first === null) {
        clean = true;
        return;
      }
      yield first;
      for (;;) {
        const chunk = await queue.next(this.options.idleTimeoutMs ?? 120_000);
        if (chunk === 'timeout') throw new ProviderError(`${site.id} stopped streaming`, 'upstream');
        if (chunk === null) {
          clean = true;
          return;
        }
        yield chunk;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (!clean && !failed) {
        const budget = Date.now() + 2_000;
        while (Date.now() < budget) {
          const tail = await queue.next(Math.max(1, budget - Date.now()));
          if (tail === null) {
            clean = true;
            break;
          }
          if (tail === 'timeout') break;
        }
      }
      release();
      this.finishThread(site.id, page);
    }
  }
}
