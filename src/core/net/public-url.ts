import { lookup } from 'node:dns/promises';
import net from 'node:net';

export type Resolve = (hostname: string) => Promise<string[]>;

const systemResolve: Resolve = async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(entry => entry.address);

function isPrivateIpv4(address: string) {
  const [a = 0, b = 0] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function mappedIpv4(address: string) {
  const rest = address.slice('::ffff:'.length);
  if (net.isIPv4(rest)) return rest;
  const groups = rest.split(':');
  if (groups.length !== 2) return null;
  const [high, low] = groups.map(group => Number.parseInt(group, 16));
  if (high === undefined || low === undefined || Number.isNaN(high) || Number.isNaN(low)) return null;
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

export function isPrivateAddress(address: string) {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (!net.isIPv6(ip)) return true;
  if (ip.startsWith('::ffff:')) {
    const v4 = mappedIpv4(ip);
    return v4 === null || isPrivateIpv4(v4);
  }
  const [first = '', second = ''] = ip.split(':');
  if (first === '') return true;
  const value = Number.parseInt(first, 16);
  if (value === 0x2002 || (value === 0x64 && Number.parseInt(second, 16) === 0xff9b)) return true;
  return (value & 0xfe00) === 0xfc00 || (value & 0xffc0) === 0xfe80 || (value & 0xff00) === 0xff00;
}

export async function assertPublicUrl(value: string, resolve: Resolve = systemResolve) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Unsupported image URL scheme: ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : await resolve(host);
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new Error(`Refusing to download from a private address: ${url.hostname}`);
  }
}
