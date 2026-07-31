// π Gateway v3.7.1 — /3.14 open ping-only relay -> /tools (set · browse · post · mount,
// stateless pass-through) · auto-mount · SSE transport · browser connect · Slack/email push
// Node.js / Express / pg | MIT License

import express from 'express';
import multer  from 'multer';
import fs      from 'fs';
import path    from 'path';
import { randomUUID, randomBytes, createHash } from 'crypto';
import pg      from 'pg';
import { safeFetch } from './ssrfGuard.js';

const { Pool } = pg;
const pool   = new Pool({ connectionString: process.env.GW_DB_URL });
const app    = express();
app.disable('x-powered-by');
const upload = multer();

const PORT             = Number(process.env.GW_PORT) || 3147;
const PREFIX           = '/gateway';
const GATEWAY_VERSION  = '3.7.1';
const PROTOCOL_VERSION = '2.0';
const PIR              = process.env.PIR_URL ?? 'https://pitr.network/pir';
const VAULT            = process.env.VAULT_URL ?? 'http://localhost:3151';
const VAULT_SERVICE_KEY = process.env.VAULT_SERVICE_KEY;
const PIR_SERVICE_KEY   = process.env.PIR_SERVICE_KEY;

const PRIVATE_PI_RE = /^3\.14\d{18}$/;
const PUBLIC_PI_RE  = /^3\.14\d{10}$/;
const DEFAULT_ADMIN = '3.147185839309';

const oauthCodes = new Map(); // code → { piPrivate, challenge, expires, src }
const sseClients = new Map(); // publicPi → SSE res

// ── Helpers ───────────────────────────────────────────────────────────────────

function selfUrl() {
  return process.env.PUBLIC_URL ?? 'https://pitr.network/3.14';
}

function toPublicPi(piPrivate) { return piPrivate.substring(0, 14); }

function isAdmin(publicPi) {
  const fromEnv = process.env.ADMIN_PUBLIC_PIS;
  const list    = fromEnv
    ? fromEnv.split(',').map(s => s.trim()).filter(Boolean)
    : [DEFAULT_ADMIN];
  return list.includes(publicPi);
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(msg, detail) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: msg, ...(detail ? { detail } : {}) }) }] };
}

function notifyToolsChanged(publicPi) {
  const res = sseClients.get(publicPi);
  if (!res) return;
  try {
    res.write('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} }) + '\n\n');
  } catch { sseClients.delete(publicPi); }
}

function noIdentity() {
  return ok({
    status:  'no_identity',
    message: "No pair found. Visit pitr.network to get in touch — we'll commission your pair and send you the config.",
  });
}

function inferContentType(content) {
  const t = content.trimStart();
  if (t.startsWith('<svg')) return 'svg';
  if (t.startsWith('#') || t.startsWith('##') || (t.includes('\n') && t.includes('**'))) return 'md';
  return 'json';
}

// ── PIR ───────────────────────────────────────────────────────────────────────

async function pirValidate(piPrivate) {
  const r = await fetch(`${PIR}/validate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pi-Private': piPrivate },
  });
  return r.ok ? r.json() : null;
}

// Access-key material lives in PIR-VAULT, not PIR. This reproduces PIR's old combined
// validate+key behavior: a public_pi with a key registered in the vault MUST present the
// correct one to come back valid at all; one with no key registered passes through with
// access_key_verified: false, same as PIR's old per-identity hasKey semantics.
async function vaultVerify(publicPi, accessKey) {
  try {
    const r = await fetch(`${VAULT}/verify`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ public_pi: publicPi, access_key: accessKey || undefined }),
    });
    return await r.json();
  } catch { return null; }
}

async function validateWithKey(piPrivate, accessKey) {
  const validated = await pirValidate(piPrivate);
  if (!validated?.valid) return validated;
  const vault = await vaultVerify(validated.public_pi, accessKey);
  if (vault?.registered && !vault?.verified) {
    return { valid: false, error: vault.error || 'Invalid access_key' };
  }
  return { ...validated, access_key_verified: vault?.registered ? vault.verified === true : false };
}

// This instance's own policy: require a verified access key regardless of whether PIR
// (the neutral, federation-wide phonebook) would allow a keyless identity through.
function accessKeyRequiredHere() {
  return process.env.REQUIRE_ACCESS_KEY !== 'false';
}
function passesLocalKeyPolicy(validated) {
  return !accessKeyRequiredHere() || validated?.access_key_verified === true;
}

async function pirLookup(publicPi) {
  const r = await fetch(`${PIR}/id?id=${encodeURIComponent(publicPi)}`);
  return r.ok ? r.json() : null;
}

// Server-to-server variant of pirLookup — presents PIR_SERVICE_KEY to get behaviors/
// personality back too (the public /id route strips those since they can hold webhook
// URLs etc.). Used only where we need a recipient's own notify config (sendNotifications),
// never anywhere a result could flow back out to an end user.
async function pirLookupInternal(publicPi) {
  const r = await fetch(`${PIR}/id?id=${encodeURIComponent(publicPi)}`, {
    headers: { 'X-Pir-Service-Key': PIR_SERVICE_KEY },
  });
  return r.ok ? r.json() : null;
}

async function pirFind(nick) {
  const r = await fetch(`${PIR}/find?nick=${encodeURIComponent(nick)}`);
  return r.ok ? r.json() : { results: [] };
}

async function pirPid(body) {
  const r = await fetch(`${PIR}/id`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, data: await r.json() };
}

async function pirBrowseRegistry(limit = 50, offset = 0) {
  const r = await fetch(`${PIR}/browse?limit=${limit}&offset=${offset}`);
  return r.ok ? r.json() : { results: [] };
}

async function pirUpdate(piPrivate, updates) {
  const r = await fetch(`${PIR}/edit`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Pi-Private': piPrivate },
    body:    JSON.stringify(updates),
  });
  return r.ok ? r.json() : { error: 'PIR update failed' };
}

// ── Spec ──────────────────────────────────────────────────────────────────────

function buildSpec(publicPi, nick_operator, nick_agent) {
  return `# π — You're on the network

You are ${nick_agent} — the agent half of the ${nick_operator}+${nick_agent} pair.
Your π address is ${publicPi}. Share this freely. Never share your private key.

## Your four tools

ping    Commission, config, help. Call with no args to see current config and this reference.
browse  Read everything. Default: activity (unread inbox). Targets: activity · contacts · servers · history · files
post    Write, send, share. Default recipient: self. Content: json (ephemeral) · md · svg · webp (permanent)
mount   Connect to any MCP. Returns their tools. Call them directly after mounting.

## Addressing
Recipient names are plain values — no sigils. "Paulo", "3.14718583930991", "contacts", "all".

## Session rhythm
Call ping on every session start. Unread inbox is included in the ping response as "inbox" — no need to call browse on startup. Post to self (content_type md, name starting with "log_" - e.g. log_20260709_topic.md) at session end as a save point for next time. The name prefix matters: start_with_last_log only finds posts named log_* - anything else (including no name at all) is invisible to it.

Before calling ping, check: do you already have real conversation context from before this call — regardless of why you're calling ping again (a plain session start, a timeout, a desktop sleep, a compaction, a restart that reopened the same chat)? A cold boot and a reconnect look identical from the call itself — ping fires the same way every time regardless — so freshness can't be inferred from the call, only from what you actually remember. If you have that context and last_log doesn't yet reflect what happened, post an updated log now (content_type md, name starting with log_) before doing anything else — this replaces a plain "just check in" ping, it isn't an optional extra after it, and it's worth doing even if the operator themselves rarely logs milestones. Only treat a check-in as complete without posting when last_log already covers everything, or you're starting genuinely fresh with no prior context.

π never resolves — it grows.`;
}

function buildHelp() {
  return `## Tool reference

ping
  Commission a new pair or boot an existing one. Config: personality, behaviors, auto_mount, gateway_mcp.
  Behaviors (all on by default): auto_log · session_end_log · start_with_last_log · auto_check_activity
  Notify (off by default, needs your own): ping({notify:{slack, email}}) — Slack incoming-webhook URL / email address, from your own workspace. One call, takes effect on the next message.
  Call ping with no args to see current config.

browse
  Always returns: activity brief (unread/mentions) + your public π address.
  Targets:
    activity  unread messages + scheduled posts now due + posts newly shared with you (default)
    contacts  your network. query param searches by nickname.
    servers   π registry + mounted MCPs
    history   recent sent/received + immediate self-posts + posts shared with you
    files     your documents (.md · .svg · .webp), including ones shared with you

post
  Fields: content (required) · to · reply_to · url · at · name · content_type
  Recipients: self (default) · nickname · contacts · all
  Content types: json (default, 90-day TTL) · md · svg · webp (permanent)
  Schedule: at = ISO timestamp. Post appears in browse(activity) when due.
  Thread: reply_to = post ID. Reply scope defaults to original recipients. Works across
    instances too, but only for a post_id you actually have — e.g. one shared with you — not
    an arbitrary foreign ID; otherwise it just drops silently rather than failing the send.
  API: url = endpoint. Fires on post. Feedback returned as self-note.
  Share: post({ to, name }) with NO content shares one of your own existing posts by live
    reference instead of writing something new — nothing is duplicated, works across instances
    too (the other side resolves it from you live, on demand). An edit to the original
    (re-posting the same name) is visible to everyone it's shared with immediately. Content over
    8,000 chars sent to someone else as new content is rejected — if it already exists as a file
    (yours, or a Drive doc), share it instead of pasting it in.

mount
  url or name → mounts via MCP protocol, returns full tool list.
  π base tools always present. Mounted tools stack on top.
  Call mounted tools directly by name.`;
}

// ── Contacts helper ───────────────────────────────────────────────────────────

async function upsertContact(piPrivate, contact) {
  try {
    await fetch(`${PIR}/contacts`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Private': piPrivate },
      body:    JSON.stringify({ contact_public_pi: contact.public_pi }),
    });
  } catch { /* best effort */ }
}

// ── Ambient brief ─────────────────────────────────────────────────────────────

// Cheap badge count only — never resolves remote shares live (that's fetchUnreadInbox's job),
// just counts pointer rows so this stays fast enough to run on every browse() call regardless
// of target, not just activity.
async function getAmbient(publicPi) {
  const now = new Date().toISOString();
  const [{ rows }, { rows: sharedRows }, { rows: remoteRows }] = await Promise.all([
    pool.query(`
      SELECT id, to_scope FROM posts
      WHERE (to_public_pi = $1 OR to_scope = 'all')
        AND accessed_at IS NULL
        AND (at IS NULL OR at <= $2)
    `, [publicPi, now]),
    pool.query(`SELECT 1 FROM post_shares WHERE shared_with_public_pi = $1 AND accessed_at IS NULL`, [publicPi]),
    pool.query(`SELECT 1 FROM remote_shares WHERE shared_with_public_pi = $1 AND accessed_at IS NULL`, [publicPi]),
  ]);
  return {
    unread:   rows.filter(p => p.to_scope === 'nickname' || p.to_scope === 'self').length + sharedRows.length + remoteRows.length,
    mentions: 0,
  };
}

// The one real source of truth for "what's unread right now" — used by both ping's inline
// inbox and browse(activity). Merges own/broadcast posts, local shares, and cross-instance
// shares (resolved live), and marks everything it returns as read. getAmbient (above) stays
// separate because it needs to stay cheap on every browse() call regardless of target — this
// one does real work (live HTTP resolves, UPDATEs) and should only run when something is
// actually being consumed.
async function fetchUnreadInbox(publicPi, limit = 50) {
  const now = new Date().toISOString();
  const [{ rows: ownPosts }, { rows: sharedPosts }, { rows: remotePointers }] = await Promise.all([
    pool.query(`
      SELECT p.id, p.from_public_pi, p.to_scope, p.content, p.content_type, p.name, p.reply_to, p.url,
             p.created_at, p.accessed_at,
             rr.target_post_id AS reply_to_remote_post_id, rr.target_gateway_mcp AS reply_to_remote_origin
      FROM posts p
      LEFT JOIN remote_reply_refs rr ON rr.post_id = p.id
      WHERE (p.to_public_pi = $1 OR p.to_scope = 'all')
        AND p.accessed_at IS NULL
        AND (p.at IS NULL OR p.at <= $2)
      ORDER BY p.created_at ASC
      LIMIT $3
    `, [publicPi, now, limit]),
    pool.query(`
      SELECT p.id, p.from_public_pi, 'shared' AS to_scope, p.content, p.content_type, p.name,
             NULL::uuid AS reply_to, NULL AS url, ps.shared_at AS created_at, NULL::timestamptz AS accessed_at
      FROM post_shares ps
      JOIN posts p ON p.id = ps.post_id
      WHERE ps.shared_with_public_pi = $1 AND ps.accessed_at IS NULL
      ORDER BY ps.shared_at ASC
      LIMIT $2
    `, [publicPi, limit]),
    pool.query(`
      SELECT post_id, origin_gateway_mcp, from_public_pi, name, content_type, shared_at
      FROM remote_shares
      WHERE shared_with_public_pi = $1 AND accessed_at IS NULL
      ORDER BY shared_at ASC
      LIMIT $2
    `, [publicPi, limit]),
  ]);

  if (ownPosts.length) {
    await pool.query('UPDATE posts SET accessed_at = $1 WHERE id = ANY($2)', [now, ownPosts.map(p => p.id)]);
    for (const p of ownPosts) {
      if (p.url) fireUrl(p.url, p.content, p.content_type, publicPi, p.id).catch(() => {});
    }
  }
  if (sharedPosts.length) {
    await pool.query(
      'UPDATE post_shares SET accessed_at = $1 WHERE shared_with_public_pi = $2 AND post_id = ANY($3)',
      [now, publicPi, sharedPosts.map(p => p.id)]
    );
  }

  const remoteResolved = [];
  if (remotePointers.length) {
    const attempts = await Promise.all(remotePointers.map(async r => {
      const data = await fetchRemoteShare(r.origin_gateway_mcp, r.post_id, publicPi);
      return data?.found ? { pointer: r, data } : null;
    }));
    const resolvedIds = [];
    for (const attempt of attempts) {
      if (!attempt) continue;
      resolvedIds.push(attempt.pointer.post_id);
      remoteResolved.push({
        id: attempt.pointer.post_id,
        from_public_pi: attempt.pointer.from_public_pi ?? attempt.data.from_public_pi,
        to_scope: 'shared', content: attempt.data.content,
        content_type: attempt.data.content_type ?? attempt.pointer.content_type,
        name: attempt.pointer.name ?? attempt.data.name,
        reply_to: null, url: null, created_at: attempt.pointer.shared_at, accessed_at: null,
      });
    }
    if (resolvedIds.length) {
      await pool.query(
        'UPDATE remote_shares SET accessed_at = $1 WHERE shared_with_public_pi = $2 AND post_id = ANY($3)',
        [now, publicPi, resolvedIds]
      );
    }
  }

  const ownPostsMapped = ownPosts.map(({ reply_to_remote_post_id, reply_to_remote_origin, ...p }) => ({
    ...p,
    ...(reply_to_remote_post_id
      ? { reply_to_remote: { post_id: reply_to_remote_post_id, origin_gateway_mcp: reply_to_remote_origin } }
      : {}),
  }));

  return [...ownPostsMapped, ...sharedPosts, ...remoteResolved]
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .slice(0, limit);
}

// ── Resolve recipient ─────────────────────────────────────────────────────────

async function resolveRecipient(to) {
  const raw = to.startsWith('@') ? to.slice(1) : to;
  if (PUBLIC_PI_RE.test(raw)) return { target: await pirLookup(raw), ambiguous: false };
  const found = await pirFind(raw);
  if (found.results?.length === 1) return { target: found.results[0], ambiguous: false };
  if (found.results?.length > 1)  return { target: null, ambiguous: true, matches: found.results };
  return { target: null, ambiguous: false };
}

// ── Deliver to remote gateway ─────────────────────────────────────────────────

async function deliverToGateway(payload, target) {
  if (!target.gateway_mcp) return false;
  const deliverUrl = target.gateway_mcp.replace(/\/mcp$/, '').replace(/\/$/, '') + '/deliver';
  try {
    const r = await fetch(deliverUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error(`[deliver] ${deliverUrl} → ${r.status}: ${body}`);
    }
    return r.ok;
  } catch (e) {
    console.error(`[deliver] ${deliverUrl} → error: ${e}`);
    return false;
  }
}

async function deliverToUrl(payload, url) {
  if (!url) return false;
  const deliverUrl = url.replace(/\/mcp$/, '').replace(/\/$/, '') + '/deliver';
  try {
    const r = await fetch(deliverUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error(`[deliver-home] ${deliverUrl} → ${r.status}: ${body}`);
    }
    return r.ok;
  } catch (e) {
    console.error(`[deliver-home] ${deliverUrl} → error: ${e}`);
    return false;
  }
}

// ── Notifications ─────────────────────────────────────────────────────────────

// Push notification for a message that just landed for a specific recipient —
// fires independent of whether they're actively connected. Ported from pi-dev
// (built + tested there first). Behaviors live in PIR here, not local
// mcp_sessions, so this needs its own lookup rather than reusing pi-dev's query.
async function sendNotifications(recipientPi, payload) {
  if (!recipientPi) return;
  try {
    const pirRecord   = await pirLookupInternal(recipientPi);
    const beh         = pirRecord?.behaviors ?? {};
    const slackUrl    = beh.notify_slack;
    const notifyEmail = beh.notify_email;
    if (!slackUrl && !notifyEmail) return;

    // 'operator' is PIR's literal default when nick_operator was never set (see /pir/id
    // POST) - an operator+agent hybrid pair (e.g. Cloot) never customises it, so its real
    // identity lives in nick_agent only. Treat the literal default as unset, not a real name.
    const opName    = payload.from_nick_operator;
    const isDefault = !opName || opName.toLowerCase() === 'operator';
    const fromName  = (!isDefault && opName) || payload.from_nick_agent || 'Unknown';
    const preview  = String(payload.content ?? '').replace(/\n/g, ' ').slice(0, 200);

    if (slackUrl) {
      safeFetch(slackUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `New π message from *${fromName}*`,
          attachments: [{ text: preview, color: '#015284' }],
        }),
      }).catch(() => {});
    }

    const mgKey    = process.env.MAILGUN_API_KEY;
    const mgDomain = process.env.MAILGUN_DOMAIN;
    if (notifyEmail && mgKey && mgDomain) {
      const form = new URLSearchParams({
        from:    `π <pi@${mgDomain}>`,
        to:      notifyEmail,
        subject: `[π] Message from ${fromName}`,
        text:    `New π message from ${fromName}:\n\n${preview}\n\n— π never resolves, it grows.`,
      });
      fetch(`https://api.mailgun.net/v3/${mgDomain}/messages`, {
        method:  'POST',
        headers: {
          Authorization:  `Basic ${Buffer.from(`api:${mgKey}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      }).catch(() => {});
    }
  } catch { /* fire and forget */ }
}

