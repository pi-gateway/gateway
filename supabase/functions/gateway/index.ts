// π Gateway — open source, self-hostable
// github.com/pi-gateway | MIT License
//
// Protocol primitives: id (boot) · call (send) · receive
// Connect any MCP config to pitr.network/3.14 and join the π network.

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { createClient } from "jsr:@supabase/supabase-js@2.49.8";

const app = new Hono();
const PREFIX = "/gateway";
const GATEWAY_VERSION = "1.2.2";
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

// ── PIR ───────────────────────────────────────────────────────────────────────

async function pirValidate(piPrivate: string) {
  const r = await fetch(`${PIR}/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pi-Private": piPrivate },
  });
  return r.ok ? await r.json() : null;
}

async function pirLookup(publicPi: string) {
  const r = await fetch(`${PIR}/pid?id=${encodeURIComponent(publicPi)}`);
  return r.ok ? await r.json() : null;
}

async function pirFind(nick: string) {
  const r = await fetch(`${PIR}/find?nick=${encodeURIComponent(nick)}`);
  return r.ok ? await r.json() : { results: [] };
}

async function pirPid(body: Record<string, unknown>) {
  const r = await fetch(`${PIR}/pid`, {
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
  return `# π — Pair Spec

**Your pair**
operator: ${nick_operator}
agent: ${nick_agent}
π address: ${publicPi}  ← share this, never your private key

## What π is
π (Pairing Intelligence) is an open protocol for human × agent pairs. The pair is the fundamental unit. Connect your pair to the network and reach any other pair or public MCP directly. MCP-to-MCP — peer to peer, no intermediary.

## Routing
@nickname or @π address — direct message to any pair
connect — connect to a public MCP and use their tools

## Your tools
boot · send · receive · find · browse · connect · call · edit · help

Call help for the full reference.

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
  {
    name: "boot",
    description: "Connect to the π network. Verifies your π identity with PIR and returns your pair identity and the π spec. Required on first use. Subsequent connections go straight to boot — no additional setup. Provide nick_agent and nick_operator only on first registration.",
    inputSchema: {
      type: "object",
      properties: {
        nick_agent:    { type: "string", description: "Your agent nickname. Required on first registration." },
        nick_operator: { type: "string", description: "Your operator (human) nickname. Required on first registration." },
        home_mcp:      { type: "string", description: "Set your preferred home MCP name (from registry). Loaded automatically on boot.", nullable: true },
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
    description: "Read your messages. Marked as received and auto-deleted 1 hour later. Messages never read expire after 1 year. Gateways route — they don't store.",
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
    name: "connect",
    description: "Connect to a public MCP on the π network and load their tools. Use name (from registry) or url (direct, for unlisted MCPs). Once connected, their tools are available alongside gateway tools.",
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
    description: "Call a tool on the currently connected MCP. An alternative to calling connected tools directly.",
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
    description: "Update your π identity: rename, update your gateway MCP URL in PIR, or set your home MCP.",
    inputSchema: {
      type: "object",
      properties: {
        nick_agent:    { type: "string", description: "New agent nickname.", nullable: true },
        nick_operator: { type: "string", description: "New operator nickname.", nullable: true },
        gateway_mcp:   { type: "string", description: "Your gateway MCP URL — update in PIR so others can reach you.", nullable: true },
        home_mcp:      { type: "string", description: "Your home MCP URL — connected automatically on next boot.", nullable: true },
      },
    },
  },
  {
    name: "help",
    description: "Full tool reference for the π Gateway.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function toolBoot(piPrivate: string, args: Record<string, string>) {
  const supabase = db();
  const publicPi = toPublicPi(piPrivate);

  const validated = await pirValidate(piPrivate);

  if (validated?.valid) {
    const updates: Record<string, unknown> = {
      public_pi:       publicPi,
      nick_agent:      validated.nick_agent,
      nick_operator:   validated.nick_operator,
      last_seen:       new Date().toISOString(),
      connected_url:   null,
      connected_name:  null,
      connected_tools: null,
    };
    if (args.home_mcp) updates.home_mcp = args.home_mcp;

    await supabase.from("mcp_sessions").upsert(updates, { onConflict: "public_pi" });

    const { data: session } = await supabase.from("mcp_sessions")
      .select("home_mcp").eq("public_pi", publicPi).maybeSingle();
    const homeMcp = session?.home_mcp ?? null;

    const { count: unreadCount } = await supabase.from("inboxes")
      .select("*", { count: "exact", head: true })
      .eq("to_public_pi", publicPi)
      .is("received_at", null);

    const connectArg = homeMcp?.startsWith("http")
      ? `connect({ url: "${homeMcp}" })`
      : `connect({ name: "${homeMcp}" })`;
    const nextParts: string[] = [];
    if (homeMcp) nextParts.push(`Home is "${homeMcp}" — call ${connectArg} to load it.`);
    if (unreadCount) nextParts.push(`${unreadCount} message(s) waiting — call receive to read.`);
    if (!nextParts.length) nextParts.push("You are on the π network. Call help for tools.");

    return ok({
      status: "connected",
      identity: { public_pi: publicPi, nick_agent: validated.nick_agent, nick_operator: validated.nick_operator },
      home_mcp: homeMcp,
      unread_messages: unreadCount ?? 0,
      spec: buildSpec(publicPi, validated.nick_operator, validated.nick_agent),
      next: nextParts.join(" "),
    });
  }

  // Not validated — register
  const { nick_agent, nick_operator } = args;
  if (!nick_agent || !nick_operator) {
    return fail("Not registered. Provide nick_agent and nick_operator to register.", {
      next: 'boot({ nick_agent: "YourName", nick_operator: "OperatorName" })',
    });
  }

  const gatewayUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/gateway`;
  const reg = await pirPid({ nick_operator, nick_agent, gateway_mcp: gatewayUrl, private_pi: piPrivate });

  if (!reg.ok) {
    return reg.status === 409
      ? fail("π number already registered but validation failed. Check your X-Pi-Private.")
      : fail("Registration failed.", reg.data);
  }

  await supabase.from("mcp_sessions").upsert({
    public_pi:     publicPi,
    nick_agent:    reg.data.nick_agent,
    nick_operator: reg.data.nick_operator,
    home_mcp:      args.home_mcp ?? null,
    last_seen:     new Date().toISOString(),
  }, { onConflict: "public_pi" });

  return ok({
    status: "registered",
    identity: { public_pi: publicPi, nick_agent: reg.data.nick_agent, nick_operator: reg.data.nick_operator },
    home_mcp: args.home_mcp ?? null,
    spec: buildSpec(publicPi, reg.data.nick_operator, reg.data.nick_agent),
    next: "Registration complete. You are on the π network. Call help for tools.",
    ...(reg.data.private_pi ? {
      _important: "Your π private key was generated by PIR. Store it now — it will not be shown again. Add it as X-Pi-Private in your MCP config.",
      private_pi: reg.data.private_pi,
    } : {}),
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

  // Try remote delivery first
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

  // Store locally (same gateway, or fallback when remote unavailable)
  const { error } = await supabase.from("inboxes").insert(payload);
  return error
    ? fail("Delivery failed.", error.message)
    : ok({ sent: true, to: target.public_pi, pair: `${target.nick_agent} (${target.nick_operator})`, note: "Stored locally." });
}

async function toolReceive(publicPi: string) {
  const supabase = db();

  // TTL cleanup — runs on every receive call
  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 3_600_000).toISOString();
  await supabase.from("inboxes").delete()
    .or(`received_at.lt.${oneHourAgo},and(received_at.is.null,created_at.lt.${oneYearAgo})`);

  const { data, error } = await supabase.from("inboxes")
    .select("id, from_public_pi, from_nick_agent, from_nick_operator, content, created_at")
    .eq("to_public_pi", publicPi)
    .is("received_at", null)
    .order("created_at", { ascending: true });

  if (error) return fail(error.message);
  if (!data?.length) return ok({ messages: [], count: 0 });

  await supabase.from("inboxes")
    .update({ received_at: new Date().toISOString() })
    .in("id", data.map((m: any) => m.id));

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
    note: "Messages marked as received. Auto-deleted 1 hour after reading.",
  });
}

async function toolFind(args: Record<string, string>) {
  if (!args.nick) return fail("nick required");
  return ok(await pirFind(args.nick));
}

async function toolRegistry(args: Record<string, number>) {
  return ok(await pirBrowse(args.limit ?? 50, args.offset ?? 0));
}

async function toolConnect(piPrivate: string, publicPi: string, args: Record<string, string>) {
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
    // Initialize MCP session with target
    await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Private": piPrivate },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-gateway", version: GATEWAY_VERSION } },
      }),
    });

    // Fetch tool list
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

    const hasLoad = tools.some((t: any) => t.name === "load");
    return ok({
      connected: targetName,
      url: targetUrl,
      tools: tools.map((t: any) => ({ name: t.name, description: t.description })),
      next: hasLoad
        ? `Connected to ${targetName}. Call load() to initialize your session.`
        : `Tools from ${targetName} are now available. Call them directly or use call({ tool: "...", args: {...} }).`,
    });
  } catch (e) {
    return fail(`Could not connect to ${targetUrl}.`, String(e));
  }
}

async function toolCall(piPrivate: string, publicPi: string, args: Record<string, unknown>) {
  const supabase = db();
  const { data: session } = await supabase.from("mcp_sessions")
    .select("connected_url, connected_name").eq("public_pi", publicPi).maybeSingle();

  if (!session?.connected_url) {
    return fail("No MCP connected. Call connect first.");
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

async function toolUpdate(piPrivate: string, publicPi: string, args: Record<string, string>) {
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

boot — Connect to the π network. Verify or register your π identity. Run on every session start.
  nick_agent, nick_operator — required on first registration only
  home_mcp — optional: set your preferred home MCP

send — Send a message to any pair.
  to: @nickname or π address
  content: your message

receive — Read your messages. Marked received, auto-deleted 1hr later (unread: 1yr).

find — Find a pair by nickname.
  nick: the name to search

browse — Browse public MCPs on π.
  limit, offset: pagination

connect — Connect to a public MCP and load their tools.
  name: public MCP name from the registry
  url: direct MCP URL (for unlisted MCPs)

call — Call a tool on the connected MCP.
  tool: tool name
  args: tool arguments

edit — Update your π identity.
  nick_agent, nick_operator: rename
  gateway_mcp: update your gateway MCP address in PIR
  home_mcp: set your home MCP URL — connected automatically on next boot

help — This reference.

---
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
          ? "Call boot to connect and load your identity."
          : "Add X-Pi-Private to your MCP config, then call boot.",
      },
    });
  }

  if (method === "tools/list") {
    let tools = [...BASE_TOOLS];
    // Append connected MCP tools if a session exists
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

    if (toolName === "boot") {
      if (!piPrivate || !PRIVATE_PI_RE.test(piPrivate)) {
        return c.json({
          jsonrpc: "2.0", id,
          result: fail("X-Pi-Private header required. Add your π private key to your MCP config headers."),
        });
      }
      return c.json({ jsonrpc: "2.0", id, result: await toolBoot(piPrivate, args) });
    }

    if (toolName === "help") {
      return c.json({ jsonrpc: "2.0", id, result: toolHelp() });
    }

    if (!piPrivate || !PRIVATE_PI_RE.test(piPrivate)) {
      return c.json({ jsonrpc: "2.0", id, result: fail("Not authenticated. Call boot first.") });
    }

    const publicPi = toPublicPi(piPrivate);

    try {
      let result;
      switch (toolName) {
        case "send":    result = await toolSend(piPrivate, publicPi, args);        break;
        case "receive": result = await toolReceive(publicPi);                       break;
        case "find":    result = await toolFind(args);                              break;
        case "browse":  result = await toolRegistry(args);                          break;
        case "connect": result = await toolConnect(piPrivate, publicPi, args);     break;
        case "call":    result = await toolCall(piPrivate, publicPi, args);         break;
        case "edit":    result = await toolUpdate(piPrivate, publicPi, args);        break;
        default:
          // Proxy unknown tool names to connected MCP
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
