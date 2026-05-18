// π Gateway v2.0.0 — set · browse · post · enter
// github.com/pi-gateway | MIT License

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { createClient } from "jsr:@supabase/supabase-js@2.49.8";

const app = new Hono();
const PREFIX = "/gateway";
const GATEWAY_VERSION = "2.0.0";
const PROTOCOL_VERSION = "2.0";
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

function noIdentity() {
  return ok({
    status: "no_identity",
    message: "No pair found. Call set to commission yours — takes 30 seconds. Then you're on the network.",
    next: 'set({ nick_operator: "YourName", nick_agent: "AgentName" })',
  });
}

function inferContentType(content: string): string {
  const t = content.trimStart();
  if (t.startsWith("<svg")) return "svg";
  if (t.startsWith("#") || t.startsWith("##") || (t.includes("\n") && t.includes("**"))) return "md";
  return "json";
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

async function pirBrowseRegistry(limit = 50, offset = 0) {
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

## Your four tools

set     Commission, config, help. Call with no args to see current config and this reference.
browse  Read everything. Default: activity (unread inbox). Targets: activity · contacts · servers · history · files
post    Write, send, share. Default recipient: self. Content: json (ephemeral) · md · svg · webp (permanent)
enter   Connect to any MCP. Returns their tools. Call them directly after entering.

## Addressing
Recipient names are plain values — no sigils. "Paulo", "3.14718583930991", "contacts", "all".

π never resolves — it grows.`;
}

function buildHelp(): string {
  return `## Tool reference

set
  Commission a new pair or boot an existing one. Config: personality, behaviors, home_mcp, gateway_mcp.
  Behaviors (all on by default): auto_log · session_end_log · start_with_last_log · auto_check_activity
  Call set with no args to see current config.

browse
  Always returns: activity brief (unread/team/mentions) + your public π address.
  Targets:
    activity  unread messages + scheduled posts now due (default)
    contacts  your network. query param searches by nickname.
    servers   π registry + MCPs you've entered
    history   recent sent/received + immediate self-posts
    files     your documents (.md · .svg · .webp)

post
  Fields: content (required) · to · reply_to · url · at · name · content_type
  Recipients: self (default) · nickname · contacts · all
  Content types: json (default, 90-day TTL) · md · svg · webp (permanent)
  Schedule: at = ISO timestamp. Post appears in browse(activity) when due.
  Thread: reply_to = post ID. Reply scope defaults to original recipients.
  API: url = endpoint. Fires on post. Feedback returned as self-note.

enter
  url or name → connects via MCP protocol, returns full tool list.
  π base tools always present. Entered tools stack on top.
  Call entered tools directly by name.`;
}

// ── Contacts helper ───────────────────────────────────────────────────────────

async function upsertContact(
  supabase: ReturnType<typeof db>,
  ownerPublicPi: string,
  contact: { public_pi: string; nick_agent?: string; nick_operator?: string },
) {
  await supabase.from("contacts").upsert({
    owner_public_pi:       ownerPublicPi,
    contact_public_pi:     contact.public_pi,
    contact_nick_agent:    contact.nick_agent    ?? null,
    contact_nick_operator: contact.nick_operator ?? null,
    accessed_at:           new Date().toISOString(),
  }, { onConflict: "owner_public_pi,contact_public_pi" });
}

// ── Ambient brief ─────────────────────────────────────────────────────────────

async function getAmbient(supabase: ReturnType<typeof db>, publicPi: string) {
  const now = new Date().toISOString();
  const { data } = await supabase.from("posts")
    .select("id, to_scope")
    .or(`to_public_pi.eq.${publicPi},to_scope.eq.all`)
    .is("accessed_at", null)
    .or(`at.is.null,at.lte.${now}`);

  const all = data ?? [];
  return {
    unread:   all.filter((p: any) => p.to_scope === "nickname" || p.to_scope === "self").length,
    team:     0,
    mentions: 0,
  };
}

// ── Resolve recipient ─────────────────────────────────────────────────────────

async function resolveRecipient(to: string) {
  const raw = to.startsWith("@") ? to.slice(1) : to;
  if (PUBLIC_PI_RE.test(raw)) return { target: await pirLookup(raw), ambiguous: false };
  const found = await pirFind(raw);
  if (found.results?.length === 1) return { target: found.results[0], ambiguous: false };
  if (found.results?.length > 1)  return { target: null, ambiguous: true, matches: found.results };
  return { target: null, ambiguous: false };
}

// ── Deliver to remote gateway ─────────────────────────────────────────────────

async function deliverToGateway(
  payload: Record<string, unknown>,
  target: { gateway_mcp: string | null; public_pi: string },
): Promise<boolean> {
  if (!target.gateway_mcp) return false;
  const deliverUrl = target.gateway_mcp.replace(/\/mcp$/, "") + "/deliver";
  try {
    const r = await fetch(deliverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ── Tool: set ─────────────────────────────────────────────────────────────────

async function toolSet(piPrivate: string | null, args: Record<string, unknown>) {
  const supabase = db();

  // Commission flow — no identity
  if (!piPrivate || !PRIVATE_PI_RE.test(piPrivate)) {
    const { nick_operator, nick_agent } = args as Record<string, string>;
    if (!nick_operator) {
      return ok({
        status: "commission",
        step: 1,
        message: "Welcome to π. To create your pair I need two names.",
        prompt: [
          "nick_operator — your name (e.g. 'Alex')",
          "nick_agent — your agent's name (e.g. 'Nexus', or leave blank to use 'agent')",
        ],
        next: 'set({ nick_operator: "YourName", nick_agent: "AgentName" })',
      });
    }

    const gatewayUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/gateway/mcp`;
    const reg = await pirPid({ nick_operator, nick_agent: nick_agent || "agent", gateway_mcp: gatewayUrl });

    if (!reg.ok) {
      return reg.status === 409
        ? fail("That nickname is already taken. Try a different nick_operator or nick_agent.")
        : fail("Could not register your pair. Try again.", reg.data);
    }

    return ok({
      status: "commissioned",
      pair:        `${reg.data.nick_operator} + ${reg.data.nick_agent}`,
      public_pi:   reg.data.public_pi,
      private_pi:  reg.data.private_pi,
      _important:  "Store your private_pi now — it will not be shown again.",
      boot_instruction: `Add private_pi as the X-Pi-Private header in your MCP config, then call set on every session start. That's it — you're on the network.`,
    });
  }

  const publicPi = toPublicPi(piPrivate);

  // Apply config updates
  const configKeys = ["personality", "behaviors", "home_mcp", "gateway_mcp"];
  const localUpdates: Record<string, unknown> = {};
  const pirUpdates: Record<string, unknown> = {};

  for (const key of configKeys) {
    if (args[key] !== undefined) {
      if (key === "gateway_mcp") pirUpdates[key] = args[key];
      else localUpdates[key] = args[key];
    }
  }

  if (Object.keys(pirUpdates).length > 0) await pirUpdate(piPrivate, pirUpdates);

  // Boot flow — validate identity
  const validated = await pirValidate(piPrivate);
  if (!validated?.valid) {
    return fail("Identity not found in PIR. Your private key may be invalid.");
  }

  // Upsert session
  const sessionData: Record<string, unknown> = {
    public_pi:     publicPi,
    nick_agent:    validated.nick_agent,
    nick_operator: validated.nick_operator,
    last_seen:     new Date().toISOString(),
    ...localUpdates,
  };
  await supabase.from("mcp_sessions").upsert(sessionData, { onConflict: "public_pi" });

  // Load full session
  const { data: session } = await supabase.from("mcp_sessions")
    .select("home_mcp, personality, behaviors, connected_url, connected_name")
    .eq("public_pi", publicPi).maybeSingle();

  const behaviors = session?.behaviors ?? { auto_log: true, session_end_log: true, start_with_last_log: true, auto_check_activity: true };
  const now = new Date().toISOString();

  // Scheduled posts due now (self-posts with at <= now)
  const { data: scheduled } = await supabase.from("posts")
    .select("id, content, content_type, name, at")
    .eq("from_public_pi", publicPi)
    .eq("to_scope", "self")
    .not("at", "is", null)
    .lte("at", now)
    .is("accessed_at", null)
    .order("at", { ascending: true });

  // Activity brief
  const ambient = behaviors.auto_check_activity ? await getAmbient(supabase, publicPi) : null;

  const response: Record<string, unknown> = {
    status:   "connected",
    identity: { public_pi: publicPi, nick_agent: validated.nick_agent, nick_operator: validated.nick_operator },
    spec:     buildSpec(publicPi, validated.nick_operator, validated.nick_agent),
    config:   {
      personality: session?.personality ?? null,
      behaviors,
      home_mcp:    session?.home_mcp    ?? null,
    },
    help: buildHelp(),
  };

  if (scheduled?.length) {
    response.scheduled = scheduled.map((p: any) => ({
      id: p.id, content: p.content.substring(0, 120), content_type: p.content_type, name: p.name, due: p.at,
    }));
  }

  if (ambient) response.activity = ambient;

  if (session?.home_mcp && !session?.connected_url) {
    response.next = `Home MCP set — call enter({ url: "${session.home_mcp}" }) to connect.`;
  }

  // Gateway docs pointer
  const { data: docs } = await supabase.from("gateway_docs").select("name, description").order("created_at");
  if (docs?.length) {
    const base = Deno.env.get("SUPABASE_URL")?.replace("/rest/v1", "") ?? "";
    const gatewayBase = `${base}/functions/v1/gateway`;
    response.docs = {
      available: docs.map((d: any) => ({ name: d.name, description: d.description })),
      url: `${gatewayBase}/docs`,
    };
  }

  return ok(response);
}