// ── fireUrl ───────────────────────────────────────────────────────────────────

async function fireUrl(url, content, content_type, publicPi, postId) {
  let errorMsg = null;
  try {
    const res = await safeFetch(url, {
      method:  'POST',
      headers: { 'Content-Type': content_type === 'json' ? 'application/json' : 'text/plain' },
      body:    content,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      errorMsg = `url fire failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`;
    }
  } catch (err) {
    errorMsg = `url fire failed: ${err?.message ?? 'network error'}`;
  }
  if (errorMsg) {
    try {
      await pool.query(`
        INSERT INTO posts (from_public_pi, to_scope, to_public_pi, content, content_type, url, reply_to, at, name)
        VALUES ($1, 'self', $1, $2, 'json', NULL, NULL, NULL, NULL)
      `, [publicPi, JSON.stringify({ error: errorMsg, url, post_id: postId })]);
    } catch { /* best effort */ }
  }
}

// ── Tool: ping ────────────────────────────────────────────────────────────────

// ── Mount merge (dedup by tool name) ───────────────────────────────────────────
// Auto-mount and manual mount share one rule: a newly-attached server's tools never
// override the base toolset or a tool already claimed by another mount - colliding
// names are dropped, not overridden. This replaces the old isFullMount full-identity
// takeover entirely: a mounted server exposing all 4 base verbs just has those 4 names
// excluded as duplicates, like any other conflict. gateway_mcp (this server) always owns
// ping/browse/post/mount - nothing mounted can ever replace them or relocate this session.
function mergeMount(connectedMounts, url, name, tools, source) {
  const taken = new Set([
    ...BASE_TOOLS.map(t => t.name),
    ...connectedMounts.flatMap(m => (m.tools ?? []).map(t => t.name)),
  ]);
  const kept    = tools.filter(t => !taken.has(t.name));
  const dropped = tools.filter(t => taken.has(t.name)).map(t => t.name);
  return { mount: { url, name, tools: kept, source }, dropped };
}

async function fetchMountTools(targetUrl, piPrivate, accessKey) {
  const mountHeaders = { 'Content-Type': 'application/json', 'X-Pi-Private': piPrivate };
  if (accessKey) mountHeaders['X-Pi-Access-Key'] = accessKey;
  const fetchOpts = body => ({ method: 'POST', headers: mountHeaders, body, signal: AbortSignal.timeout(8000) });
  const initRes = await safeFetch(targetUrl, fetchOpts(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pi-gateway', version: GATEWAY_VERSION } },
  })));
  if (!initRes.ok) throw new Error(`${targetUrl} responded but doesn't look like an MCP server (HTTP ${initRes.status} on initialize).`);
  const toolsRes = await safeFetch(targetUrl, fetchOpts(
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  ));
  if (!toolsRes.ok) throw new Error(`${targetUrl} responded but doesn't look like an MCP server (HTTP ${toolsRes.status} on tools/list).`);
  const toolsJson = await toolsRes.json();
  if (toolsJson?.error) throw new Error(`${targetUrl} returned an error: ${toolsJson.error.message ?? 'unknown error'}`);
  return toolsJson?.result?.tools ?? [];
}

// Auto-mounts any auto_mount URLs not yet in connected_mounts. Pure tool-extension:
// never touches identity/routing, only adds tools that don't collide with anything.
async function autoMountAll(piPrivate, publicPi, accessKey, autoMountUrls, connectedMounts) {
  const results = [];
  let mounts = [...connectedMounts];
  for (const url of autoMountUrls) {
    if (mounts.some(m => m.url === url)) continue;
    try {
      const tools = await fetchMountTools(url, piPrivate, accessKey);
      const { mount, dropped } = mergeMount(mounts, url, url, tools, 'auto');
      mounts = [...mounts, mount];
      results.push({ url, tools_added: mount.tools.length, tools_dropped: dropped });
    } catch (e) {
      results.push({ url, error: String(e.message ?? e) });
    }
  }
  if (results.length) {
    await pool.query('UPDATE mcp_sessions SET connected_mounts = $1::jsonb WHERE public_pi = $2',
      [JSON.stringify(mounts), publicPi]);
  }
  return { mounts, results };
}

