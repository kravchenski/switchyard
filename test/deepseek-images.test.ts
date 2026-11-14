import { afterEach, describe, expect, mock, test } from 'bun:test';

const pow = await import('../src/providers/deepseek/pow.ts');
mock.module('../src/providers/deepseek/pow.ts', () => ({ ...pow, solveDeepSeekPow: async () => 'pow' }));

import { completionRejection, deepSeekCompletion, fileStatuses, uploadedFileId } from '../src/providers/deepseek/client.ts';
import { setDeepSeekFetch } from '../src/providers/deepseek/bridge.ts';
import { createDeepSeekProvider } from '../src/providers/deepseek/provider.ts';

describe('DeepSeek images', () => {
  test('reads the uploaded file id from the usual answer shapes', () => {
    expect(uploadedFileId({ code: 0, data: { biz_code: 0, biz_data: { id: 'file-1', status: 'PENDING' } } })).toBe('file-1');
    expect(uploadedFileId({ data: { biz_data: { file_id: 'file-2' } } })).toBe('file-2');
    expect(uploadedFileId({ data: { biz_data: {} } })).toBeUndefined();
  });

  test('reads file statuses from a list or a map', () => {
    expect([...fileStatuses({ data: { biz_data: { files: [{ id: 'a', status: 'success' }, { id: 'b', status: 'PENDING' }] } } })]).toEqual([['a', 'SUCCESS'], ['b', 'PENDING']]);
    expect([...fileStatuses({ data: { biz_data: { a: { status: 'PARSE_FAILED' } } } })]).toEqual([['a', 'PARSE_FAILED']]);
  });

  test('marks DeepSeek models as able to read images', () => {
    expect(createDeepSeekProvider({ hasAccount: () => true }).capabilities('deepseek-default').vision).toBeTrue();
  });

  test('reads why DeepSeek answered with JSON instead of a stream', () => {
    expect(completionRejection({ code: 0, msg: '', data: { biz_code: 1, biz_msg: 'invalid chat session id', biz_data: null } })).toBe('invalid chat session id');
    expect(completionRejection({ code: 40003, msg: 'INVALID_TOKEN', data: null })).toBe('INVALID_TOKEN');
    expect(completionRejection({ code: 0, data: { biz_code: 0, biz_data: {} } })).toBeUndefined();
  });

  test('reports an expired account token as an auth error', async () => {
    setDeepSeekFetch(async () => Response.json({ code: 40003, msg: 'Authorization Failed (invalid token)', data: null }));
    try {
      await expect(deepSeekCompletion({ messages: [{ role: 'user', content: 'hi' }], conversationId: `expired-${Date.now()}`, account: { id: 'env', token: 'expired', cookies: [] } }))
        .rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('bun run auth:deepseek') });
    } finally {
      setDeepSeekFetch(null);
    }
  });

  describe('uploaded image reuse', () => {
    const image = (tag: string) => `data:image/png;base64,${Buffer.from(`${tag}-${Date.now()}-${Math.random()}`).toString('base64')}`;
    const png = image('first');
    const account = { id: `images-${Date.now()}`, token: 't', cookies: [] };
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: png } }] }];

    function fakeDeepSeek() {
      const calls = { uploads: 0, completions: [] as string[][], rejectNext: false };
      setDeepSeekFetch(async (input, init) => {
        const url = String(input);
        if (url.includes('/chat_session/create')) return Response.json({ data: { biz_data: { id: 'session-1' } } });
        if (url.includes('/create_pow_challenge')) {
          return Response.json({ data: { biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', expire_at: 1, difficulty: 1, signature: 'x', target_path: '/' } } } });
        }
        if (url.includes('/file/upload_file')) return Response.json({ data: { biz_data: { id: `file-${++calls.uploads}`, status: 'PENDING' } } });
        if (url.includes('/file/fetch_files')) {
          const ids = new URL(url).searchParams.getAll('file_ids');
          return Response.json({ data: { biz_data: { files: ids.map(id => ({ id, status: 'SUCCESS' })) } } });
        }
        if (url.includes('/chat/completion')) {
          calls.completions.push(JSON.parse(String(init?.body)).ref_file_ids);
          if (calls.rejectNext) {
            calls.rejectNext = false;
            return Response.json({ code: 0, data: { biz_code: 1, biz_msg: 'file not found', biz_data: null } });
          }
          return new Response('data: {"v":"ok"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
        }
        return new Response('unexpected', { status: 500 });
      });
      return calls;
    }

    afterEach(() => setDeepSeekFetch(null));

    test('uploads an image once and reuses its file on later turns', async () => {
      const calls = fakeDeepSeek();
      await deepSeekCompletion({ messages, conversationId: 'turns', account });
      await deepSeekCompletion({ messages, conversationId: 'turns', account });
      expect(calls.uploads).toBe(1);
      expect(calls.completions).toEqual([['file-1'], ['file-1']]);
    });

    test('uploads the image again when DeepSeek rejects a reused file', async () => {
      const calls = fakeDeepSeek();
      const fresh = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image('second') } }] }];
      await deepSeekCompletion({ messages: fresh, conversationId: 'stale-file', account });
      calls.rejectNext = true;
      await deepSeekCompletion({ messages: fresh, conversationId: 'stale-file', account });
      expect(calls.uploads).toBe(2);
      expect(calls.completions).toEqual([['file-1'], ['file-1'], ['file-2']]);
    });
  });
});
