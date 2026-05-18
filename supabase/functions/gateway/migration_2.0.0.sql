-- π Gateway v2.0.0 migration
-- 4-verb toolset: set · browse · post · enter
-- Run in Supabase SQL editor before deploying v2.0.0

-- posts: unified content — messages, documents, notes, scheduled items
CREATE TABLE IF NOT EXISTS posts (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_public_pi text        NOT NULL,
  to_scope       text        NOT NULL DEFAULT 'self',  -- self | nickname | contacts | all
  to_public_pi   text,                                  -- set for nickname delivery
  content        text        NOT NULL,
  content_type   text        NOT NULL DEFAULT 'json',   -- json | md | svg | webp
  name           text,                                  -- filename for permanent files
  reply_to       uuid        REFERENCES posts(id),
  url            text,                                  -- external API endpoint
  at             timestamptz,                           -- scheduled release
  created_at     timestamptz DEFAULT now(),
  accessed_at    timestamptz                            -- set on first read; 90-day TTL for json
);

CREATE INDEX IF NOT EXISTS posts_recipient_idx ON posts (to_public_pi, to_scope, accessed_at, created_at);
CREATE INDEX IF NOT EXISTS posts_from_idx      ON posts (from_public_pi, created_at);
CREATE INDEX IF NOT EXISTS posts_scheduled_idx ON posts (at) WHERE at IS NOT NULL;
CREATE INDEX IF NOT EXISTS posts_files_idx     ON posts (from_public_pi, content_type) WHERE content_type IN ('md', 'svg', 'webp');

-- contacts: auto-built from interactions — no manual management
CREATE TABLE IF NOT EXISTS contacts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_public_pi       text        NOT NULL,
  contact_public_pi     text        NOT NULL,
  contact_nick_agent    text,
  contact_nick_operator text,
  created_at            timestamptz DEFAULT now(),
  accessed_at           timestamptz DEFAULT now(),
  UNIQUE(owner_public_pi, contact_public_pi)
);

CREATE INDEX IF NOT EXISTS contacts_owner_idx ON contacts (owner_public_pi, accessed_at DESC);

-- gateway_docs: institutional documentation — admin-published, publicly readable
CREATE TABLE IF NOT EXISTS gateway_docs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL UNIQUE,
  content     text        NOT NULL,
  description text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- mcp_history: MCP servers accessed via enter — per pair
CREATE TABLE IF NOT EXISTS mcp_history (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  public_pi   text        NOT NULL,
  url         text        NOT NULL,
  name        text,
  tools       jsonb,
  created_at  timestamptz DEFAULT now(),
  accessed_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_history_pair_idx ON mcp_history (public_pi, accessed_at DESC);

-- Extend mcp_sessions with pair config
ALTER TABLE mcp_sessions ADD COLUMN IF NOT EXISTS personality text;
ALTER TABLE mcp_sessions ADD COLUMN IF NOT EXISTS behaviors   jsonb DEFAULT '{"auto_log":true,"session_end_log":true,"start_with_last_log":true,"auto_check_activity":true}'::jsonb;

-- RLS (service role key bypasses — Edge Functions use it directly)
ALTER TABLE posts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_history  ENABLE ROW LEVEL SECURITY;
