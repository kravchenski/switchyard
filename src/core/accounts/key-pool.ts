import type { ProviderErrorKind } from '../providers/errors.ts';

const RATE_LIMIT_PAUSE_MS = 60_000;
const LONG_PAUSE_MS = 60 * 60_000;
const REJECTED_PAUSE_MS = 6 * 60 * 60_000;
const ROTATING_KINDS = new Set<ProviderErrorKind>(['rate_limit', 'quota_exhausted', 'auth']);

export function parseKeyList(value: string | undefined): string[] {
  const text = value?.trim();
  if (!text) return [];
  let items: unknown[] = [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      items = text.slice(1, text.endsWith(']') ? -1 : undefined).split(',');
    }
  } else {
    items = text.split(/[,\n]/);
  }
  const keys = items.map(item => String(item ?? '').trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
  return [...new Set(keys)];
}

export function rotatesKey(kind: ProviderErrorKind) {
  return ROTATING_KINDS.has(kind);
}

export class KeyPool {
  private readonly pausedUntil = new Map<string, number>();
  private readonly rejected = new Set<string>();
  private preferred?: string;

  constructor(private readonly now: () => number = Date.now) {}

  order(keys: string[]): string[] {
    const now = this.now();
    const ready = keys.filter(key => (this.pausedUntil.get(key) ?? 0) <= now);
    const ordered = this.preferred && ready.includes(this.preferred) ? [this.preferred, ...ready.filter(key => key !== this.preferred)] : ready;
    return ordered;
  }

  secondsUntilReady(keys: string[]) {
    const times = keys.map(key => this.pausedUntil.get(key) ?? 0);
    const next = times.length ? Math.min(...times) : 0;
    return Math.max(0, Math.ceil((next - this.now()) / 1000));
  }

  rejectedKeys(keys: string[]) {
    const now = this.now();
    return keys.filter(key => this.rejected.has(key) && (this.pausedUntil.get(key) ?? 0) > now);
  }

  succeeded(key: string) {
    this.preferred = key;
    this.pausedUntil.delete(key);
    this.rejected.delete(key);
  }

  failed(key: string, kind: ProviderErrorKind, retryAfterSeconds?: number) {
    if (!rotatesKey(kind)) return;
    if (kind === 'auth') this.rejected.add(key);
    else this.rejected.delete(key);
    const pause = kind === 'auth' ? REJECTED_PAUSE_MS : retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : kind === 'rate_limit' ? RATE_LIMIT_PAUSE_MS : LONG_PAUSE_MS;
    this.pausedUntil.set(key, this.now() + pause);
    if (this.preferred === key) this.preferred = undefined;
  }
}
