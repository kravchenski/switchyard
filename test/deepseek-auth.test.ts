import { describe, expect, test } from 'bun:test';

import type { DeepSeekAccount } from '../src/providers/deepseek/accounts.ts';
import { normalizeToken } from '../src/core/accounts/token.ts';
import { addDeepSeekAccountFromToken, checkDeepSeekToken } from '../src/providers/deepseek/auth.ts';

const answering = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;

describe('DeepSeek token sign-in', () => {
  test('accepts the userToken value, the whole localStorage JSON, a quoted value or a bearer header', () => {
    expect(normalizeToken('  abc.def  ')).toBe('abc.def');
    expect(normalizeToken('{"value":"abc.def","__version":"0"}')).toBe('abc.def');
    expect(normalizeToken('"abc.def"')).toBe('abc.def');
    expect(normalizeToken('Bearer abc.def')).toBe('abc.def');
  });

  test('checks the token with DeepSeek before saving it', async () => {
    expect(await checkDeepSeekToken('good', answering({ code: 0, data: { biz_code: 0, biz_data: { id: 'user' } } }))).toBeUndefined();
    expect(await checkDeepSeekToken('expired', answering({ code: 40003, msg: 'Authorization Failed (invalid token)', data: null }))).toBe('Authorization Failed (invalid token)');
    expect(await checkDeepSeekToken('blocked', answering({}, 403))).toBe('HTTP 403');
  });

  test('saves a working token as an account and never saves a rejected or empty one', async () => {
    const saved: DeepSeekAccount[] = [];
    const save = (account: DeepSeekAccount) => saved.push(account);
    const id = await addDeepSeekAccountFromToken({ ask: async () => '{"value":"good-token"}', check: async () => undefined, save, replaceId: 'deepseek_1' });
    expect(id).toBe('deepseek_1');
    expect(saved).toEqual([{ id: 'deepseek_1', token: 'good-token', cookies: [], invalid: false, resetAt: null }]);

    await expect(addDeepSeekAccountFromToken({ ask: async () => 'bad', check: async () => 'invalid token', save })).rejects.toThrow('DeepSeek did not accept this token: invalid token');
    await expect(addDeepSeekAccountFromToken({ ask: async () => '   ', check: async () => undefined, save })).rejects.toThrow('No token entered');
    expect(saved).toHaveLength(1);
  });
});
