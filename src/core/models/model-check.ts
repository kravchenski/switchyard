import { ProviderError } from '../providers/errors.ts';
import type { Provider } from '../providers/provider.ts';
import type { ModelAvailability } from './availability.ts';
import type { ModelStats } from './stats.ts';

export interface ModelCheckResult {
  model: string;
  ok: boolean;
  hidden?: boolean;
  latencyMs?: number;
  error?: string;
}

export interface ModelCheckReport {
  provider: string;
  results: ModelCheckResult[];
  stopped?: string;
  skipped?: string;
}

export interface ModelCheckOptions {
  timeoutMs?: number;
  concurrency?: number;
  now?: () => number;
  /** Also hide models that time out or fail, not only those the key cannot use. Rate limits and auth errors never hide a model. */
  hideFailing?: boolean;
  onResult?: (result: ModelCheckResult) => void;
}

const PROMPT = 'Reply with one word: ok';
const LIMIT_KINDS = new Set(['rate_limit', 'quota_exhausted']);
const LIMITS_BEFORE_STOP = 3;
// A short rate limit is waited out during a check; a key that cools down this long is treated as spent.
const SHORT_LIMIT_SECONDS = 30;
const SPENT_KEY_SECONDS = 600;
const RETRIES_PER_MODEL = 2;

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

async function firstChunk(provider: Provider, model: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ProviderError(`no answer within ${Math.round(timeoutMs / 1000)}s`, 'unavailable')), timeoutMs);
  try {
    const { chunks } = await provider.stream({ model, messages: [{ role: 'user', content: PROMPT }] }, { signal: controller.signal });
    const iterator = chunks[Symbol.asyncIterator]();
    try {
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
      ]);
      if (next.done) throw new ProviderError('empty answer', 'upstream');
    } finally {
      await iterator.return?.();
    }
  } catch (error) {
    throw controller.signal.aborted && !(error instanceof ProviderError) ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function checkProviderModels(
  provider: Provider,
  models: string[],
  track: { availability: ModelAvailability; stats: ModelStats },
  options: ModelCheckOptions = {},
): Promise<ModelCheckReport> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const results: ModelCheckResult[] = [];
  const report = (result: ModelCheckResult) => {
    results.push(result);
    options.onResult?.(result);
  };
  const queue = [...models];
  let stopped: string | undefined;
  let stoppedKind: string | undefined;
  let stoppedRetryAfter: number | undefined;
  let limitsInARow = 0;
  const retries = new Map<string, number>();
  track.availability.clear(models);

  async function worker() {
    for (let model = queue.shift(); model !== undefined && !stopped; model = queue.shift()) {
      const startedAt = now();
      try {
        await firstChunk(provider, model, timeoutMs);
        const latencyMs = now() - startedAt;
        track.stats.recordSuccess(model, latencyMs);
        report({ model, ok: true, latencyMs });
        limitsInARow = 0;
      } catch (error) {
        const message = errorText(error);
        if (error instanceof ProviderError && error.kind === 'model_unavailable') {
          track.availability.markUnavailable(model, message);
          report({ model, ok: false, hidden: true, error: message });
        } else if (error instanceof ProviderError && error.kind === 'auth') {
          if (!stopped) stoppedKind = error.kind;
          stopped ??= message;
          queue.unshift(model);
        } else if (error instanceof ProviderError && LIMIT_KINDS.has(error.kind) && error.retryAfterSeconds !== undefined
          && error.retryAfterSeconds <= SHORT_LIMIT_SECONDS && (retries.get(model) ?? 0) < RETRIES_PER_MODEL) {
          retries.set(model, (retries.get(model) ?? 0) + 1);
          await new Promise(resolve => setTimeout(resolve, Math.max(error.retryAfterSeconds!, 1) * 1000));
          queue.push(model);
        } else if (error instanceof ProviderError && LIMIT_KINDS.has(error.kind) && ++limitsInARow >= LIMITS_BEFORE_STOP) {
          if (!stopped) {
            stoppedKind = error.kind;
            stoppedRetryAfter = error.retryAfterSeconds;
          }
          stopped ??= message;
          report({ model, ok: false, error: message });
        } else {
          const limited = error instanceof ProviderError && LIMIT_KINDS.has(error.kind);
          if (!limited) limitsInARow = 0;
          track.stats.recordFailure(model);
          const hide = options.hideFailing && !limited;
          if (hide) track.availability.markUnavailable(model, message);
          report({ model, ok: false, ...(hide ? { hidden: true } : {}), error: message });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 2) }, worker));
  // A provider that stopped on its key or balance, or has no usable key left, cannot serve any of its models now.
  const spent = stoppedKind === 'auth' || stoppedKind === 'quota_exhausted' || (stoppedRetryAfter ?? 0) >= SPENT_KEY_SECONDS;
  if (options.hideFailing && stopped && spent) {
    const answered = new Set(results.filter(result => result.ok).map(result => result.model));
    const reason = `provider unusable: ${stopped}`.slice(0, 200);
    for (const model of models) {
      if (answered.has(model)) continue;
      track.availability.markUnavailable(model, reason);
      const existing = results.find(result => result.model === model);
      if (existing) existing.hidden = true;
      else report({ model, ok: false, hidden: true, error: reason });
    }
  }
  return { provider: provider.id, results, ...(stopped ? { stopped } : {}) };
}

export interface AllModelsCheckOptions {
  timeoutMs?: number;
  /** Parallel requests per API provider; browser chat providers always go one at a time. */
  concurrency?: number;
  /** Browser chat providers are slow to check, so they are left out unless asked for. */
  includeWeb?: boolean;
  providers?: string[];
  onResult?: (provider: string, result: ModelCheckResult) => void;
}

const isWebProvider = (provider: Provider) => provider.ownedBy.endsWith('-web');

/** Checks every model of every provider at once, hiding the ones that do not answer. */
export async function checkAllModels(
  providers: readonly Provider[],
  track: { availability: ModelAvailability; stats: ModelStats },
  options: AllModelsCheckOptions = {},
): Promise<ModelCheckReport[]> {
  const selected = providers.filter(provider =>
    (!options.providers?.length || options.providers.includes(provider.id)) && (options.includeWeb || !isWebProvider(provider)));
  return Promise.all(selected.map(async (provider): Promise<ModelCheckReport> => {
    const health = provider.health();
    if (!health.available) return { provider: provider.id, results: [], skipped: health.reason ?? 'provider is not available' };
    let models: string[];
    try {
      models = await provider.listModels();
    } catch (error) {
      return { provider: provider.id, results: [], skipped: `could not list models: ${errorText(error)}` };
    }
    return checkProviderModels(provider, models, track, {
      timeoutMs: options.timeoutMs,
      concurrency: isWebProvider(provider) ? 1 : options.concurrency ?? 8,
      hideFailing: true,
      onResult: result => options.onResult?.(provider.id, result),
    });
  }));
}
