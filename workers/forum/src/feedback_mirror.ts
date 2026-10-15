// The in-app feedback that is already public as a GitHub issue, shown as read-only
// forum threads. It reads the feedback worker's public feed (which decides what is
// public) and writes only forum rows; it never writes to the feed or to GitHub. A thread
// is withdrawn only when a scan that finished without error no longer lists it.
import { tombstoneTopic } from "./github_hook";
import type { Stmt } from "./github_hook";

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
const MAX_BODY_CHARS = 20_000;
const STATUSES = new Set(["recorded", "in_progress", "fixed", "wontfix", "duplicate"]);
const STAMP = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/;
const ISSUE_URL = /^https:\/\/github\.com\/esengine\/DeepSeek-Reasonix\/issues\/\d+$/;
const RELEASE = /^v?\d+\.\d+\.\d+$/;
// A scan that would withdraw more than this many threads, or this share of them, is
// refused: an empty or filtered feed must not erase the board.
const MASS_WITHDRAWAL_CAP = 10;
const MASS_WITHDRAWAL_SHARE = 0.2;
const AUTHOR_KEY = "feedback:studio";
const AUTHOR_HANDLE = "Studio feedback";

export interface FeedbackMirrorOptions {
  db: D1Database;
  url: string;
  token: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

export interface FeedbackMirrorReport {
  requests: number;
  items: number;
  unchanged: number;
  tombstoned: number;
  stopped?: string;
}

interface FeedItem {
  issue?: unknown; url?: unknown; title?: unknown; body?: unknown; status?: unknown; version?: unknown;
  createdAt?: unknown; updatedAt?: unknown; images?: unknown;
}

class Stop extends Error {}

const nodeOf = (issue: number) => `issue:${issue}`;
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "topic";

function imagesOf(value: unknown, host: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((u): u is string => {
    if (typeof u !== "string") return false;
    try {
      const url = new URL(u);
      return url.protocol === "https:" && url.host === host && url.pathname.startsWith("/v1/feedback/attachments/");
    } catch {
      return false;
    }
  });
}

function bodyOf(item: FeedItem, host: string): string {
  const text = String(item.body ?? "");
  const clipped = text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) + "\n\n[truncated]" : text;
  const shots = imagesOf(item.images, host).map((u) => `![screenshot](${u})`).join("\n");
  const link = typeof item.url === "string" && ISSUE_URL.test(item.url) ? `\n\n— Tracked in ${item.url}` : "";
  return clipped + (shots ? `\n\n${shots}` : "") + link;
}

export async function pullFeedback(o: FeedbackMirrorOptions): Promise<FeedbackMirrorReport> {
  const now = (o.now ?? (() => new Date()))().toISOString();
  const fetchFn = o.fetchFn ?? fetch;
  const host = new URL(o.url).host;
  const report: FeedbackMirrorReport = { requests: 0, items: 0, unchanged: 0, tombstoned: 0 };
  const seen = new Set<number>();
  try {
    const category = await o.db.prepare("SELECT id FROM categories WHERE slug = 'feedback'").first<{ id: number }>();
    if (!category) throw new Stop("no feedback category");
    // What each thread already holds: a row whose feed timestamp is unchanged is not rewritten.
    const held = new Map<string, string | null>();
    const stored = await o.db.prepare("SELECT gh_node_id AS node, gh_updated_at AS at FROM topics WHERE source = 'feedback' AND gh_deleted_at IS NULL").all<{ node: string; at: string | null }>();
    for (const r of stored.results ?? []) held.set(r.node, r.at);
    let after: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new Stop("page cap");
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (after) query.set("after", after);
      report.requests++;
      const res = await fetchFn(`${o.url}?${query}`, { redirect: "manual", headers: { authorization: `Bearer ${o.token}`, accept: "application/json", "user-agent": "reasonix-forum" } });
      if (!res.ok) throw new Stop(`feed ${res.status}`);
      const data = (await res.json()) as { items?: FeedItem[]; next?: string | null };
      if (!Array.isArray(data.items) || (data.next !== null && typeof data.next !== "string")) throw new Stop("unexpected answer");
      const statements: Stmt[] = [];
      for (const item of data.items) {
        if (!Number.isInteger(item.issue) || (item.issue as number) < 1) continue;
        const issue = item.issue as number;
        seen.add(issue);
        const title = typeof item.title === "string" ? item.title.trim() : "";
        if (!title || !STATUSES.has(item.status as string) || !STAMP.test(String(item.createdAt)) || !STAMP.test(String(item.updatedAt))) continue;
        if (held.get(nodeOf(issue)) === String(item.updatedAt)) {
          report.unchanged++;
          continue;
        }
        statements.push(...plan(o.db, category.id, issue, item, title, host, now));
        report.items++;
      }
      for (let i = 0; i < statements.length; i += 50) await o.db.batch(statements.slice(i, i + 50));
      if (data.next === null) break;
      after = data.next;
    }
    // The scan finished: a stored thread the feed no longer lists has been withdrawn,
    // unless that would be a mass withdrawal, which says the feed is wrong, not the threads.
    const gone = [...held.keys()].filter((n) => !seen.has(Number(n.slice("issue:".length))));
    const allowed = Math.max(1, Math.min(MASS_WITHDRAWAL_CAP, Math.floor(held.size * MASS_WITHDRAWAL_SHARE)));
    if (gone.length > allowed) throw new Stop("refusing mass withdrawal");
    const statements = gone.flatMap((node) => tombstoneTopic(o.db, node, now, now));
    for (let i = 0; i < statements.length; i += 50) await o.db.batch(statements.slice(i, i + 50));
    report.tombstoned = gone.length;
  } catch (e) {
    report.stopped = e instanceof Stop ? e.message : e instanceof Error ? e.message : "failed";
  }
  return report;
}

