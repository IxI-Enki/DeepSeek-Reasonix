// GitHub Discussions → forum projection (RFC #13141, Stage 1). The webhook only
// reads: it never posts anything back, so it cannot be turned into a way to make
// the bot speak. Correctness rests on the rows, not on the delivery ledger: every
// object is keyed by its node id and an event applies only if it is not older
// than what is stored, and a tombstone is never cleared.
import type { Context } from "hono";
import type { AppEnv } from "./env";

export const MAX_HOOK_BYTES = 256 * 1024;
const MAX_BODY_CHARS = 20_000;
export const DELIVERY_KEEP_MS = 30 * 86_400_000;
export const ORPHAN_KEEP_MS = 7 * 86_400_000;
const MAX_ORPHANS = 500;
const STATUS_LABEL = /^status:(recorded|in-progress|fixed)(?::(.+))?$/;
const DISCUSSION_ACTIONS = new Set(["created", "edited", "deleted", "labeled", "unlabeled", "closed", "reopened", "answered", "unanswered", "locked", "unlocked", "transferred", "category_changed"]);
const COMMENT_ACTIONS = new Set(["created", "edited", "deleted"]);
const STATUS_RANK: Record<string, number> = { recorded: 1, in_progress: 2, fixed: 3 };

export interface GhUser { login?: string; type?: string }
export interface GhDiscussion {
  node_id?: string; number?: number; title?: string; body?: string | null; user?: GhUser | null;
  category?: { slug?: string } | null; created_at?: string; updated_at?: string; state?: string;
  answer_chosen_at?: string | null; labels?: Array<{ name?: string }>;
}
export interface GhComment {
  node_id?: string; id?: number; parent_id?: number | null; body?: string | null; user?: GhUser | null;
  created_at?: string; updated_at?: string;
}
export interface Payload {
  action?: string; discussion?: GhDiscussion; comment?: GhComment;
  repository?: { id?: number; full_name?: string; private?: boolean };
  installation?: { id?: number };
}

export const NODE_ID = /^[A-Za-z0-9_=-]{1,128}$/;

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function validSignature(secret: string, raw: ArrayBuffer, header: string): Promise<boolean> {
  const match = /^sha256=([0-9a-f]{64})$/.exec(header);
  if (!match) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, raw));
  // Equal-length hex strings compared without an early exit.
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= expected.charCodeAt(i) ^ match[1]!.charCodeAt(i);
  return diff === 0;
}

