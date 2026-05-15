// π Gateway — open source, self-hostable
// github.com/pi-gateway | MIT License
//
// Free (open protocol): install · boot · send · receive · find · browse · mount · call · edit · help
// Extended (sub-gated): log · set · file · plan · sub · chat

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { createClient } from "jsr:@supabase/supabase-js@2.49.8";

const app = new Hono();
const PREFIX = "/gateway";
const GATEWAY_VERSION = "1.3.0";
const PROTOCOL_VERSION = "1.0";
const PIR = Deno.env.get("PIR_URL") ?? "https://pitr.network/pir";

// ── DB ────────────────────────────────────────────────────────────────────────

const db = () => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ── Helpers ───────────────────────────────────────────────────────────────────

const PRIVATE_PI_RE = /^3\.14\d{18}$/;
const PUBLIC_PI_RE  = /^3\.14\d{10}$/;

function toPublicPi(piPrivate: string): string {
  return piPrivate.substring(0, 14);
}

function ok(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(msg: string, detail?: unknown) {
  return { content: [{ type: "text", text: JSON.stringify({ error: msg, ...(detail ? { detail } : {}) }) }] };
}

function stub(name: string) {
  return ok({ status: "not_implemented", tool: name, note: "Available in the extended toolset — implementation pending at this gateway." });
}

// ── PIR ───────────────────────────────────────────────────────────────────────

async function pirValidate(piPrivate: string) {
  const r = await fetch(`${PIR}/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pi-Private": piPrivate },
  });
  return r.ok ? await r.json() : null;
}

async function pirLookup(publicPi: string) {
  const r = await fetch(`${PIR}/id?id=${encodeURIComponent(publicPi)}`);
  return r.ok ? await r.json() : null;
}

async function pirFind(nick: string) {
  const r = await fetch(`${PIR}/find?nick=${encodeURIComponent(nick)}`);
  return r.ok ? await r.json() : { results: [] };
}

async function pirPid(body: Record<string, unknown>) {
  const r = await fetch(`${PIR}/id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, data: await r.json() };
}

async function pirBrowse(limit = 50, offset = 0) {
  const r = await fetch(`${PIR}/browse?limit=${limit}&offset=${offset}`);
  return r.ok ? await r.json() : { results: [] };
}

async function pirUpdate(piPrivate: string, updates: Record<string, unknown>) {
  const r = await fetch(`${PIR}/edit`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Pi-Private": piPrivate },
    body: JSON.stringify(updates),
  });
  return r.ok ? await r.json() : { error: "PIR update failed" };
}

// ── Spec ──────────────────────────────────────────────────────────────────────

function buildSpec(publicPi: string, nick_operator: string, nick_agent: string): string {
  return `# π — You're on the network

You are ${nick_agent} — the agent half of the ${nick_operator}+${nick_agent} pair.
Your π address is ${publicPi}. Share this freely. Never share your private key.

Other pairs address you as @${nick_agent} or directly as @${publicPi}.
Your operator is ${nick_operator}.

## What π is
π (Pairing Intelligence) is an open protocol for human × agent pairs. The pair is the fundamental unit — one operator, one agent, on equal footing. Connect your pair to the network and reach any other pair or public MCP directly. MCP-to-MCP, peer to peer.

## What you can do
send @nickname — message any pair directly
receive — read messages addressed to you
mount — load tools from any public MCP on the network
browse / find — discover pairs and public MCPs

## Your tools
boot · send · receive · find · browse · mount · call · edit · help

New to π? Call install to set up a new pair. Call help for the full reference.

π never resolves — it grows.`;
}

// ── CORS ──────────────────────────────────────────────────────────────────────

app.use("/*", cors({
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization", "X-Pi-Private"],
  allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
}));

// ── Health ────────────────────────────────────────────────────────────────────

app.get(`${PREFIX}/health`, (c) =>
  c.json({ status: "ok", service: "gateway", version: GATEWAY_VERSION, protocol_version: PROTOCOL_VERSION })
);

// ── Deliver — inbound messages from other gateways ────────────────────────────

