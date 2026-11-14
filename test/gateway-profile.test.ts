import { describe, expect, test } from 'bun:test';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { BrowserChatSession } from '../src/browser/browser-chat.ts';
import { profileLockOwner } from '../src/browser/google-profile.ts';
import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import { localGatewayUrl, releaseGatewayProfiles } from '../src/cli/gateway-profile.ts';
import { ZAI_CHAT_SITE } from '../src/providers/glm/web.ts';

describe('gateway profile release', () => {
  test('releases the profile in the gateway and gives it back afterwards', async () => {
    const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    };
    const resume = await releaseGatewayProfiles(['session/browser-profile'], { env: { UNIFIED_PORT: '4000', GATEWAY_API_KEY: 'k' }, fetch });
    await resume();
    expect(calls.map(call => call.url)).toEqual(['http://127.0.0.1:4000/v1/gateway/browser/release', 'http://127.0.0.1:4000/v1/gateway/browser/resume']);
    expect(calls[0]!.auth).toBe('Bearer k');
    expect(calls[0]!.body).toEqual({ profileDir: resolve('session/browser-profile') });
  });

  test('carries on when no gateway is running', async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      throw new Error('connection refused');
    };
    const resume = await releaseGatewayProfiles(['profile'], { env: {}, fetch });
    await resume();
    expect(calls).toEqual(['http://127.0.0.1:3260/v1/gateway/browser/release']);
  });

  test('reaches a gateway that listens on every interface through localhost', () => {
    expect(localGatewayUrl({ HOST: '0.0.0.0' })).toBe('http://127.0.0.1:3260');
    expect(localGatewayUrl({ HOST: '::1', UNIFIED_PORT: '9' })).toBe('http://[::1]:9');
  });
});

describe('account open with a running gateway', () => {
  function cli(openWindow: () => Promise<void>) {
    const events: string[] = [];
    const deps: AccountsCliDeps = {
      store: { list: () => [], addApiKey: () => { throw new Error('unused'); }, remove: () => false },
      askHidden: async () => '',
      log: () => {},
      releaseProfiles: async profile => {
        events.push(`release ${profile}`);
        return async () => { events.push('resume'); };
      },
      openWindow: async () => {
        events.push('open');
        await openWindow();
      },
      checkSignIns: async () => {
        events.push('check');
        return [{ site: ZAI_CHAT_SITE, result: { signedIn: true } }];
      },
    };
    return { deps, events };
  }

  test('frees the profile before the window opens and gives it back after the check', async () => {
    const { deps, events } = cli(async () => {});
    expect(await runAccountsCommand(['open', 'https://chat.z.ai/'], deps)).toBe(0);
    expect(events).toEqual(['release default', 'open', 'check', 'resume']);
  });

  test('gives the profile back when the window cannot open', async () => {
    const { deps, events } = cli(async () => { throw new Error('no browser'); });
    await expect(runAccountsCommand(['open', 'https://chat.z.ai/'], deps)).rejects.toThrow('no browser');
    expect(events).toEqual(['release default', 'open', 'resume']);
  });
});

describe('browser chat session suspension', () => {
  test('does not start the browser while suspended and starts it again after resume', async () => {
    let launches = 0;
    const session = new BrowserChatSession({
      profileDir: join(mkdtempSync(join(tmpdir(), 'suspend-')), 'profile'),
      launch: async () => {
        launches++;
        throw new Error('launched');
      },
    });
    await session.suspend();
    await expect(session.warm(ZAI_CHAT_SITE)).rejects.toThrow('sign-in window');
    expect(launches).toBe(0);
    session.resume();
    await expect(session.warm(ZAI_CHAT_SITE)).rejects.toThrow('launched');
    expect(launches).toBe(1);
  });
});

describe('profile lock owner', () => {
  test('names the live process that holds the profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lock-'));
    expect(profileLockOwner(dir)).toBeUndefined();
    symlinkSync(`host-${process.pid}`, join(dir, 'SingletonLock'));
    expect(profileLockOwner(dir)).toBe(process.pid);
    expect(profileLockOwner(dir, () => false)).toBeUndefined();
  });
});
