import { describe, expect, test } from 'bun:test';

import { describeImages, describeMessages, DescriptionCache } from '../src/core/providers/image-description.ts';

const PNG = 'data:image/png;base64,QUJD';
const JPG = 'data:image/jpeg;base64,REVG';

function userImage(text: string, ...urls: string[]) {
  return { role: 'user', content: [{ type: 'text', text }, ...urls.map(url => ({ type: 'image_url', image_url: { url } }))] };
}

function recorder(answer = (url: string) => `a picture of ${url.slice(-6)}`) {
  const calls: Array<{ url: string; request: string }> = [];
  return { calls, describe: async (url: string, request: string) => { calls.push({ url, request }); return answer(url); } };
}

describe('describeImages', () => {
  test('replaces image parts with a description and keeps the text', async () => {
    const { calls, describe } = recorder(() => 'a bar chart with three bars');
    const result = await describeImages([userImage('what does this show?', PNG)], describe, new DescriptionCache());
    expect(result).toMatchObject({ described: 1, omitted: 0 });
    const content = result.messages[0]!.content as string;
    expect(content).toContain('what does this show?');
    expect(content).toContain('a bar chart with three bars');
    expect(content).toContain('Image 1');
    expect(JSON.stringify(result.messages)).not.toContain('image_url');
    expect(calls).toEqual([{ url: PNG, request: 'what does this show?' }]);
  });

  test('describes anthropic style image blocks too', async () => {
    const { calls, describe } = recorder();
    const message = { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }, { type: 'text', text: 'read it' }] };
    const result = await describeImages([message], describe, new DescriptionCache());
    expect(result.described).toBe(1);
    expect(calls[0]!.url).toBe(PNG);
  });

  test('describes a repeated image once and reuses the cache on the next request', async () => {
    const { calls, describe } = recorder();
    const cache = new DescriptionCache();
    const first = [userImage('one', PNG), { role: 'assistant', content: 'ok' }, userImage('two', PNG)];
    const result = await describeImages(first, describe, cache);
    expect(result.described).toBe(2);
    expect(calls).toHaveLength(1);
    await describeImages([...first, { role: 'assistant', content: 'sure' }, { role: 'user', content: 'and now?' }], describe, cache);
    expect(calls).toHaveLength(1);
  });

  test('marks images as omitted when the describer fails and stops asking', async () => {
    const calls: string[] = [];
    const describe = async (url: string) => { calls.push(url); throw new Error('no vision model'); };
    const result = await describeImages([userImage('look', PNG, JPG)], describe, new DescriptionCache());
    expect(result).toMatchObject({ described: 0, omitted: 2 });
    expect(result.messages[0]!.content).toBe('look\n[image omitted: this model cannot process images]\n[image omitted: this model cannot process images]');
    expect(calls).toHaveLength(1);
  });

  test('treats an empty description as a failure', async () => {
    const result = await describeImages([userImage('look', PNG)], async () => '  ', new DescriptionCache());
    expect(result).toMatchObject({ described: 0, omitted: 1 });
  });

  test('describes only the latest images up to the limit', async () => {
    const { calls, describe } = recorder();
    const urls = ['https://img.test/1.png', 'https://img.test/2.png', 'https://img.test/3.png'];
    const messages = urls.map((url, index) => userImage(`image ${index + 1}`, url));
    const result = await describeImages(messages, describe, new DescriptionCache(), 2);
    expect(result).toMatchObject({ described: 2, omitted: 1 });
    expect(calls.map(call => call.url)).toEqual([urls[2]!, urls[1]!]);
    expect(result.messages[0]!.content).toContain('[image omitted');
  });

  test('leaves messages without images untouched', async () => {
    const { calls, describe } = recorder();
    const messages = [{ role: 'user', content: 'hello' }, { role: 'user', content: [{ type: 'text', text: 'plain parts' }] }];
    const result = await describeImages(messages, describe, new DescriptionCache());
    expect(result.messages[0]).toBe(messages[0]!);
    expect(result.messages[1]).toBe(messages[1]!);
    expect(calls).toEqual([]);
  });

  test('forgets the oldest description once the cache is full', () => {
    const cache = new DescriptionCache(2);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.get('a');
    cache.set('c', '3');
    expect(cache.get('a')).toBe('1');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('3');
  });
});

describe('describeMessages', () => {
  test('asks for a detailed description and carries the original request', () => {
    const [message] = describeMessages(PNG, 'why does the build fail?');
    const [text, image] = message!.content as Array<Record<string, any>>;
    expect(text.text).toContain('Describe this image in as much detail as you can');
    expect(text.text).toContain('why does the build fail?');
    expect(image.image_url.url).toBe(PNG);
  });

  test('works without an original request', () => {
    const [message] = describeMessages(PNG, '');
    expect((message!.content as Array<Record<string, any>>)[0]!.text).not.toContain('The message the image came with');
  });
});
