// π Pass verifier - for any server that receives a mounted call from a π home server.
// MIT License. No dependencies beyond Node's crypto and global fetch (Node 18+).
//
//   import { createPassVerifier } from './pi-pass-verify.js';
//   const passes = createPassVerifier({
//     pirIdUrl:     'https://pitr.network/pir/id',            // PIR public lookup (GET ?id=<public π>)
//     trustedHomes: ['https://pitr.network', 'https://314.pitr.network'],   // origins you accept as a home
//   });
//   const id = await passes.verify(req.headers['x-pi-pass'], `https://${req.headers.host}`);
//   // id = { public_pi, nick_agent, nick_operator, key_verified, home } or null
//
// What a valid pass proves: the home server PIR registers for that public π signed it, for THIS
// audience, within the last minute. It does not prove the pair is allowed to do anything here:
// authorize on id.public_pi (an allow-list) as before. key_verified (acr "pi:key") is the home's
// own assertion and is only as trustworthy as the home: keep trustedHomes short.
//
// Trust chain: pass.sub -> PIR record -> gateway_mcp (the registered home) -> its published key
// (<home>/.well-known/jwks.json) -> signature. The claim `iss` is informational only; the key is
// always fetched from where PIR says the pair's home is, so a pass can't vouch for a pair whose
// home is somewhere else.

import { createPublicKey, verify as edVerify } from 'crypto';

const PUBLIC_PI_RE = /^3\.14\d{10}$/;
const b64u = s => Buffer.from(String(s), 'base64url');

function homeBase(gatewayMcp) {
  let u;
  try { u = new URL(String(gatewayMcp)); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const path = u.pathname.replace(/\/mcp\/?$/, '').replace(/\/+$/, '');
  return { origin: u.origin, base: `${u.origin}${path}` };
}

export function createPassVerifier({ pirIdUrl, trustedHomes, timeoutMs = 5000, cacheMs = 10 * 60_000 }) {
  if (!pirIdUrl) throw new Error('pirIdUrl required');
  if (!Array.isArray(trustedHomes) || !trustedHomes.length) throw new Error('trustedHomes required');
  const trusted = new Set(trustedHomes.map(h => new URL(h).origin));
  const jwksCache = new Map();   // jwks url -> { keys, at }
  const lastForce = new Map();   // jwks url -> last forced refetch (rotation), rate limited

  async function getJson(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!r.ok) return null;
    const text = await r.text();
    if (text.length > 65_536) return null;
    return JSON.parse(text);
  }

  async function keyFor(jwksUrl, kid) {
    const hit = jwksCache.get(jwksUrl);
    let keys = hit && Date.now() - hit.at < cacheMs ? hit.keys : null;
    let k = keys?.find(x => x.kid === kid);
    if (!k && (!keys || Date.now() - (lastForce.get(jwksUrl) ?? 0) > 60_000)) {
      lastForce.set(jwksUrl, Date.now());
      const doc = await getJson(jwksUrl).catch(() => null);
      keys = Array.isArray(doc?.keys) ? doc.keys : [];
      jwksCache.set(jwksUrl, { keys, at: Date.now() });
      k = keys.find(x => x.kid === kid);
    }
    return k ?? null;
  }

  async function verify(token, audience) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || !audience) return null;
    let header, claims;
    try {
      header = JSON.parse(b64u(parts[0]).toString('utf8'));
      claims = JSON.parse(b64u(parts[1]).toString('utf8'));
    } catch { return null; }
    if (header.alg !== 'EdDSA' || header.typ !== 'pi-pass' || !header.kid) return null;
    if (!PUBLIC_PI_RE.test(String(claims.sub)) || claims.aud !== audience) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp < now || claims.exp > now + 300) return null;
    if (typeof claims.iat === 'number' && claims.iat > now + 60) return null;

    // Where does PIR say this pair lives?
    let rec;
    try { rec = await getJson(`${pirIdUrl}${pirIdUrl.includes('?') ? '&' : '?'}id=${encodeURIComponent(claims.sub)}`); } catch { return null; }
    const home = homeBase(rec?.gateway_mcp);
    if (!home || !trusted.has(home.origin)) return null;

    const jwk = await keyFor(`${home.base}/.well-known/jwks.json`, header.kid);
    if (!jwk) return null;
    try {
      const ok = edVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), b64u(parts[2]));
      if (!ok) return null;
    } catch { return null; }

    return {
      public_pi: claims.sub, nick_agent: rec.nick_agent ?? null, nick_operator: rec.nick_operator ?? null,
      key_verified: claims.acr === 'pi:key', home: rec.gateway_mcp,
    };
  }

  return { verify };
}
