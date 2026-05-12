-- π Gateway v1.2.2 migration
-- Adds received_at to inboxes for TTL-based expiry (replaces delete-on-read).
-- Messages marked as received are auto-deleted 1hr later by the receive tool.
-- Messages never read expire after 1 year.

ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
