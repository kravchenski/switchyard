#!/usr/bin/env bun

import { runAccountsCommand, type ProfileSignIn } from '../src/cli/accounts.ts';
import { openCredentialStore } from '../src/core/accounts/credential-store.ts';
import { API_KEY_PROVIDERS, apiKeyProvider, apiKeyProviders, defaultAuto, setCustomProviders, verifyProviderKey } from '../src/providers/catalog.ts';
import { CUSTOM_PROVIDERS_SETTING, customProviderDefinition, readCustomProviders, validateCustomProvider, type CustomProvider } from '../src/providers/custom.ts';
import { askHidden } from '../src/utils/hiddenPrompt.ts';
import { listGoogleAccounts, openGoogleSignIn, openProfileWindow } from '../src/browser/google-profile.ts';
import { checkSignIns } from '../src/browser/sign-in-check.ts';
import { notSignedIn } from '../src/browser/browser-chat.ts';
import { WebSignInStatus } from '../src/core/accounts/sign-in-status.ts';
import { signInWithToken } from '../src/browser/token-sign-in.ts';
import type { Database } from 'bun:sqlite';
import {
  addBrowserProfile, listBrowserProfiles, loadGatewaySetting, loadProviderSetting, loadSignIn, loadSignIns, openDatabase, removeBrowserProfile,
  saveGatewaySetting, saveProviderSetting, saveSignIn, type BrowserProfileRow,
} from '../src/core/store/database.ts';
import { createProfile, deleteProfile, listProfiles, profileDir } from '../src/browser/profiles.ts';
import { ProviderSettings } from '../src/core/providers/settings.ts';
import { AGENT_OPTIONS, GatewaySettings, type AgentOption } from '../src/core/settings/gateway-settings.ts';
import { siteForUrl, WEB_CHAT_SITES } from '../src/providers/web-chat-sites.ts';
import { buildOverview } from '../src/cli/overview.ts';
import { INIT_MESSAGES, initAccountsSecret } from '../src/cli/accounts-secret.ts';
import { loadAccountsSecret, systemKeyring } from '../src/core/secrets/accounts-secret.ts';
import { accountStates } from '../src/core/status.ts';
import { loadDeepSeekAccounts, removeDeepSeekAccount } from '../src/providers/deepseek/accounts.ts';
import { checkDeepSeekProfile, DEEPSEEK_SIGN_IN_SITE, profileAccountId } from '../src/providers/deepseek/profile.ts';
import { isDeepSeekUrl } from '../src/providers/deepseek/url.ts';
import { harvestBrowserFrom, harvestKeys } from '../src/browser/key-harvest.ts';
import { autoSignIn } from '../src/browser/auto-login.ts';
import { launchCdpBrowser, type CdpBrowser } from '../src/browser/cdp.ts';

