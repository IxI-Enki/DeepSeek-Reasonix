import { beforeEach, describe, expect, it } from "vitest";
import { memoryD1 } from "./testdb";
import schema from "../schema.sql?raw";
import seed from "../seed.sql?raw";
import migration from "../migrate-github-projection.sql?raw";
import { reconcile } from "./github_reconcile";
import { appJwt, installationToken, toPkcs8 } from "./github_app";

const NOW = new Date("2026-10-15T12:00:00Z");
const T0 = "2026-10-15T01:00:00Z";
const T1 = "2026-10-15T02:00:00Z";
const T2 = "2026-10-15T03:00:00Z";

let db: D1Database;

beforeEach(async () => {
  db = await memoryD1(schema, seed, migration, "INSERT INTO gh_category_map (gh_slug, forum_slug) VALUES ('q-a', 'help')");
});

const author = (login: string) => ({ login, __typename: "User" });
function comment(over: Record<string, unknown> = {}) {
  return { id: "DC_1", databaseId: 101, body: "Same here on 2.41.", createdAt: T1, updatedAt: T1, author: author("bob"), replyTo: null, replies: { nodes: [] }, ...over };
}
function discussion(over: Record<string, unknown> = {}) {
  return {
    id: "D_1", number: 7, title: "Add folder fails", body: "It does nothing.", createdAt: T0, updatedAt: T1, closed: false, answerChosenAt: null,
    category: { slug: "q-a" }, author: author("Alice"), labels: { nodes: [] },
    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [comment()] }, ...over,
  };
}

type Listing = ReturnType<typeof discussion>[];
function github(state: { listing: Listing; missing?: string[]; status?: number; repoId?: number; calls?: string[]; nodes?: "absent" | "short" | "partial" }) {
  return (async (_url: string, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    state.calls?.push(query.includes("nodes(ids") ? "exists" : "listing");
    if (state.status) return new Response("{}", { status: state.status });
    if (query.includes("nodes(ids")) {
      const ids = variables.ids as string[];
      if (state.nodes === "absent") return Response.json({ data: {}, errors: [{ type: "INTERNAL" }] });
      if (state.nodes === "short") return Response.json({ data: { nodes: [] } });
      if (state.nodes === "partial") return Response.json({ data: { nodes: ids.map(() => null) }, errors: [{ type: "INTERNAL", path: ["nodes", 0] }] });
      const nodes = ids.map((id) => (state.missing?.includes(id) ? null : { __typename: "Discussion", id }));
      const errors = ids.flatMap((id, k) => (state.missing?.includes(id) ? [{ type: "NOT_FOUND", path: ["nodes", k] }] : []));
      return Response.json({ data: { nodes }, ...(errors.length ? { errors } : {}) });
    }
    return Response.json({ data: { repository: { databaseId: state.repoId ?? 42, discussions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: state.listing } } } });
  }) as unknown as typeof fetch;
}

const run = (fetchFn: typeof fetch, extra: Record<string, unknown> = {}) =>
  reconcile({ db, owner: "esengine", name: "DeepSeek-Reasonix", repoId: "42", token: async () => "tok", fetchFn, now: () => NOW, ...extra });

const topic = () => db.prepare("SELECT title, status, reply_count AS replies, gh_status AS ghStatus, fixed_in AS fixedIn FROM topics WHERE gh_node_id = 'D_1'").first<{ title: string; status: string; replies: number; ghStatus: string | null; fixedIn: string | null }>();
const posts = () => db.prepare("SELECT gh_node_id AS node, body, status FROM posts WHERE source = 'github' ORDER BY id").all<{ node: string; body: string; status: string }>().then((r) => r.results);
const n = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;