// Reads at most `cap` bytes: a body with no Content-Length is cut off as it arrives
// rather than buffered whole and measured afterwards.
async function readCapped(req: Request, cap: number): Promise<ArrayBuffer | null> {
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

const clip = (s: string | null | undefined) => {
  const body = s ?? "";
  return body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + "\n\n[truncated]" : body;
};

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "topic";

// A GitHub login is not an email and not a forum handle: the key can never equal an
// email (no "@"), and the shown handle carries a suffix no account handle can hold
// (accounts allow only [a-z0-9_]).
const authorKey = (login: string) => `github:${login}`;
const authorHandle = (login: string) => `${login}@github`;

function statusFrom(d: GhDiscussion): { ghStatus: string | null; fixedIn: string | null } {
  let best: { status: string; version: string | null } | null = null;
  for (const label of d.labels ?? []) {
    const m = STATUS_LABEL.exec(label.name ?? "");
    if (!m) continue;
    const status = m[1]!.replace("-", "_");
    if (!best || STATUS_RANK[status]! > STATUS_RANK[best.status]!) best = { status, version: m[2] ?? null };
  }
  return { ghStatus: best?.status ?? null, fixedIn: best?.status === "fixed" ? best.version : null };
}

const topicStatus = (d: GhDiscussion) => (d.state === "closed" ? "closed" : d.answer_chosen_at ? "solved" : "open");

export type Stmt = D1PreparedStatement;
const ok = (c: Context<AppEnv>, status: 200 | 202, note: string) => c.body(note, status);

export async function receiveGithubHook(c: Context<AppEnv>): Promise<Response> {
  const env = c.env;
  if (!env.GITHUB_WEBHOOK_SECRET) return c.notFound();

  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_HOOK_BYTES) return c.body(null, 413);
  const raw = await readCapped(c.req.raw, MAX_HOOK_BYTES);
  if (!raw) return c.body(null, 413);

  const header = c.req.header("x-hub-signature-256") ?? "";
  const secrets = [env.GITHUB_WEBHOOK_SECRET, env.GITHUB_WEBHOOK_SECRET_PREVIOUS].filter((s): s is string => !!s);
  let signed = false;
  for (const secret of secrets) signed = (await validSignature(secret, raw, header)) || signed;
  if (!signed) return c.body(null, 401);

  let payload: Payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as Payload;
  } catch {
    return c.body(null, 400);
  }
  const repo = payload.repository;
  if (!repo || repo.private !== false || String(repo.id) !== env.GITHUB_REPO_ID || repo.full_name !== env.GITHUB_REPO) return ok(c, 202, "ignored");
  if (payload.installation?.id !== undefined && env.GITHUB_INSTALLATION_ID && String(payload.installation.id) !== env.GITHUB_INSTALLATION_ID) return ok(c, 202, "ignored");

  const event = c.req.header("x-github-event") ?? "";
  if (event === "ping") return ok(c, 200, "pong");
  if (event !== "discussion" && event !== "discussion_comment") return ok(c, 200, "ignored");

  // A new GitHub action must not become a failure loop: unknown ones are accepted and dropped.
  if (!(event === "discussion" ? DISCUSSION_ACTIONS : COMMENT_ACTIONS).has(payload.action ?? "")) return ok(c, 200, "ignored");

  const delivery = c.req.header("x-github-delivery") ?? "";
  if (!delivery) return c.body(null, 400);
  const seen = await env.DB.prepare("SELECT 1 AS x FROM gh_deliveries WHERE delivery_id = ?1").bind(delivery).first();
  if (seen) return ok(c, 200, "duplicate");

  const now = new Date().toISOString();
  const nodes = [payload.discussion?.node_id, payload.comment?.node_id].filter((n): n is string => n !== undefined);
  if (nodes.some((n) => !NODE_ID.test(n))) return ok(c, 202, "ignored");

  const statements = [
    env.DB.prepare("INSERT INTO gh_deliveries (delivery_id, received_at) VALUES (?1, ?2)").bind(delivery, now),
    env.DB.prepare("DELETE FROM gh_deliveries WHERE received_at < ?1").bind(new Date(Date.parse(now) - DELIVERY_KEEP_MS).toISOString()),
    env.DB.prepare("DELETE FROM gh_orphans WHERE updated_at < ?1").bind(new Date(Date.parse(now) - ORPHAN_KEEP_MS).toISOString()),
  ];
  statements.push(...(event === "discussion" ? await planDiscussion(env.DB, payload, now) : await planComment(env.DB, payload, now)));
  await env.DB.batch(statements);
  return ok(c, 200, "applied");
}

async function topicIdOf(db: D1Database, node: string): Promise<{ id: number; deleted: boolean } | null> {
  const row = await db.prepare("SELECT id, gh_deleted_at AS d FROM topics WHERE gh_node_id = ?1").bind(node).first<{ id: number; d: string | null }>();
  return row ? { id: row.id, deleted: row.d !== null } : null;
}

function memberStatement(db: D1Database, user: GhUser | null | undefined, at: string): Stmt {
  const login = user?.login || "ghost";
  return db.prepare("INSERT OR IGNORE INTO members (email, handle, trust, role, created_at) VALUES (?1, ?2, 0, 'member', ?3)")
    .bind(authorKey(login), authorHandle(login), at);
}

const recount = (db: D1Database, topicSql: string, ...bind: unknown[]): Stmt =>
  db.prepare(
    `UPDATE topics SET
       reply_count = MAX(0, (SELECT COUNT(*) FROM posts p WHERE p.topic_id = topics.id AND p.status = 'visible') - 1),
       last_post_at = COALESCE((SELECT MAX(p.created_at) FROM posts p WHERE p.topic_id = topics.id AND p.status = 'visible'), topics.created_at)
     WHERE id = (${topicSql})`,
  ).bind(...bind);

