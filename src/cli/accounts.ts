import type { ApiKeyCredential, Credential } from '../core/accounts/credential-store.ts';
import type { SiteSignIn } from '../browser/sign-in-check.ts';
import type { BrowserProfile } from '../browser/profiles.ts';
import type { HarvestResult, HarvestStatus } from '../browser/key-harvest.ts';
import type { AutoLoginResult, AutoLoginStatus } from '../browser/auto-login.ts';
import { notSignedIn } from '../browser/browser-chat.ts';
import type { SignInResult } from '../browser/sign-in.ts';
import { supportsTokenSignIn } from '../browser/token-sign-in.ts';
import { normalizeToken } from '../core/accounts/token.ts';
import { formatOverview, type ProviderOverview } from './overview.ts';
import { API_KEY_PROVIDERS as API_KEY_DEFINITIONS, apiKeyProvider } from '../providers/catalog.ts';
import type { CustomProvider } from '../providers/custom.ts';
import { WEB_CHAT_SITES } from '../providers/web-chat-sites.ts';

export interface AccountsCliDeps {
  store: {
    list(provider?: string): Credential[];
    addApiKey(input: ApiKeyCredential): Credential;
    remove(id: string): boolean;
  };
  askHidden: (question: string) => Promise<string>;
  log: (line: string) => void;
  openGoogleSignIn?: (profile: string) => Promise<void>;
  listGoogleAccounts?: (profile: string) => Promise<string[]>;
  openWindow?: (urls: string[], profile: string) => Promise<void>;
  verifyApiKey?: (provider: string, apiKey: string) => Promise<number>;
  accountLabel?: (provider: string) => string | undefined;
  checkSignIns?: (url: string | undefined, profile?: string) => Promise<ProfileSignIn[]>;
  signInWithToken?: (siteId: string, token: string, profile: string) => Promise<SignInResult>;
  profiles?: {
    list(): BrowserProfile[];
    add(label: string): BrowserProfile;
    remove(id: string): boolean;
    summary?(): unknown;
  };
  chatUrls?: string[];
  overview?: () => ProviderOverview[];
  initSecret?: () => Promise<string>;
  secretSource?: () => Promise<string>;
  providerAuto?: (provider: string, auto?: boolean) => boolean;
  customProviders?: {
    list(): CustomProvider[];
    add(input: { id: string; label?: string; baseUrl: string }): CustomProvider;
    remove(id: string): boolean;
  };
  autoSettings?: (change: { order?: string; agents?: Record<string, string | undefined> }) => { order: string[]; agents?: Record<string, boolean> };
  harvest?: (options: { profile: string; providers?: string[]; session?: unknown; onResult?: (result: HarvestResult) => void }) => Promise<HarvestResult[]>;
  autoLogin?: (options: { profile: string; sites?: string[]; providers?: string[]; credentials: { email: string; password: string }; viaGoogle?: boolean; session?: unknown }) => Promise<AutoLoginResult[]>;
  beginSession?: (profile: string) => Promise<unknown>;
  endSession?: (session: unknown) => Promise<void>;
  env?: Record<string, string | undefined>;
}

const API_KEY_PROVIDERS = new Set(API_KEY_DEFINITIONS.map(provider => provider.id));
const WEB_CHAT_IDS = WEB_CHAT_SITES.map(site => site.id);

export type ProfileSignIn = SiteSignIn & { profile?: BrowserProfile };

const DEFAULT_ACCOUNT = 'default';
const GOOGLE_SIGN_IN_URL = 'https://accounts.google.com/';