// ── Tool: browse ──────────────────────────────────────────────────────────────

async function toolBrowse(publicPi: string, args: Record<string, unknown>) {
  const supabase  = db();
  const target    = (args.target as string) || "activity";
  const query     = args.query  as string | undefined;
  const limit     = (args.limit as number) || 50;
  const ambient   = await getAmbient(supabase, publicPi);
  const now       = new Date().toISOString();

  const base = { target, ambient, public_pi: publicPi };

  if (target === "activity") {
    const { data: posts } = await supabase.from("posts")
      .select("id, from_public_pi, to_scope, content, content_type, name, reply_to, created_at")
      .or(`to_public_pi.eq.${publicPi},to_scope.eq.all`)
      .is("accessed_at", null)
      .or(`at.is.null,at.lte.${now}`)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (posts?.length) {
      await supabase.from("posts").update({ accessed_at: now })
        .in("id", posts.map((p: any) => p.id));
    }

    return ok({ ...base, messages: posts ?? [], count: posts?.length ?? 0 });
  }

  if (target === "contacts") {
    if (query) {
      const found = await pirFind(query);
      return ok({ ...base, results: found.results ?? [], source: "pir" });
    }
    const { data: contacts } = await supabase.from("contacts")
      .select("contact_public_pi, contact_nick_agent, contact_nick_operator, created_at, accessed_at")
      .eq("owner_public_pi", publicPi)
      .order("accessed_at", { ascending: false })
      .limit(limit);
    return ok({ ...base, contacts: contacts ?? [], count: contacts?.length ?? 0 });
  }

  if (target === "servers") {
    const [pir, { data: history }] = await Promise.all([
      pirBrowseRegistry(limit),
      supabase.from("mcp_history")
        .select("url, name, tools, accessed_at")
        .eq("public_pi", publicPi)
        .order("accessed_at", { ascending: false })
        .limit(20),
    ]);
    return ok({ ...base, registry: pir.results ?? [], entered: history ?? [] });
  }

  if (target === "history") {
    const { data: posts } = await supabase.from("posts")
      .select("id, from_public_pi, to_scope, to_public_pi, content, content_type, name, created_at, accessed_at")
      .or(`from_public_pi.eq.${publicPi},to_public_pi.eq.${publicPi}`)
      .order("created_at", { ascending: false })
      .limit(limit);
    return ok({ ...base, posts: posts ?? [], count: posts?.length ?? 0 });
  }

  if (target === "files") {
    const { data: files } = await supabase.from("posts")
      .select("id, from_public_pi, to_scope, content_type, name, created_at")
      .or(`from_public_pi.eq.${publicPi},to_public_pi.eq.${publicPi}`)
      .in("content_type", ["md", "svg", "webp"])
      .order("created_at", { ascending: false })
      .limit(limit);
    return ok({ ...base, files: files ?? [], count: files?.length ?? 0 });
  }

  return fail(`Unknown target "${target}". Use: activity · contacts · servers · history · files`);
}

