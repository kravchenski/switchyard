import { webChatModelSlug, type BrowserChatSession, type ChatSite, type WebChatModel } from '../browser/browser-chat.ts';
import { ProviderError } from '../core/providers/errors.ts';
import type { ChatChunk, ChatRequest, Provider, ProviderHealth, ProviderStream } from '../core/providers/provider.ts';
import { collectImageUrls, messagesToPrompt, stripImages } from '../core/providers/prompt.ts';
import { primeChunks } from '../core/streaming/sse.ts';

export interface ProfileSession {
  profile: string;
  session: Pick<BrowserChatSession, 'send'> & Partial<Pick<BrowserChatSession, 'solveVerification'>>;
}

export interface BrowserChatProviderConfig {
  id: string;
  ownedBy: string;
  model: string;
  site: ChatSite;
  sessions: () => ProfileSession[];
  sessionsFor?: (request: ChatRequest) => ProfileSession[];
  parse: (bytes: AsyncIterable<Uint8Array>) => AsyncIterable<ChatChunk>;
  reasoning?: boolean;
  health?: () => ProviderHealth;
  onResult?: (profile: string, ok: boolean) => void;
  models?: () => WebChatModel[] | undefined;
  ensureSignIn?: () => Promise<void>;
  pin?: (request: ChatRequest, profile: string) => void;
  recoveryDelayMs?: number;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createBrowserChatProvider(config: BrowserChatProviderConfig): Provider {
  const prefix = `${config.model}/`;
  const listed = () => config.models?.() ?? [];
  const models = () => {
    const known = listed();
    return known.length ? known : config.site.defaultModels ?? [];
  };
  const upstreamModel = (model: string) => {
    if (!model.startsWith(prefix)) return undefined;
    const slug = model.slice(prefix.length);
    const found = models().find(entry => webChatModelSlug(entry.name) === slug)?.id;
    if (found) return found;
    if (listed().length) throw new ProviderError(`${config.id}: model ${model} is not offered by the site; see GET /v1/models`, 'model_unavailable');
    return slug;
  };
  return {
    id: config.id,
    ownedBy: config.ownedBy,
    supports: model => model === config.model || model.startsWith(prefix),
    listModels: async () => [config.model, ...models().map(entry => `${prefix}${webChatModelSlug(entry.name)}`)],
    capabilities: () => ({ nativeTools: false, reasoning: config.reasoning ?? true, vision: config.site.images === true }),
    health: () => config.health?.() ?? { available: true },
    async stream(request): Promise<ProviderStream> {
      const model = upstreamModel(request.model);
      const select = config.sessionsFor ? () => config.sessionsFor!(request) : config.sessions;
      let candidates = select();
      if (!candidates.length && config.ensureSignIn) {
        await config.ensureSignIn();
        candidates = select();
      }
      if (!candidates.length) throw new ProviderError(`${config.id}: no account is signed in`, 'unavailable');
      const supported = config.site.images === true;
      const prompt = messagesToPrompt(stripImages(request.messages, supported));
      const extractImages = (messages: Record<string, any>[]) => supported ? collectImageUrls(messages) : [];
      const failures: string[] = [];
      const recovered = { signIn: false, verification: false };
      let transientRetries = 0;
      for (const candidate of candidates) {
        for (;;) {
          try {
            const chunks = await primeChunks(config.parse(await candidate.session.send(config.site, prompt, model, {
              conversationId: request.conversationId,
              messages: request.messages,
              toPrompt: messages => messagesToPrompt(stripImages(messages, supported)),
              extractImages,
            })));
            config.onResult?.(candidate.profile, true);
            config.pin?.(request, candidate.profile);
            return { chunks };
          } catch (error) {
            config.onResult?.(candidate.profile, false);
            const kind = error instanceof ProviderError ? error.kind : undefined;
            const auth = kind === 'auth';
            const verification = !auth && /verification|verify you are human/i.test(message(error));
            if (auth && !recovered.signIn && config.ensureSignIn) {
              recovered.signIn = true;
              await config.ensureSignIn();
              continue;
            }
            if (verification && !recovered.verification && candidate.session.solveVerification) {
              recovered.verification = true;
              await candidate.session.solveVerification(config.site);
              continue;
            }
            if ((kind === 'rate_limit' || kind === 'upstream') && transientRetries < 2) {
              transientRetries++;
              await Bun.sleep((config.recoveryDelayMs ?? 5_000) * transientRetries);
              continue;
            }
            if (candidates.length === 1) throw error;
            failures.push(`${candidate.profile}: ${message(error)}`);
            break;
          }
        }
      }
      throw new ProviderError(`${config.id} failed on every account: ${failures.join('; ')}`, 'unavailable');
    },
  };
}

export async function* bytesToLines(bytes: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of bytes) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) yield trimmed;
    }
  }
  const rest = (pending + decoder.decode()).trim();
  if (rest) yield rest;
}