export const ACCOUNTS_USAGE = `Usage: bun run account <command>

  (no command) [--json]                           Show every provider and whether it is connected
  init                                            Create ACCOUNTS_SECRET in the system keyring (moves it out of .env)
  secret                                          Show where ACCOUNTS_SECRET is loaded from
  provider <id> [--auto on|off]                   Show or change whether model=auto may use a provider
  auto [--order <id,...>] [--compact on|off] [--tools on|off] [--rtk on|off]
                                                  Show or change model=auto (order of the web chats, e.g. qwen-chat,deepseek,glm-chat)
                                                  and coding agent requests (--compact trims tool output,
                                                  --tools keeps only the tools a request needs,
                                                  --rtk runs the agent's shell commands through rtk)
  custom                                          List custom OpenAI-compatible providers
  custom add <id> --url <base-url> [--name <name>]
                                                  Add a custom OpenAI-compatible provider (https, or http on localhost);
                                                  then save its key with: add <id> --api-key
  custom remove <id>                              Delete a custom provider and its saved keys
  add <provider> --api-key [--label <name>]       Save an API key (the key is always prompted)
  list [provider]                                 List saved API keys
  remove <id>                                     Delete a saved API key
  test <id>                                       Check a saved API key
  profiles [--json]                               List browser accounts and their web chat sign-ins
  profile add <name>                              Create a browser account (its own browser profile)
  profile remove <id>                             Delete a browser account and its browser profile
  connect [--profile <id>]                        Open Google and every web chat in an account to sign in, then check them
  google [--list] [--profile <id>]                Sign in to Google in a browser account, then list its Google accounts
  open <https-url> [--profile <id>]               Open a site in a browser account to sign in manually
  token <qwen-chat|glm-chat|kimi-chat> [--profile <id>]
                                                  Sign a browser account in with the token from your own browser
                                                  (the token is prompted; stop the API first)
  status [--profile <id>]                         Show which web chats each browser account is signed in to
  harvest [--profile <id>] [--provider <id>] [--yes]
                                                  Visit provider dashboards and create/update API keys from your
                                                  signed-in browser accounts (asks for consent unless --yes)
  auto-login [--profile <id>] [--site <id,...>] [--provider <id,...>] [--google] [--email <address>] [--password <secret>]
                                                  Sign in to every web chat and provider dashboard with an account you
                                                  provide; Google sign-in is preferred when the site offers it,
                                                  --google forces it, the email and password are prompted
                                                  (LOGIN_EMAIL/LOGIN_PASSWORD work too); without --site/--provider
                                                  every chat and dashboard is attempted
  auto-collect [--profile <id>] [--site <id,...>] [--provider <id,...>] [--google] [--yes]
                                                  Sign in (the browser profile's Google session or LOGIN_EMAIL/
                                                  LOGIN_PASSWORD, never prompted) and then create/update API keys
                                                  for every provider; --site/--provider limit the sign-in step,
                                                  --provider also limits the key collection step

API key providers: ${[...API_KEY_PROVIDERS].join(', ')}
Web chat site ids: ${WEB_CHAT_IDS.join(', ')}
Web chats sign in through the browser profile: bun run account open <url>`;

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function splitIds(value: string) {
  return value.split(',').map(entry => entry.trim()).filter(Boolean);
}

function requireProvider(provider: string | undefined) {
  if (!provider || !apiKeyProvider(provider)) throw new Error(`Unknown provider: ${provider ?? '(none)'}\n\n${ACCOUNTS_USAGE}`);
  return provider;
}

function reportSignIns(results: ProfileSignIn[], log: (line: string) => void) {
  const labelled = new Set(results.map(entry => entry.profile?.id ?? DEFAULT_ACCOUNT)).size > 1;
  for (const { site, result, profile } of results) {
    const host = new URL(site.url).hostname;
    const suffix = labelled && profile ? `  [${profile.label}]` : '';
    log(result.signedIn ? `✓ ${site.id.padEnd(10)} ${host}${suffix}` : `○ ${site.id.padEnd(10)} ${notSignedIn(site, result)}${suffix}`);
  }
  return results.every(entry => entry.result.signedIn) ? 0 : 1;
}

function profileOption(args: string[], deps: AccountsCliDeps) {
  const id = option(args, '--profile') ?? DEFAULT_ACCOUNT;
  if (deps.profiles && !deps.profiles.list().some(profile => profile.id === id)) {
    throw new Error(`Unknown account: ${id}. See: bun run account profiles`);
  }
  return id;
}

function formatAutoLogin(result: AutoLoginResult) {
  return `${result.site.padEnd(12)} ${result.status.padEnd(10)} ${result.detail}`;
}

function autoLoginSummary(results: AutoLoginResult[]) {
  const count = (status: AutoLoginStatus) => results.filter(entry => entry.status === status).length;
  return `signed-in: ${count('signed-in')}, logged-in: ${count('logged-in')}, skipped: ${count('skipped')}, failed: ${count('failed')}`;
}

function autoLoginGood(results: AutoLoginResult[]) {
  return results.filter(entry => entry.status === 'signed-in' || entry.status === 'logged-in').length;
}

function autoLoginFailed(results: AutoLoginResult[]) {
  return results.filter(entry => entry.status === 'failed').length;
}

function formatHarvest(result: HarvestResult) {
  const preview = result.keyPreview ? `  ${result.keyPreview}` : '';
  return `${result.provider.padEnd(14)} ${result.status.padEnd(10)} ${result.detail}${preview}`;
}