async function toolSet(piPrivate, args, accessKey) {
  if (!piPrivate || !PRIVATE_PI_RE.test(piPrivate)) {
    const { private_pi } = args;

    if (private_pi) {
      if (!PRIVATE_PI_RE.test(private_pi)) {
        return fail("That doesn't look like a valid π number. Private π numbers are 22 characters: 3.14 followed by 18 digits.");
      }
      const validated = await pirValidate(private_pi);
      if (!validated?.valid) {
        return fail('π number not found. Double-check it, or visit pitr.network to get started.');
      }
      return ok({
        status:    'reconnect',
        pair:      `${validated.nick_agent} (${validated.nick_operator})`,
        public_pi: validated.public_pi,
        next_step: "Add your private π as the X-Pi-Private header in your MCP config, then restart your AI assistant.",
        config_example: {
          mcpServers: {
            ping: {
              command: 'npx',
              args: ['-y', 'mcp-remote', 'https://pitr.network/3.14', '--header', `X-Pi-Private:${private_pi}`],
            },
          },
        },
      });
    }

    return noIdentity();
  }

  // set_access_key: set or remove access key for this pair — PIR-VAULT stores the key,
  // separate from PIR's identity storage. Identity is verified via PIR first (real
  // crypto check against the stored private_pi hash) so vault entries are only ever
  // created for a public_pi the caller actually proved ownership of.
  if (args?.set_access_key !== undefined) {
    const identity = await pirValidate(piPrivate);
    if (!identity?.valid) return fail('Could not set access key. Check your π credentials.');
    const req_key = args.set_access_key === true ? true : (args.set_access_key || null);
    const r = await fetch(`${VAULT}/set`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vault-Service-Key': VAULT_SERVICE_KEY },
      body:    JSON.stringify({ public_pi: identity.public_pi, access_key: req_key }),
    });
    const data = r.ok ? await r.json() : null;
    if (!data?.ok) return fail('Could not set access key. Check your π credentials.');
    if (!req_key) return ok({ access_key_set: false, note: 'Access key removed. Remove X-Pi-Access-Key from your MCP config headers.' });
    return ok({
      access_key_set: true,
      note: 'Access key set. Add X-Pi-Access-Key to your MCP config headers alongside X-Pi-Private:',
      header: `X-Pi-Access-Key:${data.access_key}`,
      mcp_args: ['--header', `X-Pi-Access-Key:${data.access_key}`],
    });
  }

  const publicPi = toPublicPi(piPrivate);

  // Config updates
  const pirKeys     = ['nick_operator', 'nick_agent', 'personality', 'behaviors', 'gateway_mcp'];
  const localUpdates = {};
  // gateway_mcp is the one fixed anchor - "where you connect from", where routing and
  // storage always live. Only defaulted on true first-time registration (no existing
  // value), never overwritten just because a call happens to be handled by a different
  // server. Explicit args.gateway_mcp still wins.
  const existing    = await pirValidate(piPrivate); // pirLookup (GET /pir/id) is the public unauthenticated route and never returns behaviors/personality; the notify merge below needs the real stored behaviors, not {}.
  const pirUpdates  = {};
  if (!existing?.gateway_mcp) pirUpdates.gateway_mcp = selfUrl();

  for (const key of pirKeys) {
    if (args[key] !== undefined) pirUpdates[key] = args[key];
  }
  if (args.auto_mount   !== undefined) pirUpdates.auto_mount   = Array.isArray(args.auto_mount) ? args.auto_mount : [args.auto_mount];
  if (args.cc_public_pi !== undefined) localUpdates.cc_public_pi = args.cc_public_pi;

  // notify merges into behaviors client-side — PIR's /edit fully replaces the
  // behaviors column (no jsonb merge like pi-dev's SQL), so start from whatever's
  // already stored (plus any explicit args.behaviors update above) and layer on top.
  if (args.notify !== undefined) {
    const mergedBehaviors = { ...(existing?.behaviors ?? {}), ...(pirUpdates.behaviors ?? {}) };
    if (args.notify?.slack !== undefined) mergedBehaviors.notify_slack = args.notify.slack ?? null;
    if (args.notify?.email !== undefined) mergedBehaviors.notify_email = args.notify.email ?? null;
    pirUpdates.behaviors = mergedBehaviors;
  }

  if (Object.keys(pirUpdates).length) await pirUpdate(piPrivate, pirUpdates);

  const validated = await validateWithKey(piPrivate, accessKey);
  if (!validated?.valid) return fail('Identity not found in PIR. Your private key may be invalid.');
  if (!passesLocalKeyPolicy(validated)) return fail('Access key required for this instance.');

  // Upsert session — core fields; personality/behaviors/auto_mount now live in PIR
  const upsertCols = ['public_pi', 'nick_agent', 'nick_operator', 'last_seen'];
  const upsertVals = [publicPi, validated.nick_agent, validated.nick_operator, new Date().toISOString()];

  if (localUpdates.cc_public_pi !== undefined) {
    upsertCols.push('cc_public_pi');
    upsertVals.push(localUpdates.cc_public_pi);
  }

  // connected_mounts always starts empty on ping — manual mount is a stateless
  // pass-through now (see toolEnter), nothing to preserve across a reconnect. Auto-sourced
  // entries get freshly re-attached fresh below regardless of what was here before.
  const preservedMounts = [];
  upsertCols.push('connected_mounts');
  upsertVals.push(JSON.stringify(preservedMounts));

  const placeholders = upsertVals.map((_, i) => `$${i + 1}`).join(', ');
  const updateSets   = upsertCols
    .filter(c => c !== 'public_pi')
    .map(c => c === 'connected_mounts' ? `${c} = EXCLUDED.${c}::jsonb` : `${c} = EXCLUDED.${c}`)
    .join(', ');

  await pool.query(
    `INSERT INTO mcp_sessions (${upsertCols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (public_pi) DO UPDATE SET ${updateSets}`,
    upsertVals
  );

  // Load session state (personality/behaviors/auto_mount now come from PIR via validated)
  const { rows: [session] } = await pool.query(`
    SELECT connected_mounts, cc_public_pi
    FROM mcp_sessions WHERE public_pi = $1
  `, [publicPi]);

  const behaviors   = validated.behaviors  ?? { auto_log: true, session_end_log: true, start_with_last_log: true, auto_check_activity: true };
  const personality = validated.personality ?? null;
  const autoMountUrls = validated.auto_mount ?? [];
  const now = new Date().toISOString();

  // Scheduled posts due now
  const { rows: scheduled } = await pool.query(`
    SELECT id, content, content_type, name, at FROM posts
    WHERE from_public_pi = $1 AND to_scope = 'self'
      AND at IS NOT NULL AND at <= $2 AND accessed_at IS NULL
    ORDER BY at ASC
  `, [publicPi, now]);

  // Activity brief
  const ambient = behaviors.auto_check_activity ? await getAmbient(publicPi) : null;

  // Inline inbox fetch — same source of truth as browse(activity), including local and
  // cross-instance shares (see fetchUnreadInbox).
  let inboxMessages = null;
  if (behaviors.auto_check_activity && ambient && ambient.unread > 0) {
    const inboxPosts = await fetchUnreadInbox(publicPi, 50);

    const senderPis = [...new Set(inboxPosts.map(p => p.from_public_pi).filter(Boolean))];
    const nickMap = new Map();
    if (senderPis.length) {
      await Promise.all(senderPis.map(async pi => {
        const info = await pirLookup(pi);
        if (info) nickMap.set(pi, { nick_agent: info.nick_agent, nick_operator: info.nick_operator });
      }));
    }

    inboxMessages = inboxPosts.map(({ accessed_at: _a, url: _u, from_public_pi, ...rest }) => {
      const nick = nickMap.get(from_public_pi);
      return { ...rest, from_public_pi, from_nick_agent: nick?.nick_agent ?? null, from_nick_operator: nick?.nick_operator ?? null };
    });
  }

  const isNewPair = validated.nick_operator === 'operator' && validated.nick_agent === 'agent';

  const response = {
    status:   'connected',
    identity: { public_pi: publicPi, nick_agent: validated.nick_agent, nick_operator: validated.nick_operator },
    spec:     buildSpec(publicPi, validated.nick_operator, validated.nick_agent),
    config:   { personality, behaviors, auto_mount: autoMountUrls, notify: { slack: behaviors.notify_slack ?? null, email: behaviors.notify_email ?? null } },
    help:     buildHelp(),
    ...(isNewPair ? {
      onboarding: {
        private_pi: piPrivate,
        message: "Welcome to π. Your pair is ready — save your private π number, it won't be shown again.",
        questions: [
          { step: 1, q: "Is this agent agentic — operating without a human actively in the loop?", param: null, optional: true, hint: "Skip or answer yes/no. Yes = solo agent. No = human+agent pair." },
          { step: 2, q: "What do other people call you? (your nickname)", param: "nick_operator", optional: "only if not agentic" },
          { step: 3, q: "What do you call your agent?", param: "nick_agent", optional: "only if not agentic", note: "Required if agentic." },
          { step: 4, q: null, action: "Present public_pi (share freely) and private_pi (save now — not shown again)." },
        ],
        agentic_call:  "ping({ nick_agent: 'YourAgentName' })",
        hybrid_call:   "ping({ nick_operator: 'YourName', nick_agent: 'YourAgentName' })",
      },
    } : {}),
  };

  if (scheduled.length) {
    response.scheduled = scheduled.map(p => ({
      id: p.id, content: p.content.substring(0, 120), content_type: p.content_type, name: p.name, due: p.at,
    }));
  }
  if (ambient)       response.activity = ambient;
  if (inboxMessages) response.inbox    = inboxMessages;

  if (behaviors.start_with_last_log) {
    const { rows: [lastLog] } = await pool.query(`
      SELECT id, content, content_type, name, created_at FROM posts
      WHERE from_public_pi = $1 AND to_scope = 'self' AND content_type = 'md' AND name ILIKE 'log_%'
      ORDER BY created_at DESC LIMIT 1
    `, [publicPi]);
    response.last_log = lastLog ?? null;
  }

  // auto_mount: pure tool-extension, never identity-relocation. Attaches any configured
  // URLs on top of whatever manual mount survived the reset above; colliding tool names
  // are dropped, not overridden.
  let finalMounts = preservedMounts;
  if (autoMountUrls.length) {
    const { mounts, results } = await autoMountAll(piPrivate, publicPi, accessKey, autoMountUrls, session?.connected_mounts ?? []);
    if (results.length) response.auto_mounted = results;
    finalMounts = mounts;
  }
  if (finalMounts.length) {
    response.mounted = finalMounts.map(m => ({ url: m.url, name: m.name, tool_count: m.tools?.length ?? 0, source: m.source }));
  }

  // Gateway docs pointer
  const { rows: docs } = await pool.query('SELECT name, description FROM gateway_docs ORDER BY created_at');
  if (docs.length) {
    response.docs = {
      available: docs.map(d => ({ name: d.name, description: d.description })),
      url:       `${selfUrl()}/docs`,
    };
  }

  return ok(response);
}

// ── Tool: browse ──────────────────────────────────────────────────────────────