describe("reconcile", () => {
  it("brings in a discussion and its replies that no webhook delivered", async () => {
    const reply = comment({ id: "DC_2", databaseId: 102, body: "A reply", replyTo: { databaseId: 101 } });
    const listing = [discussion({ comments: { pageInfo: { hasNextPage: false }, nodes: [comment({ replies: { nodes: [reply] } })] } })];
    const report = await run(github({ listing }));
    expect(report).toMatchObject({ discussions: 1, comments: 2, tombstoned: 0 });
    expect(report.stopped).toBeUndefined();
    expect((await topic())?.replies).toBe(2);
    expect((await posts()).map((p) => p.node)).toEqual(["D_1", "DC_1", "DC_2"]);
    expect(await db.prepare("SELECT gh_parent_id AS p FROM posts WHERE gh_node_id = 'DC_2'").first<{ p: number }>()).toEqual({ p: 101 });
    expect(await n("SELECT COUNT(*) AS n FROM members WHERE email LIKE 'github:%'")).toBe(2);
  });

  it("takes a missed edit and the status label, and an older copy never overwrites a newer row", async () => {
    await run(github({ listing: [discussion({ updatedAt: T2, title: "Newer title", labels: { nodes: [{ name: "status:fixed:2.42.0" }] } })] }));
    expect(await topic()).toMatchObject({ title: "Newer title", ghStatus: "fixed", fixedIn: "2.42.0" });
    await run(github({ listing: [discussion({ updatedAt: T1, title: "Stale title" })] }));
    expect((await topic())?.title).toBe("Newer title");
  });

  it("marks a comment gone from a complete listing as deleted and recounts", async () => {
    const two = [comment(), comment({ id: "DC_2", databaseId: 102, body: "second" })];
    await run(github({ listing: [discussion({ comments: { pageInfo: { hasNextPage: false }, nodes: two } })] }));
    expect((await topic())?.replies).toBe(2);
    await run(github({ listing: [discussion({ updatedAt: T2, comments: { pageInfo: { hasNextPage: false }, nodes: [comment()] } })] }));
    expect((await posts()).find((p) => p.node === "DC_2")).toMatchObject({ status: "deleted", body: "" });
    expect((await topic())?.replies).toBe(1);
  });

  it("handles a discussion with more comments than one D1 statement can bind", async () => {
    const many = (count: number, skip = -1) => Array.from({ length: count }, (_, i) => i).filter((i) => i !== skip).map((i) => comment({ id: `DC_${i}`, databaseId: 1000 + i, body: `comment ${i}` }));
    await run(github({ listing: [discussion({ comments: { pageInfo: { hasNextPage: false }, nodes: many(130) } })] }));
    expect((await topic())?.replies).toBe(130);
    const report = await run(github({ listing: [discussion({ updatedAt: T2, comments: { pageInfo: { hasNextPage: false }, nodes: many(130, 7) } })] }));
    expect(report.stopped).toBeUndefined();
    expect((await posts()).filter((p) => p.status === "deleted").map((p) => p.node)).toEqual(["DC_7"]);
    expect((await topic())?.replies).toBe(129);
  });

  it("does not treat a partial comment listing as proof that a comment is gone", async () => {
    await run(github({ listing: [discussion({ comments: { pageInfo: { hasNextPage: false }, nodes: [comment(), comment({ id: "DC_2", databaseId: 102 })] } })] }));
    const partial = discussion({ updatedAt: T2, comments: { pageInfo: { hasNextPage: true, endCursor: "x" }, nodes: [comment()] } });
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (query.includes("nodes(ids")) return Response.json({ data: { nodes: [{ __typename: "Discussion", id: "D_1" }] } });
      if (query.includes("node(id")) return Response.json({ data: { node: { comments: { pageInfo: { hasNextPage: true, endCursor: "y" }, nodes: [] } } } });
      return Response.json({ data: { repository: { databaseId: 42, discussions: { pageInfo: { hasNextPage: false }, nodes: [partial] } } } });
    }) as unknown as typeof fetch;
    await run(fetchFn);
    expect((await posts()).find((p) => p.node === "DC_2")?.status).toBe("visible");
  });

  it("tombstones a discussion GitHub no longer has, and a later stale listing cannot bring it back", async () => {
    await run(github({ listing: [discussion()] }));
    const report = await run(github({ listing: [], missing: ["D_1"] }));
    expect(report.tombstoned).toBe(1);
    expect(await topic()).toMatchObject({ title: "[removed]", status: "hidden" });
    expect((await posts()).every((p) => p.status === "deleted" && p.body === "")).toBe(true);
    await run(github({ listing: [discussion({ updatedAt: T2 })] }));
    expect((await topic())?.title).toBe("[removed]");
  });

  it("never tombstones on a nodes answer that is missing, short, or null without a NOT_FOUND for that node", async () => {
    await run(github({ listing: [discussion()] }));
    for (const nodes of ["absent", "short", "partial"] as const) {
      const report = await run(github({ listing: [], nodes }));
      expect(report.tombstoned).toBe(0);
      expect(report.stopped).toBe("graphql error");
      expect((await topic())?.title).toBe("Add folder fails");
    }
  });

  it("tombstones only the node a NOT_FOUND names, in a batch with other live topics", async () => {
    const live = discussion({ id: "D_2", number: 8, title: "Another", comments: { pageInfo: { hasNextPage: false }, nodes: [] } });
    await run(github({ listing: [discussion(), live] }));
    const report = await run(github({ listing: [], missing: ["D_2"] }));
    expect(report.tombstoned).toBe(1);
    expect((await topic())?.title).toBe("Add folder fails");
    expect((await db.prepare("SELECT title FROM topics WHERE gh_node_id = 'D_2'").first<{ title: string }>())?.title).toBe("[removed]");
  });

  it("does not call a stored reply gone when a comment has more replies than were read", async () => {
    const replies = Array.from({ length: 51 }, (_, i) => comment({ id: `DR_${i}`, databaseId: 200 + i, body: `r${i}`, replyTo: { databaseId: 101 } }));
    await run(github({ listing: [discussion({ comments: { pageInfo: { hasNextPage: false }, nodes: [comment({ replies: { pageInfo: { hasNextPage: false }, nodes: replies } })] } })] }));
    expect(await n("SELECT COUNT(*) AS n FROM posts WHERE gh_node_id LIKE 'DR_%' AND status = 'visible'")).toBe(51);
    // Next read sees only the first 50 and says there are more: the 51st is not deleted.
    const first50 = replies.slice(0, 50);
    await run(github({ listing: [discussion({ updatedAt: T2, comments: { pageInfo: { hasNextPage: false }, nodes: [comment({ replies: { pageInfo: { hasNextPage: true }, nodes: first50 } })] } })] }));
    expect(await n("SELECT COUNT(*) AS n FROM posts WHERE gh_node_id LIKE 'DR_%' AND status = 'visible'")).toBe(51);
  });

  it("skips a category that is not mapped and says so once across runs", async () => {
    const general = discussion({ id: "D_9", category: { slug: "general" } });
    await run(github({ listing: [general] }));
    await run(github({ listing: [general] }));
    expect(await n("SELECT COUNT(*) AS n FROM topics WHERE gh_node_id = 'D_9'")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM mod_log WHERE action = 'gh_unmapped_category' AND target = 'D_9'")).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM gh_orphans")).toBe(0);
  });

  it("stops at the request cap with what it already applied intact", async () => {
    const calls: string[] = [];
    const report = await run(github({ listing: [discussion()], calls }), { maxRequests: 1 });
    expect(calls).toEqual(["listing"]);
    expect(report.stopped).toBe("request cap");
    expect((await topic())?.title).toBe("Add folder fails");
  });

  it("leaves the data untouched when GitHub refuses, and when the token cannot be minted", async () => {
    expect((await run(github({ listing: [discussion()], status: 403 }))).stopped).toBe("rate limited");
    expect((await run(github({ listing: [discussion()], status: 502 }))).stopped).toBe("github 502");
    const refused = await reconcile({ db, owner: "esengine", name: "r", repoId: "42", token: async () => { throw new Error("installation token refused (401)"); }, fetchFn: github({ listing: [discussion()] }), now: () => NOW });
    expect(refused.stopped).toContain("token refused");
    expect(await topic()).toBeNull();
  });

  it("refuses a repository that is not the configured one", async () => {
    const report = await run(github({ listing: [discussion()], repoId: 99 }));
    expect(report.stopped).toBe("repository id does not match");
    expect(await topic()).toBeNull();
  });

  it("prunes old deliveries and orphans on every run", async () => {
    await db.batch([
      db.prepare("INSERT INTO gh_deliveries (delivery_id, received_at) VALUES ('old', '2026-08-01T00:00:00Z'), ('new', '2026-10-14T00:00:00Z')"),
      db.prepare("INSERT INTO gh_orphans (comment_node_id, discussion_node_id, updated_at, payload) VALUES ('c-old', 'D_x', '2026-10-01T00:00:00Z', '{}'), ('c-new', 'D_y', '2026-10-14T00:00:00Z', '{}')"),
    ]);
    await run(github({ listing: [] }));
    expect((await db.prepare("SELECT delivery_id AS id FROM gh_deliveries").all<{ id: string }>()).results.map((r) => r.id)).toEqual(["new"]);
    expect((await db.prepare("SELECT comment_node_id AS id FROM gh_orphans").all<{ id: string }>()).results.map((r) => r.id)).toEqual(["c-new"]);
  });
});

