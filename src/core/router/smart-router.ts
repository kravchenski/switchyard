import { ProviderError, type ProviderErrorKind } from '../providers/errors.ts';
import type { ChatChunk, ChatRequest, Provider, ProviderStream } from '../providers/provider.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { primeChunks } from '../streaming/sse.ts';
import type { RouteAttempt, RoutingDecision, SkippedRoute } from './decisions.ts';
import type { AutoMode } from './focus.ts';
import { modelStrength } from '../models/strength.ts';

export const AUTO_MODEL = 'auto';
export const VISION_MODEL = 'vision';
export const AGENT_MODEL = 'agent';
export const VIRTUAL_MODELS = [AUTO_MODEL, VISION_MODEL, AGENT_MODEL] as const;
export type VirtualModel = typeof VIRTUAL_MODELS[number];

export function isVirtualModel(model: string): model is VirtualModel {
  return (VIRTUAL_MODELS as readonly string[]).includes(model);
}

const PROVIDER_COOLDOWN_MS = 30_000;
const NOT_MODEL_FAULTS: ProviderErrorKind[] = ['rate_limit', 'quota_exhausted', 'auth', 'unavailable', 'invalid_request'];
const MODEL_TIMEOUT_COOLDOWN_MS = 10 * 60_000;

export interface SmartRouterOptions {
  firstChunkTimeoutMs?: number;
  autoEnabled?: (providerId: string) => boolean;
  autoMode?: () => AutoMode;
  choose?: (prompt: string, routes: Route[]) => Promise<string | undefined>;
  raceWidth?: number;
  prepareAuto?: () => void;
  onDecision?: (decision: Omit<RoutingDecision, 'id'>) => void;
}

const DEFAULT_RACE_WIDTH = 3;

export interface Route {
  provider: Provider;
  model: string;
}

export interface RoutedStream extends ProviderStream {
  route: Route;
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

  private decide(model: string, mode: RoutingDecision['mode'], preferredModel: string | undefined, skipped: SkippedRoute[], attempts: RouteAttempt[], chosen?: Route, error?: unknown, picked?: string, decisionMs?: number, decisionError?: string, details?: Record<string, unknown>) {
    this.options.onDecision?.({
      ...(details ? { details } : {}),
      at: this.now(),
      requestedModel: model,
      mode,
      ...(preferredModel ? { preferredModel } : {}),
      ...(picked ? { picked } : {}),
      ...(decisionMs !== undefined ? { decisionMs } : {}),
      ...(decisionError ? { decisionError } : {}),
      skipped,
      attempts,
      ...(chosen ? { chosen: { model: chosen.model, provider: chosen.provider.id } } : {}),
      ...(error ? { error: errorText(error) } : {}),
    });
  }