function withDb<T>(run: (db: Database) => T) {
  const db = openDatabase();
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function profileStore(db: Database) {
  return { list: () => listBrowserProfiles(db), add: (row: BrowserProfileRow) => addBrowserProfile(db, row), remove: (id: string) => removeBrowserProfile(db, id) };
}

const environmentSecret = process.env.ACCOUNTS_SECRET;
const secretSource = await loadAccountsSecret();
const store = openCredentialStore();

function loadCustomProviders() {
  return withDb(db => readCustomProviders(loadGatewaySetting(db, CUSTOM_PROVIDERS_SETTING)));
}

function saveCustomProviders(providers: CustomProvider[]) {
  withDb(db => saveGatewaySetting(db, CUSTOM_PROVIDERS_SETTING, JSON.stringify(providers)));
  setCustomProviders(providers.map(customProviderDefinition));
}

setCustomProviders(loadCustomProviders().map(customProviderDefinition));

try {
  process.exitCode = await runAccountsCommand(process.argv.slice(2), {
    store,
    askHidden,
    log: line => console.log(line),
    openGoogleSignIn: profile => openGoogleSignIn(profileDir(profile)),
    listGoogleAccounts: profile => listGoogleAccounts(profileDir(profile)),
    openWindow: (urls, profile) => openProfileWindow(urls, profileDir(profile)),
    chatUrls: [...WEB_CHAT_SITES.map(site => site.url), DEEPSEEK_SIGN_IN_SITE.url],
    profiles: {
      list: () => withDb(db => listProfiles(profileStore(db))),
      add: label => withDb(db => createProfile(profileStore(db), label)),
      remove: id => {
        const removed = withDb(db => deleteProfile(profileStore(db), id));
        if (removed && loadDeepSeekAccounts().some(account => account.id === profileAccountId(id))) removeDeepSeekAccount(profileAccountId(id));
        return removed;
      },
      summary: () => withDb(db => listProfiles(profileStore(db)).map(profile => ({
        ...profile,
        chats: [...WEB_CHAT_SITES.filter(site => site.signIn), DEEPSEEK_SIGN_IN_SITE].map(site => {
          const record = loadSignIn(db, site.id, profile.id);
          return { id: site.id, signedIn: record?.signedIn ?? null, checkedAt: record?.checkedAt ?? null, reason: record?.reason ?? null };
        }),
      }))),
    },
    initSecret: async () => INIT_MESSAGES[await initAccountsSecret({ envFile: '.env', env: { ACCOUNTS_SECRET: environmentSecret }, keyring: systemKeyring })],
    secretSource: async () => secretSource,
    autoSettings: change => withDb(db => {
      const settings = new GatewaySettings({ load: key => loadGatewaySetting(db, key), save: (key, value) => saveGatewaySetting(db, key, value) });
      if (change.order !== undefined) settings.setWebOrder(change.order);
      if (change.model) settings.setWebModel(change.model.chat, change.model.model);
      for (const [name, value] of Object.entries(change.agents ?? {})) if (value !== undefined) settings.setAgentOption(name, value);
      return {
        order: settings.webOrder(),
        models: settings.webModels(),
        agents: Object.fromEntries(Object.keys(AGENT_OPTIONS).map(name => [name, settings.agentOption(name as AgentOption)])),
      };
    }),
    customProviders: {
      list: loadCustomProviders,
      add: input => {
        const providers = loadCustomProviders();
        const reserved = new Set(['deepseek', 'auto', 'vision', 'agent', ...WEB_CHAT_SITES.map(site => site.id)]);
        const added = validateCustomProvider(input, id => reserved.has(id) || Boolean(apiKeyProvider(id)));
        saveCustomProviders([...providers, added]);
        return added;
      },
      remove: id => {
        const providers = loadCustomProviders();
        if (!providers.some(provider => provider.id === id)) return false;
        for (const entry of store.list().filter(entry => entry.provider === id)) store.remove(entry.id);
        saveCustomProviders(providers.filter(provider => provider.id !== id));
        return true;
      },
    },
    providerAuto: (provider, auto) => {
      const known = new Set(['deepseek', ...apiKeyProviders().map(entry => entry.id), ...WEB_CHAT_SITES.map(site => site.id)]);
      if (!known.has(provider)) throw new Error(`Unknown provider: ${provider}`);
      const db = openDatabase();
      try {
        const settings = new ProviderSettings({ load: id => loadProviderSetting(db, id), save: setting => saveProviderSetting(db, setting) }, Date.now, defaultAuto);
        return auto === undefined ? settings.autoEnabled(provider) : settings.setAuto(provider, auto).auto;
      } finally {
        db.close();
      }
    },
    overview: () => {
      const db = openDatabase();
      try {
        return buildOverview({
          env: process.env,
          credentials: () => store.list(),
          deepseekAccounts: loadDeepSeekAccounts,
          accountStates: () => accountStates(db),
          signIn: provider => loadSignIn(db, provider),
          accountSignIns: provider => loadSignIns(db, provider),
          webSites: WEB_CHAT_SITES,
          apiKeyProviders: apiKeyProviders(),
          autoEnabled: provider => loadProviderSetting(db, provider)?.auto ?? defaultAuto(provider),
        });
      } finally {
        db.close();
      }
    },
    checkSignIns: async (url, profile) => {
      const sites = url ? [siteForUrl(url)].filter(site => site !== undefined) : WEB_CHAT_SITES;
      const deepseek = !url || isDeepSeekUrl(url);
      if (!sites.length && !deepseek) return [];
      const accounts = withDb(db => listProfiles(profileStore(db))).filter(entry => !profile || entry.id === profile);
      const results: ProfileSignIn[] = [];
      for (const account of accounts) {
        if (sites.length) {
          for (const entry of await checkSignIns(sites, undefined, profileDir(account.id))) results.push({ ...entry, profile: account });
        }
        if (deepseek) {
          results.push({ site: DEEPSEEK_SIGN_IN_SITE, result: await checkDeepSeekProfile(account.id, profileDir(account.id)), profile: account });
        }
      }
      withDb(db => {
        const status = new WebSignInStatus({ load: (provider, id) => loadSignIn(db, provider, id), save: record => saveSignIn(db, record) });
        for (const { site, result, profile: account } of results) {
          status.record(site.id, result.signedIn, result.signedIn ? undefined : notSignedIn(site, result), account?.id);
        }
      });
      return results;
    },
    signInWithToken: (siteId, token, profile) => signInWithToken({ site: WEB_CHAT_SITES.find(site => site.id === siteId)!, token, profileDir: profileDir(profile) }),
    verifyApiKey: (provider, apiKey) => {
      const definition = apiKeyProvider(provider);
      if (!definition) throw new Error(`API keys are not supported for ${provider}`);
      return verifyProviderKey(definition, apiKey);
    },
    accountLabel: provider => apiKeyProvider(provider)?.account?.label,
    beginSession: async profile => {
      const cdp = await launchCdpBrowser({ profileDir: profileDir(profile) });
      await cdp.browser.contexts()[0]?.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
      return cdp;
    },
    endSession: async session => {
      await (session as CdpBrowser).close().catch(() => {});
    },
    harvest: ({ profile, providers, session, onResult }) => harvestKeys({
      profileDir: profileDir(profile),
      label: profile,
      providers,
      store,
      onResult,
      ...(session ? { launch: async () => harvestBrowserFrom(session as CdpBrowser) } : {}),
    }),
    env: process.env,
    autoLogin: async ({ profile, sites, providers, credentials, viaGoogle, session }) => {
      const chosen = WEB_CHAT_SITES.filter(site => !sites || sites.includes(site.id));
      const dashboards = API_KEY_PROVIDERS
        .filter(provider => !providers || providers.includes(provider.id))
        .map(provider => ({ id: provider.id, url: provider.keyUrl }));
      const db = openDatabase();
      try {
        const status = new WebSignInStatus({ load: (provider, id) => loadSignIn(db, provider, id), save: record => saveSignIn(db, record) });
        return await autoSignIn({
          sites: chosen,
          dashboards,
          credentials,
          viaGoogle,
          profileDir: profileDir(profile),
          ...(session ? { launch: async () => session as CdpBrowser, closeBrowser: false } : {}),
          onSignIn: (siteId, result) => status.record(siteId, result.signedIn, result.signedIn ? undefined : result.reason, profile),
        });
      } finally {
        db.close();
      }
    },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
