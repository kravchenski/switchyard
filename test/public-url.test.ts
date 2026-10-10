import type dns from 'node:dns';
import { describe, expect, test } from 'bun:test';

import { assertPublicUrl, createPublicLookup, isPrivateAddress } from '../src/core/net/public-url.ts';

describe('isPrivateAddress', () => {
  test('flags loopback, private, link-local and reserved ranges', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::1]', '64:ff9b::7f00:1', '2002:7f00:1::1']) {
      expect(isPrivateAddress(address)).toBeTrue();
    }
  });

  test('allows public addresses', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(address)).toBeFalse();
    }
  });
});

describe('assertPublicUrl', () => {
  test('accepts http and https hosts', () => {
    expect(() => assertPublicUrl('https://images.example/a.png')).not.toThrow();
    expect(() => assertPublicUrl('http://93.184.216.34/a.png')).not.toThrow();
  });

  test('rejects private literals and other schemes', () => {
    expect(() => assertPublicUrl('http://[::1]:3260/')).toThrow('private address');
    expect(() => assertPublicUrl('http://10.0.0.1/')).toThrow('private address');
    expect(() => assertPublicUrl('http://2130706433/')).toThrow('private address');
    expect(() => assertPublicUrl('ftp://images.example/a.png')).toThrow('Unsupported image URL scheme');
  });
});

describe('createPublicLookup', () => {
  const resolveTo = (...addresses: string[]) => ((_host: string, _options: unknown, callback: (error: null, found: dns.LookupAddress[]) => void) =>
    callback(null, addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 })))) as never;

  const run = (lookup: ReturnType<typeof createPublicLookup>, all: boolean) =>
    new Promise<{ error: Error | null; address: unknown }>(resolve =>
      lookup('images.example', { all }, (error, address) => resolve({ error, address })));

  test('passes public addresses through in both callback shapes', async () => {
    const lookup = createPublicLookup(resolveTo('93.184.216.34'));
    expect(await run(lookup, false)).toEqual({ error: null, address: '93.184.216.34' });
    expect((await run(lookup, true)).address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  test('fails when any resolved address is private or none is found', async () => {
    expect((await run(createPublicLookup(resolveTo('93.184.216.34', '127.0.0.1')), false)).error?.message).toContain('private address');
    expect((await run(createPublicLookup(resolveTo()), false)).error?.message).toContain('private address');
  });
});
