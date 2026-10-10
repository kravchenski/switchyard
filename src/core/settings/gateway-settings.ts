export interface SettingsStore {
  load(key: string): string | undefined;
  save(key: string, value: string): void;
}

const CACHE_MS = 30_000;

export const AGENT_OPTIONS = { compact: true, tools: true, rtk: true } as const;
export type AgentOption = keyof typeof AGENT_OPTIONS;

const WEB_CHAT_ORDER = ['qwen-chat', 'deepseek', 'glm-chat', 'kimi-chat', 'arena-chat'] as const;

function isAgentOption(value: string): value is AgentOption {
  return Object.hasOwn(AGENT_OPTIONS, value);
}

function parseOrder(value: string | undefined) {
  return (value ?? '').split(',').map(id => id.trim()).filter(Boolean);
}

export class GatewaySettings {
  private readonly cache = new Map<string, { value?: string; readAt: number }>();

  constructor(
    private readonly store: SettingsStore,
    private readonly now: () => number = Date.now,
  ) {}

  private read(key: string) {
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.readAt < CACHE_MS) return cached.value;
    let value: string | undefined;
    try {
      value = this.store.load(key);
    } catch {}
    this.cache.set(key, { value, readAt: this.now() });
    return value;
  }

  private write(key: string, value: string) {
    this.store.save(key, value);
    this.cache.set(key, { value, readAt: this.now() });
  }

  webOrder(): string[] {
    const known: readonly string[] = WEB_CHAT_ORDER;
    const saved = parseOrder(this.read('auto.web-order')).filter(id => known.includes(id));
    return [...new Set([...saved, ...WEB_CHAT_ORDER])];
  }

  setWebOrder(order: string) {
    const ids = parseOrder(order);
    const known: readonly string[] = WEB_CHAT_ORDER;
    const unknown = ids.filter(id => !known.includes(id));
    if (unknown.length) throw new Error(`Unknown web chat: ${unknown.join(', ')}. Use ${WEB_CHAT_ORDER.join(', ')}`);
    if (!ids.length) throw new Error('Give at least one web chat');
    this.write('auto.web-order', [...new Set(ids)].join(','));
  }

  agentOption(name: AgentOption) {
    const value = this.read(`agents.${name}`);
    return value === 'on' ? true : value === 'off' ? false : AGENT_OPTIONS[name];
  }

  setAgentOption(name: string, value: string) {
    if (!isAgentOption(name)) throw new Error(`Unknown agent option: ${name}`);
    if (value !== 'on' && value !== 'off') throw new Error(`Use on or off for ${name}`);
    this.write(`agents.${name}`, value);
  }
}
