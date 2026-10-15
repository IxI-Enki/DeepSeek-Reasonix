// Reconciliation for the GitHub Discussions projection. The webhook keeps rows
// current while it is delivered to; this reads GitHub back and feeds what it finds
// through the same planners, so one set of rules (newer-wins, tombstones never
// cleared, mapped categories only) decides every row. It never writes to GitHub.
import { DELIVERY_KEEP_MS, NODE_ID, ORPHAN_KEEP_MS, planComment, planDiscussion, tombstoneTopic } from "./github_hook";
import type { GhComment, GhDiscussion, Payload, Stmt } from "./github_hook";
import type { TokenSource } from "./github_app";

const PAGE = 25;
const COMMENTS = 100;
const REPLIES = 50;
const EXTRA_COMMENT_PAGES = 3;
const DELETE_CHECK_CAP = 100;
const NODES_PER_QUERY = 50;
const BATCH = 50;

export interface ReconcileOptions {
  db: D1Database;
  owner: string;
  name: string;
  repoId: string;
  token: TokenSource;
  fetchFn?: typeof fetch;
  now?: () => Date;
  days?: number;
  maxRequests?: number;
}

export interface ReconcileReport {
  requests: number;
  discussions: number;
  comments: number;
  tombstoned: number;
  stopped?: string;
}

interface GqlAuthor { login?: string | null; __typename?: string }
interface GqlComment {
  id: string; databaseId?: number; body?: string; createdAt?: string; updatedAt?: string;
  author?: GqlAuthor | null; replyTo?: { databaseId?: number } | null; replies?: { pageInfo?: { hasNextPage?: boolean }; nodes?: GqlComment[] };
}
interface GqlError { type?: string; path?: Array<string | number> }
interface GqlDiscussion {
  id: string; number?: number; title?: string; body?: string; createdAt?: string; updatedAt?: string; closed?: boolean;
  answerChosenAt?: string | null; category?: { slug?: string } | null; author?: GqlAuthor | null;
  labels?: { nodes?: Array<{ name?: string }> }; comments?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: GqlComment[] };
}

const COMMENT_FIELDS = `id databaseId body createdAt updatedAt author { login __typename } replyTo { databaseId }`;
const DISCUSSIONS = `
query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    databaseId
    discussions(first: ${PAGE}, orderBy: { field: UPDATED_AT, direction: DESC }, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number title body createdAt updatedAt closed answerChosenAt category { slug } author { login __typename }
        labels(first: 20) { nodes { name } }
        comments(first: ${COMMENTS}) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} replies(first: ${REPLIES}) { pageInfo { hasNextPage } nodes { ${COMMENT_FIELDS} } } } }
      }
    }
  }
}`;
const MORE_COMMENTS = `
query($id: ID!, $after: String) {
  node(id: $id) { ... on Discussion { comments(first: ${COMMENTS}, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} replies(first: ${REPLIES}) { pageInfo { hasNextPage } nodes { ${COMMENT_FIELDS} } } } } } }
}`;
const EXISTS = `query($ids: [ID!]!) { nodes(ids: $ids) { __typename ... on Discussion { id } } }`;

class Stop extends Error {}

const user = (a: GqlAuthor | null | undefined) => ({ login: a?.login ?? undefined, type: a?.__typename });

function discussionOf(d: GqlDiscussion): GhDiscussion {
  return {
    node_id: d.id, number: d.number, title: d.title, body: d.body ?? "", user: user(d.author), category: d.category ?? null,
    created_at: d.createdAt, updated_at: d.updatedAt, state: d.closed ? "closed" : "open", answer_chosen_at: d.answerChosenAt ?? null,
    labels: (d.labels?.nodes ?? []).map((l) => ({ name: l.name })),
  };
}

function commentOf(c: GqlComment): GhComment {
  return { node_id: c.id, id: c.databaseId, parent_id: c.replyTo?.databaseId ?? null, body: c.body ?? "", user: user(c.author), created_at: c.createdAt, updated_at: c.updatedAt };
}

