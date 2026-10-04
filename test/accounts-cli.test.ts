import { describe, expect, test } from 'bun:test';

import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import type { Credential } from '../src/core/accounts/credential-store.ts';

function harness() {
  const saved: Credential[] = [];
  const lines: string[] = [];
  const deps: AccountsCliDeps = {
    store: {
      list: provider => saved.filter(entry => !provider || entry.provider === provider),
      addApiKey: input => {
        const credential: Credential = { id: `${input.provider}-${saved.length + 1}`, provider: input.provider, email: input.label, password: '', method: 'api-key', token: input.apiKey };
        saved.push(credential);
        return credential;
      },
      remove: id => {
        const index = saved.findIndex(entry => entry.id === id);
        if (index === -1) return false;
        saved.splice(index, 1);
        return true;
      },
    },
    askHidden: async () => 'nvapi-secret',
    log: line => lines.push(line),
    verifyApiKey: async () => 3,
  };
  return { deps, saved, lines };
}

describe('accounts CLI', () => {
  test('lists saved keys without printing them, checks and removes them by id', async () => {
    const { deps, lines } = harness();
    await runAccountsCommand(['add', 'nvidia', '--api-key', '--label', 'main', '--no-verify'], deps);
    lines.length = 0;
    await runAccountsCommand(['list'], deps);
    expect(lines).toEqual(['nvidia-1\tnvidia\tmain']);
    expect(lines.join('\n')).not.toContain('nvapi-secret');
    expect(await runAccountsCommand(['test', 'nvidia-1'], deps)).toBe(0);
    expect(lines.at(-1)).toBe('OK main: 3 models available');
    expect(await runAccountsCommand(['remove', 'nvidia-1'], deps)).toBe(0);
    expect(await runAccountsCommand(['remove', 'nvidia-1'], deps)).toBe(1);
    expect(await runAccountsCommand(['test', 'nvidia-1'], deps)).toBe(1);
  });

  test('rejects unknown providers and commands and points to the API key flag', async () => {
    const { deps } = harness();
    await expect(runAccountsCommand(['add', 'qwen'], deps)).rejects.toThrow('Unknown provider: qwen');
    await expect(runAccountsCommand(['add', 'nvidia'], deps)).rejects.toThrow('Use: bun run account add nvidia --api-key');
    expect(await runAccountsCommand(['explode'], deps)).toBe(1);
    expect(await runAccountsCommand([], deps)).toBe(0);
  });

  test('opens the Google profile then lists its accounts', async () => {
    const { deps, lines } = harness();
    const opened: string[] = [];
    deps.openGoogleSignIn = async () => { opened.push('open'); };
    deps.listGoogleAccounts = async () => ['a@gmail.com', 'b@gmail.com'];

    expect(await runAccountsCommand(['google'], deps)).toBe(0);
    expect(opened).toEqual(['open']);
    expect(lines.slice(-2)).toEqual(['google\ta@gmail.com', 'google\tb@gmail.com']);

    expect(await runAccountsCommand(['google', '--list'], deps)).toBe(0);
    expect(opened).toEqual(['open']);
  });

  test('opens https sites in the browser profile and rejects anything else', async () => {
    const { deps } = harness();
    const opened: string[] = [];
    deps.openWindow = async urls => { opened.push(...urls); };
    expect(await runAccountsCommand(['open', 'https://www.kimi.com'], deps)).toBe(0);
    expect(opened).toEqual(['https://www.kimi.com/']);
    await expect(runAccountsCommand(['open', 'http://chat.z.ai'], deps)).rejects.toThrow('https');
    await expect(runAccountsCommand(['open', 'kimi.com'], deps)).rejects.toThrow('full https URL');
  });

  test('asks for consent before harvesting and cancels on no', async () => {
    const { deps, lines } = harness();
    const calls: Array<{ profile: string; providers?: string[] }> = [];
    deps.askHidden = async () => 'n';
    deps.harvest = async options => {
      calls.push(options);
      return [{ provider: 'gemini', status: 'created', detail: 'created', keyPreview: 'AIza…1234' }];
    };
    expect(await runAccountsCommand(['harvest'], deps)).toBe(0);
    expect(calls).toEqual([]);
    expect(lines).toEqual(['Cancelled.']);
  });

  test('runs the harvest with --yes, prints the report and the summary last', async () => {
    const { deps, lines } = harness();
    const calls: Array<{ profile: string; providers?: string[] }> = [];
    deps.askHidden = async () => {
      throw new Error('must not ask when --yes is set');
    };
    deps.harvest = async options => {
      calls.push(options);
      return [
        { provider: 'gemini', status: 'created', detail: 'created', keyPreview: 'AIza…1234' },
        { provider: 'groq', status: 'unchanged', detail: 'already saved', keyPreview: 'gsk_…7890' },
        { provider: 'mistral', status: 'skipped', detail: 'not signed in (bun run account connect)' },
        { provider: 'zai', status: 'failed', detail: 'refusing to click "Upgrade plan"' },
      ];
    };
    expect(await runAccountsCommand(['harvest', '--yes'], deps)).toBe(0);
    expect(calls).toEqual([{ profile: 'default', providers: undefined }]);
    expect(lines.at(-1)).toBe('created: 1, updated: 0, unchanged: 1, skipped: 1, failed: 1');
    expect(lines.some(line => line.includes('gemini') && line.includes('created') && line.includes('AIza…1234'))).toBe(true);
    expect(lines.some(line => line.includes('zai') && line.includes('refusing to click'))).toBe(true);
  });

  test('passes --provider through and rejects unknown providers and accounts', async () => {
    const { deps } = harness();
    const calls: Array<{ profile: string; providers?: string[] }> = [];
    deps.harvest = async options => {
      calls.push(options);
      return [];
    };
    deps.profiles = { list: () => [{ id: 'default', label: 'Main' }], add: label => ({ id: 'acct-1', label }), remove: () => true };
    expect(await runAccountsCommand(['harvest', '--yes', '--provider', 'gemini'], deps)).toBe(0);
    expect(calls).toEqual([{ profile: 'default', providers: ['gemini'] }]);
    await expect(runAccountsCommand(['harvest', '--yes', '--provider', 'nope'], deps)).rejects.toThrow('Unknown provider: nope');
    await expect(runAccountsCommand(['harvest', '--yes', '--profile', 'acct-zzz'], deps)).rejects.toThrow('Unknown account: acct-zzz');
  });

  test('fails the run when everything attempted failed, but not when all skipped', async () => {
    const { deps } = harness();
    deps.harvest = async () => [{ provider: 'zai', status: 'failed', detail: 'timeout' }];
    expect(await runAccountsCommand(['harvest', '--yes'], deps)).toBe(1);
    deps.harvest = async () => [{ provider: 'zai', status: 'skipped', detail: 'not signed in (bun run account connect)' }];
    expect(await runAccountsCommand(['harvest', '--yes'], deps)).toBe(0);
  });

  test('auto-login prompts for credentials, prints the report and the summary last', async () => {
    const { deps, lines } = harness();
    const calls: Array<{ profile: string; sites?: string[]; credentials: { email: string; password: string }; viaGoogle?: boolean }> = [];
    deps.askHidden = async question => (question.startsWith('Email') ? 'user@example.com ' : 'secret-pw');
    deps.autoLogin = async options => {
      calls.push(options);
      return [
        { site: 'qwen-chat', status: 'logged-in', detail: 'signed in as user@example.com' },
        { site: 'glm-chat', status: 'signed-in', detail: 'already signed in' },
        { site: 'kimi-chat', status: 'failed', detail: 'login form not found' },
        { site: 'arena-chat', status: 'skipped', detail: 'sign-in is optional' },
      ];
    };
    expect(await runAccountsCommand(['auto-login'], deps)).toBe(0);
    expect(calls).toEqual([{ profile: 'default', sites: undefined, credentials: { email: 'user@example.com', password: 'secret-pw' }, viaGoogle: false }]);
    expect(lines.at(-1)).toBe('signed-in: 1, logged-in: 1, skipped: 1, failed: 1');
    expect(lines.some(line => line.includes('qwen-chat') && line.includes('logged-in') && line.includes('user@example.com'))).toBe(true);
    expect(lines.some(line => line.includes('kimi-chat') && line.includes('login form not found'))).toBe(true);
  });

  test('auto-login reads credentials from env and flags and honors --site/--google', async () => {
    const { deps } = harness();
    deps.askHidden = async () => {
      throw new Error('must not prompt when credentials are provided');
    };
    const calls: Array<{ profile: string; sites?: string[]; providers?: string[]; credentials: { email: string; password: string }; viaGoogle?: boolean }> = [];
    deps.autoLogin = async options => {
      calls.push(options);
      return [];
    };
    deps.env = { LOGIN_EMAIL: 'env@example.com', LOGIN_PASSWORD: 'env-secret' };
    expect(await runAccountsCommand(['auto-login', '--site', 'qwen-chat, kimi-chat', '--google'], deps)).toBe(0);
    expect(calls).toEqual([{ profile: 'default', sites: ['qwen-chat', 'kimi-chat'], providers: [], credentials: { email: 'env@example.com', password: 'env-secret' }, viaGoogle: true }]);
    expect(await runAccountsCommand(['auto-login', '--email', 'flag@example.com', '--password', 'flag-secret'], deps)).toBe(0);
    expect(calls[1].credentials).toEqual({ email: 'flag@example.com', password: 'flag-secret' });
    expect(calls[1].sites).toBeUndefined();
    expect(calls[1].providers).toBeUndefined();
  });

  test('auto-login filters provider dashboards with --provider and rejects unknown providers', async () => {
    const { deps } = harness();
    deps.askHidden = async () => {
      throw new Error('must not prompt when credentials are provided');
    };
    const calls: Array<{ sites?: string[]; providers?: string[] }> = [];
    deps.autoLogin = async options => {
      calls.push(options);
      return [];
    };
    deps.env = { LOGIN_EMAIL: 'env@example.com', LOGIN_PASSWORD: 'env-secret' };
    expect(await runAccountsCommand(['auto-login', '--provider', 'groq, nvidia'], deps)).toBe(0);
    expect(calls[0].sites).toEqual([]);
    expect(calls[0].providers).toEqual(['groq', 'nvidia']);
    expect(await runAccountsCommand(['auto-login', '--site', 'qwen-chat'], deps)).toBe(0);
    expect(calls[1].sites).toEqual(['qwen-chat']);
    expect(calls[1].providers).toEqual([]);
    await expect(runAccountsCommand(['auto-login', '--provider', 'nope'], deps)).rejects.toThrow('Unknown provider: nope');
  });

  test('auto-login rejects unknown sites and empty credentials', async () => {
    const { deps } = harness();
    deps.autoLogin = async () => [];
    await expect(runAccountsCommand(['auto-login', '--site', 'nope'], deps)).rejects.toThrow('Unknown site: nope');
    deps.askHidden = async () => '';
    await expect(runAccountsCommand(['auto-login'], deps)).rejects.toThrow('Email is required');
    deps.askHidden = async question => (question.startsWith('Email') ? 'user@example.com' : '');
    await expect(runAccountsCommand(['auto-login'], deps)).rejects.toThrow('Password is required');
  });

  test('auto-login fails the run only when a login actually failed', async () => {
    const { deps } = harness();
    deps.askHidden = async question => (question.startsWith('Email') ? 'user@example.com' : 'secret');
    deps.autoLogin = async () => [{ site: 'qwen-chat', status: 'failed', detail: 'timeout' }];
    expect(await runAccountsCommand(['auto-login'], deps)).toBe(1);
    deps.autoLogin = async () => [{ site: 'arena-chat', status: 'skipped', detail: 'sign-in is optional' }];
    expect(await runAccountsCommand(['auto-login'], deps)).toBe(0);
    deps.autoLogin = async () => [
      { site: 'qwen-chat', status: 'failed', detail: 'timeout' },
      { site: 'glm-chat', status: 'logged-in', detail: 'signed in as user@example.com' },
    ];
    expect(await runAccountsCommand(['auto-login'], deps)).toBe(0);
  });
});