  async open(model: string, build: (route: Route) => ChatRequest, preferredModel?: string, details?: Record<string, unknown>, options: { nativeToolsFirst?: boolean } = {}): Promise<RoutedStream> {
    const skipped: SkippedRoute[] = [];
    let routes = this.routes(model, preferredModel, skipped);
    const virtual = isVirtualModel(model);
    if (virtual && options.nativeToolsFirst) {
      const native = routes
        .filter(route => route.provider.capabilities(route.model).nativeTools)
        .map((route, order) => ({ route, order, strength: modelStrength(route.model) }))
        .sort((a, b) => a.strength - b.strength || a.order - b.order)
        .map(entry => entry.route);
      routes = [...native, ...routes.filter(route => !native.includes(route))];
    }
    const autoMode = virtual && routes.length > 1 ? this.options.autoMode?.() : undefined;
    const mode: RoutingDecision['mode'] = !virtual ? 'direct'
      : autoMode === 'race' ? 'race'
      : autoMode === 'decide' && this.options.choose ? 'decide'
      : 'fallback';
    if (!routes.length) {
      const error = new ProviderError(`No available provider for model ${model}`, 'unavailable');
      this.decide(model, mode, preferredModel, skipped, [], undefined, error, undefined, undefined, undefined, details);
      throw error;
    }
    const failures: string[] = [];
    const attempts: RouteAttempt[] = [];
    const finish = (route: Route, result: { stream: ProviderStream; chunks: Awaited<ReturnType<typeof primeChunks>> }, picked?: string, decisionMs?: number, decisionError?: string): RoutedStream => {
      this.decide(model, mode, preferredModel, skipped, attempts, route, undefined, picked, decisionMs, decisionError, details);
      return { ...result.stream, chunks: result.chunks, route };
    };
    const fail = (error: unknown, picked?: string, decisionMs?: number, decisionError?: string): never => {
      this.decide(model, mode, preferredModel, skipped, attempts, undefined, error, picked, decisionMs, decisionError, details);
      throw error;
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
    if (mode === 'race') {
      const contenders = routes.filter(route => route.provider.fallback).slice(0, this.options.raceWidth ?? DEFAULT_RACE_WIDTH);
      const won = await this.race(contenders, build, attempts, failures);
      if (won) return finish(won.route, won);
      const rest = await this.sequential(routes.filter(route => !contenders.includes(route)), build, attempts, failures, false);
      if (rest) return finish(rest.route, rest);
      return fail(new ProviderError(`All routes failed for model ${model}: ${failures.join('; ')}`, 'unavailable'));
    }
    let picked: string | undefined;
    let decisionMs: number | undefined;
    let decisionError: string | undefined;
    if (mode === 'decide') {
      const decisionStarted = this.now();
      picked = await this.options.choose!(promptOf(build(routes[0]!).messages), routes).catch(error => {
        decisionError = errorText(error);
        return undefined;
      });
      decisionMs = this.now() - decisionStarted;
      if (picked) routes = [...routes.filter(route => route.model === picked), ...routes.filter(route => route.model !== picked)];
    }
    const won = await this.sequential(routes, build, attempts, failures, false);
    if (won) return finish(won.route, won, picked, decisionMs, decisionError);
    return fail(new ProviderError(`All routes failed for model ${model}: ${failures.join('; ')}`, 'unavailable'), picked, decisionMs, decisionError);
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

  private async race(contenders: Route[], build: (route: Route) => ChatRequest, attempts: RouteAttempt[], failures: string[]) {
    if (!contenders.length) return undefined;
    const controllers = contenders.map(() => new AbortController());
    const outcomes = new Map<number, RouteAttempt>();
    const startedAt = this.now();
    let settled = false;
    const racing = contenders.map((route, index) => this.attempt(route, build, controllers[index]!, this.options.firstChunkTimeoutMs).then(
      result => {
        if (settled) {
          void result.chunks.return(undefined);
          throw new Error('lost the race');
        }
        settled = true;
        return { ...result, route, index };
      },
      error => {
        if (!settled) {
          this.recordFailure(route, error, true);
          outcomes.set(index, failedAttempt(route, error, this.now() - startedAt));
          failures.push(`${route.model}: ${errorText(error)}`);
        }
        throw error;
      },
    ));
    try {
      const winner = await Promise.any(racing);
      controllers.forEach((controller, index) => { if (index !== winner.index) controller.abort(); });
      this.succeeded(winner.route, winner.latencyMs);
      outcomes.set(winner.index, { model: winner.route.model, provider: winner.route.provider.id, outcome: 'chosen', latencyMs: winner.latencyMs });
      attempts.push(...contenders.map((route, index) => outcomes.get(index) ?? { model: route.model, provider: route.provider.id, outcome: 'lost' as const }));
      return { stream: winner.stream, chunks: winner.chunks, route: winner.route };
    } catch {
      attempts.push(...contenders.map((route, index) => outcomes.get(index) ?? { model: route.model, provider: route.provider.id, outcome: 'failed' as const }));
      return undefined;
    }
  }

}

export function promptOf(messages: Array<Record<string, unknown>>) {
  const last = [...messages].reverse().find(message => message.role === 'user');
  const content = last?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('\n');
  return '';
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
