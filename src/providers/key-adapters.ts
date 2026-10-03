import { API_KEY_PROVIDERS } from './catalog.ts';

export interface ProviderKeyAdapter {
  provider: string;
  keyUrl: string;
  keyPattern: RegExp;
  createSelectors: string[];
  nameFieldSelectors: string[];
  confirmSelectors: string[];
  keySelectors: string[];
}

function keyUrl(id: string) {
  const provider = API_KEY_PROVIDERS.find(entry => entry.id === id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider.keyUrl;
}

const NAME_FIELDS = [
  'input[name="name"]',
  'input[placeholder*="name" i]',
  'input[placeholder*="Name" i]',
  'input[name="description"]',
  '#token-name',
];

const CONFIRMS = [
  'button:has-text("Confirm")',
  'button:has-text("I agree")',
  'button:has-text("Got it")',
  'button:has-text("OK")',
];

const CREATORS = [
  'button:has-text("Create")',
  'a:has-text("Create")',
  'button:has-text("Generate")',
  'button:has-text("Get API Key")',
  'button:has-text("New")',
];

const READABLE = ['code', 'input[readonly]', 'pre [data-key]', '[data-api-key]'];

const common = {
  createSelectors: CREATORS,
  nameFieldSelectors: NAME_FIELDS,
  confirmSelectors: CONFIRMS,
  keySelectors: READABLE,
};

export const KEY_ADAPTERS: ProviderKeyAdapter[] = [
  { provider: 'nvidia', keyUrl: keyUrl('nvidia'), keyPattern: /^nvapi-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'xkiro', keyUrl: keyUrl('xkiro'), keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'openrouter', keyUrl: keyUrl('openrouter'), keyPattern: /^sk-or-v1-[A-Za-z0-9_-]{32,}$/, ...common },
  { provider: 'groq', keyUrl: keyUrl('groq'), keyPattern: /^gsk_[A-Za-z0-9]{20,}$/, ...common },
  { provider: 'gemini', keyUrl: keyUrl('gemini'), keyPattern: /^AIza[A-Za-z0-9_-]{30,}$/, ...common },
  { provider: 'cerebras', keyUrl: keyUrl('cerebras'), keyPattern: /^csk-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'mistral', keyUrl: keyUrl('mistral'), keyPattern: /^[a-f0-9]{32}$/, ...common },
  { provider: 'sambanova', keyUrl: keyUrl('sambanova'), keyPattern: /^[A-Za-z0-9]{32,64}$/, ...common },
  {
    provider: 'github-models',
    keyUrl: keyUrl('github-models'),
    keyPattern: /^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}$|^github_pat_[A-Za-z0-9_]{20,}$/,
    ...common,
  },
  { provider: 'huggingface', keyUrl: keyUrl('huggingface'), keyPattern: /^hf_[A-Za-z0-9]{30,}$/, ...common },
  { provider: 'bigmodel', keyUrl: keyUrl('bigmodel'), keyPattern: /^[a-f0-9]{32}(?:\.[A-Za-z0-9_-]{8,})?$/, ...common },
  { provider: 'cohere', keyUrl: keyUrl('cohere'), keyPattern: /^[A-Za-z0-9]{34,}$/, ...common },
  { provider: 'aion', keyUrl: keyUrl('aion'), keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'ovhcloud', keyUrl: keyUrl('ovhcloud'), keyPattern: /^[A-Za-z0-9]{32,64}$/, ...common },
  { provider: 'llm7', keyUrl: keyUrl('llm7'), keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'zai', keyUrl: keyUrl('zai'), keyPattern: /^[A-Za-z0-9]{32,64}$/, ...common },
  { provider: 'ollama-cloud', keyUrl: keyUrl('ollama-cloud'), keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'opencode-zen', keyUrl: keyUrl('opencode-zen'), keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'kilo', keyUrl: keyUrl('kilo'), keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/, ...common },
  { provider: 'cloudflare', keyUrl: keyUrl('cloudflare'), keyPattern: /^[A-Za-z0-9]{40}$/, ...common },
];