const flatten = (top: GqlComment[]) => top.flatMap((c) => [c, ...(c.replies?.nodes ?? [])]);

export async function reconcile(o: ReconcileOptions): Promise<ReconcileReport> {
  const now = (o.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - (o.days ?? 7) * 86_400_000).toISOString();
  const report: ReconcileReport = { requests: 0, discussions: 0, comments: 0, tombstoned: 0 };
  const fetchFn = o.fetchFn ?? fetch;
  const cap = o.maxRequests ?? 25;

  await o.db.batch([
    o.db.prepare("DELETE FROM gh_deliveries WHERE received_at < ?1").bind(new Date(now.getTime() - DELIVERY_KEEP_MS).toISOString()),
    o.db.prepare("DELETE FROM gh_orphans WHERE updated_at < ?1").bind(new Date(now.getTime() - ORPHAN_KEEP_MS).toISOString()),
  ]);

  let token: string | null = null;
  const gql = async <T>(query: string, variables: Record<string, unknown>, tolerate?: (e: GqlError) => boolean): Promise<{ data: T; errors: GqlError[] }> => {
    if (report.requests >= cap) throw new Stop("request cap");
    report.requests++;
    token ??= await o.token();
    const res = await fetchFn("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "reasonix-forum-bridge" },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 403 || res.status === 429) throw new Stop("rate limited");
    if (!res.ok) throw new Stop(`github ${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: GqlError[] };
    const errors = body.errors ?? [];
    if (errors.some((e) => e.type === "RATE_LIMITED")) throw new Stop("rate limited");
    // An error nobody expected is not evidence of anything: stop rather than write on it.
    if (errors.some((e) => !tolerate?.(e))) throw new Stop("graphql error");
    if (!body.data) throw new Stop("graphql error");
    return { data: body.data, errors };
  };
  const apply = async (statements: Stmt[]) => {
    for (let i = 0; i < statements.length; i += BATCH) await o.db.batch(statements.slice(i, i + BATCH));
  };

  try {
    let after: string | null = null;
    type Listing = { repository?: { databaseId?: number; discussions?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: GqlDiscussion[] } } };
    scan: for (;;) {
      const listed: { data: Listing; errors: GqlError[] } = await gql<Listing>(DISCUSSIONS, { owner: o.owner, name: o.name, after });
      const repo = listed.data.repository;
      if (String(repo?.databaseId) !== o.repoId) throw new Stop("repository id does not match");
      for (const d of repo?.discussions?.nodes ?? []) {
        if (!d.updatedAt || d.updatedAt < cutoff) break scan;
        if (!NODE_ID.test(d.id)) continue;
        await applyDiscussion(d);
      }
      const info = repo?.discussions?.pageInfo;
      if (!info?.hasNextPage || !info.endCursor) break;
      after = info.endCursor;
    }
    await detectDeleted();
  } catch (e) {
    if (e instanceof Stop) report.stopped = e.message;
    else report.stopped = e instanceof Error ? e.message : "failed";
  }
  return report;

  async function applyDiscussion(d: GqlDiscussion) {
    const discussion = discussionOf(d);
    await apply(await planDiscussion(o.db, { action: "edited", discussion }, nowIso));
    report.discussions++;
    const comments: GqlComment[] = [...(d.comments?.nodes ?? [])];
    let info = d.comments?.pageInfo;
    for (let extra = 0; info?.hasNextPage && info.endCursor && extra < EXTRA_COMMENT_PAGES; extra++) {
      const { data: more } = await gql<{ node?: { comments?: GqlDiscussion["comments"] } }>(MORE_COMMENTS, { id: d.id, after: info.endCursor });
      comments.push(...(more.node?.comments?.nodes ?? []));
      info = more.node?.comments?.pageInfo;
    }
    const all = flatten(comments).filter((c) => NODE_ID.test(c.id));
    const statements: Stmt[] = [];
    for (const c of all) {
      const payload: Payload = { action: "edited", discussion: { node_id: d.id, category: discussion.category }, comment: commentOf(c) };
      statements.push(...(await planComment(o.db, payload, nowIso)));
      report.comments++;
    }
    // Only a complete listing, comments and every comment's replies, can say a stored comment is gone.
    const complete = !info?.hasNextPage && !comments.some((c) => c.replies?.pageInfo?.hasNextPage);
    if (complete) statements.push(...(await goneComments(d.id, all.map((c) => c.id))));
    await apply(statements);
  }

  // A stored comment the complete listing no longer shows is gone. The ids are compared here
  // and removed in small groups: one statement may carry at most 100 bound parameters.
  async function goneComments(discussionNode: string, present: string[]): Promise<Stmt[]> {
    const kept = new Set(present);
    const stored = await o.db.prepare(
      `SELECT p.gh_node_id AS node FROM posts p JOIN topics t ON t.id = p.topic_id
        WHERE t.gh_node_id = ?1 AND p.source = 'github' AND p.gh_deleted_at IS NULL AND p.gh_node_id IS NOT NULL AND p.gh_node_id != ?1`,
    ).bind(discussionNode).all<{ node: string }>();
    const gone = (stored.results ?? []).map((r) => r.node).filter((n) => !kept.has(n));
    if (gone.length === 0) return [];
    const out: Stmt[] = [];
    for (let i = 0; i < gone.length; i += 50) {
      const chunk = gone.slice(i, i + 50);
      const marks = chunk.map((_, k) => `?${k + 2}`).join(", ");
      out.push(o.db.prepare(
        `UPDATE posts SET status = 'deleted', body = '', gh_deleted_at = COALESCE(gh_deleted_at, ?1) WHERE gh_deleted_at IS NULL AND gh_node_id IN (${marks})`,
      ).bind(nowIso, ...chunk));
    }
    out.push(o.db.prepare(
      `UPDATE topics SET
         reply_count = MAX(0, (SELECT COUNT(*) FROM posts p WHERE p.topic_id = topics.id AND p.status = 'visible') - 1),
         last_post_at = COALESCE((SELECT MAX(p.created_at) FROM posts p WHERE p.topic_id = topics.id AND p.status = 'visible'), topics.created_at)
       WHERE gh_node_id = ?1`,
    ).bind(discussionNode));
    return out;
  }

  // The listing cannot show a deletion, so the recent mirrored topics are asked for
  // by id: GitHub answers null for one that no longer exists.
  async function detectDeleted() {
    const rows = await o.db.prepare(
      "SELECT gh_node_id AS node FROM topics WHERE source = 'github' AND gh_deleted_at IS NULL AND gh_updated_at >= ?1 ORDER BY gh_updated_at DESC LIMIT ?2",
    ).bind(cutoff, DELETE_CHECK_CAP).all<{ node: string }>();
    const nodes = (rows.results ?? []).map((r) => r.node).filter((n) => NODE_ID.test(n));
    for (let i = 0; i < nodes.length; i += NODES_PER_QUERY) {
      const ids = nodes.slice(i, i + NODES_PER_QUERY);
      // A missing discussion is `null` at nodes[k] together with a NOT_FOUND error whose
      // path names that same k. A null without it (a partial failure) says nothing.
      const { data: found, errors } = await gql<{ nodes?: Array<{ id?: string } | null> }>(EXISTS, { ids }, (e) => e.type === "NOT_FOUND" && e.path?.[0] === "nodes" && typeof e.path[1] === "number");
      if (!Array.isArray(found.nodes) || found.nodes.length !== ids.length) throw new Stop("graphql error");
      const gone = new Set(errors.map((e) => e.path?.[1]));
      const statements: Stmt[] = [];
      ids.forEach((id, k) => {
        if (found.nodes![k] !== null || !gone.has(k)) return;
        statements.push(...tombstoneTopic(o.db, id, nowIso, nowIso));
        report.tombstoned++;
      });
      await apply(statements);
    }
  }
}