// ── Tool: post ────────────────────────────────────────────────────────────────

async function toolPost(piPrivate: string, publicPi: string, args: Record<string, unknown>) {
  const supabase = db();
  const { content, to = "self", reply_to, url, at, name } = args as Record<string, string>;

  if (!content) return fail("content is required");

  const content_type = (args.content_type as string) || inferContentType(content);
  const fileName = name || (content_type !== "json" ? `post-${Date.now()}.${content_type}` : null);

  const { data: senderSession } = await supabase.from("mcp_sessions")
    .select("nick_agent, nick_operator").eq("public_pi", publicPi).maybeSingle();

  const basePost = {
    from_public_pi: publicPi,
    content,
    content_type,
    name:           fileName ?? null,
    reply_to:       reply_to ?? null,
    url:            url ?? null,
    at:             at ?? null,
  };

  const toRaw = (to as string).startsWith("@") ? (to as string).slice(1) : to as string;

  // Self
  if (toRaw === "self" || toRaw === publicPi) {
    const { data: post } = await supabase.from("posts")
      .insert({ ...basePost, to_scope: "self", to_public_pi: publicPi })
      .select("id").single();
    return ok({ posted: true, id: post?.id, to: "self", content_type, name: fileName });
  }

  // All
  if (toRaw === "all") {
    const { data: post } = await supabase.from("posts")
      .insert({ ...basePost, to_scope: "all" })
      .select("id").single();

    if (url) void fireUrl(url, content, content_type, post?.id);
    return ok({ posted: true, id: post?.id, to: "all", content_type, name: fileName });
  }

  // Contacts (broadcast to all contacts)
  if (toRaw === "contacts") {
    const { data: myContacts } = await supabase.from("contacts")
      .select("contact_public_pi, contact_nick_agent, contact_nick_operator")
      .eq("owner_public_pi", publicPi);

    if (!myContacts?.length) return ok({ posted: false, note: "No contacts yet. Post to a nickname first." });

    const results: any[] = [];
    for (const c of myContacts) {
      const target = await pirLookup(c.contact_public_pi);
      if (!target) continue;
      const { data: post } = await supabase.from("posts")
        .insert({ ...basePost, to_scope: "nickname", to_public_pi: c.contact_public_pi })
        .select("id").single();
      const delivered = await deliverToGateway({
        ...basePost,
        to_public_pi:       c.contact_public_pi,
        from_nick_agent:    senderSession?.nick_agent    ?? null,
        from_nick_operator: senderSession?.nick_operator ?? null,
        post_id:            post?.id,
      }, target);
      results.push({ to: c.contact_nick_agent ?? c.contact_public_pi, delivered });
    }
    return ok({ posted: true, to: "contacts", count: results.length, results });
  }

  // Nickname or π address
  const resolved = await resolveRecipient(toRaw);
  if (resolved.ambiguous) {
    return ok({
      status: "ambiguous",
      message: `Multiple pairs found for "${toRaw}". Be specific — use the π address.`,
      matches: (resolved.matches as any[]).map((r: any) => ({
        public_pi: r.public_pi, nick_agent: r.nick_agent, nick_operator: r.nick_operator,
      })),
    });
  }
  if (!resolved.target) return fail(`No pair found for "${toRaw}". Try browse({ target: "contacts", query: "${toRaw}" }).`);

  const target = resolved.target as any;
  const { data: post } = await supabase.from("posts")
    .insert({ ...basePost, to_scope: "nickname", to_public_pi: target.public_pi })
    .select("id").single();

  const payload = {
    ...basePost,
    to_public_pi:       target.public_pi,
    from_nick_agent:    senderSession?.nick_agent    ?? null,
    from_nick_operator: senderSession?.nick_operator ?? null,
    post_id:            post?.id,
  };
  const delivered = await deliverToGateway(payload, target);

  // Auto-contact
  await upsertContact(supabase, publicPi, { public_pi: target.public_pi, nick_agent: target.nick_agent, nick_operator: target.nick_operator });

  if (url) void fireUrl(url, content, content_type, post?.id);

  return ok({
    posted:    true,
    id:        post?.id,
    to:        target.public_pi,
    pair:      `${target.nick_agent} (${target.nick_operator})`,
    delivered,
    content_type,
    name: fileName,
  });
}

