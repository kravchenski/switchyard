type RouteOutcome = 'chosen' | 'failed' | 'timeout';

export interface RouteAttempt {
  model: string;
  provider: string;
  outcome: RouteOutcome;
  latencyMs?: number;
  error?: string;
}

export interface SkippedRoute {
  model: string;
  reason: string;
}

export interface RoutingDecision {
  id: number;
  at: number;
  requestedModel: string;
  mode: 'direct' | 'fallback';
  details?: Record<string, unknown>;
  preferredModel?: string;
  skipped: SkippedRoute[];
  attempts: RouteAttempt[];
  chosen?: { model: string; provider: string };
  error?: string;
}

const DEFAULT_LIMIT = 200;

export class DecisionLog {
  private readonly entries: RoutingDecision[] = [];
  private nextId: number;

  constructor(private readonly limit = DEFAULT_LIMIT, firstId = 1) {
    this.nextId = firstId;
  }

  add(decision: Omit<RoutingDecision, 'id'>) {
    const id = this.nextId++;
    this.entries.push({ ...decision, id });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    return id;
  }

  get(id: number) {
    return this.entries.find(entry => entry.id === id);
  }

  list(limit = 50, model?: string): RoutingDecision[] {
    return this.entries
      .filter(entry => !model || entry.requestedModel === model || entry.chosen?.model === model)
      .slice(-Math.max(1, limit))
      .reverse();
  }
}