function plan(db: D1Database, categoryId: number, issue: number, item: FeedItem, title: string, host: string, now: string): Stmt[] {
  const status = item.status as string;
  const node = nodeOf(issue);
  const created = String(item.createdAt);
  const updated = String(item.updatedAt);
  const topicStatus = status === "fixed" ? "solved" : status === "wontfix" || status === "duplicate" ? "closed" : "open";
  const ghStatus = status === "fixed" || status === "recorded" || status === "in_progress" ? status : null;
  const version = status === "fixed" && typeof item.version === "string" && RELEASE.test(item.version) ? item.version : null;
  const clippedTitle = title.length > 160 ? title.slice(0, 160) : title;
  return [
    db.prepare("INSERT OR IGNORE INTO members (email, handle, trust, role, created_at) VALUES (?1, ?2, 0, 'member', ?3)").bind(AUTHOR_KEY, AUTHOR_HANDLE, now),
    db.prepare(
      `INSERT INTO topics (category_id, author, title, slug, status, created_at, last_post_at, source, gh_node_id, gh_number, gh_updated_at, gh_status, fixed_in)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 'feedback', ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(gh_node_id) WHERE gh_node_id IS NOT NULL DO UPDATE SET
         title = excluded.title, slug = excluded.slug,
         status = CASE WHEN topics.status = 'hidden' THEN 'hidden' ELSE excluded.status END,
         gh_updated_at = excluded.gh_updated_at, gh_status = excluded.gh_status, fixed_in = excluded.fixed_in
       WHERE topics.gh_deleted_at IS NULL AND excluded.gh_updated_at >= topics.gh_updated_at`,
    ).bind(categoryId, AUTHOR_KEY, clippedTitle, slugify(clippedTitle), topicStatus, created, node, issue, updated, ghStatus, version),
    db.prepare(
      `INSERT INTO posts (topic_id, author, body, created_at, edited_at, source, gh_node_id, gh_updated_at)
       VALUES ((SELECT id FROM topics WHERE gh_node_id = ?1), ?2, ?3, ?4, NULL, 'feedback', ?1, ?5)
       ON CONFLICT(gh_node_id) WHERE gh_node_id IS NOT NULL DO UPDATE SET
         body = excluded.body, edited_at = excluded.gh_updated_at, gh_updated_at = excluded.gh_updated_at
       WHERE posts.gh_deleted_at IS NULL AND excluded.gh_updated_at >= posts.gh_updated_at`,
    ).bind(node, AUTHOR_KEY, bodyOf(item, host), created, updated),
    db.prepare(
      `UPDATE topics SET last_post_at = ?2 WHERE gh_node_id = ?1 AND gh_deleted_at IS NULL`,
    ).bind(node, updated),
  ];
}
