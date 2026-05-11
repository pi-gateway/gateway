-- π Gateway v1.1.0 — naming convention migration
-- Project: faivankvxgushzasqgxu
-- Run in Supabase SQL editor before deploying v1.1.0

-- mcp_sessions: pid → public_pi
ALTER TABLE mcp_sessions RENAME COLUMN pid TO public_pi;

-- inboxes: to_pid / from_pid → to_public_pi / from_public_pi
ALTER TABLE inboxes RENAME COLUMN to_pid   TO to_public_pi;
ALTER TABLE inboxes RENAME COLUMN from_pid TO from_public_pi;
