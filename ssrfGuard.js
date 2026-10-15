// SSRF egress guard for mount (toolEnter) and post (fireUrl) — both let a caller
// point this server's own fetch at an arbitrary URL. Blocks loopback/private/link-local
// (incl. cloud metadata 169.254.169.254) targets, and resolves DNS itself so the
// same lookup used to validate is the one used to connect (no rebind TOCTOU gap).
//
// IP literals never reach the DNS lookup hook, so they are checked up front: brackets are stripped from
// IPv6 hosts, every IPv6 form that embeds an IPv4 address (mapped hex and dotted, compatible, NAT64, 6to4)
// is unwrapped and checked, and redirects are followed by hand so each hop is validated, not only the
// first URL.
import { fetch as undiciFetch, Agent } from 'undici';
import dns from 'node:dns';
import net from 'node:net';

const MAX_REDIRECTS = 4;

export function isBlockedIpv4(ip) {
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

// Eight 16-bit groups from any valid IPv6 text form (handles "::" and a trailing dotted IPv4).
function expandIpv6(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length > 1 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail].map(g => parseInt(g || '0', 16));
  return groups.length === 8 ? groups : null;
}

function v4FromGroups(hi, lo) {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isBlockedIp(ipIn) {
  const ip = String(ipIn).replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (!net.isIPv6(ip)) return false;
  const g = expandIpv6(ip);
  if (!g) return true;                                              // cannot parse: refuse
  const allZeroTo = n => g.slice(0, n).every(x => x === 0);
  if (allZeroTo(7) && (g[7] === 0 || g[7] === 1)) return true;      // :: and ::1
  if (allZeroTo(5) && g[5] === 0xffff) return isBlockedIpv4(v4FromGroups(g[6], g[7])); // ::ffff:a.b.c.d (mapped)
  if (allZeroTo(6)) return isBlockedIpv4(v4FromGroups(g[6], g[7])); // ::a.b.c.d (compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isBlockedIpv4(v4FromGroups(g[6], g[7])); // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return isBlockedIpv4(v4FromGroups(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true;                   // Teredo 2001::/32
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;               // documentation
  if ((g[0] & 0xffc0) === 0xfe80) return true;                      // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;                      // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xfe00) === 0xfc00) return true;                      // fc00::/7 ULA
  if ((g[0] & 0xff00) === 0xff00) return true;                      // ff00::/8 multicast
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

export function assertUrlAllowed(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Egress blocked: unsupported protocol ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || /^localhost$/i.test(host) || /\.localhost$/i.test(host)) {
    throw new Error(`Egress blocked: ${u.hostname} is a restricted address`);
  }
  // An IP literal never goes through the DNS lookup hook, so it is checked here.
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new Error(`Egress blocked: ${u.hostname} is a restricted address`);
  }
  return u;
}

export async function safeFetch(url, opts = {}) {
  let current = assertUrlAllowed(url).toString();
  let init = { ...opts, dispatcher: ssrfAgent, redirect: 'manual' };
  for (let hop = 0; ; hop++) {
    const res = await undiciFetch(current, init);
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc || opts.redirect === 'manual' || opts.redirect === 'error') return res;
    if (hop >= MAX_REDIRECTS) throw new Error('Egress blocked: too many redirects');
    try { await res.body?.cancel(); } catch { /* ignore */ }
    const next = new URL(loc, current).toString();
    assertUrlAllowed(next);                                          // every hop is validated
    const method = (init.method || 'GET').toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      init = { ...init, method: 'GET', body: undefined };
    }
    current = next;
  }
}
