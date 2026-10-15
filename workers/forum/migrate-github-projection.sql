-- GitHub Discussions projection (RFC #13141, Stage 1). Apply after schema.sql:
--   wrangler d1 execute reasonix-forum --remote --file=migrate-github-projection.sql
-- Rows with source = 'github' are mirrors: the webhook owns their text, the forum's
-- own write routes treat them as read-only, moderation (hide, flags, reactions) still applies.

ALTER TABLE topics ADD COLUMN source TEXT NOT NULL DEFAULT 'forum';        -- forum · github
ALTER TABLE topics ADD COLUMN gh_node_id TEXT;
ALTER TABLE topics ADD COLUMN gh_number INTEGER;
ALTER TABLE topics ADD COLUMN gh_updated_at TEXT;
ALTER TABLE topics ADD COLUMN gh_deleted_at TEXT;                          -- tombstone; never cleared
ALTER TABLE topics ADD COLUMN gh_status TEXT;                              -- recorded · in_progress · fixed
ALTER TABLE topics ADD COLUMN fixed_in TEXT;
-- SQLite cannot add a UNIQUE column, so uniqueness is a partial index.
CREATE UNIQUE INDEX IF NOT EXISTS topics_gh_node ON topics (gh_node_id) WHERE gh_node_id IS NOT NULL;

ALTER TABLE posts ADD COLUMN source TEXT NOT NULL DEFAULT 'forum';
ALTER TABLE posts ADD COLUMN gh_node_id TEXT;
ALTER TABLE posts ADD COLUMN gh_id INTEGER;                                -- numeric id, what a reply's parent_id names
ALTER TABLE posts ADD COLUMN gh_parent_id INTEGER;                         -- threading: the numeric id of the comment replied to
ALTER TABLE posts ADD COLUMN gh_updated_at TEXT;
ALTER TABLE posts ADD COLUMN gh_deleted_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS posts_gh_node ON posts (gh_node_id) WHERE gh_node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS posts_gh_id ON posts (gh_id) WHERE gh_id IS NOT NULL;

-- Every accepted delivery, kept to answer a redelivery with no work.
CREATE TABLE IF NOT EXISTS gh_deliveries (
  delivery_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

-- A comment that arrived before its discussion, applied when the discussion does.
CREATE TABLE IF NOT EXISTS gh_orphans (
  comment_node_id    TEXT PRIMARY KEY,
  discussion_node_id TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  payload            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gh_orphans_discussion ON gh_orphans (discussion_node_id);
CREATE INDEX IF NOT EXISTS gh_orphans_updated ON gh_orphans (updated_at);
CREATE INDEX IF NOT EXISTS gh_deliveries_received ON gh_deliveries (received_at);

-- Which forum category a GitHub discussion category lands in. A category with no
-- row here is dropped and logged, never defaulted.
CREATE TABLE IF NOT EXISTS gh_category_map (
  gh_slug    TEXT PRIMARY KEY,
  forum_slug TEXT NOT NULL
);