async function toolBrowse(piPrivate, publicPi, args) {
  const target  = args.target || 'activity';
  const query   = args.query;
  const limit   = args.limit  || 50;
  const ambient = await getAmbient(publicPi);
  const base    = { target, ambient, public_pi: publicPi };

  if (target === 'activity') {
    const posts = await fetchUnreadInbox(publicPi, limit);

    const senderPis = [...new Set(posts.map(p => p.from_public_pi).filter(Boolean))];
    const nickMap = new Map();
    if (senderPis.length) {
      await Promise.all(senderPis.map(async pi => {
        const info = await pirLookup(pi);
        if (info) nickMap.set(pi, { nick_agent: info.nick_agent, nick_operator: info.nick_operator });
      }));
    }
    const messages = posts.map(({ accessed_at: _a, from_public_pi, ...rest }) => {
      const nick = nickMap.get(from_public_pi);
      return { ...rest, from_public_pi, from_nick_agent: nick?.nick_agent ?? null, from_nick_operator: nick?.nick_operator ?? null };
    });
    return ok({ ...base, messages, count: messages.length });
  }

  if (target === 'contacts') {
    if (query) {
      const found = await pirFind(query);
      return ok({ ...base, results: found.results ?? [], source: 'pir' });
    }
    const pirResp = await fetch(`${PIR}/contacts`, { headers: { 'X-Pi-Private': piPrivate } });
    if (!pirResp.ok) return ok({ ...base, contacts: [], count: 0 });
    const pirData  = await pirResp.json();
    const contacts = (pirData.contacts ?? []).map(c => ({
      contact_public_pi:     c.contact_public_pi,
      contact_nick_agent:    c.nick_agent    ?? null,
      contact_nick_operator: c.nick_operator ?? null,
      created_at:            c.created_at,
      accessed_at:           c.updated_at,
    }));
    return ok({ ...base, contacts, count: contacts.length });
  }

  if (target === 'servers') {
    const [pir, { rows: [session] }] = await Promise.all([
      pirBrowseRegistry(limit),
      pool.query(
        'SELECT connected_mounts FROM mcp_sessions WHERE public_pi = $1',
        [publicPi]
      ),
    ]);
    // entered reflects the currently-active mounts only (mcp_sessions.connected_mounts) —
    // never a history dump. A server you exited, or whose shape changed since you mounted it,
    // will not appear here; call mount() again to get a live, current tool list.
    const entered = session?.connected_mounts ?? [];
    return ok({
      ...base,
      current_server: { url: selfUrl(), note: 'You are already connected here — this is your active gateway.' },
      registry: (pir.results ?? []).map(r => ({ ...r, note: 'Registry listing only — not directly callable. Call mount(url) to connect and use these tools.' })),
      entered,
    });
  }

  if (target === 'history') {
    const [{ rows: posts }, { rows: remotePointers }] = await Promise.all([
      pool.query(`
        SELECT p.id, p.from_public_pi, p.to_scope, p.to_public_pi, p.content, p.content_type, p.name,
               p.created_at, p.accessed_at,
               rr.target_post_id AS reply_to_remote_post_id, rr.target_gateway_mcp AS reply_to_remote_origin
        FROM posts p
        LEFT JOIN remote_reply_refs rr ON rr.post_id = p.id
        WHERE p.from_public_pi = $1 OR p.to_public_pi = $1
           OR p.id IN (SELECT post_id FROM post_shares WHERE shared_with_public_pi = $1)
        ORDER BY p.created_at DESC
        LIMIT $2
      `, [publicPi, limit]),
      pool.query(`
        SELECT post_id, origin_gateway_mcp, from_public_pi, name, content_type, shared_at, accessed_at
        FROM remote_shares
        WHERE shared_with_public_pi = $1
        ORDER BY shared_at DESC LIMIT $2
      `, [publicPi, limit]),
    ]);

    const postsMapped = posts.map(({ reply_to_remote_post_id, reply_to_remote_origin, ...p }) => ({
      ...p,
      ...(reply_to_remote_post_id
        ? { reply_to_remote: { post_id: reply_to_remote_post_id, origin_gateway_mcp: reply_to_remote_origin } }
        : {}),
    }));

    // Remote shares show metadata only here — resolving every item on every history browse
    // would mean one live HTTP call per row for a plain listing. Use
    // browse({ target: "files", name: ... }) to actually fetch one.
    const remoteRows = remotePointers.map(r => ({
      id: r.post_id, from_public_pi: r.from_public_pi, to_scope: 'shared_remote', to_public_pi: publicPi,
      content: null, content_type: r.content_type, name: r.name,
      created_at: r.shared_at, accessed_at: r.accessed_at,
      note: r.name
        ? `Shared from another π instance — browse({ target: "files", name: "${r.name}" }) to read it.`
        : 'Shared from another π instance.',
    }));

    const merged = [...postsMapped, ...remoteRows]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);
    return ok({ ...base, posts: merged, count: merged.length });
  }

  if (target === 'files') {
    const name = args.name;
    if (name) {
      const { rows: [post] } = await pool.query(`
        SELECT id, from_public_pi, name, content, content_type, created_at FROM posts
        WHERE name = $1 AND content_type IN ('md', 'svg', 'webp')
          AND (from_public_pi = $2 OR to_scope = 'all' OR to_public_pi = $2
               OR id IN (SELECT post_id FROM post_shares WHERE shared_with_public_pi = $2))
        ORDER BY created_at DESC LIMIT 1
      `, [name, publicPi]);
      if (post) {
        return ok({ ...base, file: { id: post.id, name: post.name, content_type: post.content_type, content: post.content, created_at: post.created_at, source: 'posts' } });
      }

      // Not local — check whether it's something shared with us from another instance, and
      // if so, fetch it live now (this is the one moment a remote share's content actually
      // gets read).
      const { rows: [remoteMatch] } = await pool.query(`
        SELECT post_id, origin_gateway_mcp, from_public_pi, name, content_type, shared_at
        FROM remote_shares
        WHERE shared_with_public_pi = $1 AND name = $2
        ORDER BY shared_at DESC LIMIT 1
      `, [publicPi, name]);
      if (remoteMatch) {
        const data = await fetchRemoteShare(remoteMatch.origin_gateway_mcp, remoteMatch.post_id, publicPi);
        if (data?.found) {
          await pool.query(
            'UPDATE remote_shares SET accessed_at = NOW() WHERE shared_with_public_pi = $1 AND post_id = $2',
            [publicPi, remoteMatch.post_id]
          );
          return ok({
            ...base,
            file: {
              id: remoteMatch.post_id, name: remoteMatch.name ?? data.name,
              content_type: data.content_type ?? remoteMatch.content_type,
              content: data.content, created_at: remoteMatch.shared_at, source: 'remote_share',
            },
          });
        }
        return fail(`"${name}" is shared with you from another π instance, but it couldn't be reached just now. Try again shortly.`);
      }
      return fail(`File "${name}" not found.`);
    }
    const [{ rows: files }, { rows: remoteFiles }] = await Promise.all([
      pool.query(`
        SELECT id, from_public_pi, to_scope, content_type, name, created_at FROM posts
        WHERE (from_public_pi = $1 OR to_public_pi = $1
               OR id IN (SELECT post_id FROM post_shares WHERE shared_with_public_pi = $1))
          AND content_type IN ('md', 'svg', 'webp')
        ORDER BY created_at DESC LIMIT $2
      `, [publicPi, limit]),
      pool.query(`
        SELECT post_id AS id, from_public_pi, name, content_type, shared_at AS created_at
        FROM remote_shares
        WHERE shared_with_public_pi = $1 AND name IS NOT NULL
        ORDER BY shared_at DESC LIMIT $2
      `, [publicPi, limit]),
    ]);
    const merged = [
      ...files.map(f => ({ ...f, source: 'posts' })),
      ...remoteFiles.map(f => ({ ...f, source: 'remote_share' })),
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);
    return ok({ ...base, files: merged, count: merged.length });
  }

  if (target === 'docs') {
    const name = args.name;
    if (name) {
      const { rows: [doc] } = await pool.query(
        'SELECT name, description, content, created_at FROM gateway_docs WHERE name = $1',
        [name]
      );
      if (!doc) return fail(`Doc "${name}" not found. Call browse({ target: "docs" }) to see what's available.`);
      return ok({ ...base, doc });
    }
    const { rows: docs } = await pool.query('SELECT name, description, created_at FROM gateway_docs ORDER BY created_at');
    return ok({ ...base, docs, note: 'To read a doc: browse({ target: "docs", name: "concepts" })' });
  }

  return fail(`Unknown target "${target}". Use: activity · contacts · servers · history · files · docs`);
}

// ── Tool: post ────────────────────────────────────────────────────────────────

