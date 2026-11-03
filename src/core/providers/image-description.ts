import { imageUrl, isImagePart, OMITTED_IMAGE } from './prompt.ts';
import type { ChatMessage } from './provider.ts';

const MAX_DESCRIBED_IMAGES = 4;
const MAX_DESCRIPTION_CHARS = 8000;
const MAX_REQUEST_CHARS = 600;
const CACHE_ENTRIES = 128;

const DESCRIBE_INSTRUCTION = 'Describe this image in as much detail as you can, for a reader who cannot see it and has to work from your description alone. Transcribe all visible text, code, error messages and numbers exactly as written. Describe the layout, interface elements, charts (axes, series, values), diagrams, colors and anything unusual. State only what is visible; do not guess.';

export type DescribeImage = (image: string, request: string) => Promise<string>;

export class DescriptionCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly limit = CACHE_ENTRIES) {}

  get(key: string) {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: string) {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
}

export function describeMessages(image: string, request: string): ChatMessage[] {
  const text = request
    ? `${DESCRIBE_INSTRUCTION}\n\nThe message the image came with, so you know what matters in it:\n${request}`
    : DESCRIBE_INSTRUCTION;
  return [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: image } }] }];
}

function imageKey(url: string) {
  return new Bun.CryptoHasher('sha256').update(url).digest('hex');
}

function requestText(message: ChatMessage) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts
    .flatMap((part: any) => typeof part?.text === 'string' ? [part.text] : [])
    .join('\n')
    .trim()
    .slice(0, MAX_REQUEST_CHARS);
}

async function describeOnce(describe: DescribeImage, url: string, request: string) {
  try {
    return (await describe(url, request)).trim().slice(0, MAX_DESCRIPTION_CHARS) || undefined;
  } catch {
    return undefined;
  }
}

export async function describeImages(messages: ChatMessage[], describe: DescribeImage, cache: DescriptionCache, limit = MAX_DESCRIBED_IMAGES) {
  const wanted = new Map<string, string>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const content = messages[index]?.content;
    if (!Array.isArray(content)) continue;
    for (const part of [...content].reverse()) {
      const url = isImagePart(part) ? imageUrl(part) : undefined;
      if (url && !wanted.has(url) && wanted.size < limit) wanted.set(url, requestText(messages[index]!));
    }
  }

  const descriptions = new Map<string, string>();
  let unavailable = false;
  for (const [url, request] of wanted) {
    const key = imageKey(url);
    const cached = cache.get(key);
    if (cached !== undefined) {
      descriptions.set(url, cached);
      continue;
    }
    if (unavailable) continue;
    const text = await describeOnce(describe, url, request);
    if (text === undefined) {
      unavailable = true;
      continue;
    }
    cache.set(key, text);
    descriptions.set(url, text);
  }

  let described = 0;
  let omitted = 0;
  let number = 0;
  const rebuilt = messages.map(message => {
    if (!Array.isArray(message?.content) || !message.content.some(isImagePart)) return message;
    const parts = message.content.map((part: any) => {
      if (!isImagePart(part)) return typeof part?.text === 'string' ? part.text : typeof part === 'string' ? part : JSON.stringify(part ?? '');
      const url = imageUrl(part);
      const description = url ? descriptions.get(url) : undefined;
      if (description === undefined) {
        omitted++;
        return OMITTED_IMAGE;
      }
      described++;
      return `[Image ${++number} from the user, described by a vision model because you cannot see images:\n${description}]`;
    });
    return { ...message, content: parts.join('\n') };
  });
  return { messages: rebuilt, described, omitted };
}
