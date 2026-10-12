// π Pass signing (home server side). MIT License.
//   const signer = loadOrCreateSigningKey('./.passkey.pem');   // Ed25519, file mode 0600
//   const pass   = signPass(signer, { iss, sub, aud, nick_agent, nick_operator, acr });  // 60 s
//   publish { keys: [signer.jwk] } at <your-base>/.well-known/jwks.json
import { randomBytes, createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign } from 'crypto';
import fs from 'fs';

const b64u = buf => Buffer.from(buf).toString('base64url');

export function loadOrCreateSigningKey(file) {
  let pem;
  try { pem = fs.readFileSync(file, 'utf8'); } catch { /* first run */ }
  if (!pem) {
    const { privateKey } = generateKeyPairSync('ed25519');
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.writeFileSync(file, pem, { mode: 0o600 });
  }
  const privateKey = createPrivateKey(pem);
  const publicKey  = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = createHash('sha256').update(jwk.x).digest('hex').slice(0, 16);
  return { privateKey, publicKey, jwk: { ...jwk, kid, alg: 'EdDSA', use: 'sig' }, kid };
}

export function signPass(signer, claims) {
  const header  = { alg: 'EdDSA', typ: 'pi-pass', kid: signer.kid };
  const now     = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + 60, jti: randomBytes(8).toString('hex'), ...claims };
  const data    = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  return `${data}.${b64u(edSign(null, Buffer.from(data), signer.privateKey))}`;
}