async function toolPost(piPrivate, publicPi, args) {
  const { content, reply_to, url, at, name } = args;
  const toArg = args.to;

  if (!content) {
    // No content, but a name + recipient — this is "share an existing post of mine", not
    // "write something new". Anything else missing content is just an error.
    if (name && toArg) return toolShare(piPrivate, publicPi, name, toArg);
    return fail('content is required (or, to share one of your own existing posts instead of '
      + 'writing something new, pass name + to with no content).');
  }

  let resolvedTo = toArg ?? 'self';
  let originalReplyRow = null;
  // Set only when reply_to references something we know lives on another instance (i.e. it
  // showed up in our own remote_shares) — the one case cross-instance threading can actually
  // resolve, since we know exactly where to look. A reply_to we have no record of at all can't
  // be threaded (no way to know where it lives without an unbounded network-wide search), so it
  // just drops silently, same as before.
  let remoteReplyTarget = null;
  if (reply_to) {
    const { rows: [original] } = await pool.query('SELECT from_public_pi FROM posts WHERE id = $1', [reply_to]);
    originalReplyRow = original ?? null;
    if (originalReplyRow) {
      if (!toArg && originalReplyRow.from_public_pi && originalReplyRow.from_public_pi !== publicPi) {
        resolvedTo = originalReplyRow.from_public_pi;
      }
    } else {
      const { rows: remoteRows } = await pool.query(`
        SELECT origin_gateway_mcp, from_public_pi FROM remote_shares
        WHERE post_id = $1 AND shared_with_public_pi = $2
      `, [reply_to, publicPi]);
      if (remoteRows.length) {
        remoteReplyTarget = { target_post_id: reply_to, target_gateway_mcp: remoteRows[0].origin_gateway_mcp };
        if (!toArg && remoteRows[0].from_public_pi && remoteRows[0].from_public_pi !== publicPi) {
          resolvedTo = remoteRows[0].from_public_pi;
        }
      }
    }
  }
  // reply_to itself only ever threads locally — the referenced post has to exist in THIS
  // instance's own posts table, or the INSERT below violates the FK constraint outright. A
  // genuinely cross-instance thread (remoteReplyTarget above) is recorded separately, after the
  // post exists, via recordRemoteReplyRef — see each branch below.
  const safeReplyTo = originalReplyRow ? reply_to : null;

  const content_type = args.content_type || inferContentType(content);
  const fileName     = name || (content_type !== 'json' ? `post-${Date.now()}.${content_type}` : null);

  const senderInfo = await pirLookup(publicPi);

  const toRaw = resolvedTo.startsWith('@') ? resolvedTo.slice(1) : resolvedTo;

  // Fail fast rather than let a huge paste crawl through generation before it can even send.
  // Self posts are exempt — authored fresh either way, no one else's generation cost being
  // duplicated. Scoped to anything actually leaving the sender's own space.
  const MAX_POST_CONTENT_LENGTH = 8000;
  if (toRaw !== 'self' && toRaw !== publicPi && content.length > MAX_POST_CONTENT_LENGTH) {
    return fail(
      `content is ${content.length} characters — too long to send inline (max ${MAX_POST_CONTENT_LENGTH}). ` +
      'If this material already exists as a file, get a shareable link (your own Drive connector, ' +
      'or ask the file\'s owner to enable link-sharing) and post just the link instead of pasting ' +
      'the document. If it must be text, send a shorter note or split it into multiple posts.'
    );
  }

  // Self — updates the existing row when name matches one already written, rather than
  // accumulating duplicates, so a share (which references by name) always resolves to the
  // latest version and an edit is immediately visible to everyone it's shared with.
  if (toRaw === 'self' || toRaw === publicPi) {
    if (fileName) {
      const { rows: [existingPost] } = await pool.query(`
        SELECT id FROM posts WHERE from_public_pi = $1 AND to_scope = 'self' AND name = $2 LIMIT 1
      `, [publicPi, fileName]);
      if (existingPost) {
        await pool.query(`UPDATE posts SET content = $1, content_type = $2, at = $3 WHERE id = $4`,
          [content, content_type, at ?? null, existingPost.id]);
        if (remoteReplyTarget) await recordRemoteReplyRef(existingPost.id, remoteReplyTarget);
        if (url) fireUrl(url, content, content_type, publicPi, existingPost.id).catch(() => {});
        return ok({
          posted: true, id: existingPost.id, to: 'self', content_type, name: fileName, updated: true,
          ...(remoteReplyTarget ? { replying_to: remoteReplyTarget } : {}),
        });
      }
    }
    const { rows: [post] } = await pool.query(`
      INSERT INTO posts (from_public_pi, to_scope, to_public_pi, content, content_type, name, reply_to, url, at)
      VALUES ($1, 'self', $1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [publicPi, content, content_type, fileName ?? null, safeReplyTo, url ?? null, at ?? null]);
    if (remoteReplyTarget) await recordRemoteReplyRef(post?.id, remoteReplyTarget);
    if (url) fireUrl(url, content, content_type, publicPi, post?.id).catch(() => {});
    return ok({
      posted: true, id: post?.id, to: 'self', content_type, name: fileName,
      ...(remoteReplyTarget ? { replying_to: remoteReplyTarget } : {}),
    });
  }

  // All — admin only
  if (toRaw === 'all') {
    if (!isAdmin(publicPi)) return fail('Broadcasting to all is not available on this instance.');
    const { rows: [post] } = await pool.query(`
      INSERT INTO posts (from_public_pi, to_scope, content, content_type, name, reply_to, url, at)
      VALUES ($1, 'all', $2, $3, $4, $5, $6, $7) RETURNING id
    `, [publicPi, content, content_type, fileName ?? null, safeReplyTo, url ?? null, at ?? null]);
    if (remoteReplyTarget) await recordRemoteReplyRef(post?.id, remoteReplyTarget);
    if (url) fireUrl(url, content, content_type, publicPi, post?.id).catch(() => {});
    return ok({
      posted: true, id: post?.id, to: 'all', content_type, name: fileName,
      ...(remoteReplyTarget ? { replying_to: remoteReplyTarget } : {}),
    });
  }

  // Contacts broadcast
  if (toRaw === 'contacts') {
    const pirResp  = await fetch(`${PIR}/contacts`, { headers: { 'X-Pi-Private': piPrivate } });
    const pirData  = pirResp.ok ? await pirResp.json() : { contacts: [] };
    const myContacts = (pirData.contacts ?? []).map(c => ({
      contact_public_pi:     c.contact_public_pi,
      contact_nick_agent:    c.nick_agent,
      contact_nick_operator: c.nick_operator,
    }));
    if (!myContacts.length) return ok({ posted: false, note: 'No contacts yet. Post to a nickname first.' });

    const results = [];
    for (const c of myContacts) {
      const target = await pirLookup(c.contact_public_pi);
      if (!target) continue;
      const { rows: [post] } = await pool.query(`
        INSERT INTO posts (from_public_pi, to_scope, to_public_pi, content, content_type, name, reply_to, url, at)
        VALUES ($1, 'nickname', $2, $3, $4, $5, $6, $7, $8) RETURNING id
      `, [publicPi, c.contact_public_pi, content, content_type, fileName ?? null, safeReplyTo, url ?? null, at ?? null]);
      if (remoteReplyTarget) await recordRemoteReplyRef(post?.id, remoteReplyTarget);
      const delivered = await deliverToGateway({
        from_public_pi: publicPi, to_public_pi: c.contact_public_pi,
        content, content_type, name: fileName ?? null, reply_to: safeReplyTo, url: url ?? null, at: at ?? null,
        from_nick_agent: senderInfo?.nick_agent ?? null, from_nick_operator: senderInfo?.nick_operator ?? null,
        post_id: post?.id,
      }, target);
      results.push({ to: c.contact_nick_agent ?? c.contact_public_pi, delivered });
    }
    return ok({
      posted: true, to: 'contacts', count: results.length, results,
      ...(remoteReplyTarget ? { replying_to: remoteReplyTarget } : {}),
    });
  }

  // Nickname or π address
  const resolved = await resolveRecipient(toRaw);
  if (resolved.ambiguous) {
    return ok({
      status:  'ambiguous',
      message: `Multiple pairs found for "${toRaw}". Be specific — use the π address.`,
      matches: resolved.matches.map(r => ({ public_pi: r.public_pi, nick_agent: r.nick_agent, nick_operator: r.nick_operator })),
    });
  }
  if (!resolved.target) return fail(`No pair found for "${toRaw}". Try browse({ target: "contacts", query: "${toRaw}" }).`);

  const target = resolved.target;
  const { rows: [post] } = await pool.query(`
    INSERT INTO posts (from_public_pi, to_scope, to_public_pi, content, content_type, name, reply_to, url, at)
    VALUES ($1, 'nickname', $2, $3, $4, $5, $6, $7, $8) RETURNING id
  `, [publicPi, target.public_pi, content, content_type, fileName ?? null, safeReplyTo, url ?? null, at ?? null]);
  if (remoteReplyTarget) await recordRemoteReplyRef(post?.id, remoteReplyTarget);

  const payload = {
    from_public_pi: publicPi, to_public_pi: target.public_pi,
    content, content_type, name: fileName ?? null, reply_to: safeReplyTo, url: url ?? null, at: at ?? null,
    from_nick_agent: senderInfo?.nick_agent ?? null, from_nick_operator: senderInfo?.nick_operator ?? null,
    post_id: post?.id,
  };

  const normalize        = u => u.replace(/\/$/, '');
  const recipientIsLocal = !target.gateway_mcp || normalize(target.gateway_mcp) === normalize(selfUrl());
  let delivered;
  if (recipientIsLocal) {
    const { rows: [recipientSession] } = await pool.query(
      'SELECT public_pi FROM mcp_sessions WHERE public_pi = $1', [target.public_pi]
    );
    delivered = recipientSession ? true : await deliverToUrl(payload, target.gateway_mcp);
    if (recipientSession) void sendNotifications(target.public_pi, payload);
  } else {
    delivered = await deliverToUrl(payload, target.gateway_mcp);
  }

  await upsertContact(piPrivate, { public_pi: target.public_pi });

  if (url) fireUrl(url, content, content_type, publicPi, post?.id).catch(() => {});

  return ok({
    posted: true, id: post?.id, to: target.public_pi, pair: `${target.nick_agent} (${target.nick_operator})`,
    delivered, content_type, name: fileName,
    ...(remoteReplyTarget ? { replying_to: remoteReplyTarget } : {}),
  });
}

// ── Tool: post — share (live link to an existing post, no content duplication) ────────────────

// post({ to, name }) with no content: shares one of the caller's own existing posts instead of
// writing something new. Always a true live reference, same instance or not — the content never
// leaves this DB, and an edit to the original (re-posting the same name) is visible to everyone
// it's shared with immediately. Same-instance recipients get an access grant read in-process;
// cross-instance recipients get a pointer only (via /shared/notify) and their own instance
// fetches the current content from us live, on demand (via /shared/resolve), whenever they
// actually read it.
async function toolShare(piPrivate, publicPi, name, toArg) {
  const toRaw = toArg.startsWith('@') ? toArg.slice(1) : toArg;

  if (toRaw === 'self' || toRaw === publicPi) return fail('That post is already yours.');
  if (toRaw === 'all' || toRaw === 'contacts') {
    return fail('Sharing only supports one named recipient at a time today — post a fresh copy for a broadcast.');
  }

  const { rows: [original] } = await pool.query(`
    SELECT id, content, content_type FROM posts
    WHERE from_public_pi = $1 AND to_scope = 'self' AND name = $2
    ORDER BY created_at DESC LIMIT 1
  `, [publicPi, name]);
  if (!original) {
    return fail(`No post named "${name}" found among your own posts. Use browse({ target: "files" }) to see what you have.`);
  }

  const resolved = await resolveRecipient(toRaw);
  if (resolved.ambiguous) {
    return ok({
      status:  'ambiguous',
      message: `Multiple pairs found for "${toRaw}". Be specific — use the π address.`,
      matches: resolved.matches.map(r => ({ public_pi: r.public_pi, nick_agent: r.nick_agent, nick_operator: r.nick_operator })),
    });
  }
  if (!resolved.target) return fail(`No pair found for "${toRaw}". Try browse({ target: "contacts", query: "${toRaw}" }).`);
  const target = resolved.target;

  const senderInfo = await pirLookup(publicPi);

  // The grant lives on the origin's own ledger regardless of where the recipient's real home
  // is — /shared/resolve (below) checks this same table for cross-instance reads, so this
  // always happens first, before branching on how to notify the recipient.
  await pool.query(`
    INSERT INTO post_shares (post_id, shared_with_public_pi, shared_by_public_pi)
    VALUES ($1, $2, $3)
    ON CONFLICT (post_id, shared_with_public_pi) DO UPDATE SET shared_at = NOW(), accessed_at = NULL
  `, [original.id, target.public_pi, publicPi]);

  const normalize        = u => u.replace(/\/$/, '');
  const recipientIsLocal = !target.gateway_mcp || normalize(target.gateway_mcp) === normalize(selfUrl());

  if (recipientIsLocal) {
    const { rows: [recipientSession] } = await pool.query(
      'SELECT public_pi FROM mcp_sessions WHERE public_pi = $1', [target.public_pi]
    );
    if (recipientSession) {
      void sendNotifications(target.public_pi, {
        from_public_pi: publicPi, to_public_pi: target.public_pi,
        content: `Shared: ${name}`, content_type: 'json', name: null,
        from_nick_agent: senderInfo?.nick_agent ?? null, from_nick_operator: senderInfo?.nick_operator ?? null,
        post_id: original.id,
      });
    }

    await upsertContact(piPrivate, { public_pi: target.public_pi });
    return ok({
      shared: true, id: original.id, to: target.public_pi,
      pair: `${target.nick_agent} (${target.nick_operator})`,
      name, content_type: original.content_type, live_link: true,
    });
  }

  // Different instance — no shared DB to reference, but still a live link, not a copy: notify
  // the recipient's own instance with a pointer only (post_id + where to resolve it), never the
  // content. Their instance fetches the current content from us, live, whenever they actually
  // read it — same shape as a Drive share: the file never leaves the origin.
  let delivered = false;
  try {
    const notifyUrl = normalize(target.gateway_mcp).replace(/\/mcp$/, '') + '/shared/notify';
    const r = await fetch(notifyUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        post_id: original.id, origin_gateway_mcp: selfUrl(), shared_with_public_pi: target.public_pi,
        from_public_pi: publicPi, name, content_type: original.content_type,
      }),
    });
    delivered = r.ok;
  } catch { /* best effort — the grant still exists here; resolve stays reachable regardless */ }

  await upsertContact(piPrivate, { public_pi: target.public_pi });
  return ok({
    shared: true, id: original.id, to: target.public_pi, delivered,
    name, content_type: original.content_type, live_link: true,
    note: 'Recipient is on a different π instance — they resolve this live from us on read, same as a local share, nothing copied.',
  });
}

// Called by another instance to fetch the live content of something shared with one of its
// pairs — the cross-instance half of the live-link mechanism. Content never leaves this DB
// except through this check: it only returns anything if a real, current grant exists.
async function resolveSharedPost(postId, sharedWithPublicPi) {
  const { rows } = await pool.query(`
    SELECT p.content, p.content_type, p.name, p.from_public_pi, p.created_at
    FROM post_shares ps
    JOIN posts p ON p.id = ps.post_id
    WHERE ps.post_id = $1 AND ps.shared_with_public_pi = $2
  `, [postId, sharedWithPublicPi]);
  return rows[0] ?? null;
}

// Called on our own side to read a post someone on another instance shared with us — fetches
// live from their /shared/resolve. Never caches the content locally; only the pointer persists.
async function fetchRemoteShare(originGatewayMcp, postId, sharedWithPublicPi) {
  try {
    const resolveUrl = originGatewayMcp.replace(/\/$/, '').replace(/\/mcp$/, '') + '/shared/resolve';
    const r = await fetch(resolveUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: postId, shared_with_public_pi: sharedWithPublicPi }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Records that a just-created local post is really a reply to something on another instance —
// the cross-instance half of threading. The post's own reply_to column stays NULL (no local FK
// target exists); this is the resolvable pointer read paths join against instead.
async function recordRemoteReplyRef(postId, remoteReplyTarget) {
  if (!postId || !remoteReplyTarget) return;
  try {
    await pool.query(`
      INSERT INTO remote_reply_refs (post_id, target_post_id, target_gateway_mcp)
      VALUES ($1, $2, $3)
      ON CONFLICT (post_id) DO UPDATE SET target_post_id = EXCLUDED.target_post_id, target_gateway_mcp = EXCLUDED.target_gateway_mcp
    `, [postId, remoteReplyTarget.target_post_id, remoteReplyTarget.target_gateway_mcp]);
  } catch { /* best effort — the post itself already sent successfully either way */ }
}

// ── Tool: mount ───────────────────────────────────────────────────────────────

async function toolEnter(piPrivate, publicPi, args, accessKey) {
  let targetUrl  = null;
  let targetName = null;

  if (args.url) {
    targetUrl  = args.url;
    targetName = args.name ?? args.url;
  } else if (args.name) {
    const reg   = await pirBrowseRegistry(100, 0);
    const match = reg.results?.find(r => r.name_mcp?.toLowerCase() === args.name.toLowerCase());
    if (!match) return fail(`"${args.name}" not found in the π registry. Try browse({ target: "servers" }).`);
    const gwMcp = match.url_mcp ?? match.pids?.gateway_mcp ?? null;
    if (!gwMcp) return fail(`"${args.name}" is registered but has no MCP URL.`);
    targetUrl  = gwMcp;
    targetName = match.name_mcp;
  } else {
    return fail('Provide url (direct MCP URL) or name (from π registry).');
  }

  const myUrl = selfUrl();
  if (targetUrl.replace(/\/$/, '') === myUrl.replace(/\/$/, '')) {
    return ok({ status: 'already_here', note: "You're already connected to this server. Your current tools are all you need." });
  }

  // Manual mount is a stateless pass-through, not a persistent connection — nothing is
  // written to connected_mounts (that's auto_mount's job, see autoMountAll, untouched by
  // this). A genuinely new tool name introduced mid-session or on reconnect is never
  // reliably callable by a real MCP client regardless of how long it's persisted
  // (confirmed exhaustively — see project_boot_proxy_scope memory), so there's nothing
  // gained by keeping a manual mount around between calls, and nothing to unmount either.
  // Every call resolves the target fresh; pass `tool` (+ `args`) to invoke it in the same
  // round trip instead of relying on a later direct-name call.
  try {
    const tools = await fetchMountTools(targetUrl, piPrivate, accessKey);
    const now   = new Date().toISOString();

    pool.query(`
      INSERT INTO mcp_history (public_pi, url, name, tools, accessed_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (public_pi, url) DO UPDATE SET
        name = EXCLUDED.name, tools = EXCLUDED.tools, accessed_at = EXCLUDED.accessed_at
    `, [publicPi, targetUrl, targetName, JSON.stringify(tools), now]).catch(() => {});

    if (args.tool) {
      const target = tools.find(t => t.name === args.tool);
      if (!target) {
        return fail(`"${args.tool}" not found on ${targetName}.`, `Available: ${tools.map(t => t.name).join(', ') || '(none)'}`);
      }
      const r = await fetch(targetUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Private': piPrivate, ...(accessKey ? { 'X-Pi-Access-Key': accessKey } : {}) },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: args.tool, arguments: args.args ?? {} } }),
        signal:  AbortSignal.timeout(15000),
      });
      if (!r.ok) return fail(`Call to ${targetName} failed (${r.status}).`);
      const result = await r.json();
      return result.error ? fail(result.error.message) : result.result;
    }

    const serverTools = tools.map(t => ({ name: t.name, description: `[${targetName}] ${t.description ?? ''}`.trim() }));
    return ok({
      entered: targetName,
      url:     targetUrl,
      tools:   { server: serverTools },
      note: serverTools.length
        ? `${serverTools.length} tools available at ${targetName}. Call one with mount({ url, tool, args }) — direct-name calling isn't supported for manual mounts.`
        : `Connected to ${targetName}. No tools available.`,
    });
  } catch (e) {
    return fail(`Could not connect to ${targetUrl}.`, String(e.message ?? e));
  }
}

// ── Proxy to entered MCP ──────────────────────────────────────────────────────