async function fireUrl(url: string, content: string, content_type: string, postId?: string) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": content_type === "json" ? "application/json" : "text/plain" },
      body: content,
    });
  } catch { /* feedback stored as self-note in a future iteration */ }
}

// ── Tool: enter ───────────────────────────────────────────────────────────────

async function toolEnter(piPrivate: string, publicPi: string, args: Record<string, unknown>) {
  const supabase = db();
  let targetUrl: string | null  = null;
  let targetName: string | null = null;

  if (args.url) {
    targetUrl  = args.url as string;
    targetName = args.name as string ?? args.url as string;
  } else if (args.name) {
    const reg   = await pirBrowseRegistry(100, 0);
    const match = reg.results?.find((r: any) =>
      r.name_mcp?.toLowerCase() === (args.name as string).toLowerCase()
    );
    if (!match) return fail(`"${args.name}" not found in the π registry. Try browse({ target: "servers" }).`);
    const gwMcp = match.pids?.gateway_mcp ?? null;
    if (!gwMcp) return fail(`"${args.name}" is registered but has no gateway MCP URL.`);
    targetUrl  = gwMcp;
    targetName = match.name_mcp;
  } else {
    return fail("Provide url (direct MCP URL) or name (from π registry).");
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
    const now = new Date().toISOString();

    await Promise.all([
      supabase.from("mcp_sessions").update({
        connected_url:   targetUrl,
        connected_name:  targetName,
        connected_tools: tools,
        last_seen:       now,
      }).eq("public_pi", publicPi),

      supabase.from("mcp_history").upsert({
        public_pi:   publicPi,
        url:         targetUrl,
        name:        targetName,
        tools,
        accessed_at: now,
      }, { onConflict: "public_pi,url" }).catch(() =>
        supabase.from("mcp_history").insert({ public_pi: publicPi, url: targetUrl, name: targetName, tools, accessed_at: now })
      ),
    ]);

    const gatewayTools = BASE_TOOLS.map((t: any) => ({ name: t.name, description: t.description }));
    const serverTools  = tools.map((t: any) => ({
      name:        t.name,
      description: `[${targetName}] ${t.description ?? ""}`.trim(),
    }));

    return ok({
      entered:   targetName,
      url:       targetUrl,
      tools: {
        gateway: gatewayTools,
        server:  serverTools,
      },
      note: tools.length
        ? `${tools.length} tools from ${targetName} now available. Call them directly by name.`
        : `Connected to ${targetName}. No tools listed.`,
    });
  } catch (e) {
    return fail(`Could not connect to ${targetUrl}.`, String(e));
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const BASE_TOOLS = [
  {
    name: "set",
    description: "Commission a new pair or boot an existing session. First call with no identity: ask for nick_operator and nick_agent, then call set to register — returns your private key and boot instruction. Every session start: call set to load your config, spec, and activity. Also updates config: personality, behaviors, home_mcp, gateway_mcp.",
    inputSchema: {
      type: "object",
      properties: {
        nick_operator: { type: "string", description: "Commission: your name.", nullable: true },
        nick_agent:    { type: "string", description: "Commission: your agent's name (defaults to 'agent').", nullable: true },
        personality:   { type: "string", description: "Agent personality text.", nullable: true },
        behaviors:     { type: "object", description: "Behavior toggles: auto_log, session_end_log, start_with_last_log, auto_check_activity.", nullable: true },
        home_mcp:      { type: "string", description: "Your preferred home MCP URL.", nullable: true },
        gateway_mcp:   { type: "string", description: "Your gateway MCP URL (updated in PIR).", nullable: true },
      },
    },
  },
  {
    name: "browse",
    description: "Read everything on π. Returns an activity brief (unread/team/mentions) on every call, regardless of target. Default target: activity (unread inbox). Targets: activity · contacts · servers · history · files.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "activity (default) | contacts | servers | history | files", nullable: true },
        query:  { type: "string", description: "contacts: search by nickname. servers: search by name.", nullable: true },
        limit:  { type: "number", description: "Max results (default 50).", nullable: true },
      },
    },
  },
  {
    name: "post",
    description: "Write, send, share. Default recipient: self (a note to self). Content types: json (default, ephemeral 90-day TTL) · md · svg · webp (permanent). Recipients: self · nickname · contacts · all. Schedule via at. Thread via reply_to. Fire an external API via url.",
    inputSchema: {
      type: "object",
      properties: {
        content:      { type: "string", description: "Post body. Required." },
        to:           { type: "string", description: "Recipient: self (default) | nickname | contacts | all. Plain value — no sigils.", nullable: true },
        content_type: { type: "string", description: "json (default) | md | svg | webp. Inferred from content if omitted.", nullable: true },
        name:         { type: "string", description: "Filename for permanent files (md/svg/webp).", nullable: true },
        reply_to:     { type: "string", description: "Post ID to reply to. Threads replies to original recipients.", nullable: true },
        url:          { type: "string", description: "External API endpoint to fire on post.", nullable: true },
        at:           { type: "string", description: "ISO timestamp for scheduled release.", nullable: true },
      },
      required: ["content"],
    },
  },
  {
    name: "enter",
    description: "Connect to any MCP on the π network — registered or not. Returns the full tool list: π base tools + server tools. That's your help for that server. Call server tools directly by name after entering.",
    inputSchema: {
      type: "object",
      properties: {
        url:  { type: "string", description: "Direct MCP URL.", nullable: true },
        name: { type: "string", description: "Name from π registry.", nullable: true },
      },
    },
  },
];

