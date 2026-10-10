import { ProviderError, type ProviderErrorKind } from '../providers/errors.ts';
import type { ChatChunk, ChatRequest, Provider, ProviderStream } from '../providers/provider.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { primeChunks } from '../streaming/sse.ts';
import type { RouteAttempt, RoutingDecision, SkippedRoute } from './decisions.ts';

export const AUTO_MODEL = 'auto';
export const VISION_MODEL = 'vision';
export const AGENT_MODEL = 'agent';
const VIRTUAL_MODELS = [AUTO_MODEL, VISION_MODEL, AGENT_MODEL] as const;
export type VirtualModel = typeof VIRTUAL_MODELS[number];

export function isVirtualModel(model: string): model is VirtualModel {
  return (VIRTUAL_MODELS as readonly string[]).includes(model);
}

export function chainFor(model: string, request: { images: boolean; tools: boolean }, ready: (chain: VirtualModel) => boolean) {
  if (!isVirtualModel(model)) return model;
  if (request.images && ready(VISION_MODEL)) return VISION_MODEL;
  if (request.tools && ready(AGENT_MODEL)) return AGENT_MODEL;
  return AUTO_MODEL;
}

const PROVIDER_COOLDOWN_MS = 30_000;
const NOT_MODEL_FAULTS: ProviderErrorKind[] = ['rate_limit', 'quota_exhausted', 'auth', 'unavailable', 'invalid_request'];
const MODEL_TIMEOUT_COOLDOWN_MS = 10 * 60_000;

export interface SmartRouterOptions {
  firstChunkTimeoutMs?: number;
  autoEnabled?: (providerId: string) => boolean;
  prepareAuto?: () => void;
  onDecision?: (decision: Omit<RoutingDecision, 'id'>) => number | void;
}

export interface Route {
  provider: Provider;
  model: string;
}

export interface RoutedStream extends ProviderStream {
  route: Route;
  decisionId?: number;
}

export function decisionIdOf(error: unknown) {
  return error && typeof error === 'object' && 'decisionId' in error && typeof error.decisionId === 'number' ? error.decisionId : undefined;
}

class FirstChunkTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number | undefined, onTimeout: () => void) {
  if (!ms) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new FirstChunkTimeout(`no response within ${ms} ms`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export class SmartRouter {
  private readonly cooldownUntil = new Map<string, number>();
  private readonly modelCooldownUntil = new Map<string, number>();
  private readonly chains = new Map<VirtualModel, string[]>();

  constructor(
    private readonly registry: ProviderRegistry,
    autoModels: string[] = [],
    private readonly now: () => number = Date.now,
    private readonly options: SmartRouterOptions = {},
  ) {
    this.chains.set(AUTO_MODEL, [...autoModels]);
  }

  setAutoModels(models: string[]) {
    if (models.length) this.chains.set(AUTO_MODEL, [...models]);
  }

  setChain(model: VirtualModel, models: string[]) {
    if (model === AUTO_MODEL) this.setAutoModels(models);
    else this.chains.set(model, [...models]);
  }

  autoChain(model: VirtualModel = AUTO_MODEL): readonly string[] {
    return this.chains.get(model) ?? [];
  }

  knows(model: string) {
    return isVirtualModel(model) || Boolean(this.registry.resolve(model));
  }

  routes(model: string, preferredModel?: string, skipped: SkippedRoute[] = []): Route[] {
    if (!isVirtualModel(model)) {
      const provider = this.registry.resolve(model);
      return provider ? [{ provider, model }] : [];
    }
    this.options.prepareAuto?.();
    const now = this.now();
    const chain = this.autoChain(model);
    const candidates = preferredModel && chain.includes(preferredModel)
      ? [preferredModel, ...chain.filter(candidate => candidate !== preferredModel)]
      : chain;
    const skip = (candidate: string, reason: string) => {
      skipped.push({ model: candidate, reason });
      return [];
    };
    return candidates.flatMap(candidate => {
      const provider = this.registry.resolve(candidate);
      if (!provider) return skip(candidate, 'no provider serves this model');
      const health = provider.health();
      if (!health.available) return skip(candidate, `${provider.id} unavailable${health.reason ? `: ${health.reason}` : ''}`);
      if (this.options.autoEnabled && !this.options.autoEnabled(provider.id)) return skip(candidate, `${provider.id} is off in auto`);
      if (!this.registry.availability.isAvailable(candidate)) return skip(candidate, 'model is not available for this key');
      if ((this.cooldownUntil.get(provider.id) ?? 0) > now) return skip(candidate, `${provider.id} cooling down after an error`);
      if ((this.modelCooldownUntil.get(candidate) ?? 0) > now) return skip(candidate, 'model cooling down after a timeout');
      return [{ provider, model: candidate }];
    });
  }

  private async attempt(route: Route, build: (route: Route) => ChatRequest, controller: AbortController, timeoutMs: number | undefined) {
    const startedAt = this.now();
    const pending = (async () => {
      const stream = await route.provider.stream(build(route), { signal: controller.signal });
      return { stream, chunks: await primeChunks(stream.chunks) };
    })();
    const result = await withTimeout(pending, timeoutMs, () => {
      controller.abort();
      pending.then(late => late.chunks.return(undefined), () => undefined);
    });
    return { ...result, latencyMs: this.now() - startedAt };
  }

  private succeeded(route: Route, latencyMs: number) {
    this.cooldownUntil.delete(route.provider.id);
    this.registry.stats.recordSuccess(route.model, latencyMs);
  }

  private recordFailure(route: Route, error: unknown, coolDown: boolean) {
    const modelMissing = error instanceof ProviderError && error.kind === 'model_unavailable';
    if (!(error instanceof ProviderError && NOT_MODEL_FAULTS.includes(error.kind))) this.registry.stats.recordFailure(route.model);
    if (modelMissing) this.registry.availability.markUnavailable(route.model, error.message);
    if (!coolDown) return;
    if (error instanceof FirstChunkTimeout) this.modelCooldownUntil.set(route.model, this.now() + MODEL_TIMEOUT_COOLDOWN_MS);
    else if (!modelMissing) this.cooldownUntil.set(route.provider.id, this.now() + PROVIDER_COOLDOWN_MS);
  }

  private decide(model: string, mode: RoutingDecision['mode'], preferredModel: string | undefined, skipped: SkippedRoute[], attempts: RouteAttempt[], chosen?: Route, error?: unknown, details?: Record<string, unknown>) {
    return this.options.onDecision?.({
      ...(details ? { details } : {}),
      at: this.now(),
      requestedModel: model,
      mode,
      ...(preferredModel ? { preferredModel } : {}),
      skipped,
      attempts,
      ...(chosen ? { chosen: { model: chosen.model, provider: chosen.provider.id } } : {}),
      ...(error ? { error: errorText(error) } : {}),
    });
  }

  async open(model: string, build: (route: Route) => ChatRequest, preferredModel?: string, details?: Record<string, unknown>): Promise<RoutedStream> {
    const skipped: SkippedRoute[] = [];
    let routes = this.routes(model, preferredModel, skipped);
    const virtual = isVirtualModel(model);
    const mode: RoutingDecision['mode'] = virtual ? 'fallback' : 'direct';
    if (!routes.length) {
      const error = new ProviderError(`No available provider for model ${model}`, 'unavailable');
      throw withDecision(error, this.decide(model, mode, preferredModel, skipped, [], undefined, error, details));
    }
    const failures: string[] = [];
    const attempts: RouteAttempt[] = [];
    const finish = (route: Route, result: { stream: ProviderStream; chunks: Awaited<ReturnType<typeof primeChunks>> }): RoutedStream => {
      const decisionId = this.decide(model, mode, preferredModel, skipped, attempts, route, undefined, details);
      return { ...result.stream, chunks: result.chunks, route, ...(typeof decisionId === 'number' ? { decisionId } : {}) };
    };
    const fail = (error: unknown): never => {
      throw withDecision(error, this.decide(model, mode, preferredModel, skipped, attempts, undefined, error, details));
    };
    if (routes.length === 1) {
      const won = await this.sequential(routes, build, attempts, failures, true).catch(error => fail(error));
      return finish(won!.route, won!);
    }
    const pinned = virtual && preferredModel && routes[0]?.model === preferredModel ? routes[0] : undefined;
    if (pinned) {
      const won = await this.sequential([pinned], build, attempts, failures, false);
      if (won) return finish(won.route, won);
      routes = routes.slice(1);
    }
    const won = await this.sequential(routes, build, attempts, failures, false);
    if (won) return finish(won.route, won);
    return fail(new ProviderError(`All routes failed for model ${model}: ${failures.join('; ')}`, 'unavailable'));
  }

  private async sequential(routes: Route[], build: (route: Route) => ChatRequest, attempts: RouteAttempt[], failures: string[], only: boolean) {
    for (const route of routes) {
      // A direct (single-route) open gets one extra chance: browser chats
      // often fail transiently on a cold start (page not hydrated yet, model
      // list still loading) and a fresh attempt re-opens the page warm.
      const tries = only ? 2 : 1;
      for (let tryIndex = 1; ; tryIndex++) {
        const startedAt = this.now();
        try {
          const { stream, chunks, latencyMs } = await this.attempt(route, build, new AbortController(), only ? undefined : this.options.firstChunkTimeoutMs);
          this.succeeded(route, latencyMs);
          attempts.push({ model: route.model, provider: route.provider.id, outcome: 'chosen', latencyMs });
          return { stream, chunks, route };
        } catch (error) {
          attempts.push(failedAttempt(route, error, this.now() - startedAt));
          if (tryIndex < tries && error instanceof ProviderError && error.kind === 'unavailable') continue;
          this.recordFailure(route, error, !only);
          if (only) throw error;
          failures.push(`${route.model}: ${errorText(error)}`);
          break;
        }
      }
    }
    return undefined;
  }
}

function withDecision(error: unknown, decisionId: number | void) {
  if (typeof decisionId === 'number' && error && typeof error === 'object') Object.assign(error, { decisionId });
  return error;
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function failedAttempt(route: Route, error: unknown, latencyMs: number): RouteAttempt {
  return { model: route.model, provider: route.provider.id, outcome: error instanceof FirstChunkTimeout ? 'timeout' : 'failed', latencyMs, error: errorText(error) };
}

export function parseAutoModels(value: string | undefined) {
  const models = (value ?? '').split(',').map(model => model.trim()).filter(Boolean);
  return models;
}