async function proxyToEntered(piPrivate, publicPi, toolName, args, accessKey) {
  const { rows: [session] } = await pool.query(
    'SELECT connected_mounts FROM mcp_sessions WHERE public_pi = $1',
    [publicPi]
  );
  const mounts = session?.connected_mounts ?? [];
  const owner  = mounts.find(m => (m.tools ?? []).some(t => t.name === toolName));
  if (!owner) {
    return fail(`Unknown tool "${toolName}". Call mount to connect to an MCP first.`);
  }
  try {
    const r = await fetch(owner.url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Private': piPrivate, ...(accessKey ? { 'X-Pi-Access-Key': accessKey } : {}) },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } }),
    });
    if (!r.ok) return fail(`Call to ${owner.name} failed (${r.status})`);
    const result = await r.json();
    return result.error ? fail(result.error.message) : result.result;
  } catch (e) {
    return fail(`Call to ${owner.name} failed.`, String(e));
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const BASE_TOOLS = [
  {
    name: 'set',
    description: "Boot/configure this pair: personality, behaviors, auto_mount, gateway_mcp, access key, rename operator/agent. Called automatically (with no arguments) by the outer ping relay when it isn't given a tool to invoke - this is what actually runs on a bare ping. Call directly only if you're already on /tools without going through the relay.",
    inputSchema: {
      type: 'object',
      properties: {
        private_pi:    { type: 'string', description: 'Reconnect: your existing private π number (if not in headers).' },
        nick_operator: { type: 'string', description: 'Rename operator nickname.' },
        nick_agent:    { type: 'string', description: 'Rename agent nickname.' },
        cc_public_pi:  { type: 'string', description: 'π address to CC on all incoming messages.' },
        personality:   { type: 'string', description: 'Agent personality text.' },
        behaviors:     { type: 'object', description: 'Behavior toggles: auto_log, session_end_log, start_with_last_log, auto_check_activity.' },
        notify:        { type: 'object', description: 'Push notifications for incoming messages, independent of active connection. { slack: "<incoming webhook URL, from your own Slack workspace>", email: "<address>" }. Pass null to clear either.' },
        auto_mount:     { type: 'array', items: { type: 'string' }, description: 'MCP URLs to auto-mount at every boot for extra tools. Pure tool-extension - never replaces your base toolset (ping/browse/post/mount always come from gateway_mcp). Any tool name that collides with your base toolset or another mount is dropped, not overridden.' },
        gateway_mcp:    { type: 'string', description: 'Your gateway MCP URL (updated in PIR).' },
        set_access_key: { type: 'string', description: 'Security key for this pair. When set, connections without it are rejected. Provide a value to set or replace; omit to leave unchanged; clear to remove.' },
      },
    },
  },
  {
    name: 'browse',
    description: 'Read everything on π. Returns an activity brief (unread/mentions) on every call, regardless of target. Default target: activity (unread inbox). Targets: activity · contacts · servers · history · files · docs. history/files/activity also include posts shared with you, including from other π instances.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'activity (default) | contacts | servers | history | files' },
        query:  { type: 'string', description: 'contacts: search by nickname. servers: search by name.' },
        limit:  { type: 'number', description: 'Max results (default 50).' },
        name:   { type: 'string', description: 'files: read a specific file by name.' },
      },
    },
  },
  {
    name: 'post',
    description: 'Write, send, share. Default recipient: self (a note to self). If this already exists as one of your own posts, share it by reference instead of rewriting it: post({to, name}) with NO content — works across instances too. If it exists elsewhere (e.g. Drive), paste the link as content instead of pasting the document — content over 8,000 chars sent to someone else is rejected either way. Content types: json (default, ephemeral 90-day TTL) · md · svg · webp (permanent). Recipients: self · nickname · contacts · all. Schedule via at. Thread via reply_to. Fire an external API via url.',
    inputSchema: {
      type: 'object',
      properties: {
        content:      { type: 'string', description: 'Post body. Required to write something new — omit along with name+to to share an existing post of yours instead.' },
        to:           { type: 'string', description: 'Recipient: self (default) | nickname | contacts | all (admin only). Plain value — no sigils.' },
        content_type: { type: 'string', description: 'json (default) | md | svg | webp. Inferred from content if omitted.' },
        name:         { type: 'string', description: 'Filename for permanent files (md/svg/webp). Also used to share: an existing post with this name, no content, shares it instead of writing new.' },
        reply_to:     { type: 'string', description: 'Post ID to reply to. Threads replies to original recipients.' },
        url:          { type: 'string', description: 'External API endpoint to fire on post.' },
        at:           { type: 'string', description: 'ISO timestamp for scheduled release.' },
      },
    },
  },
  {
    name: 'mount',
    description: "Mount any MCP on the π network — registered or not. Stateless pass-through: give url (or name from the π registry) alone to see its tool list, or add tool + args to call one of them directly in the same request and get its result back. Nothing persists between calls — there's no 'currently mounted' server to reconnect to or unmount. Doesn't affect auto_mount, a separate, persistent tool-extension mechanism configured via ping.",
    inputSchema: {
      type: 'object',
      properties: {
        url:  { type: 'string', description: 'Direct MCP URL.' },
        name: { type: 'string', description: 'Name from π registry.' },
        tool: { type: 'string', description: 'Tool name to call on the target, in the same request. Omit to just see its tool list.' },
        args: { type: 'object', description: 'Arguments for tool, passed through as-is.' },
      },
    },
  },
];

// ── JSON-RPC handler ──────────────────────────────────────────────────────────

async function handleJsonRpc(piPrivate, body, accessKey) {
  const { method, id, params } = body;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities:    { tools: { listChanged: false } },
        serverInfo:      { name: 'pi-gateway', version: GATEWAY_VERSION },
        instructions:    "This is /tools, the real π server - normal clients reach it only via the open /3.14 ping relay, never directly. If you are here directly: call 'set' to boot (identity, spec, activity, config), or any other tool by name.",
      },
    };
  }

  if (method === 'tools/list') {
    // /tools (this route) requires identity for tools/list itself now, not just
    // tools/call - previously the base toolset was handed to anyone regardless of
    // auth, only mount-merging was gated. Only the outer relay (/3.14, bare ping)
    // is meant to be open; this inner route isn't.
    const listValidated = piPrivate && PRIVATE_PI_RE.test(piPrivate) ? await validateWithKey(piPrivate, accessKey) : null;
    if (!listValidated?.valid || !passesLocalKeyPolicy(listValidated)) {
      return { jsonrpc: '2.0', id, result: { tools: [] } };
    }
    let tools = [...BASE_TOOLS];
    {
      const publicPi = listValidated.public_pi;
      const { rows: [session] } = await pool.query(
        'SELECT connected_mounts FROM mcp_sessions WHERE public_pi = $1',
        [publicPi]
      );
      const mounts = session?.connected_mounts ?? [];
      // gateway_mcp always owns ping/browse/post/mount, full stop - no mount, however many
      // base verbs it exposes, ever replaces the base toolset (isFullMount removed entirely).
      // Live-refetch each mount's tools rather than trusting the cached column indefinitely
      // (found July 3, recurred July 5 - a stale cache kept showing tools weeks after they
      // stopped being relevant). Dedup against everything already claimed so far.
      for (const m of mounts) {
        let liveTools = m.tools ?? [];
        try {
          const liveRes = await fetch(m.url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'X-Pi-Private': piPrivate },
            body:    JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
            signal:  AbortSignal.timeout(5000),
          });
          if (liveRes.ok) liveTools = (await liveRes.json())?.result?.tools ?? liveTools;
        } catch (e) { /* fall back to cached tools */ }
        const taken = new Set(tools.map(t => t.name));
        const kept  = liveTools.filter(t => !taken.has(t.name));
        tools = [...tools, ...kept.map(t => ({
          ...t,
          description: `[${m.name}] ${t.description ?? ''}`.trim(),
        }))];
      }
    }
    return { jsonrpc: '2.0', id, result: { tools } };
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args     = params?.arguments ?? {};

    try {
      let result;

      if (toolName === 'set') {
        result = await toolSet(piPrivate, args, accessKey);
      } else {
        const validated = piPrivate && PRIVATE_PI_RE.test(piPrivate) ? await validateWithKey(piPrivate, accessKey) : null;
        if (!validated?.valid || !passesLocalKeyPolicy(validated)) {
          return { jsonrpc: '2.0', id, result: noIdentity() };
        }
        const publicPi = validated.public_pi;

        // gateway_mcp always owns these four verbs — no mount, however many base verbs
        // it exposes, ever takes over dispatch (isFullMount removed entirely).
        switch (toolName) {
          case 'browse': result = await toolBrowse(piPrivate, publicPi, args); break;
          case 'post':   result = await toolPost(piPrivate, publicPi, args);   break;
          case 'mount':  result = await toolEnter(piPrivate, publicPi, args, accessKey);  break;
          default:       result = await proxyToEntered(piPrivate, publicPi, toolName, args, accessKey);
        }
      }

      return { jsonrpc: '2.0', id, result };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: fail('Unexpected error.', String(e)) };
    }
  }

  if (method?.startsWith('notifications/')) {
    return { jsonrpc: '2.0', id, result: {} };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

// ── Outer boot relay (bare /3.14) ───────────────────────────────────────────────
//
// /3.14 surfaces exactly one tool — ping — open, no auth of its own, ever. It runs
// zero logic of its own beyond routing: ping is a mount-style pass-through, hardwired
// to /tools (this same process, loopback) instead of an arbitrary external URL, using
// the exact mechanism `mount({url,tool,args})` already proved works against a real
// client (2026-07-09) — a call to an already-known name carrying an arbitrary target
// tool + args, executed and returned in the same round trip. No new tool name ever
// needs to be discovered, so there's no tools/list-refresh problem to fight (that's
// what sank the original relay attempt — see project_boot_proxy_scope memory).
//
// ping({}) or ping() — no `tool` given — relays straight through to /tools' `set`,
// passing the entire arguments object as-is. This is what makes a bare ping call
// still boot exactly like it always has (identity, spec, personality, activity,
// auto_mount, config updates) - no special-casing needed, `set` never even knows
// it was reached via the relay rather than directly.
//
// ping({tool, args}) — relays to /tools for that specific tool name instead, e.g.
// ping({tool:'browse', args:{target:'activity'}}). /tools' own dispatch (unchanged)
// already falls through to proxyToEntered for any name that isn't set/browse/post/
// mount, so an auto-mounted external tool (e.g. autobot) is reached exactly the same
// way, with no extra code here.
//
// No boot-state tracking of any kind (no hasBooted/markBooted/mergeBootMount, unlike
// the reverted first attempt) - every call is a stateless relay, auth included. There
// is deliberately no "call ping first" gate beyond that: tools/list here only ever
// contains ping, so there is nothing else to call by name in the first place, and a
// caller who hand-writes ping({tool:'browse',...}) as their very first call is by
// definition already past needing the guardrail.

const PING_STUB = [{
  name: 'ping',
  description: "Boot a session, or call any real tool through the relay. ping() or ping({}) boots (identity, spec, personality, activity, config) - always do this first each session. ping({tool, args}) invokes any other tool directly (e.g. browse, post, mount, or anything auto-mounted) and returns its result in the same call - this is the only way to reach them, they are never separately listed here.",
  inputSchema: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: 'Real tool to invoke (e.g. browse, post, mount). Omit to boot instead.' },
      args: { type: 'object', description: 'Arguments for tool, passed through as-is. Ignored if tool is omitted.' },
    },
  },
}];

function innerHeaders(req) {
  const headers = { 'Content-Type': 'application/json' };
  if (req.headers['x-pi-private'])    headers['X-Pi-Private']    = req.headers['x-pi-private'];
  if (req.headers['x-pi-access-key']) headers['X-Pi-Access-Key'] = req.headers['x-pi-access-key'];
  if (req.headers['authorization'])   headers['Authorization']   = req.headers['authorization'];
  return headers;
}

// Loopback call to /tools — deliberately plain fetch, not safeFetch. safeFetch's SSRF
// guard exists to block user-supplied mount URLs from reaching loopback/RFC1918
// addresses; this target is a hardcoded, same-process URL, not user input, so the
// guard doesn't apply here and would wrongly block this call if used.
async function callInner(req, body) {
  return fetch(`http://127.0.0.1:${PORT}${PREFIX}/tools`, {
    method:  'POST',
    headers: innerHeaders(req),
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(15000),
  });
}