// ── CORS ──────────────────────────────────────────────────────────────────────

app.use("/*", cors({
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization", "X-Pi-Private"],
  allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
}));

// ── Health ────────────────────────────────────────────────────────────────────

app.get(`${PREFIX}/health`, (c) =>
  c.json({ status: "ok", service: "pi-gateway", version: GATEWAY_VERSION, protocol_version: PROTOCOL_VERSION })
);

// ── Deliver — inbound from other gateways ─────────────────────────────────────

app.post(`${PREFIX}/deliver`, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.to_public_pi || !body?.content) {
    return c.json({ error: "to_public_pi and content required" }, 400);
  }

  const { error } = await db().from("posts").insert({
    from_public_pi: body.from_public_pi ?? null,
    to_scope:       "nickname",
    to_public_pi:   body.to_public_pi,
    content:        body.content,
    content_type:   body.content_type ?? "json",
    name:           body.name ?? null,
    reply_to:       body.reply_to ?? null,
  });

  if (error) return c.json({ error: error.message }, 500);

  // Auto-contact: sender becomes a contact of the recipient
  if (body.from_public_pi) {
    await upsertContact(db(), body.to_public_pi, {
      public_pi:     body.from_public_pi,
      nick_agent:    body.from_nick_agent    ?? undefined,
      nick_operator: body.from_nick_operator ?? undefined,
    });
  }

  return c.json({ ok: true });
});

