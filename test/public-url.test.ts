import { describe, expect, test } from 'bun:test';

import { assertPublicUrl, isPrivateAddress } from '../src/core/net/public-url.ts';

describe('isPrivateAddress', () => {
  test('flags loopback, private, link-local and reserved ranges', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::1]']) {
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
  const resolveTo = (...addresses: string[]) => async () => addresses;

  test('accepts hosts that resolve only to public addresses', async () => {
    await expect(assertPublicUrl('https://images.example/a.png', resolveTo('93.184.216.34'))).resolves.toBeUndefined();
  });

  test('rejects hosts that resolve to any private address', async () => {
    await expect(assertPublicUrl('https://rebind.example/a.png', resolveTo('93.184.216.34', '127.0.0.1'))).rejects.toThrow('private address');
    await expect(assertPublicUrl('https://nothing.example/a.png', resolveTo())).rejects.toThrow('private address');
  });

  test('rejects private literals and non-http schemes without resolving', async () => {
    const resolve = async () => { throw new Error('should not resolve'); };
    await expect(assertPublicUrl('http://[::1]:3260/', resolve)).rejects.toThrow('private address');
    await expect(assertPublicUrl('http://10.0.0.1/', resolve)).rejects.toThrow('private address');
    await expect(assertPublicUrl('ftp://images.example/a.png', resolve)).rejects.toThrow('Unsupported image URL scheme');
  });
});
