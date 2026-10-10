import { describe, expect, test } from 'bun:test';

import type { CdpBrowser } from '../src/browser/cdp.ts';
import type { DeepSeekAccount } from '../src/providers/deepseek/accounts.ts';
import { checkDeepSeekProfile, profileAccountId } from '../src/providers/deepseek/profile.ts';

const COOKIES = [{ name: 'ds_session_id', value: 'abc', domain: '.deepseek.com', path: '/' }];

function fakeBrowser(storage: string | null, options: { loadError?: Error } = {}) {
  const visited: string[] = [];
  let closed = false;
  const page = {
    goto: async (url: string) => {
      visited.push(url);
      if (options.loadError) throw options.loadError;
    },
    evaluate: async () => storage,
    close: async () => {},
  };
  const context = { newPage: async () => page, cookies: async () => COOKIES };
  const cdp = { browser: { contexts: () => [context] }, exited: Promise.resolve(), close: async () => { closed = true; } } as unknown as CdpBrowser;
  return { launch: async () => cdp, visited, closed: () => closed };
}

function recorder() {
  const saved: DeepSeekAccount[] = [];
  const forgotten: string[] = [];
  return { saved, forgotten, save: (account: DeepSeekAccount) => saved.push(account), forget: (id: string) => forgotten.push(id) };
}

describe('checkDeepSeekProfile', () => {
  test('saves the signed-in session of a browser profile as a DeepSeek account', async () => {
    const browser = fakeBrowser('{"value":"user-token","__version":"0"}');
    const store = recorder();
    const checked: string[] = [];
    const result = await checkDeepSeekProfile('default', '/profiles/default', {
      launch: browser.launch,
      check: async token => { checked.push(token); return undefined; },
      ...store,
    });
    expect(result).toEqual({ signedIn: true });
    expect(browser.visited).toEqual(['https://chat.deepseek.com/']);
    expect(checked).toEqual(['user-token']);
    expect(store.saved).toEqual([{ id: profileAccountId('default'), token: 'user-token', cookies: COOKIES, invalid: false, resetAt: null }]);
    expect(browser.closed()).toBeTrue();
  });

  test('forgets the profile account when the profile is signed out', async () => {
    const store = recorder();
    const result = await checkDeepSeekProfile('acct-1a2b3c', '/profiles/acct', { launch: fakeBrowser(null).launch, check: async () => undefined, ...store });
    expect(result).toEqual({ signedIn: false, reason: 'not signed in' });
    expect(store.saved).toEqual([]);
    expect(store.forgotten).toEqual(['deepseek_profile_acct-1a2b3c']);
  });

  test('forgets the profile account when DeepSeek rejects the session', async () => {
    const store = recorder();
    const result = await checkDeepSeekProfile('default', '/profiles/default', { launch: fakeBrowser('"stale"').launch, check: async () => 'HTTP 401', ...store });
    expect(result).toEqual({ signedIn: false, reason: 'session rejected: HTTP 401' });
    expect(store.saved).toEqual([]);
    expect(store.forgotten).toEqual(['deepseek_profile_default']);
  });

  test('keeps the saved account when the page does not load', async () => {
    const store = recorder();
    const result = await checkDeepSeekProfile('default', '/profiles/default', {
      launch: fakeBrowser(null, { loadError: new Error('net::ERR_INTERNET_DISCONNECTED') }).launch,
      check: async () => undefined,
      ...store,
    });
    expect(result.signedIn).toBeFalse();
    expect(result.reason).toContain('page did not load');
    expect(store.forgotten).toEqual([]);
  });
});