export async function planDiscussion(db: D1Database, payload: Payload, now: string): Promise<Stmt[]> {
  const d = payload.discussion;
  const node = d?.node_id;
  if (!d || !node) return [];
  const updated = d.updated_at ?? now;
  const category = await db.prepare("SELECT c.id AS id FROM gh_category_map m JOIN categories c ON c.slug = m.forum_slug WHERE m.gh_slug = ?1")
    .bind(d.category?.slug ?? "").first<{ id: number }>();
  const existing = await topicIdOf(db, node);
  const gone = payload.action === "deleted" || payload.action === "transferred";

  if (!category) {
    // Outside the board's categories: whatever we hold stops showing, and an
    // unmapped category is said out loud rather than defaulted.
    const out: Stmt[] = [];
    if (existing) out.push(...tombstoneTopic(db, node, updated, now));
    else if (!gone) {
      out.push(db.prepare(
        `INSERT INTO mod_log (at, actor, action, target, detail)
         SELECT ?1, 'github-hook', 'gh_unmapped_category', ?2, ?3
         WHERE NOT EXISTS (SELECT 1 FROM mod_log WHERE action = 'gh_unmapped_category' AND target = ?2)`,
      ).bind(now, node, d.category?.slug ?? ""));
    }
    return out;
  }

  if (gone) return [...(existing ? [] : insertTopic(db, d, category.id, now, "hidden")), ...tombstoneTopic(db, node, updated, now)];

  const { ghStatus, fixedIn } = statusFrom(d);
  const created = d.created_at ?? now;
  const title = (d.title ?? "").trim() || "(untitled)";
  const out: Stmt[] = [memberStatement(db, d.user, created)];
  out.push(
    db.prepare(
      `INSERT INTO topics (category_id, author, title, slug, status, created_at, last_post_at, source, gh_node_id, gh_number, gh_updated_at, gh_status, fixed_in)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 'github', ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(gh_node_id) WHERE gh_node_id IS NOT NULL DO UPDATE SET
         category_id = excluded.category_id, title = excluded.title, slug = excluded.slug,
         status = CASE WHEN topics.status = 'hidden' THEN 'hidden' ELSE excluded.status END,
         gh_number = excluded.gh_number, gh_updated_at = excluded.gh_updated_at,
         gh_status = excluded.gh_status, fixed_in = excluded.fixed_in
       WHERE topics.gh_deleted_at IS NULL AND excluded.gh_updated_at >= topics.gh_updated_at`,
    ).bind(category.id, authorKey(d.user?.login || "ghost"), title, slugify(title), topicStatus(d), created, node, d.number ?? null, updated, ghStatus, fixedIn),
    db.prepare(
      `INSERT INTO posts (topic_id, author, body, created_at, edited_at, source, gh_node_id, gh_updated_at)
       VALUES ((SELECT id FROM topics WHERE gh_node_id = ?1), ?2, ?3, ?4, NULL, 'github', ?1, ?5)
       ON CONFLICT(gh_node_id) WHERE gh_node_id IS NOT NULL DO UPDATE SET
         body = excluded.body, edited_at = excluded.gh_updated_at, gh_updated_at = excluded.gh_updated_at
       WHERE posts.gh_deleted_at IS NULL AND excluded.gh_updated_at >= posts.gh_updated_at`,
    ).bind(node, authorKey(d.user?.login || "ghost"), clip(d.body), created, updated),
  );
  // A comment that arrived first is applied now that its discussion exists.
  const waiting = await db.prepare("SELECT payload FROM gh_orphans WHERE discussion_node_id = ?1").bind(node).all<{ payload: string }>();
  for (const row of waiting.results ?? []) {
    out.push(...commentStatements(db, JSON.parse(row.payload) as Payload, now, node));
  }
  out.push(db.prepare("DELETE FROM gh_orphans WHERE discussion_node_id = ?1").bind(node));
  out.push(recount(db, "SELECT id FROM topics WHERE gh_node_id = ?1", node));
  return out;
}

function insertTopic(db: D1Database, d: GhDiscussion, categoryId: number, now: string, status: string): Stmt[] {
  const node = d.node_id!;
  const title = (d.title ?? "").trim() || "(untitled)";
  return [
    db.prepare(
      `INSERT OR IGNORE INTO topics (category_id, author, title, slug, status, created_at, last_post_at, source, gh_node_id, gh_number, gh_updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 'github', ?7, ?8, ?9)`,
    ).bind(categoryId, authorKey(d.user?.login || "ghost"), title, slugify(title), status, d.created_at ?? now, node, d.number ?? null, d.updated_at ?? now),
  ];
}