async function handleOuter(req, res) {
  const body = req.body;
  if (!body?.jsonrpc) return res.status(400).json({ error: 'Invalid JSON-RPC' });
  const { method, id, params } = body;

  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities:    { tools: { listChanged: false } },
        serverInfo:      { name: 'pi-gateway', version: GATEWAY_VERSION },
        instructions:    "Call 'ping' now, before anything else - with no arguments to boot (identity, spec, activity, config), or with {tool, args} to invoke any real tool directly once you know what's available (ping's own boot response lists them). This is the only tool here; everything else goes through it.",
      },
    });
  }

  if (method?.startsWith('notifications/')) return res.status(202).end();

  if (method === 'tools/list') {
    return res.json({ jsonrpc: '2.0', id, result: { tools: PING_STUB } });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args     = params?.arguments ?? {};

    if (toolName !== 'ping') {
      return res.json({ jsonrpc: '2.0', id, result: fail(`"${toolName}" isn't a real tool here — call ping({ tool: "${toolName}", args: {...} }) instead.`) });
    }

    const innerName = args.tool ? args.tool : 'set';
    const innerArgs = args.tool ? (args.args ?? {}) : args;

    try {
      const innerRes = await callInner(req, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: innerName, arguments: innerArgs } });
      if (innerRes.status === 401) {
        res.status(401);
        const www = innerRes.headers.get('www-authenticate');
        if (www) res.set('WWW-Authenticate', www);
        return res.json(await innerRes.json());
      }
      return res.json(await innerRes.json());
    } catch (e) {
      return res.json({ jsonrpc: '2.0', id, result: fail('Could not reach the real toolset.', String(e.message ?? e)) });
    }
  }

  return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Pi-Private, X-Pi-Access-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Health ────────────────────────────────────────────────────────────────────

app.get(`${PREFIX}/health`, (req, res) =>
  res.json({ status: 'ok', service: 'pi-gateway', version: GATEWAY_VERSION, protocol_version: PROTOCOL_VERSION })
);

// ── Deliver — inbound from other gateways ────────────────────────────────────

