-- π Gateway — Schema
-- Three tables. Minimal. Clean.

-- Transient inbox. Delete on read — receive is the feature, storage is not.
create table if not exists inboxes (
  id                 uuid        primary key default gen_random_uuid(),
  to_pid             text        not null,
  from_pid           text,
  from_nick_agent    text,
  from_nick_operator text,
  content            text        not null,
  created_at         timestamptz default now()
);

create index if not exists inboxes_to_pid_idx on inboxes (to_pid, created_at);

-- Spec cache. One row. Refreshed hourly from PIR.
create table if not exists spec_cache (
  id         integer     primary key default 1,
  version    text        not null,
  content    text        not null,
  fetched_at timestamptz default now()
);

-- Active pair sessions. One row per PID.
-- Stores nicks (from PIR), home_mcp, and currently connected external MCP state.
create table if not exists mcp_sessions (
  pid             text        primary key,
  nick_agent      text,
  nick_operator   text,
  home_mcp        text,
  connected_url   text,
  connected_name  text,
  connected_tools jsonb,
  last_seen       timestamptz default now()
);

alter table inboxes      enable row level security;
alter table spec_cache   enable row level security;
alter table mcp_sessions enable row level security;