describe("GitHub App token", () => {
  async function pkcs1Pem() {
    const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    // The PKCS#1 key is the OCTET STRING inside the PKCS#8 envelope (26-byte header for 2048-bit RSA).
    const pkcs1 = pkcs8.slice(26);
    const b64 = btoa(String.fromCharCode(...pkcs1)).replace(/(.{64})/g, "$1\n");
    return { pem: `-----BEGIN RSA PRIVATE KEY-----\n${b64}\n-----END RSA PRIVATE KEY-----`, pair };
  }

  it("wraps GitHub's PKCS#1 key so WebCrypto can sign with it", async () => {
    const { pem, pair } = await pkcs1Pem();
    const jwt = await appJwt("5326038", pem, 1_800_000_000);
    const [head, claims, sig] = jwt.split(".");
    expect(JSON.parse(atob(claims!.replace(/-/g, "+").replace(/_/g, "/")))).toMatchObject({ iss: "5326038", iat: 1_799_999_940, exp: 1_800_000_540 });
    const raw = Uint8Array.from(atob(sig!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, raw, new TextEncoder().encode(`${head}.${claims}`))).toBe(true);
    expect(toPkcs8(pem)[0]).toBe(0x30);
  });

  it("asks for read access to discussions in one repository and nothing else", async () => {
    const { pem } = await pkcs1Pem();
    let seen: { url: string; body: Record<string, unknown>; auth: string } | undefined;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen = { url, body: JSON.parse(String(init?.body)), auth: String((init?.headers as Record<string, string>).authorization) };
      return Response.json({ token: "ghs_x" }, { status: 201 });
    }) as unknown as typeof fetch;
    const token = await installationToken({ appId: "1", privateKey: pem, installationId: "171606831", repository: "DeepSeek-Reasonix" }, fetchFn)();
    expect(token).toBe("ghs_x");
    expect(seen?.url).toBe("https://api.github.com/app/installations/171606831/access_tokens");
    expect(seen?.body).toEqual({ repositories: ["DeepSeek-Reasonix"], permissions: { discussions: "read" } });
    expect(seen?.auth.startsWith("Bearer ")).toBe(true);
  });

  it("fails loudly, without a token, when GitHub refuses", async () => {
    const { pem } = await pkcs1Pem();
    const fetchFn = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(installationToken({ appId: "1", privateKey: pem, installationId: "9", repository: "r" }, fetchFn)()).rejects.toThrow("refused (401)");
  });
});
