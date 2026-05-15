-- π Gateway v1.3.0 — extended toolset schema
-- Project: faivankvxgushzasqgxu
-- Run in Supabase SQL editor before enabling extended tools at gateway layer

-- mcp_sessions: add extended tool columns
ALTER TABLE mcp_sessions
  ADD COLUMN IF NOT EXISTS incarnation TEXT,
  ADD COLUMN IF NOT EXISTS personality TEXT,
  ADD COLUMN IF NOT EXISTS role        TEXT NOT NULL DEFAULT 'member';

-- logs table — for log, plan, and boot session_start entries
CREATE TABLE IF NOT EXISTS logs (
  id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  from_public_pi TEXT        NOT NULL,
  scope          TEXT        NOT NULL, -- agent | operator | team | all | nickname
  to_recipients  TEXT[],               -- populated when scope = nickname
  type           TEXT        NOT NULL, -- milestone | decision | reflection | memory | scheduled_task | session_start
  content        TEXT        NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS logs_from_scope_idx ON logs (from_public_pi, scope);
CREATE INDEX IF NOT EXISTS logs_scope_created_idx ON logs (scope, created_at DESC);
CREATE INDEX IF NOT EXISTS logs_from_created_idx  ON logs (from_public_pi, created_at DESC);