function harvestSummary(results: HarvestResult[]) {
  const count = (status: HarvestStatus) => results.filter(entry => entry.status === status).length;
  return `created: ${count('created')}, updated: ${count('updated')}, unchanged: ${count('unchanged')}, skipped: ${count('skipped')}, failed: ${count('failed')}`;
}

function harvestGood(results: HarvestResult[]) {
  return results.filter(entry => entry.status === 'created' || entry.status === 'updated' || entry.status === 'unchanged').length;
}

function harvestFailed(results: HarvestResult[]) {
  return results.filter(entry => entry.status === 'failed').length;
}

export async function runAccountsCommand(args: string[], deps: AccountsCliDeps) {
  const [command, target] = args;

  if ((command === undefined || command === '--json' || command === 'overview') && deps.overview) {
    const rows = deps.overview();
    deps.log(args.includes('--json') ? JSON.stringify(rows, null, 2) : formatOverview(rows));
    return 0;
  }

  if (command === 'init' && deps.initSecret) {
    deps.log(await deps.initSecret());
    return 0;
  }

  if (command === 'provider' && target && deps.providerAuto) {
    const value = option(args, '--auto');
    if (value !== undefined && value !== 'on' && value !== 'off') throw new Error('Use --auto on or --auto off');
    const auto = deps.providerAuto(target, value === undefined ? undefined : value === 'on');
    deps.log(`${target} auto: ${auto ? 'on' : 'off'}`);
    return 0;
  }

  if (command === 'custom' && deps.customProviders) {
    const action = args[1];
    if (action === 'add') {
      const url = option(args, '--url');
      if (!args[2] || !url) throw new Error('Usage: bun run account custom add <id> --url <base-url> [--name <name>]');
      const added = deps.customProviders.add({ id: args[2], baseUrl: url, label: option(args, '--name') });
      deps.log(`Added custom provider ${added.id} (${added.baseUrl})`);
      return 0;
    }
    if (action === 'remove') {
      if (!args[2]) throw new Error('Usage: bun run account custom remove <id>');
      if (!deps.customProviders.remove(args[2])) throw new Error(`Unknown custom provider: ${args[2]}`);
      deps.log(`Removed custom provider ${args[2]}`);
      return 0;
    }
    const providers = deps.customProviders.list();
    if (!providers.length) deps.log('No custom providers');
    for (const provider of providers) deps.log(`${provider.id}\t${provider.label}\t${provider.baseUrl}`);
    return 0;
  }

  if (command === 'auto' && deps.autoSettings) {
    const current = deps.autoSettings({ order: option(args, '--order'), agents: { compact: option(args, '--compact'), tools: option(args, '--tools'), rtk: option(args, '--rtk') } });
    deps.log(`web order: ${current.order.join(',')}`);
    for (const [name, on] of Object.entries(current.agents ?? {})) deps.log(`agents ${name}: ${on ? 'on' : 'off'}`);
    return 0;
  }

  if (command === 'secret' && deps.secretSource) {
    deps.log(`ACCOUNTS_SECRET: ${await deps.secretSource()}`);
    return 0;
  }

  if (command === 'profiles' && deps.profiles) {
    if (args.includes('--json')) {
      deps.log(JSON.stringify(deps.profiles.summary?.() ?? deps.profiles.list(), null, 2));
      return 0;
    }
    for (const profile of deps.profiles.list()) deps.log(`${profile.id}\t${profile.label}`);
    return 0;
  }

  if (command === 'profile' && target === 'add' && deps.profiles) {
    const label = args.slice(2).join(' ');
    const profile = deps.profiles.add(label);
    deps.log(`Created ${profile.id} (${profile.label}). Sign it in to the web chats: bun run account connect --profile ${profile.id}`);
    return 0;
  }

  if (command === 'profile' && target === 'remove' && deps.profiles) {
    const id = args[2];
    if (!id) throw new Error('Use: bun run account profile remove <id>');
    const removed = deps.profiles.remove(id);
    deps.log(removed ? `Removed ${id}` : `Account not found: ${id}`);
    return removed ? 0 : 1;
  }

  if (command === 'connect' && deps.openWindow) {
    const profile = profileOption(args, deps);
    deps.log('Sign in to Google, then to every web chat tab in the opened window (use "Sign in with Google"). Close the window when done.');
    await deps.openWindow([GOOGLE_SIGN_IN_URL, ...(deps.chatUrls ?? [])], profile);
    return deps.checkSignIns ? reportSignIns(await deps.checkSignIns(undefined, profile), deps.log) : 0;
  }

  if (command === 'google' && deps.listGoogleAccounts) {
    const profile = profileOption(args, deps);
    if (!args.includes('--list') && deps.openGoogleSignIn) {
      deps.log('Sign in to your Google accounts in the opened browser window, then close the window.');
      await deps.openGoogleSignIn(profile);
    }
    const accounts = await deps.listGoogleAccounts(profile);
    if (!accounts.length) deps.log('No Google accounts found in the browser profile.');
    for (const email of accounts) deps.log(`google\t${email}`);
    return 0;
  }

  if (command === 'open' && deps.openWindow) {
    const profile = profileOption(args, deps);
    let url: URL;
    try {
      url = new URL(target ?? '');
    } catch {
      throw new Error(`Enter a full https URL, e.g. https://www.kimi.com\n\n${ACCOUNTS_USAGE}`);
    }
    if (url.protocol !== 'https:') throw new Error('Only https URLs can be opened');
    deps.log(`Sign in on ${url.hostname} in the opened browser window, then close the window.`);
    await deps.openWindow([url.href], profile);
    if (!deps.checkSignIns) return 0;
    const results = await deps.checkSignIns(url.href, profile);
    return results.length ? reportSignIns(results, deps.log) : 0;
  }

  if (command === 'token' && deps.signInWithToken) {
    const site = WEB_CHAT_SITES.find(entry => entry.id === target && supportsTokenSignIn(entry));
    if (!site) throw new Error(`Use: bun run account token <${WEB_CHAT_SITES.filter(supportsTokenSignIn).map(entry => entry.id).join('|')}> [--profile <id>]`);
    const profile = profileOption(args, deps);
    const host = new URL(site.url).hostname;
    const key = site.signIn!.storageKey!;
    deps.log(`Sign in at ${host} in your usual browser, then open DevTools (F12) > Application > Local Storage > https://${host} and copy "${key}".`);
    deps.log('The token gives full access to the account. Stop the API first: it uses the same browser profile.');
    const token = normalizeToken(await deps.askHidden(`${key} (hidden): `));
    if (!token) throw new Error('No token entered');
    const result = await deps.signInWithToken(site.id, token, profile);
    if (!result.signedIn) {
      deps.log(`${host}: not signed in, ${result.reason}`);
      return 1;
    }
    deps.log(`${host}: signed in with the token`);
    if (deps.checkSignIns) await deps.checkSignIns(site.url, profile);
    return 0;
  }

  if (command === 'status' && deps.checkSignIns) {
    const profile = args.includes('--profile') ? profileOption(args, deps) : undefined;
    return reportSignIns(await deps.checkSignIns(undefined, profile), deps.log);
  }

  if (command === 'harvest' && deps.harvest) {
    const profile = profileOption(args, deps);
    const providerOption = option(args, '--provider');
    const provider = providerOption ? requireProvider(providerOption) : undefined;
    if (!args.includes('--yes')) {
      const answer = (await deps.askHidden('This will open provider dashboards in your browser session and create/update API keys for your logged-in accounts. Continue? (y/n) ')).trim().toLowerCase();
      if (!answer.startsWith('y')) {
        deps.log('Cancelled.');
        return 0;
      }
    }
    deps.log('Visiting provider dashboards...');
    const results = await deps.harvest({ profile, providers: provider ? [provider] : undefined, onResult: result => deps.log(formatHarvest(result)) });
    deps.log(harvestSummary(results));
    return harvestFailed(results) > 0 && harvestGood(results) === 0 ? 1 : 0;
  }

  if (command === 'auto-collect' && deps.autoLogin && deps.harvest) {
    const profile = profileOption(args, deps);
    const siteOption = option(args, '--site');
    const providerOption = option(args, '--provider');
    const sites = siteOption ? splitIds(siteOption) : providerOption ? [] : undefined;
    const providers = providerOption ? splitIds(providerOption) : siteOption ? [] : undefined;
    for (const id of sites ?? []) {
      if (!WEB_CHAT_IDS.includes(id)) throw new Error(`Unknown site: ${id}. Web chats: ${WEB_CHAT_IDS.join(', ')}\n\n${ACCOUNTS_USAGE}`);
    }
    for (const id of providers ?? []) {
      requireProvider(id);
    }
    const email = (option(args, '--email') ?? deps.env?.LOGIN_EMAIL ?? '').trim();
    const password = option(args, '--password') ?? deps.env?.LOGIN_PASSWORD ?? '';
    if (!args.includes('--yes')) {
      const answer = (await deps.askHidden('This will sign in to your web chats and provider dashboards and create/update API keys for them. Continue? (y/n) ')).trim().toLowerCase();
      if (!answer.startsWith('y')) {
        deps.log('Cancelled.');
        return 0;
      }
    }
    deps.log('Signing in to web chats and provider dashboards...');
    const session = deps.beginSession ? await deps.beginSession(profile) : undefined;
    try {
      const loginResults = await deps.autoLogin({ profile, sites, providers, credentials: { email, password }, viaGoogle: args.includes('--google'), session });
      for (const result of loginResults) deps.log(formatAutoLogin(result));
      deps.log(autoLoginSummary(loginResults));
      deps.log('Visiting provider dashboards...');
      const results = await deps.harvest({ profile, providers: providers && providers.length ? providers : undefined, session, onResult: result => deps.log(formatHarvest(result)) });
      deps.log(harvestSummary(results));
      const good = autoLoginGood(loginResults) + harvestGood(results);
      const failed = autoLoginFailed(loginResults) + harvestFailed(results);
      return failed > 0 && good === 0 ? 1 : 0;
    } finally {
      if (session !== undefined && deps.endSession) await deps.endSession(session);
    }
  }

  if (command === 'auto-login' && deps.autoLogin) {
    const profile = profileOption(args, deps);
    const siteOption = option(args, '--site');
    const providerOption = option(args, '--provider');
    const sites = siteOption ? splitIds(siteOption) : providerOption ? [] : undefined;
    const providers = providerOption ? splitIds(providerOption) : siteOption ? [] : undefined;
    for (const id of sites ?? []) {
      if (!WEB_CHAT_IDS.includes(id)) throw new Error(`Unknown site: ${id}. Web chats: ${WEB_CHAT_IDS.join(', ')}\n\n${ACCOUNTS_USAGE}`);
    }
    for (const id of providers ?? []) {
      requireProvider(id);
    }
    const email = (option(args, '--email') ?? deps.env?.LOGIN_EMAIL ?? (await deps.askHidden('Email: '))).trim();
    const password = option(args, '--password') ?? deps.env?.LOGIN_PASSWORD ?? await deps.askHidden('Password: ');
    if (!email) throw new Error('Email is required');
    if (!password) throw new Error('Password is required');
    const results = await deps.autoLogin({ profile, sites, providers, credentials: { email, password }, viaGoogle: args.includes('--google') });
    for (const result of results) deps.log(formatAutoLogin(result));
    deps.log(autoLoginSummary(results));
    return autoLoginFailed(results) > 0 && autoLoginGood(results) === 0 ? 1 : 0;
  }

  if (command === 'add' && args.includes('--api-key')) {
    const provider = requireProvider(target);
    const label = option(args, '--label') ?? 'default';
    let apiKey = (await deps.askHidden('API key: ')).trim();
    if (!apiKey) throw new Error('API key is required');
    const accountLabel = deps.accountLabel?.(provider);
    if (accountLabel && !apiKey.includes(':')) {
      const account = (await deps.askHidden(`${accountLabel}: `)).trim();
      if (!account) throw new Error(`${accountLabel} is required`);
      apiKey = `${account}:${apiKey}`;
    }
    if (!args.includes('--no-verify') && deps.verifyApiKey) {
      deps.log(`Key works: ${await deps.verifyApiKey(provider, apiKey)} models available`);
    }
    const credential = deps.store.addApiKey({ provider, label, apiKey });
    deps.log(`Saved ${credential.id} (${credential.email})`);
    return 0;
  }

  if (command === 'add') {
    requireProvider(target);
    throw new Error(`Use: bun run account add ${target} --api-key`);
  }

  if (command === 'list') {
    const credentials = deps.store.list(target);
    if (!credentials.length) deps.log('No saved accounts.');
    for (const credential of credentials) deps.log(`${credential.id}\t${credential.provider}\t${credential.email}`);
    return 0;
  }

  if (command === 'remove' && target) {
    const removed = deps.store.remove(target);
    deps.log(removed ? `Removed ${target}` : `Account not found: ${target}`);
    return removed ? 0 : 1;
  }

  if (command === 'test' && target) {
    const credential = deps.store.list().find(entry => entry.id === target);
    if (!credential) {
      deps.log(`Account not found: ${target}`);
      return 1;
    }
    if (credential.method === 'api-key') {
      if (!deps.verifyApiKey || !credential.token) throw new Error('API key checks are not available');
      deps.log(`OK ${credential.email}: ${await deps.verifyApiKey(credential.provider, credential.token)} models available`);
      return 0;
    }
    deps.log(`${credential.email} is not an API key; nothing to check`);
    return 1;
  }

  deps.log(ACCOUNTS_USAGE);
  return command === undefined || command === 'help' || command === '--help' ? 0 : 1;
}
