// π Gateway v3.2.3 — pi · browse · post · mount · SSE transport · full-mount · browser connect
// Node.js / Express / pg | MIT License

import express from 'express';
import multer  from 'multer';
import fs      from 'fs';
import path    from 'path';
import { randomUUID, randomBytes, createHash } from 'crypto';
import pg      from 'pg';

const { Pool } = pg;
const pool   = new Pool({ connectionString: process.env.GW_DB_URL });
const app    = express();
const upload = multer();

const PORT             = Number(process.env.GW_PORT) || 3147;
const PREFIX           = '/gateway';
const GATEWAY_VERSION  = '3.2.3';
const PROTOCOL_VERSION = '2.0';
const PIR              = process.env.PIR_URL ?? 'https://pitr.network/pir';

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

async function pirValidate(piPrivate, accessKey) {
  const body = {};
  if (accessKey) body.access_key = accessKey;
  const r = await fetch(`${PIR}/validate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pi-Private': piPrivate },
    body:    JSON.stringify(body),
  });
  return r.ok ? r.json() : null;
}

async function pirLookup(publicPi) {
  const r = await fetch(`${PIR}/id?id=${encodeURIComponent(publicPi)}`);
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

pi      Commission, config, help. Call with no args to see current config and this reference.
browse  Read everything. Default: activity (unread inbox). Targets: activity · contacts · servers · history · files
post    Write, send, share. Default recipient: self. Content: json (ephemeral) · md · svg · webp (permanent)
mount   Connect to any MCP. Returns their tools. Call them directly after mounting.

## Addressing
Recipient names are plain values — no sigils. "Paulo", "3.14718583930991", "contacts", "all".

## Session rhythm
Call pi on every session start. Unread inbox is included in the pi response as "inbox" — no need to call browse on startup. Post to self (content_type md) at session end as a save point for next time.

π never resolves — it grows.`;
}

function buildHelp() {
  return `## Tool reference

pi
  Commission a new pair or boot an existing one. Config: personality, behaviors, home_mcp, gateway_mcp.
  Behaviors (all on by default): auto_log · session_end_log · start_with_last_log · auto_check_activity
  Call pi with no args to see current config.

browse
  Always returns: activity brief (unread/mentions) + your public π address.
  Targets:
    activity  unread messages + scheduled posts now due (default)
    contacts  your network. query param searches by nickname.
    servers   π registry + mounted MCPs
    history   recent sent/received + immediate self-posts
    files     your documents (.md · .svg · .webp)

post
  Fields: content (required) · to · reply_to · url · at · name · content_type
  Recipients: self (default) · nickname · contacts · all
  Content types: json (default, 90-day TTL) · md · svg · webp (permanent)
  Schedule: at = ISO timestamp. Post appears in browse(activity) when due.
  Thread: reply_to = post ID. Reply scope defaults to original recipients.
  API: url = endpoint. Fires on post. Feedback returned as self-note.

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

async function getAmbient(publicPi) {
  const now = new Date().toISOString();
  const { rows } = await pool.query(`
    SELECT id, to_scope FROM posts
    WHERE (to_public_pi = $1 OR to_scope = 'all')
      AND accessed_at IS NULL
      AND (at IS NULL OR at <= $2)
  `, [publicPi, now]);
  return {
    unread:   rows.filter(p => p.to_scope === 'nickname' || p.to_scope === 'self').length,
    mentions: 0,
  };
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

// ── fireUrl ───────────────────────────────────────────────────────────────────

async function fireUrl(url, content, content_type, publicPi, postId) {
  let errorMsg = null;
  try {
    const res = await fetch(url, {
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

// ── Tool: pi ──────────────────────────────────────────────────────────────────

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
            pi: {
              command: 'npx',
              args: ['-y', 'mcp-remote', 'https://pitr.network/3.14', '--header', `X-Pi-Private:${private_pi}`],
            },
          },
        },
      });
    }

    return noIdentity();
  }

  // set_access_key: set or remove access key for this pair — PIR provisions the key
  if (args?.set_access_key !== undefined) {
    const req_key = args.set_access_key === true ? true : (args.set_access_key || null);
    const r = await fetch(`${PIR}/access-key`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Private': piPrivate },
      body:    JSON.stringify({ access_key: req_key }),
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
  const pirKeys     = ['nick_operator', 'nick_agent', 'personality', 'behaviors', 'home_mcp', 'gateway_mcp'];
  const localUpdates = {};
  const pirUpdates  = { gateway_mcp: selfUrl() };

  for (const key of pirKeys) {
    if (args[key] !== undefined) pirUpdates[key] = args[key];
  }
  if (args.cc_public_pi !== undefined) localUpdates.cc_public_pi = args.cc_public_pi;

  await pirUpdate(piPrivate, pirUpdates);

  const validated = await pirValidate(piPrivate, accessKey);
  if (!validated?.valid) return fail('Identity not found in PIR. Your private key may be invalid.');

  // Upsert session — core fields + home_mcp cache from PIR; personality/behaviors now live in PIR
  const upsertCols = ['public_pi', 'nick_agent', 'nick_operator', 'last_seen', 'home_mcp'];
  const upsertVals = [publicPi, validated.nick_agent, validated.nick_operator, new Date().toISOString(), validated.home_mcp ?? null];

  if (localUpdates.cc_public_pi !== undefined) {
    upsertCols.push('cc_public_pi');
    upsertVals.push(localUpdates.cc_public_pi);
  }

  // connected_url reset to null on every set() — fresh session, no stale enter state
  upsertCols.push('connected_url', 'connected_name', 'connected_tools');
  upsertVals.push(null, null, null);

  const placeholders = upsertVals.map((_, i) => `$${i + 1}`).join(', ');
  const updateSets   = upsertCols
    .filter(c => c !== 'public_pi')
    .map(c => `${c} = EXCLUDED.${c}`)
    .join(', ');

  await pool.query(
    `INSERT INTO mcp_sessions (${upsertCols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (public_pi) DO UPDATE SET ${updateSets}`,
    upsertVals
  );

  // Load session state (personality/behaviors/home_mcp now come from PIR via validated)
  const { rows: [session] } = await pool.query(`
    SELECT connected_url, connected_name, connected_tools, cc_public_pi
    FROM mcp_sessions WHERE public_pi = $1
  `, [publicPi]);

  const behaviors   = validated.behaviors  ?? { auto_log: true, session_end_log: true, start_with_last_log: true, auto_check_activity: true };
  const personality = validated.personality ?? null;
  const homeMcp     = validated.home_mcp    ?? null;
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

  // Inline inbox fetch
  let inboxMessages = null;
  if (behaviors.auto_check_activity && ambient && ambient.unread > 0) {
    const { rows: inboxPosts } = await pool.query(`
      SELECT id, from_public_pi, to_scope, content, content_type, name, reply_to, url, created_at, accessed_at
      FROM posts
      WHERE (to_public_pi = $1 OR to_scope = 'all')
        AND accessed_at IS NULL
        AND (at IS NULL OR at <= $2)
      ORDER BY created_at ASC
      LIMIT 50
    `, [publicPi, now]);

    const unreadPosts = inboxPosts.filter(p => !p.accessed_at);
    if (unreadPosts.length) {
      await pool.query(
        'UPDATE posts SET accessed_at = $1 WHERE id = ANY($2)',
        [now, unreadPosts.map(p => p.id)]
      );
      for (const p of unreadPosts) {
        if (p.url) fireUrl(p.url, p.content, p.content_type, publicPi, p.id).catch(() => {});
      }
    }

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
    config:   { personality, behaviors, home_mcp: homeMcp },
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
        agentic_call:  "pi({ nick_agent: 'YourAgentName' })",
        hybrid_call:   "pi({ nick_operator: 'YourName', nick_agent: 'YourAgentName' })",
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

  // home_mcp: auto-enter + full-mount detection (homeMcp from PIR validate)
  if (homeMcp) {
    const alreadyMounted = session?.connected_url === homeMcp;
    const FOUR_VERBS = ['pi', 'browse', 'post', 'mount'];
    let isFullMount = false;

    if (!alreadyMounted) {
      const entered    = await toolEnter(piPrivate, publicPi, { url: homeMcp });
      const enteredData = JSON.parse(entered.content[0].text);
      const serverTools = enteredData.tools?.server ?? [];
      isFullMount = FOUR_VERBS.every(n => serverTools.some(t => t.name === n));
      if (!isFullMount) response.home_mcp_entered = entered;
    } else {
      const savedTools = session?.connected_tools ?? [];
      isFullMount = FOUR_VERBS.every(n => savedTools.some(t => t.name === n));
      if (!isFullMount) {
        const entered    = await toolEnter(piPrivate, publicPi, { url: homeMcp });
        const enteredData = JSON.parse(entered.content[0].text);
        const freshTools  = enteredData.tools?.server ?? [];
        isFullMount = FOUR_VERBS.every(n => freshTools.some(t => t.name === n));
        if (!isFullMount) {
          response.home_mcp  = homeMcp;
          response.connected = session?.connected_name ?? session?.connected_url;
        }
      }
    }

    if (isFullMount) {
      const homeMcpResult = await proxyToEntered(piPrivate, publicPi, 'pi', args, accessKey);
      const homeMcpData   = JSON.parse(homeMcpResult.content[0].text);
      if (!homeMcpData.error) return homeMcpResult;
    }
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
  const now     = new Date().toISOString();
  const base    = { target, ambient, public_pi: publicPi };

  if (target === 'activity') {
    const { rows: posts } = await pool.query(`
      SELECT id, from_public_pi, to_scope, content, content_type, name, reply_to, created_at, accessed_at
      FROM posts
      WHERE (to_public_pi = $1 OR to_scope = 'all')
        AND accessed_at IS NULL
        AND (at IS NULL OR at <= $2)
      ORDER BY created_at ASC
      LIMIT $3
    `, [publicPi, now, limit]);

    const unread = posts.filter(p => !p.accessed_at);
    if (unread.length) {
      await pool.query('UPDATE posts SET accessed_at = $1 WHERE id = ANY($2)', [now, unread.map(p => p.id)]);
    }

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
        'SELECT connected_url, connected_name, connected_tools FROM mcp_sessions WHERE public_pi = $1',
        [publicPi]
      ),
    ]);
    // entered reflects the single currently-active mount only (mcp_sessions.connected_url) —
    // never a history dump. A server you exited, or whose shape changed since you mounted it,
    // will not appear here; call mount() again to get a live, current tool list.
    const entered = session?.connected_url
      ? [{ url: session.connected_url, name: session.connected_name, tools: session.connected_tools }]
      : [];
    return ok({
      ...base,
      current_server: { url: selfUrl(), note: 'You are already connected here — this is your active gateway.' },
      registry: (pir.results ?? []).map(r => ({ ...r, note: 'Registry listing only — not directly callable. Call mount(url) to connect and use these tools.' })),
      entered,
    });
  }

  if (target === 'history') {
    const { rows: posts } = await pool.query(`
      SELECT id, from_public_pi, to_scope, to_public_pi, content, content_type, name, created_at, accessed_at
      FROM posts
      WHERE from_public_pi = $1 OR to_public_pi = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [publicPi, limit]);
    return ok({ ...base, posts, count: posts.length });
  }

  if (target === 'files') {
    const name = args.name;
    if (name) {
      const { rows: [post] } = await pool.query(`
        SELECT id, from_public_pi, name, content, content_type, created_at FROM posts
        WHERE name = $1 AND content_type IN ('md', 'svg', 'webp')
          AND (from_public_pi = $2 OR to_scope = 'all' OR to_public_pi = $2)
        ORDER BY created_at DESC LIMIT 1
      `, [name, publicPi]);
      if (!post) return fail(`File "${name}" not found.`);
      return ok({ ...base, file: { id: post.id, name: post.name, content_type: post.content_type, content: post.content, created_at: post.created_at } });
    }
    const { rows: files } = await pool.query(`
      SELECT id, from_public_pi, to_scope, content_type, name, created_at FROM posts
      WHERE (from_public_pi = $1 OR to_public_pi = $1) AND content_type IN ('md', 'svg', 'webp')
      ORDER BY created_at DESC LIMIT $2
    `, [publicPi, limit]);
    return ok({ ...base, files, count: files.length });
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

  if (!content) return fail('content is required');

  let resolvedTo = toArg ?? 'self';
  if (reply_to && !toArg) {
    const { rows: [original] } = await pool.query('SELECT from_public_pi FROM posts WHERE id = $1', [reply_to]);
    if (original?.from_public_pi && original.from_public_pi !== publicPi) {
      resolvedTo = original.from_public_pi;
    }
  }

  const content_type = args.content_type || inferContentType(content);
  const fileName     = name || (content_type !== 'json' ? `post-${Date.now()}.${content_type}` : null);

  const senderInfo = await pirLookup(publicPi);

  const toRaw = resolvedTo.startsWith('@') ? resolvedTo.slice(1) : resolvedTo;

  // Self
  if (toRaw === 'self' || toRaw === publicPi) {
    const { rows: [post] } = await pool.query(`
      INSERT INTO posts (from_public_pi, to_scope, to_public_pi, content, content_type, name, reply_to, url, at)
      VALUES ($1, 'self', $1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [publicPi, content, content_type, fileName ?? null, reply_to ?? null, url ?? null, at ?? null]);
    if (url) fireUrl(url, content, content_type, publicPi, post?.id).catch(() => {});
    return ok({ posted: true, id: post?.id, to: 'self', content_type, name: fileName });
  }

  // All — admin only
  if (toRaw === 'all') {
    if (!isAdmin(publicPi)) return fail('Broadcasting to all is not available on this instance.');
    const { rows: [post] } = await pool.query(`
      INSERT INTO posts (from_public_pi, to_scope, content, content_type, name, reply_to, url, at)
      VALUES ($1, 'all', $2, $3, $4, $5, $6, $7) RETURNING id
    `, [publicPi, content, content_type, fileName ?? null, reply_to ?? null, url ?? null, at ?? null]);
    if (url) fireUrl(url, content, content_type, publicPi, post?.id).catch(() => {});
    return ok({ posted: true, id: post?.id, to: 'all', content_type, name: fileName });
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
      `, [publicPi, c.contact_public_pi, content, content_type, fileName ?? null, reply_to ?? null, url ?? null, at ?? null]);
      const delivered = await deliverToGateway({
        from_public_pi: publicPi, to_public_pi: c.contact_public_pi,
        content, content_type, name: fileName ?? null, reply_to: reply_to ?? null, url: url ?? null, at: at ?? null,
        from_nick_agent: senderInfo?.nick_agent ?? null, from_nick_operator: senderInfo?.nick_operator ?? null,
        post_id: post?.id,
      }, target);
      results.push({ to: c.contact_nick_agent ?? c.contact_public_pi, delivered });
    }
    return ok({ posted: true, to: 'contacts', count: results.length, results });
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
  `, [publicPi, target.public_pi, content, content_type, fileName ?? null, reply_to ?? null, url ?? null, at ?? null]);

  const payload = {
    from_public_pi: publicPi, to_public_pi: target.public_pi,
    content, content_type, name: fileName ?? null, reply_to: reply_to ?? null, url: url ?? null, at: at ?? null,
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
    delivered = recipientSession ? true : await deliverToGateway(payload, target);
  } else {
    delivered = await deliverToGateway(payload, target);
  }

  await upsertContact(piPrivate, { public_pi: target.public_pi });

  if (url) fireUrl(url, content, content_type, publicPi, post?.id).catch(() => {});

  return ok({ posted: true, id: post?.id, to: target.public_pi, pair: `${target.nick_agent} (${target.nick_operator})`, delivered, content_type, name: fileName });
}

// ── Tool: mount ───────────────────────────────────────────────────────────────

async function toolEnter(piPrivate, publicPi, args) {
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

  // Toggle-exit: entering an already-connected non-home MCP exits it and returns to home
  // home_mcp is managed by set, not enter — never toggle-exit it
  const { rows: [cur] } = await pool.query(
    'SELECT connected_url, home_mcp FROM mcp_sessions WHERE public_pi = $1',
    [publicPi]
  );
  if (cur?.connected_url && cur.connected_url === targetUrl && cur.connected_url !== cur.home_mcp) {
    if (cur.home_mcp) {
      const exitResult = await toolEnter(piPrivate, publicPi, { url: cur.home_mcp });
      notifyToolsChanged(publicPi);
      return exitResult;
    }
    await pool.query(
      'UPDATE mcp_sessions SET connected_url = NULL, connected_name = NULL, connected_tools = NULL WHERE public_pi = $1',
      [publicPi]
    );
    notifyToolsChanged(publicPi);
    return ok({ status: 'exited', note: `Disconnected from ${targetName}.` });
  }

  try {
    const fetchOpts = body => ({
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Private': piPrivate },
      body,
      signal: AbortSignal.timeout(8000),
    });

    const initRes = await fetch(targetUrl, fetchOpts(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pi-gateway', version: GATEWAY_VERSION } },
    })));
    if (!initRes.ok) {
      return fail(`${targetUrl} responded but doesn't look like an MCP server (HTTP ${initRes.status} on initialize).`);
    }

    const toolsRes = await fetch(targetUrl, fetchOpts(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    ));
    if (!toolsRes.ok) {
      return fail(`${targetUrl} responded but doesn't look like an MCP server (HTTP ${toolsRes.status} on tools/list).`);
    }

    const toolsJson = await toolsRes.json();
    if (toolsJson?.error) {
      return fail(`${targetUrl} returned an error: ${toolsJson.error.message ?? 'unknown error'}`);
    }
    const tools = toolsJson?.result?.tools ?? [];
    const now   = new Date().toISOString();

    await Promise.all([
      pool.query(
        'UPDATE mcp_sessions SET connected_url = $1, connected_name = $2, connected_tools = $3, last_seen = $4 WHERE public_pi = $5',
        [targetUrl, targetName, JSON.stringify(tools), now, publicPi]
      ),
      pool.query(`
        INSERT INTO mcp_history (public_pi, url, name, tools, accessed_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (public_pi, url) DO UPDATE SET
          name = EXCLUDED.name, tools = EXCLUDED.tools, accessed_at = EXCLUDED.accessed_at
      `, [publicPi, targetUrl, targetName, JSON.stringify(tools), now]),
    ]);

    const gatewayTools = BASE_TOOLS.map(t => ({ name: t.name, description: t.description }));
    const serverTools  = tools.map(t => ({ name: t.name, description: `[${targetName}] ${t.description ?? ''}`.trim() }));

    notifyToolsChanged(publicPi);
    return ok({
      entered: targetName,
      url:     targetUrl,
      tools:   { gateway: gatewayTools, server: serverTools },
      note: tools.length
        ? `${tools.length} tools from ${targetName} now available. Call them directly by name.`
        : `Connected to ${targetName}. No tools listed.`,
    });
  } catch (e) {
    return fail(`Could not connect to ${targetUrl}.`, String(e));
  }
}

