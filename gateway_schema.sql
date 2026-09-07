-- π Gateway — PostgreSQL schema
-- Run once against GW_DB_URL before starting the server:
--   psql "$GW_DB_URL" -f gateway_schema.sql
-- Contacts and the public registry live in PIR, not here.

CREATE TABLE IF NOT EXISTS mcp_sessions (
  public_pi        TEXT        PRIMARY KEY,
  nick_agent       TEXT,
  nick_operator    TEXT,
  last_seen        TIMESTAMPTZ DEFAULT NOW(),
  incarnation      TEXT,
  role             TEXT        NOT NULL DEFAULT 'member',
  behaviors        JSONB       DEFAULT '{"auto_log":true,"session_end_log":true,"start_with_last_log":true,"auto_check_activity":true}'::jsonb,
  cc_public_pi     TEXT,
  connected_mounts JSONB       DEFAULT '[]'::jsonb
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

-- OAuth bearer tokens (browser connect flow). Opaque token, stored hashed.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT        PRIMARY KEY,
  pi_private TEXT        NOT NULL,
  access_key TEXT,
  issued_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_pi_private ON oauth_tokens (pi_private);

-- A local post shared by live reference with another pair on this same gateway.
CREATE TABLE IF NOT EXISTS post_shares (
  post_id               UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  shared_with_public_pi TEXT        NOT NULL,
  shared_by_public_pi   TEXT        NOT NULL,
  shared_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accessed_at           TIMESTAMPTZ,
  PRIMARY KEY (post_id, shared_with_public_pi)
);

CREATE INDEX IF NOT EXISTS post_shares_recipient_idx ON post_shares (shared_with_public_pi, accessed_at, shared_at);

-- A post on a remote gateway shared with a pair here — resolved live from the origin.
CREATE TABLE IF NOT EXISTS remote_shares (
  post_id               UUID        NOT NULL,
  origin_gateway_mcp    TEXT        NOT NULL,
  shared_with_public_pi TEXT        NOT NULL,
  from_public_pi        TEXT,
  name                  TEXT,
  content_type          TEXT        NOT NULL DEFAULT 'json',
  shared_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accessed_at           TIMESTAMPTZ,
  PRIMARY KEY (post_id, shared_with_public_pi)
);

CREATE INDEX IF NOT EXISTS remote_shares_recipient_idx ON remote_shares (shared_with_public_pi, accessed_at, shared_at);

-- Cross-instance reply threading: maps a local reply post to the remote post it answers.
CREATE TABLE IF NOT EXISTS remote_reply_refs (
  post_id            UUID        PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  target_post_id     UUID        NOT NULL,
  target_gateway_mcp TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
