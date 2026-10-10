import type { ApiProviderDefinition } from './catalog.ts';

export interface CustomProvider {
  id: string;
  label: string;
  baseUrl: string;
}

export const CUSTOM_PROVIDERS_SETTING = 'providers.custom';

const ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_LABEL = 40;

function normalizeUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Not a valid URL: ${value}`);
  }
  if (url.username || url.password) throw new Error('Put the API key in the key field, not in the URL');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error('Use an https:// URL (plain http:// only for localhost)');
  }
  if (url.search || url.hash) throw new Error('The base URL must not contain ? or #');
  return url.toString().replace(/\/+$/, '');
}

export function validateCustomProvider(input: { id: string; label?: string; baseUrl: string }, taken: (id: string) => boolean): CustomProvider {
  const id = input.id.trim().toLowerCase();
  if (!ID.test(id)) throw new Error('Use 2-32 lowercase letters, digits or dashes for the provider id');
  if (taken(id)) throw new Error(`Provider id already in use: ${id}`);
  const label = (input.label ?? '').trim() || id;
  if (label.length > MAX_LABEL) throw new Error(`Keep the name under ${MAX_LABEL} characters`);
  return { id, label, baseUrl: normalizeUrl(input.baseUrl) };
}

export function readCustomProviders(value: string | undefined): CustomProvider[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const providers: CustomProvider[] = [];
  for (const entry of parsed) {
    try {
      const candidate = entry as { id: string; label?: string; baseUrl: string };
      providers.push(validateCustomProvider(candidate, id => providers.some(provider => provider.id === id)));
    } catch {}
  }
  return providers;
}

export function customProviderDefinition(provider: CustomProvider): ApiProviderDefinition {
  return {
    id: provider.id,
    label: provider.label,
    baseUrl: provider.baseUrl,
    apiKeyEnv: `${provider.id.toUpperCase().replace(/-/g, '_')}_API_KEY`,
    keyUrl: provider.baseUrl,
    keyOptional: true,
    namespace: true,
    custom: true,
  };
}