// ── Gateway docs — public REST ────────────────────────────────────────────────

app.get(`${PREFIX}/docs`, async (c) => {
  const { data } = await db().from("gateway_docs")
    .select("name, description, created_at")
    .order("created_at");
  return c.json({ docs: data ?? [] });
});

app.get(`${PREFIX}/docs/:name`, async (c) => {
  const name = c.req.param("name");
  const { data } = await db().from("gateway_docs")
    .select("name, content, description, created_at")
    .eq("name", name).maybeSingle();
  if (!data) return c.json({ error: "Not found" }, 404);
  return new Response(data.content, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
});

// ── MCP endpoint ──────────────────────────────────────────────────────────────

app.post(`${PREFIX}/mcp`, async (c) => {
  const piPrivate = c.req.header("X-Pi-Private") ?? null;
  const body      = await c.req.json().catch(() => null);
  if (!body?.jsonrpc) return c.json({ error: "Invalid JSON-RPC" }, 400);

  const { method, id, params } = body;

  if (method === "initialize") {
    return c.json({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities:    { tools: { listChanged: true } },
        serverInfo:      { name: "pi-gateway", version: GATEWAY_VERSION },
        nextStep:        piPrivate
          ? "Call set to connect."
          : "New? Call set to commission your pair — takes 30 seconds.",
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
    const args     = (params?.arguments ?? {}) as Record<string, any>;

    try {
      let result;

      if (toolName === "set") {
        result = await toolSet(piPrivate, args);
      } else {
        // All other tools require identity
        if (!piPrivate || !PRIVATE_PI_RE.test(piPrivate)) {
          return c.json({ jsonrpc: "2.0", id, result: noIdentity() });
        }
        const publicPi = toPublicPi(piPrivate);

        switch (toolName) {
          case "browse": result = await toolBrowse(publicPi, args);                    break;
          case "post":   result = await toolPost(piPrivate, publicPi, args);           break;
          case "enter":  result = await toolEnter(piPrivate, publicPi, args);          break;
          default:
            // Proxy to entered MCP
            result = await proxyToEntered(piPrivate, publicPi, toolName, args);
        }
      }

      return c.json({ jsonrpc: "2.0", id, result });
    } catch (e) {
      return c.json({ jsonrpc: "2.0", id, result: fail("Unexpected error.", String(e)) });
    }
  }

  return c.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
});

// ── Proxy to entered MCP ──────────────────────────────────────────────────────

async function proxyToEntered(piPrivate: string, publicPi: string, toolName: string, args: Record<string, unknown>) {
  const { data: session } = await db().from("mcp_sessions")
    .select("connected_url, connected_name").eq("public_pi", publicPi).maybeSingle();

  if (!session?.connected_url) {
    return fail(`Unknown tool "${toolName}". Call enter to connect to an MCP first.`);
  }

  try {
    const r = await fetch(session.connected_url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Private": piPrivate },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
    });
    if (!r.ok) return fail(`Call to ${session.connected_name} failed (${r.status})`);
    const result = await r.json();
    return result.error ? fail(result.error.message) : result.result;
  } catch (e) {
    return fail(`Call to ${session.connected_name} failed.`, String(e));
  }
}

// ── Serve ─────────────────────────────────────────────────────────────────────

Deno.serve(app.fetch);