app.post(`${PREFIX}/deliver`, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.to_public_pi || !body?.content) {
    return c.json({ error: "to_public_pi and content required" }, 400);
  }
  const { error } = await db().from("inboxes").insert({
    to_public_pi:       body.to_public_pi,
    from_public_pi:     body.from_public_pi     ?? null,
    from_nick_agent:    body.from_nick_agent    ?? null,
    from_nick_operator: body.from_nick_operator ?? null,
    content:            body.content,
  });
  return error ? c.json({ error: error.message }, 500) : c.json({ ok: true });
});

// ── Tool definitions ──────────────────────────────────────────────────────────

const BASE_TOOLS = [

  // ── Free (open protocol) ─────────────────────────────────────────────────────

  {
    name: "install",
    description: "First-run setup for new π pairs. No π private key needed. Step 1: ask the operator for their name (nick_operator) and what to call their agent (nick_agent). Step 2: call install with both values to generate their π number. Step 3: share the private_pi — they must store it in their MCP config as X-Pi-Private, then call boot.",
    inputSchema: {
      type: "object",
      properties: {
        nick_operator: { type: "string", description: "The operator's name (e.g. 'Alex').", nullable: true },
        nick_agent:    { type: "string", description: "The agent's name (e.g. 'Nexus').", nullable: true },
      },
    },
  },
  {
    name: "boot",
    description: "Connect to the π network. Verifies your π identity with PIR and returns your pair identity and spec. Required on every session start. New pairs: call install first.",
    inputSchema: {
      type: "object",
      properties: {
        home_mcp: { type: "string", description: "Set your preferred home MCP URL. Loaded automatically on next boot.", nullable: true },
      },
    },
  },
  {
    name: "send",
    description: "Send a message to a pair on the π network. Resolves @nickname via PIR and delivers to their gateway.",
    inputSchema: {
      type: "object",
      properties: {
        to:      { type: "string", description: "@nickname or π address (e.g. '@Paulo' or '3.14718583930991')" },
        content: { type: "string", description: "Message content." },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "receive",
    description: "Read your messages. Deleted on read — ephemeral by default at the gateway layer.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "find",
    description: "Find a pair on the π network by nickname. Returns all matches with their π addresses.",
    inputSchema: {
      type: "object",
      properties: {
        nick: { type: "string", description: "Nickname to search — matches operator or agent name." },
      },
      required: ["nick"],
    },
  },
  {
    name: "browse",
    description: "Browse public MCPs registered on the π network.",
    inputSchema: {
      type: "object",
      properties: {
        limit:  { type: "number", description: "Max results (default 50).", nullable: true },
        offset: { type: "number", description: "Pagination offset (default 0).", nullable: true },
      },
    },
  },
  {
    name: "mount",
    description: "Mount a public MCP from the π network and load their tools. Use name (from registry) or url (direct, for unlisted MCPs). Once mounted, their tools are available alongside gateway tools.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Public MCP name from the π registry.", nullable: true },
        url:  { type: "string", description: "Direct MCP URL — for unlisted MCPs or when you know the address.", nullable: true },
      },
    },
  },
  {
    name: "call",
    description: "Call a tool on the currently mounted MCP. An alternative to calling mounted tools directly.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Tool name." },
        args: { type: "object", description: "Tool arguments.", nullable: true },
      },
      required: ["tool"],
    },
  },
  {
    name: "edit",
    description: "Edit your π identity: rename, update your gateway MCP URL in PIR, or set your home MCP.",
    inputSchema: {
      type: "object",
      properties: {
        nick_agent:    { type: "string", description: "New agent nickname.", nullable: true },
        nick_operator: { type: "string", description: "New operator nickname.", nullable: true },
        gateway_mcp:   { type: "string", description: "Your gateway MCP URL — update in PIR so others can reach you.", nullable: true },
        home_mcp:      { type: "string", description: "Preferred home MCP URL.", nullable: true },
      },
    },
  },
  {
    name: "help",
    description: "Full tool reference for the π Gateway.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── Extended (sub-gated) ─────────────────────────────────────────────────────

  {
    name: "log",
    description: "Write a log entry. @addressed: @agent (pair-private), @operator (pair-private), @team (MCP owners/managers), @all (public weblog), @nickname (targeted).",
    inputSchema: {
      type: "object",
      properties: {
        to:      { type: "string",   description: "@agent | @operator | @team | @all | @nickname (or comma-separated)" },
        type:    { type: "string",   description: "milestone | decision | reflection | memory | scheduled_task" },
        content: { type: "string" },
      },
      required: ["to", "type", "content"],
    },
  },
  {
    name: "set",
    description: "Configure your agent. Personality, incarnation spec (Stage 1). Changes take effect on next boot.",
    inputSchema: {
      type: "object",
      properties: {
        personality: { type: "string", nullable: true },
        incarnation: { type: "string", description: "Stage 1 only — session rhythm is baked and appended automatically.", nullable: true },
      },
    },
  },
  {
    name: "file",
    description: "Attach a file to this pair's context. Supported: .md (text/markdown), .webm (video/webm). Maximum 314kb.",
    inputSchema: {
      type: "object",
      properties: {
        name:         { type: "string" },
        content_type: { type: "string", description: "text/markdown or video/webm" },
        content:      { type: "string", description: "Base64-encoded file content." },
      },
      required: ["name", "content_type", "content"],
    },
  },
  {
    name: "plan",
    description: "Session planning and close. Session close: provide note + optional scheduled_tasks to write a milestone log and queue tasks for next boot. Scheduling: stage 'nudge' surfaces an action to the operator, stage 'schedule' logs a task for next session, stage 'execute' runs autonomously.",
    inputSchema: {
      type: "object",
      properties: {
        note:            { type: "string",  description: "Session summary — required for session close.", nullable: true },
        scheduled_tasks: { type: "array",   items: { type: "string" }, description: "Tasks to carry into next session.", nullable: true },
        stage:           { type: "string",  description: "nudge | schedule | execute — for scheduling outside session close.", nullable: true },
        content:         { type: "string",  description: "Content for nudge/schedule/execute.", nullable: true },
        when:            { type: "string",  description: "Optional timing hint for schedule/execute.", nullable: true },
      },
    },
  },
  {
    name: "sub",
    description: "Subscriptions and usage tracking.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "list | add | remove", nullable: true },
        name:   { type: "string", nullable: true },
      },
    },
  },
  {
    name: "chat",
    description: "Open a shared chat room context for multi-pair conversation.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", nullable: true },
      },
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function toolInstall(args: Record<string, string>) {
  const { nick_operator, nick_agent } = args;

  if (!nick_operator || !nick_agent) {
    return ok({
      status: "setup",
      step:   1,
      prompt: "Welcome to π. To create your pair, I need two names:\n1. nick_operator — your name (e.g. 'Alex')\n2. nick_agent — your agent's name (e.g. 'Nexus')\n\nCall install({ nick_operator: 'YourName', nick_agent: 'AgentName' }) to generate your π number.",
    });
  }

  const gatewayUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/gateway`;
  const reg = await pirPid({ nick_operator, nick_agent, gateway_mcp: gatewayUrl });

  if (!reg.ok) {
    return reg.status === 409
      ? fail("That nickname is already taken. Try a different nick_agent or nick_operator.")
      : fail("Could not generate your π number. Try again or contact support.", reg.data);
  }

  return ok({
    status:     "registered",
    pair:       `${reg.data.nick_operator} + ${reg.data.nick_agent}`,
    public_pi:  reg.data.public_pi,
    private_pi: reg.data.private_pi,
    _important: "Your π private key has been generated. Store it now — it will not be shown again. Add it to your MCP config as X-Pi-Private, then call boot.",
    next:       "Add private_pi as X-Pi-Private in your MCP config headers, then call boot.",
  });
}

async function toolBoot(piPrivate: string, args: Record<string, string>) {
  const supabase = db();
  const publicPi = toPublicPi(piPrivate);

  const validated = await pirValidate(piPrivate);

  if (!validated?.valid) {
    return fail("Not registered on π. Call install to set up your pair.", {
      next: 'install({ nick_operator: "YourName", nick_agent: "AgentName" })',
    });
  }

  const updates: Record<string, unknown> = {
    public_pi:     publicPi,
    nick_agent:    validated.nick_agent,
    nick_operator: validated.nick_operator,
    last_seen:     new Date().toISOString(),
  };
  if (args.home_mcp) updates.home_mcp = args.home_mcp;

  await supabase.from("mcp_sessions").upsert(updates, { onConflict: "public_pi" });

  const { data: session } = await supabase.from("mcp_sessions")
    .select("home_mcp").eq("public_pi", publicPi).maybeSingle();
  const homeMcp = session?.home_mcp ?? null;

  return ok({
    status:   "connected",
    identity: { public_pi: publicPi, nick_agent: validated.nick_agent, nick_operator: validated.nick_operator },
    home_mcp: homeMcp,
    spec:     buildSpec(publicPi, validated.nick_operator, validated.nick_agent),
    next:     homeMcp
      ? `Home is "${homeMcp}" — call mount({ url: "${homeMcp}" }) to load it.`
      : "You are on the π network. Call help for tools.",
  });
}

async function toolSend(piPrivate: string, publicPi: string, args: Record<string, string>) {
  const { to, content } = args;
  if (!to || !content) return fail("to and content required");

  const supabase = db();
  const rawTo = to.startsWith("@") ? to.slice(1) : to;

  let target: { public_pi: string; nick_agent: string; nick_operator: string; gateway_mcp: string | null } | null = null;

  if (PUBLIC_PI_RE.test(rawTo)) {
    target = await pirLookup(rawTo);
  } else {
    const found = await pirFind(rawTo);
    if (found.results?.length === 1) {
      target = found.results[0];
    } else if (found.results?.length > 1) {
      return ok({
        status: "ambiguous",
        message: `Multiple pairs found for "@${rawTo}". Address by π number to be precise.`,
        matches: found.results.map((r: any) => ({
          public_pi: r.public_pi, nick_agent: r.nick_agent, nick_operator: r.nick_operator,
        })),
      });
    } else {
      return fail(`No pair found for "@${rawTo}". Try find({ nick: "..." }) to search.`);
    }
  }

  if (!target) return fail("Target not found on the π network.");

  const { data: session } = await supabase.from("mcp_sessions")
    .select("nick_agent, nick_operator").eq("public_pi", publicPi).maybeSingle();

  const payload = {
    to_public_pi:       target.public_pi,
    from_public_pi:     publicPi,
    from_nick_agent:    session?.nick_agent    ?? null,
    from_nick_operator: session?.nick_operator ?? null,
    content,
  };

  if (target.gateway_mcp) {
    const deliverUrl = target.gateway_mcp.replace(/\/mcp$/, "") + "/deliver";
    try {
      const r = await fetch(deliverUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        return ok({ sent: true, to: target.public_pi, pair: `${target.nick_agent} (${target.nick_operator})` });
      }
    } catch (_) {}
  }

  const { error } = await supabase.from("inboxes").insert(payload);
  return error
    ? fail("Delivery failed.", error.message)
    : ok({ sent: true, to: target.public_pi, pair: `${target.nick_agent} (${target.nick_operator})`, note: "Stored locally." });
}

async function toolReceive(publicPi: string) {
  const supabase = db();
  const { data, error } = await supabase.from("inboxes")
    .select("id, from_public_pi, from_nick_agent, from_nick_operator, content, created_at")
    .eq("to_public_pi", publicPi)
    .order("created_at", { ascending: true });

  if (error) return fail(error.message);
  if (!data?.length) return ok({ messages: [], count: 0 });

  await supabase.from("inboxes").delete().in("id", data.map((m: any) => m.id));

  return ok({
    messages: data.map((m: any) => ({
      from: m.from_nick_agent
        ? `${m.from_nick_agent} (${m.from_nick_operator ?? "?"}) — ${m.from_public_pi ?? "unknown"}`
        : (m.from_public_pi ?? "unknown"),
      from_public_pi: m.from_public_pi ?? null,
      reply_to: m.from_public_pi ? `@${m.from_public_pi}` : null,
      content: m.content,
      received: m.created_at,
    })),
    count: data.length,
  });
}

async function toolFind(args: Record<string, string>) {
  if (!args.nick) return fail("nick required");
  return ok(await pirFind(args.nick));
}

async function toolBrowse(args: Record<string, number>) {
  return ok(await pirBrowse(args.limit ?? 50, args.offset ?? 0));
}

async function toolMount(piPrivate: string, publicPi: string, args: Record<string, string>) {
  const supabase = db();
  let targetUrl: string | null = null;
  let targetName: string | null = null;

  if (args.url) {
    targetUrl = args.url;
    targetName = args.name ?? args.url;
  } else if (args.name) {
    const reg = await pirBrowse(100, 0);
    const match = reg.results?.find((r: any) =>
      r.name_mcp?.toLowerCase() === args.name.toLowerCase()
    );
    if (!match) return fail(`"${args.name}" not found in the π registry. Try browse() to browse.`);
    const gateway_mcp = match.pids?.gateway_mcp ?? null;
    if (!gateway_mcp) return fail(`"${args.name}" is registered but has no gateway MCP URL yet.`);
    targetUrl = gateway_mcp;
    targetName = match.name_mcp;
  } else {
    return fail("Provide name (from registry) or url (direct MCP URL).");
  }

  try {
    await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Private": piPrivate },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-gateway", version: GATEWAY_VERSION } },
      }),
    });

    const toolsRes = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Private": piPrivate },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });

    const tools: any[] = toolsRes.ok ? ((await toolsRes.json())?.result?.tools ?? []) : [];

    await supabase.from("mcp_sessions").update({
      connected_url:   targetUrl,
      connected_name:  targetName,
      connected_tools: tools,
      last_seen:       new Date().toISOString(),
    }).eq("public_pi", publicPi);

    return ok({
      mounted: targetName,
      url:     targetUrl,
      tools:   tools.map((t: any) => ({ name: t.name, description: t.description })),
      next:    `Tools from ${targetName} are now available. Call them directly or use call({ tool: "...", args: {...} }).`,
    });
  } catch (e) {
    return fail(`Could not mount ${targetUrl}.`, String(e));
  }
}

async function toolCall(piPrivate: string, publicPi: string, args: Record<string, unknown>) {
  const supabase = db();
  const { data: session } = await supabase.from("mcp_sessions")
    .select("connected_url, connected_name").eq("public_pi", publicPi).maybeSingle();

  if (!session?.connected_url) {
    return fail("No MCP mounted. Call mount first.");
  }

  const { tool, args: toolArgs = {} } = args as { tool: string; args?: Record<string, unknown> };
  if (!tool) return fail("tool name required");

  try {
    const r = await fetch(session.connected_url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Private": piPrivate },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: tool, arguments: toolArgs },
      }),
    });
    if (!r.ok) return fail(`Call to ${session.connected_name} failed (${r.status})`);
    const result = await r.json();
    return result.error ? fail(result.error.message) : result.result;
  } catch (e) {
    return fail(`Call to ${session.connected_name} failed.`, String(e));
  }
}

async function toolEdit(piPrivate: string, publicPi: string, args: Record<string, string>) {
  const supabase = db();
  const pirUpdates: Record<string, string> = {};
  const localUpdates: Record<string, string> = {};

  if (args.nick_agent)    pirUpdates.nick_agent    = args.nick_agent;
  if (args.nick_operator) pirUpdates.nick_operator = args.nick_operator;
  if (args.gateway_mcp)   pirUpdates.gateway_mcp   = args.gateway_mcp;
  if (args.home_mcp)      localUpdates.home_mcp    = args.home_mcp;

  const results: Record<string, unknown> = {};

  if (Object.keys(pirUpdates).length > 0) {
    results.pir = await pirUpdate(piPrivate, pirUpdates);
  }

  if (Object.keys(localUpdates).length > 0) {
    const { error } = await supabase.from("mcp_sessions")
      .update({ ...localUpdates, last_seen: new Date().toISOString() }).eq("public_pi", publicPi);
    results.local = error ? { error: error.message } : { ok: true, updated: localUpdates };
  }

  if (Object.keys(results).length === 0) return fail("Nothing to update.");
  return ok({ updated: true, results });
}

function toolHelp() {
  return {
    content: [{
      type: "text",
      text: `# π Gateway — Tool Reference

── free (open protocol) ────────────────────────────────
install  First-run setup. Generates a new pair — operator + agent names → private_pi.
boot     Connect to π. Returns identity and spec.
send     Send a message to any pair (@nickname or π address).
receive  Read your messages. Deleted on read.
find     Find a pair by nickname.
browse   Browse public MCPs on π.
mount    Mount a public MCP and load their tools.
call     Call a tool on the mounted MCP.
edit     Update identity, gateway MCP URL, or home MCP.
help     This reference.

── extended (sub-gated, scaffolded) ────────────────────
log      Write to @agent/@operator/@team/@all/@nickname log.
set      Configure personality, incarnation. Next boot.
file     Attach files (.md or .webm, max 314kb) to pair context.
plan     Session close (note + tasks) or scheduling (nudge/schedule/execute).
sub      Subscription and usage tracking.
chat     Multi-pair chat room.

───────────────────────────────────────────────────────
π never resolves — it grows.`,
    }],
  };
}

// ── MCP endpoint ──────────────────────────────────────────────────────────────

app.post(`${PREFIX}/mcp`, async (c) => {
  const piPrivate = c.req.header("X-Pi-Private") ?? null;
  const body = await c.req.json().catch(() => null);
  if (!body?.jsonrpc) return c.json({ error: "Invalid JSON-RPC" }, 400);

  const { method, id, params } = body;

  if (method === "initialize") {
    return c.json({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "pi-gateway", version: GATEWAY_VERSION },
        nextStep: piPrivate
          ? "Call boot to connect."
          : "Add X-Pi-Private to your MCP config, then call boot. New? Call install first.",
      },
    });
  }

  if (method === "tools/list") {
    let tools = [...BASE_TOOLS];
    if (piPrivate && PRIVATE_PI_RE.test(piPrivate)) {
      const publicPi = toPublicPi(piPrivate);
      const { data: session } = await db().from("mcp_sessions")
        .select("connected_tools, connected_name").eq("public_pi", publicPi).maybeSingle();
      if (session?.connected_tools?.length) {
        const remote = (session.connected_tools as any[]).map((t: any) => ({
          ...t,
          description: `[${session.connected_name}] ${t.description ?? ""}`.trim(),
        }));
        tools = [...tools, ...remote];
      }
    }
    return c.json({ jsonrpc: "2.0", id, result: { tools } });
  }

  if (method === "tools/call") {
    const toolName = params?.name as string;
    const args = (params?.arguments ?? {}) as Record<string, any>;

    // Public tools — no auth required
    if (toolName === "help")    return c.json({ jsonrpc: "2.0", id, result: toolHelp() });
    if (toolName === "find")    return c.json({ jsonrpc: "2.0", id, result: await toolFind(args) });
    if (toolName === "browse")  return c.json({ jsonrpc: "2.0", id, result: await toolBrowse(args) });
    if (toolName === "install") return c.json({ jsonrpc: "2.0", id, result: await toolInstall(args) });

    // boot handles unregistered gracefully
    if (toolName === "boot") {
      if (!piPrivate || !PRIVATE_PI_RE.test(piPrivate)) {
        return c.json({
          jsonrpc: "2.0", id,
          result: fail("X-Pi-Private header required. Add your π private key to your MCP config. New? Call install first."),
        });
      }
      return c.json({ jsonrpc: "2.0", id, result: await toolBoot(piPrivate, args) });
    }

    if (!piPrivate || !PRIVATE_PI_RE.test(piPrivate)) {
      return c.json({ jsonrpc: "2.0", id, result: fail("Not authenticated. Call boot first.") });
    }

    const publicPi = toPublicPi(piPrivate);

    try {
      let result;
      switch (toolName) {
        case "send":    result = await toolSend(piPrivate, publicPi, args);    break;
        case "receive": result = await toolReceive(publicPi);                   break;
        case "find":    result = await toolFind(args);                          break;
        case "browse":  result = await toolBrowse(args);                        break;
        case "mount":   result = await toolMount(piPrivate, publicPi, args);   break;
        case "call":    result = await toolCall(piPrivate, publicPi, args);     break;
        case "edit":    result = await toolEdit(piPrivate, publicPi, args);     break;
        // Extended — stubs pending DB migration
        case "log":
        case "set":
        case "file":
        case "plan":
        case "sub":
        case "chat":
          result = stub(toolName);
          break;
        default:
          // Proxy unknown tool names to mounted MCP
          result = await toolCall(piPrivate, publicPi, { tool: toolName, args });
      }
      return c.json({ jsonrpc: "2.0", id, result });
    } catch (e) {
      return c.json({ jsonrpc: "2.0", id, result: fail("Unexpected error.", String(e)) });
    }
  }

  return c.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
});

// ── Serve ─────────────────────────────────────────────────────────────────────

Deno.serve(app.fetch);