// The text and title are blanked: an erasure and a takedown leave nothing to read
// even before the row is next touched.
export function tombstoneTopic(db: D1Database, node: string, updated: string, now: string): Stmt[] {
  return [
    db.prepare("UPDATE topics SET status = 'hidden', title = '[removed]', slug = 'removed', gh_deleted_at = COALESCE(gh_deleted_at, ?2), gh_updated_at = MAX(COALESCE(gh_updated_at, ''), ?3) WHERE gh_node_id = ?1")
      .bind(node, now, updated),
    db.prepare("UPDATE posts SET status = 'deleted', body = '', gh_deleted_at = COALESCE(gh_deleted_at, ?2) WHERE topic_id = (SELECT id FROM topics WHERE gh_node_id = ?1)")
      .bind(node, now),
  ];
}

export async function planComment(db: D1Database, payload: Payload, now: string): Promise<Stmt[]> {
  const cm = payload.comment;
  const node = payload.discussion?.node_id;
  if (!cm?.node_id || !node) return [];
  const topic = await topicIdOf(db, node);
  if (!topic) {
    // Kept only for a discussion that could still arrive: one in a mapped category.
    // Only what replay needs is stored, and the table is bounded in count and age.
    const mapped = await db.prepare("SELECT 1 AS x FROM gh_category_map WHERE gh_slug = ?1").bind(payload.discussion?.category?.slug ?? "").first();
    if (!mapped) return [];
    const kept = JSON.stringify({
      action: payload.action,
      comment: { node_id: cm.node_id, id: cm.id, parent_id: cm.parent_id, body: clip(cm.body), user: { login: cm.user?.login, type: cm.user?.type }, created_at: cm.created_at, updated_at: cm.updated_at },
    });
    return [db.prepare(
      `INSERT INTO gh_orphans (comment_node_id, discussion_node_id, updated_at, payload)
       SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COUNT(*) FROM gh_orphans) < ?5
          OR EXISTS (SELECT 1 FROM gh_orphans WHERE comment_node_id = ?1)
       ON CONFLICT(comment_node_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
       WHERE excluded.updated_at >= gh_orphans.updated_at`,
    ).bind(cm.node_id, node, cm.updated_at ?? now, kept, MAX_ORPHANS)];
  }
  if (topic.deleted) return [];
  return commentStatements(db, payload, now, node);
}

// The topic is always reached through its node id as a bound parameter (?8).
function commentStatements(db: D1Database, payload: Payload, now: string, discussionNode: string): Stmt[] {
  const cm = payload.comment!;
  const created = cm.created_at ?? now;
  const updated = cm.updated_at ?? created;
  const author = authorKey(cm.user?.login || "ghost");
  const topicSql = "(SELECT id FROM topics WHERE gh_node_id = ?8)";
  const out: Stmt[] = [];
  if (payload.action === "deleted") {
    out.push(db.prepare(
      `INSERT INTO posts (topic_id, author, body, status, created_at, source, gh_node_id, gh_id, gh_updated_at, gh_deleted_at)
       VALUES (${topicSql}, ?1, '', 'deleted', ?2, 'github', ?3, ?4, ?5, ?6)
       ON CONFLICT(gh_node_id) WHERE gh_node_id IS NOT NULL DO UPDATE SET
         status = 'deleted', body = '', gh_deleted_at = COALESCE(posts.gh_deleted_at, excluded.gh_deleted_at),
         gh_updated_at = MAX(COALESCE(posts.gh_updated_at, ''), excluded.gh_updated_at)`,
    ).bind(author, created, cm.node_id, cm.id ?? null, updated, now, null, discussionNode));
  } else {
    out.push(memberStatement(db, cm.user, created));
    out.push(db.prepare(
      `INSERT INTO posts (topic_id, author, body, created_at, edited_at, source, gh_node_id, gh_id, gh_parent_id, gh_updated_at)
       VALUES (${topicSql}, ?1, ?2, ?3, NULL, 'github', ?4, ?5, ?6, ?7)
       ON CONFLICT(gh_node_id) WHERE gh_node_id IS NOT NULL DO UPDATE SET
         body = excluded.body, edited_at = excluded.gh_updated_at, gh_updated_at = excluded.gh_updated_at, gh_parent_id = excluded.gh_parent_id
       WHERE posts.gh_deleted_at IS NULL AND excluded.gh_updated_at >= posts.gh_updated_at`,
    ).bind(author, clip(cm.body), created, cm.node_id, cm.id ?? null, cm.parent_id ?? null, updated, discussionNode));
  }
  out.push(recount(db, "SELECT id FROM topics WHERE gh_node_id = ?1", discussionNode));
  return out;
}
