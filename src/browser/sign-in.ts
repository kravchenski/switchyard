import type { Page } from 'playwright-core';

export interface SignInRule {
  storageKey?: string;
  cookie?: string;
  tokenPattern?: string;
  claim?: string;
  guestPattern?: RegExp;
  expiring?: boolean;
}

export interface SignInResult {
  signedIn: boolean;
  reason?: string;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : undefined;
  } catch {
    return undefined;
  }
}

export function evaluateSignIn(rule: SignInRule, value: string | null | undefined, now = Date.now()): SignInResult {
  if (!value) return { signedIn: false, reason: 'not signed in' };
  const payload = decodeJwtPayload(value);
  if (!payload) return { signedIn: false, reason: 'session token is not readable' };
  if (rule.claim) {
    const claim = payload[rule.claim];
    if (typeof claim !== 'string' || !claim) return { signedIn: false, reason: 'not signed in' };
    if (rule.guestPattern?.test(claim)) return { signedIn: false, reason: 'signed in as a guest' };
  }
  if (rule.expiring) {
    const exp = Number(payload.exp);
    if (!Number.isFinite(exp) || exp * 1000 <= now) return { signedIn: false, reason: 'session expired' };
  }
  return { signedIn: true };
}

export async function readSignInValue(page: Page, rule: SignInRule): Promise<string | null> {
  return page.evaluate(({ key, cookie, pattern }) => {
    let raw: string | null = null;
    if (key) raw = localStorage.getItem(key);
    else if (cookie) {
      const found = document.cookie.match(new RegExp(`(?:^|;\\s*)${cookie}=([^;]+)`));
      raw = found ? decodeURIComponent(found[1]) : null;
    }
    if (!raw) return null;
    if (raw.startsWith('base64-')) {
      const b64 = raw.slice(7);
      try {
        raw = atob(b64.slice(0, b64.length - (b64.length % 4)));
      } catch {
        return null;
      }
    }
    if (pattern) {
      const match = new RegExp(pattern).exec(raw);
      return match ? (match[1] ?? match[0]) : null;
    }
    return raw;
  }, { key: rule.storageKey ?? null, cookie: rule.cookie ?? null, pattern: rule.tokenPattern ?? null }).catch(() => null);
}

export async function readSignIn(page: Page, rule: SignInRule, now = Date.now()) {
  return evaluateSignIn(rule, await readSignInValue(page, rule), now);
}
