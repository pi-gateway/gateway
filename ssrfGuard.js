// SSRF egress guard for mount (toolEnter) and post (fireUrl) — both let a caller
// point this server's own fetch at an arbitrary URL. Blocks loopback/private/link-local
// (incl. cloud metadata 169.254.169.254) targets, and resolves DNS itself so the
// same lookup used to validate is the one used to connect (no rebind TOCTOU gap).
import { fetch as undiciFetch, Agent } from 'undici';
import dns from 'node:dns';
import net from 'node:net';

function isBlockedIpv4(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 127) return true;                         // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true;    // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true;// 198.18.0.0/15 benchmarking
  if (a >= 224) return true;                           // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isBlockedIp(ip) {
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (/^fe[89ab]/.test(low)) return true;            // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{0,2}:/.test(low)) return true;  // fc00::/7 ULA
    if (low.startsWith('::ffff:')) {
      const v4 = low.split(':').pop();
      if (net.isIPv4(v4)) return isBlockedIpv4(v4);
    }
    return false;
  }
  return false;
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses?.length) return callback(new Error(`DNS resolution for ${hostname} returned no addresses`));
    const blocked = addresses.find(a => isBlockedIp(a.address));
    if (blocked) return callback(new Error(`Egress blocked: ${hostname} resolves to restricted address ${blocked.address}`));
    // Caller's `options.all` dictates the expected callback shape — net/undici
    // request array-style here, plain dns.lookup callers want a single address.
    if (options?.all) return callback(null, addresses);
    const chosen = addresses[0];
    callback(null, chosen.address, chosen.family);
  });
}

// One shared agent: connect.lookup runs at actual TCP-connect time for every
// request made through it, so validation and connection always see the same address.
const ssrfAgent = new Agent({ connect: { lookup: safeLookup } });

export async function safeFetch(url, opts = {}) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Egress blocked: unsupported protocol ${u.protocol}`);
  }
  if (net.isIP(u.hostname) && isBlockedIp(u.hostname)) {
    throw new Error(`Egress blocked: ${u.hostname} is a restricted address`);
  }
  return undiciFetch(url, { ...opts, dispatcher: ssrfAgent });
}
