import { describe, expect, test } from 'bun:test';

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
});
