// The monitor fetches links that customers type in, so it must never be
// pointed at the server's own network (localhost, cloud metadata, private
// ranges). Only public web addresses on the standard ports are allowed, and
// every redirect is checked the same way.

import dns from 'node:dns/promises';
import net from 'node:net';

function v4ToInt(ip) {
  return ip.split('.').reduce((n, x) => (n << 8) + Number(x), 0) >>> 0;
}

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
].map(([base, bits]) => [v4ToInt(base), bits]);

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8:');
  }
  return true;
}

export class BlockedUrlError extends Error {}

/** Throws BlockedUrlError unless `url` is a public http(s) address. */
export async function assertPublicUrl(url, { allowPrivate = false, lookup = dns.lookup } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new BlockedUrlError('Not a valid link'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new BlockedUrlError('Only web links can be checked');
  if (allowPrivate) return;
  if (u.port && u.port !== '80' && u.port !== '443') throw new BlockedUrlError('Only standard web ports can be checked');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new BlockedUrlError("That address isn't on the public internet");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new BlockedUrlError("That website's address couldn't be found"); });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new BlockedUrlError("That address isn't on the public internet");
}

/** fetch() that checks the address first and every redirect hop. */
export async function safeFetch(fetchImpl, url, init, opts) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(current, opts);
    const res = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    return res;
  }
  throw new BlockedUrlError('Too many redirects');
}