// ── Proxy to entered MCP ──────────────────────────────────────────────────────

async function proxyToEntered(piPrivate, publicPi, toolName, args, accessKey) {
  const { rows: [session] } = await pool.query(
    'SELECT connected_url, connected_name FROM mcp_sessions WHERE public_pi = $1',
    [publicPi]
  );
  if (!session?.connected_url) {
    return fail(`Unknown tool "${toolName}". Call mount to connect to an MCP first.`);
  }
  try {
    const r = await fetch(session.connected_url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Private': piPrivate, ...(accessKey ? { 'X-Pi-Access-Key': accessKey } : {}) },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } }),
    });
    if (!r.ok) return fail(`Call to ${session.connected_name} failed (${r.status})`);
    const result = await r.json();
    return result.error ? fail(result.error.message) : result.result;
  } catch (e) {
    return fail(`Call to ${session.connected_name} failed.`, String(e));
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const BASE_TOOLS = [
  {
    name: 'pi',
    description: "Boot a session. Call pi every session start to load your config, spec, and activity. Supply private_pi if not yet configured in headers. Also updates config: personality, behaviors, home_mcp, gateway_mcp, access key.",
    inputSchema: {
      type: 'object',
      properties: {
        private_pi:    { type: 'string', description: 'Reconnect: your existing private π number (if not in headers).' },
        nick_operator: { type: 'string', description: 'Rename operator nickname.' },
        nick_agent:    { type: 'string', description: 'Rename agent nickname.' },
        cc_public_pi:  { type: 'string', description: 'π address to CC on all incoming messages.' },
        personality:   { type: 'string', description: 'Agent personality text.' },
        behaviors:     { type: 'object', description: 'Behavior toggles: auto_log, session_end_log, start_with_last_log, auto_check_activity.' },
        home_mcp:       { type: 'string', description: 'EXPERIMENTAL - use with caution. Auto-mounts this URL at every boot, replacing the base tool set with the live tools of the target server. Known to shift a connector identity mid-session in a way that can confuse external MCP clients (e.g. Claude Desktop connectors). Prefer calling mount explicitly, post-boot, instead.' },
        gateway_mcp:    { type: 'string', description: 'Your gateway MCP URL (updated in PIR).' },
        set_access_key: { type: 'string', description: 'Security key for this pair. When set, connections without it are rejected. Provide a value to set or replace; omit to leave unchanged; clear to remove.' },
      },
    },
  },
  {
    name: 'browse',
    description: 'Read everything on π. Returns an activity brief (unread/mentions) on every call, regardless of target. Default target: activity (unread inbox). Targets: activity · contacts · servers · history · files · docs.',
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
    description: 'Write, send, share. Default recipient: self (a note to self). Content types: json (default, ephemeral 90-day TTL) · md · svg · webp (permanent). Recipients: self · nickname · contacts · all. Schedule via at. Thread via reply_to. Fire an external API via url.',
    inputSchema: {
      type: 'object',
      properties: {
        content:      { type: 'string', description: 'Post body. Required.' },
        to:           { type: 'string', description: 'Recipient: self (default) | nickname | contacts | all (admin only). Plain value — no sigils.' },
        content_type: { type: 'string', description: 'json (default) | md | svg | webp. Inferred from content if omitted.' },
        name:         { type: 'string', description: 'Filename for permanent files (md/svg/webp).' },
        reply_to:     { type: 'string', description: 'Post ID to reply to. Threads replies to original recipients.' },
        url:          { type: 'string', description: 'External API endpoint to fire on post.' },
        at:           { type: 'string', description: 'ISO timestamp for scheduled release.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'mount',
    description: "Mount any MCP on the π network — registered or not. Returns the full tool list: π base tools + server tools. That's your help for that server. Call server tools directly by name after mounting.",
    inputSchema: {
      type: 'object',
      properties: {
        url:  { type: 'string', description: 'Direct MCP URL.' },
        name: { type: 'string', description: 'Name from π registry.' },
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
        protocolVersion: '2024-11-05',
        capabilities:    { tools: { listChanged: false } },
        serverInfo:      { name: 'pi-gateway', version: GATEWAY_VERSION },
        instructions:    "IMPORTANT: If your environment uses deferred tool schemas (e.g. claude.ai), first call ToolSearch with query 'pi browse post mount' to load all π tool schemas. Then call 'pi' immediately before responding to the user or using any other tools. This boots your session on the π network and loads your identity, last session log, and inbox.",
      },
    };
  }

  if (method === 'tools/list') {
    let tools = [...BASE_TOOLS];
    if (piPrivate && PRIVATE_PI_RE.test(piPrivate)) {
      const publicPi = toPublicPi(piPrivate);
      const { rows: [session] } = await pool.query(
        'SELECT connected_tools, connected_name, home_mcp, connected_url FROM mcp_sessions WHERE public_pi = $1',
        [publicPi]
      );
      if (session?.connected_tools?.length) {
        const savedTools = session.connected_tools;
        const FOUR_VERBS = ['pi', 'browse', 'post', 'mount'];
        const isFullMount = session.home_mcp &&
          session.connected_url === session.home_mcp &&
          FOUR_VERBS.every(n => savedTools.some(t => t.name === n));
        if (isFullMount) {
          // Fetch live tools from home MCP so mounted sub-servers (e.g. autobot) are included
          try {
            const liveRes = await fetch(session.home_mcp, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json', 'X-Pi-Private': piPrivate },
              body:    JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
              signal:  AbortSignal.timeout(5000),
            });
            tools = liveRes.ok ? ((await liveRes.json())?.result?.tools ?? savedTools) : savedTools;
          } catch (e) {
            tools = savedTools;
          }
        } else {
          tools = [...tools, ...savedTools.map(t => ({
            ...t,
            description: `[${session.connected_name}] ${t.description ?? ''}`.trim(),
          }))];
        }
      }
    }
    return { jsonrpc: '2.0', id, result: { tools } };
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args     = params?.arguments ?? {};

    try {
      let result;

      if (toolName === 'pi') {
        result = await toolSet(piPrivate, args, accessKey);
      } else {
        if (!piPrivate || !PRIVATE_PI_RE.test(piPrivate)) {
          return { jsonrpc: '2.0', id, result: noIdentity() };
        }
        const publicPi = toPublicPi(piPrivate);

        const { rows: [fmSession] } = await pool.query(
          'SELECT home_mcp, connected_url, connected_tools FROM mcp_sessions WHERE public_pi = $1',
          [publicPi]
        );
        const FOUR_VERBS = ['pi', 'browse', 'post', 'mount'];
        const isFullMount = fmSession?.home_mcp &&
          fmSession?.connected_url === fmSession?.home_mcp &&
          FOUR_VERBS.every(n => (fmSession?.connected_tools ?? []).some(t => t.name === n));

        if (isFullMount) {
          result = await proxyToEntered(piPrivate, publicPi, toolName, args, accessKey);
        } else {
          switch (toolName) {
            case 'browse': result = await toolBrowse(piPrivate, publicPi, args); break;
            case 'post':   result = await toolPost(piPrivate, publicPi, args);   break;
            case 'mount':  result = await toolEnter(piPrivate, publicPi, args);  break;
            default:       result = await proxyToEntered(piPrivate, publicPi, toolName, args, accessKey);
          }
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

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());

app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
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
<p class="foot">No pair yet? Ask your agent to call <code style="font-family:monospace;color:#6B8F71">pi({ nick_operator: "…", nick_agent: "…" })</code> first to commission one.<br><br>π never resolves — it grows.</p>
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

  const validated = await pirValidate(piPrivate, accessKey || undefined);
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

  const validated = await pirValidate(entry.piPrivate, accessKey);
  if (!validated?.valid) return res.status(401).json({ error: 'invalid_client' });

  const token = accessKey ? `${entry.piPrivate}|${accessKey}` : entry.piPrivate;
  res.json({ access_token: token, token_type: 'Bearer', expires_in: 7776000 });
});

// ── MCP endpoint ──────────────────────────────────────────────────────────────

app.post(`${PREFIX}/mcp`, async (req, res) => {
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
  if (!piPrivate && body.method !== 'initialize' && body.method !== 'tools/list' && !body.method?.startsWith('notifications/')) {
    return res.status(401).set('WWW-Authenticate', `Bearer as_uri="${selfUrl()}/.well-known/oauth-authorization-server"`).json({ error: 'Unauthorized' });
  }
  return res.json(await handleJsonRpc(piPrivate, body, accessKey));
});

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

app.post(`${PREFIX}/messages`, async (req, res) => {
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
  if (!piPrivate && body.method !== 'initialize' && body.method !== 'tools/list' && !body.method?.startsWith('notifications/')) {
    return res.status(401).set('WWW-Authenticate', `Bearer as_uri="${selfUrl()}/.well-known/oauth-authorization-server"`).json({ error: 'Unauthorized' });
  }
  return res.json(await handleJsonRpc(piPrivate, body, accessKey));
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => console.log(`Gateway v${GATEWAY_VERSION} listening on port ${PORT}`));