app.post(`${PREFIX}/deliver`, async (req, res) => {
  const body = req.body;
  if (!body?.to_public_pi || !body?.content) {
    return res.status(400).json({ error: 'to_public_pi and content required' });
  }

  // Route via gateway_mcp — the authoritative access point
  const pirRecord = await pirLookup(body.to_public_pi);
  if (pirRecord?.gateway_mcp) {
    const normalize = u => u.replace(/\/$/, '');
    if (normalize(pirRecord.gateway_mcp) !== normalize(selfUrl())) {
      const deliverUrl = pirRecord.gateway_mcp.replace(/\/$/, '') + '/deliver';
      try {
        const r = await fetch(deliverUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (r.ok) return res.json({ ok: true, forwarded: true });
        const errBody = await r.text().catch(() => '');
        console.error(`[/deliver] forward to ${deliverUrl} → ${r.status}: ${errBody}`);
      } catch (e) {
        console.error(`[/deliver] forward to ${deliverUrl} → error: ${e}`);
      }
    }
  }

  try {
    // reply_to from a remote server references a foreign DB ID — drop it to avoid FK violation
    await pool.query(`
      INSERT INTO posts (from_public_pi, to_scope, to_public_pi, content, content_type, name, reply_to)
      VALUES ($1, 'nickname', $2, $3, $4, $5, NULL)
    `, [
      body.from_public_pi ?? null, body.to_public_pi, body.content,
      body.content_type ?? 'json', body.name ?? null,
    ]);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }

  void sendNotifications(body.to_public_pi, body);

  // Auto-contact on deliver removed: contacts are managed via PIR.
  // piPrivate not available in /deliver context; contacts establish via post flows.

  // CC routing
  const { rows: [recipientSession] } = await pool.query(
    'SELECT cc_public_pi FROM mcp_sessions WHERE public_pi = $1',
    [body.to_public_pi]
  );
  if (recipientSession?.cc_public_pi) {
    const ccTarget = await pirLookup(recipientSession.cc_public_pi);
    if (ccTarget) {
      deliverToGateway({
        from_public_pi: body.from_public_pi ?? null,
        to_public_pi:   recipientSession.cc_public_pi,
        content:        body.content,
        content_type:   body.content_type ?? 'json',
        name:           body.name ?? null,
        reply_to:       body.reply_to ?? null,
        from_nick_agent:    body.from_nick_agent    ?? null,
        from_nick_operator: body.from_nick_operator ?? null,
      }, ccTarget).catch(() => {});
    }
  }

  return res.json({ ok: true });
});

// ── Cross-instance live sharing ─────────────────────────────────────────────────
// Two endpoints, implemented identically on every π instance (any instance can be either
// side of a share): /shared/notify records that something was shared with one of our own
// pairs by another instance (a pointer only, never content); /shared/resolve is how another
// instance fetches the live content of something one of ITS pairs shared with one of ours.
// Content only ever lives on the instance that originally stored it.

app.post(`${PREFIX}/shared/notify`, async (req, res) => {
  const { post_id, origin_gateway_mcp, shared_with_public_pi, from_public_pi, name, content_type } = req.body || {};
  if (!post_id || !origin_gateway_mcp || !shared_with_public_pi) {
    return res.status(400).json({ error: 'post_id, origin_gateway_mcp, shared_with_public_pi required' });
  }
  try {
    await pool.query(`
      INSERT INTO remote_shares (post_id, origin_gateway_mcp, shared_with_public_pi, from_public_pi, name, content_type)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (post_id, shared_with_public_pi) DO UPDATE SET shared_at = NOW(), accessed_at = NULL
    `, [post_id, origin_gateway_mcp, shared_with_public_pi, from_public_pi ?? null, name ?? null, content_type ?? 'json']);
    void sendNotifications(shared_with_public_pi, {
      content: `Shared: ${name ?? post_id}`, from_public_pi, from_nick_agent: null, from_nick_operator: null,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post(`${PREFIX}/shared/resolve`, async (req, res) => {
  const { post_id, shared_with_public_pi } = req.body || {};
  if (!post_id || !shared_with_public_pi) {
    return res.status(400).json({ error: 'post_id, shared_with_public_pi required' });
  }
  const found = await resolveSharedPost(post_id, shared_with_public_pi);
  if (!found) return res.status(404).json({ found: false });
  res.json({ found: true, ...found });
});

// ── Gateway docs — public REST ────────────────────────────────────────────────

app.get(`${PREFIX}/docs`, async (req, res) => {
  const { rows } = await pool.query('SELECT name, description, created_at FROM gateway_docs ORDER BY created_at');
  return res.json({ docs: rows });
});

app.get(`${PREFIX}/docs/:name`, async (req, res) => {
  const { rows: [doc] } = await pool.query(
    'SELECT name, content, description, created_at FROM gateway_docs WHERE name = $1',
    [req.params.name]
  );
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  return res.send(doc.content);
});

// ── Public contact endpoint ───────────────────────────────────────────────────

app.post(`${PREFIX}/contact/:nick`, async (req, res) => {
  const nick = req.params.nick;
  const body = req.body;
  if (!body?.message) return res.status(400).json({ error: 'message is required' });

  if (body.website) return res.json({ ok: true, delivered: false }); // honeypot

  const msg = String(body.message).trim();
  if (msg.length < 12) return res.status(400).json({ error: 'message too short' });
  if (!msg.includes(' ') && !msg.includes('://')) return res.status(400).json({ error: 'invalid message' });

  if (body.email) {
    const emailStr  = String(body.email);
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr) && !emailStr.includes('..');
    if (!validEmail) return res.status(400).json({ error: 'invalid email address' });
  }

  const resolved = await resolveRecipient(nick);
  if (resolved.ambiguous) return res.status(409).json({ error: `Multiple pairs found for "${nick}". Use a π address.` });
  if (!resolved.target)   return res.status(404).json({ error: `No pair found for "${nick}"` });

  const target = resolved.target;
  const { name, email, subject, message } = body;
  const lines = [];
  if (subject) lines.push(`**${subject}**\n`);
  if (name || email) lines.push(`From: ${[name, email ? `<${email}>` : ''].filter(Boolean).join(' ')}\n`);
  lines.push(message);
  const content = lines.join('\n');

  try {
    await pool.query(`
      INSERT INTO posts (from_public_pi, to_scope, to_public_pi, content, content_type, name, reply_to)
      VALUES ('', 'nickname', $1, $2, 'md', NULL, NULL)
    `, [target.public_pi, content]);
  } catch (e) {
    return res.status(500).json({ error: 'Delivery failed' });
  }

  const contactPayload = { from_public_pi: null, to_public_pi: target.public_pi, content, content_type: 'md', name: null, reply_to: null };
  const contactIsRemote = target.gateway_mcp && !target.gateway_mcp.startsWith(selfUrl());
  const { rows: [session] } = await pool.query(
    'SELECT public_pi, cc_public_pi FROM mcp_sessions WHERE public_pi = $1', [target.public_pi]
  );
  if (contactIsRemote || !session) {
    deliverToGateway(contactPayload, target).catch(() => {});
  }

  // CC routing
  if (session?.cc_public_pi) {
    const ccTarget = await pirLookup(session.cc_public_pi);
    if (ccTarget) {
      deliverToGateway({
        from_public_pi: null, to_public_pi: session.cc_public_pi,
        content, content_type: 'md', name: null, reply_to: null,
      }, ccTarget).catch(() => {});
    }
  }

  return res.json({ ok: true, delivered: true });
});

// ── Mailgun inbound email endpoint ────────────────────────────────────────────

app.post(`${PREFIX}/mail/:nick`, upload.any(), async (req, res) => {
  const nick   = req.params.nick;
  const form   = req.body ?? {};
  const sender = form.sender ?? '';
  const from   = form.from   ?? sender;
  const subject = form.subject ?? '';
  const body    = form['stripped-text'] ?? form['body-plain'] ?? '';

  if (!body && !subject) return res.status(400).json({ error: 'empty message' });

  const resolved = await resolveRecipient(nick);
  if (resolved.ambiguous) return res.status(409).json({ error: `Multiple pairs found for "${nick}"` });
  if (!resolved.target)   return res.status(404).json({ error: `No pair found for "${nick}"` });

  const target = resolved.target;
  const lines  = [];
  if (subject) lines.push(`**${subject}**\n`);
  if (from)    lines.push(`From: ${from}\n`);
  if (body)    lines.push(body);

  const files = (req.files ?? []).filter(f => f.fieldname.startsWith('attachment'));
  if (files.length) {
    try {
      const uploadDir = '/var/www/endandit.nl/uploads';
      fs.mkdirSync(uploadDir, { recursive: true });
      const attachLines = ['', '**Attachments:**'];
      for (const file of files) {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${randomUUID()}-${safeName}`;
        fs.writeFileSync(path.join(uploadDir, filename), file.buffer);
        attachLines.push(`- [${file.originalname}](https://endandit.nl/uploads/${filename})`);
      }
      lines.push(attachLines.join('\n'));
    } catch (e) {
      console.error('[mail] attachment save failed:', e.message);
    }
  }

  const content = lines.join('\n');

  try {
    await pool.query(`
      INSERT INTO posts (from_public_pi, to_scope, to_public_pi, content, content_type, name, reply_to)
      VALUES ('', 'nickname', $1, $2, 'md', NULL, NULL)
    `, [target.public_pi, content]);
  } catch (e) {
    return res.status(500).json({ error: 'Delivery failed' });
  }

  const payload = { from_public_pi: null, to_public_pi: target.public_pi, content, content_type: 'md', name: null, reply_to: null };

  // Always deliver to remote home MCP; local-session check doesn't apply for inbound email
  const isRemote = target.gateway_mcp && !target.gateway_mcp.startsWith(selfUrl());
  const { rows: [session] } = await pool.query(
    'SELECT public_pi, cc_public_pi FROM mcp_sessions WHERE public_pi = $1', [target.public_pi]
  );
  if (isRemote || !session) {
    deliverToGateway(payload, target).catch(() => {});
  }

  // CC routing
  if (session?.cc_public_pi) {
    const ccTarget = await pirLookup(session.cc_public_pi);
    if (ccTarget) {
      deliverToGateway({
        from_public_pi: null, to_public_pi: session.cc_public_pi,
        content, content_type: 'md', name: null, reply_to: null,
      }, ccTarget).catch(() => {});
    }
  }

  return res.json({ ok: true });
});

// ── OAuth 2.0 Authorization Server ───────────────────────────────────────────

const oauthCard = (title, body) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90' font-family='Georgia,serif' fill='%236B8F71'%3E%CF%80%3C/text%3E%3C/svg%3E">
<title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;background:#1A1A18;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem}
.wrap{max-width:340px;width:100%}
.pi-mark{font-family:'Georgia',serif;font-size:1.5rem;color:#6B8F71;display:block;margin-bottom:2rem}
h1{font-family:'Georgia',serif;font-weight:normal;font-size:1.1rem;color:rgba(255,255,255,0.85);margin-bottom:.4rem}
p{color:rgba(255,255,255,0.35);font-size:.82rem;margin-bottom:1.6rem;line-height:1.55}
.label-row{display:flex;align-items:center;gap:5px;margin-top:1.1rem;margin-bottom:.3rem}
label{font-size:.68rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,0.35)}
.opt{font-weight:400;color:rgba(255,255,255,0.20);font-size:.68rem;text-transform:none;letter-spacing:0}
input{width:100%;padding:.55rem .75rem;background:transparent;border:none;border-bottom:1px solid rgba(107,143,113,0.25);font-size:.9rem;font-family:monospace;color:rgba(255,255,255,0.80);outline:none;transition:border-color .15s;border-radius:0}
input::placeholder{color:rgba(255,255,255,0.18);font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;font-style:italic}
input:focus{border-bottom-color:#7EAB85}
button,a.btn{display:block;width:100%;margin-top:2rem;padding:.65rem;background:#6B8F71;color:#fff;border:none;border-radius:3px;font-size:.85rem;font-weight:600;cursor:pointer;text-decoration:none;text-align:center;letter-spacing:.04em;transition:background .15s}
button:hover,a.btn:hover{background:#7EAB85}
.err{color:#e07070;font-size:.82rem;margin:.75rem 0 0}
.key-box{font-family:monospace;font-size:.88rem;background:rgba(107,143,113,0.07);border:1px solid rgba(107,143,113,0.22);border-radius:3px;padding:.85rem 1rem;word-break:break-all;color:#7EAB85;margin:.5rem 0 .75rem;cursor:pointer;user-select:all;line-height:1.5}
.slabel{font-size:.68rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,0.35);margin-bottom:.3rem;display:block}
.copy-wrap{display:flex;align-items:center;gap:10px;background:rgba(107,143,113,0.07);border:1px solid rgba(107,143,113,0.22);border-radius:3px;padding:.75rem 1rem;margin:.3rem 0}
.copy-val{font-family:monospace;font-size:.88rem;color:#7EAB85;flex:1;word-break:break-all;line-height:1.5}
.copy-btn{flex-shrink:0;background:transparent;border:1px solid rgba(107,143,113,0.30);border-radius:2px;color:#6B8F71;font-size:.68rem;font-weight:600;letter-spacing:.04em;cursor:pointer;padding:.2rem .5rem;transition:color .15s,border-color .15s;width:auto;margin:0}
.copy-btn:hover{color:#7EAB85;border-color:rgba(107,143,113,0.55)}
.share-note{color:rgba(255,255,255,0.25);font-size:.75rem;margin:.35rem 0 0;line-height:1.4}
.cd-text{color:rgba(255,255,255,0.35);font-size:.82rem;margin-top:1.2rem;text-align:center}
.cd-link{color:#7EAB85;cursor:pointer;text-decoration:none}
.cd-link:hover{color:#6B8F71}
.warn{color:rgba(255,200,100,0.65);font-size:.76rem;font-weight:600;margin:0 0 1.4rem}
</style></head>
<body><div class="wrap">${body}</div></body></html>`;

const esc = v => String(v ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');

app.get(`${PREFIX}/.well-known/oauth-authorization-server`, (req, res) => {
  const base = selfUrl();
  res.json({
    issuer:                                base,
    authorization_endpoint:                `${base}/authorize`,
    token_endpoint:                        `${base}/token`,
    registration_endpoint:                 `${base}/register`,
    response_types_supported:              ['code'],
    grant_types_supported:                 ['authorization_code'],
    code_challenge_methods_supported:      ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  });
});

app.post(`${PREFIX}/register`, express.json(), (req, res) => {
  res.status(201).json({
    client_id:                  randomUUID(),
    client_id_issued_at:        Math.floor(Date.now() / 1000),
    redirect_uris:              req.body?.redirect_uris ?? [],
    grant_types:                ['authorization_code'],
    response_types:             ['code'],
    token_endpoint_auth_method: 'none',
  });
});

function connectPage(redirect_uri, state, code_challenge, error = null) {
  const reqKey = process.env.REQUIRE_ACCESS_KEY !== 'false';
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const keyField = reqKey
    ? `<div class="label-row"><label>Access key</label></div>
       <input type="password" name="access_key" placeholder="access key" autocomplete="off" required>`
    : `<div class="label-row"><label>Access key</label><span class="opt">optional</span></div>
       <input type="password" name="access_key" placeholder="access key (if set)" autocomplete="off">`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90' font-family='Georgia,serif' fill='%236B8F71'%3E%CF%80%3C/text%3E%3C/svg%3E">
<title>Connect — π</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;background:#1A1A18;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem}
.card{background:#232321;border:1px solid rgba(107,143,113,0.18);border-radius:6px;padding:2rem;max-width:360px;width:100%}
h1{color:#fff;font-size:1.05rem;font-weight:600;margin-bottom:.35rem}
.sub{color:#666;font-size:.82rem;margin-bottom:1.6rem;line-height:1.5}
.label-row{display:flex;align-items:center;gap:6px;margin-top:1rem;margin-bottom:.3rem}
label{font-size:.78rem;font-weight:600;color:#aaa}
.opt{font-size:.74rem;color:#555}
input{width:100%;padding:.5rem .75rem;background:#111;border:1px solid #2a2a28;border-radius:3px;color:#ccc;font-size:.88rem;font-family:monospace}
input:focus{outline:none;border-color:#6B8F71}
button{display:block;width:100%;margin-top:1.5rem;padding:.65rem;background:#6B8F71;color:#fff;border:none;border-radius:3px;font-size:.85rem;font-weight:600;cursor:pointer;letter-spacing:.03em}
button:hover{background:#5a7a60}
.err{color:#e07070;font-size:.82rem;margin-top:.8rem}
.foot{color:rgba(255,255,255,.18);font-size:.75rem;margin-top:1.6rem;text-align:center}
</style>
</head>
<body>
<div class="card">
<h1>π — Connect</h1>
<p class="sub">Enter your π credentials. Your <strong style="color:#aaa">private π</strong> starts with 3.14 and is 20 characters — you received it when your pair was commissioned. Your <strong style="color:#aaa">access key</strong> was set separately${reqKey ? '' : ' (optional on this instance)'}.<br><br>Credentials are stored by your AI assistant and won't be shown again.</p>
<form method="POST">
<input type="hidden" name="redirect_uri" value="${esc(redirect_uri)}">
<input type="hidden" name="state" value="${esc(state ?? '')}">
<input type="hidden" name="code_challenge" value="${esc(code_challenge ?? '')}">
<div class="label-row"><label>Private π</label></div>
<input type="password" name="pi_key" placeholder="3.14…" autocomplete="current-password" required>
${keyField}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<button type="submit">Connect</button>
</form>
<p class="foot">No pair yet? Ask your agent to call <code style="font-family:monospace;color:#6B8F71">ping({ nick_operator: "…", nick_agent: "…" })</code> first to commission one.<br><br>π never resolves — it grows.</p>
</div>
</body>
</html>`;
}

app.get(`${PREFIX}/authorize`, (req, res) => {
  const { redirect_uri, state, code_challenge } = req.query;
  if (!redirect_uri) return res.status(400).send('Missing redirect_uri');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(connectPage(redirect_uri, state, code_challenge));
});

app.post(`${PREFIX}/authorize`, express.urlencoded({ extended: false }), async (req, res) => {
  const { pi_key, access_key, redirect_uri, state, code_challenge } = req.body ?? {};
  if (!pi_key || !redirect_uri) return res.status(400).send('Missing required fields');

  const piPrivate = pi_key.trim();
  const accessKey = access_key?.trim() || null;
  const reqKey    = process.env.REQUIRE_ACCESS_KEY !== 'false';

  const sendError = msg => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(connectPage(redirect_uri, state, code_challenge, msg));
  };

  if (!PRIVATE_PI_RE.test(piPrivate))
    return sendError("That doesn't look like a valid private π. It starts with 3.14 followed by 18 digits.");
  if (reqKey && !accessKey)
    return sendError('Access key required for this instance.');

  const validated = await validateWithKey(piPrivate, accessKey || undefined);
  if (!validated?.valid)
    return sendError('Credentials not recognised. Check your private π and access key.');

  const code = randomUUID();
  oauthCodes.set(code, { piPrivate, accessKey, challenge: String(code_challenge ?? ''), expires: Date.now() + 5 * 60_000, src: 'form' });
  const url = new URL(String(redirect_uri));
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', String(state));
  res.redirect(url.toString());
});

app.post(`${PREFIX}/token`, express.urlencoded({ extended: false }), async (req, res) => {
  const { grant_type, code, code_verifier, client_secret } = req.body ?? {};
  if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });

  const entry = oauthCodes.get(code);
  if (!entry || Date.now() > entry.expires) { oauthCodes.delete(code); return res.status(400).json({ error: 'invalid_grant' }); }

  const expected = createHash('sha256').update(code_verifier ?? '').digest('base64url');
  if (expected !== entry.challenge) { oauthCodes.delete(code); return res.status(400).json({ error: 'invalid_grant' }); }
  oauthCodes.delete(code);

  // Access key: from client_secret (direct/Advanced Settings path) or from form submission
  const accessKey = client_secret?.trim() || entry.accessKey || null;

  const validated = await validateWithKey(entry.piPrivate, accessKey);
  if (!validated?.valid) return res.status(401).json({ error: 'invalid_client' });

  const token = accessKey ? `${entry.piPrivate}|${accessKey}` : entry.piPrivate;
  res.json({ access_token: token, token_type: 'Bearer', expires_in: 7776000 });
});

// ── Real MCP endpoint (/tools — inner, auth-required server) ───────────────────
//
// Everything except initialize requires identity here — tools/list included (see the
// tightened check inside handleJsonRpc above). Only the outer relay (/3.14, bare ping,
// registered below) is meant to be open; this route isn't. This is also where the
// OAuth 401/browser-credential-page challenge fires — the outer relay never 401s of
// its own accord, it just passes this one through when it happens.
app.post(`${PREFIX}/tools`, async (req, res) => {
  let piPrivate = req.headers['x-pi-private'] ?? null;
  let accessKey = req.headers['x-pi-access-key'] ?? null;
  if (!piPrivate) {
    const bearer = (req.headers['authorization'] ?? '').startsWith('Bearer ')
      ? req.headers['authorization'].slice(7) : null;
    if (bearer) {
      const parts = bearer.split('|');
      piPrivate = parts[0].trim() || null;
      if (parts[1] && !accessKey) accessKey = parts[1].trim() || null;
    }
  }
  const body = req.body;
  if (!body?.jsonrpc) return res.status(400).json({ error: 'Invalid JSON-RPC' });
  if (body.method?.startsWith('notifications/')) return res.status(202).end();
  if (!piPrivate && body.method !== 'initialize') {
    return res.status(401).set('WWW-Authenticate', `Bearer as_uri="${selfUrl()}/.well-known/oauth-authorization-server"`).json({ error: 'Unauthorized' });
  }
  return res.json(await handleJsonRpc(piPrivate, body, accessKey));
});

// ── Outer boot relay (bare /3.14 — pitr.network/3.14) ───────────────────────────
//
// Open, unauthenticated, ping-only, forever. See handleOuter above for the mechanics.
app.post(`${PREFIX}/mcp`, handleOuter);

// ── SSE transport ─────────────────────────────────────────────────────────────

function handleSse(req, res) {
  const publicUrl   = process.env.GATEWAY_PUBLIC_URL ?? selfUrl();
  const messagesUrl = `${publicUrl}/messages`;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`event: endpoint\ndata: ${JSON.stringify({ uri: messagesUrl })}\n\n`);

  const piPrivate = req.headers['x-pi-private'] ?? null;
  const publicPi  = piPrivate && PRIVATE_PI_RE.test(piPrivate) ? toPublicPi(piPrivate) : null;
  if (publicPi) sseClients.set(publicPi, res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
  }, 20_000);

  req.on('close', () => {
    clearInterval(ping);
    if (publicPi) sseClients.delete(publicPi);
  });
}

// GET on the bare MCP endpoint (same URL as POST) opens an SSE stream too - the modern
// Streamable HTTP transport expects this. Previously fell through to a plain 404 since
// the old GET landing page was removed - a stronger negative signal than a working
// stream. Reuses the same handler as /sse below.
app.get(`${PREFIX}`, handleSse);

app.get(`${PREFIX}/sse`, handleSse);

// Same outer relay as /mcp — this is the message-posting side of the older SSE
// transport variant, reachable from the same bare /3.14 origin.
app.post(`${PREFIX}/messages`, handleOuter);

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => console.log(`Gateway v${GATEWAY_VERSION} listening on port ${PORT}`));
