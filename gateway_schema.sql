-- π Gateway — Hetzner Postgres schema (v2.3.x)
-- Run once against the gateway database before starting the server.

CREATE TABLE IF NOT EXISTS mcp_sessions (
  public_pi       TEXT        PRIMARY KEY,
  nick_agent      TEXT,
  nick_operator   TEXT,
  home_mcp        TEXT,
  connected_url   TEXT,
  connected_name  TEXT,
  connected_tools JSONB,
  last_seen       TIMESTAMPTZ DEFAULT NOW(),
  incarnation     TEXT,
  personality     TEXT,
  role            TEXT        NOT NULL DEFAULT 'member',
  behaviors       JSONB       DEFAULT '{"auto_log":true,"session_end_log":true,"start_with_last_log":true,"auto_check_activity":true}'::jsonb,
  cc_public_pi    TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_public_pi TEXT        NOT NULL,
  to_scope       TEXT        NOT NULL DEFAULT 'self',
  to_public_pi   TEXT,
  content        TEXT        NOT NULL,
  content_type   TEXT        NOT NULL DEFAULT 'json',
  name           TEXT,
  reply_to       UUID        REFERENCES posts(id),
  url            TEXT,
  at             TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  accessed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS posts_recipient_idx ON posts (to_public_pi, to_scope, accessed_at, created_at);
CREATE INDEX IF NOT EXISTS posts_from_idx      ON posts (from_public_pi, created_at);
CREATE INDEX IF NOT EXISTS posts_scheduled_idx ON posts (at) WHERE at IS NOT NULL;
CREATE INDEX IF NOT EXISTS posts_files_idx     ON posts (from_public_pi, content_type) WHERE content_type IN ('md', 'svg', 'webp');

CREATE TABLE IF NOT EXISTS contacts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_public_pi       TEXT        NOT NULL,
  contact_public_pi     TEXT        NOT NULL,
  contact_nick_agent    TEXT,
  contact_nick_operator TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  accessed_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(owner_public_pi, contact_public_pi)
);

CREATE INDEX IF NOT EXISTS contacts_owner_idx ON contacts (owner_public_pi, accessed_at DESC);

CREATE TABLE IF NOT EXISTS gateway_docs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL UNIQUE,
  content     TEXT        NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mcp_history (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  public_pi   TEXT        NOT NULL,
  url         TEXT        NOT NULL,
  name        TEXT,
  tools       JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  accessed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(public_pi, url)
);

CREATE INDEX IF NOT EXISTS mcp_history_pair_idx ON mcp_history (public_pi, accessed_at DESC);
