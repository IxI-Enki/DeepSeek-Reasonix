-- Which forum category each GitHub Discussions category lands in. Apply once after
-- migrate-github-projection.sql. A GitHub category with no row (General, Polls) is
-- dropped and logged in mod_log, never defaulted.
INSERT OR REPLACE INTO gh_category_map (gh_slug, forum_slug) VALUES
  ('announcements', 'announcements'),
  ('q-a', 'help'),
  ('show-and-tell', 'show'),
  ('ideas', 'feedback');
