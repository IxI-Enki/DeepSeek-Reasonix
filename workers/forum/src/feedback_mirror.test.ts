import { beforeEach, describe, expect, it } from "vitest";
import { memoryD1 } from "./testdb";
import schema from "../schema.sql?raw";
import seed from "../seed.sql?raw";
import migration from "../migrate-github-projection.sql?raw";
import app from "./index";
import type { Bindings } from "./env";
import { pullFeedback } from "./feedback_mirror";

const URL_FEED = "https://crash.reasonix.io/v1/feedback/public";
const NOW = new Date("2026-10-15T12:00:00Z");

let db: D1Database;
beforeEach(async () => {
  db = await memoryD1(schema, seed, migration);
});

const item = (over: Record<string, unknown> = {}) => ({
  issue: 13220, url: "https://github.com/esengine/DeepSeek-Reasonix/issues/13220", title: "Effort change is not saved", body: "Effort change is not saved\nthe config could not be read",
  category: "bug", status: "recorded", version: null, duplicateOf: null, createdAt: "2026-10-15T01:00:00.000Z", updatedAt: "2026-10-15T02:00:00.000Z",
  images: [], ...over,
});

// A feed answering the given pages in order, and recording what it was asked.
function feed(pages: Array<{ items: unknown[]; next: string | null } | number>) {
  const seen: Array<{ url: string; auth: string | null }> = [];
  let i = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    const page = pages[Math.min(i++, pages.length - 1)]!;
    if (typeof page === "number") return new Response("no", { status: page });
    return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, seen };
}

const run = (fetchFn: typeof fetch) => pullFeedback({ db, url: URL_FEED, token: "tok", fetchFn, now: () => NOW });

async function topics() {
  const env = { DB: db, APP_ORIGIN: "https://reasonix.io", ALLOWED_ORIGINS: "", ID_ORIGIN: "https://id.reasonix.io" } as Bindings;
  const res = await app.request("https://forum.reasonix.io/topics", {}, env);
  return ((await res.json()) as { topics: Array<Record<string, unknown>> }).topics;
}

describe("the feedback mirror", () => {
  it("shows an accepted report as a read-only thread in Feedback & Ideas, asking with the bearer", async () => {
    const { fetchFn, seen } = feed([{ items: [item({ images: ["https://crash.reasonix.io/v1/feedback/attachments/abc"] })], next: null }]);
    const report = await run(fetchFn);
    expect(report).toMatchObject({ requests: 1, items: 1, unchanged: 0, tombstoned: 0 });
    expect(seen[0]).toMatchObject({ auth: "Bearer tok" });
    const [t] = await topics();
    expect(t).toMatchObject({ title: "Effort change is not saved", category: "feedback", author: "Studio feedback", source: "feedback", ghNumber: 13220, ghStatus: "recorded" });
    const post = await db.prepare("SELECT body FROM posts WHERE source = 'feedback'").first<{ body: string }>();
    expect(post?.body).toContain("the config could not be read");
    expect(post?.body).toContain("![screenshot](https://crash.reasonix.io/v1/feedback/attachments/abc)");
    expect(post?.body).toContain("https://github.com/esengine/DeepSeek-Reasonix/issues/13220");
  });

  it("follows the ticket: fixed in a version, then closed as wontfix", async () => {
    await run(feed([{ items: [item({ status: "fixed", version: "v2.42.0", updatedAt: "2026-10-15T03:00:00.000Z" })], next: null }]).fetchFn);
    expect((await topics())[0]).toMatchObject({ status: "solved", ghStatus: "fixed", fixedIn: "v2.42.0" });
    await run(feed([{ items: [item({ status: "wontfix", updatedAt: "2026-10-15T04:00:00.000Z" })], next: null }]).fetchFn);
    expect((await topics())[0]).toMatchObject({ status: "closed", ghStatus: null, fixedIn: null });
  });

  it("does not show a version that is not a release", async () => {
    await run(feed([{ items: [item({ status: "fixed", version: "next" })], next: null }]).fetchFn);
    expect((await topics())[0]).toMatchObject({ ghStatus: "fixed", fixedIn: null });
  });

  it("ignores an older update and keeps a moderator's hide", async () => {
    await run(feed([{ items: [item({ updatedAt: "2026-10-15T05:00:00.000Z", title: "Newer title here" })], next: null }]).fetchFn);
    await run(feed([{ items: [item({ updatedAt: "2026-10-15T01:30:00.000Z", title: "Older title here" })], next: null }]).fetchFn);
    expect((await topics())[0]?.title).toBe("Newer title here");
    await db.prepare("UPDATE topics SET status = 'hidden'").run();
    await run(feed([{ items: [item({ updatedAt: "2026-10-15T06:00:00.000Z" })], next: null }]).fetchFn);
    expect(await topics()).toHaveLength(0);
  });

  it("withdraws a thread that is missing from a complete scan, and only then", async () => {
    await run(feed([{ items: [item(), item({ issue: 13221, title: "Second report here" })], next: null }]).fetchFn);
    expect(await topics()).toHaveLength(2);
    // The scan breaks off in the middle: nothing may be withdrawn on that evidence.
    const broken = await run(feed([{ items: [item()], next: "2026-10-15T02:00:00.000Z|1" }, 500]).fetchFn);
    expect(broken.stopped).toBeTruthy();
    expect(await topics()).toHaveLength(2);
    // A complete scan that no longer lists it withdraws it.
    const done = await run(feed([{ items: [item()], next: null }]).fetchFn);
    expect(done.tombstoned).toBe(1);
    expect((await topics()).map((t) => t.ghNumber)).toEqual([13220]);
  });

  it("never follows a redirect: a 3xx is no evidence, and the request says so in a form the edge runtime accepts", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init);
      return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
    }) as typeof fetch;
    const report = await run(fetchFn);
    expect(report.stopped).toBeTruthy();
    expect(seen[0]?.redirect).toBe("manual");
  });

  it("treats an unexpected answer as no evidence at all", async () => {
    await run(feed([{ items: [item()], next: null }]).fetchFn);
    for (const bad of [401, 404, 502]) expect((await run(feed([bad]).fetchFn)).stopped).toBeTruthy();
    const odd = await run((async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as typeof fetch);
    expect(odd.stopped).toBeTruthy();
    expect(await topics()).toHaveLength(1);
  });

  it("stores nothing but the fields the feed names, and drops images from other hosts", async () => {
    const hostile = item({ images: ["https://evil.example/x.png", "javascript:alert(1)", "https://crash.reasonix.io/v1/feedback/attachments/ok"], url: "https://evil.example/issues/1", receipt: "FB-AAAA-BBBB", displayName: "someone" });
    await run(feed([{ items: [hostile], next: null }]).fetchFn);
    const post = await db.prepare("SELECT body FROM posts WHERE source = 'feedback'").first<{ body: string }>();
    expect(post?.body).toContain("attachments/ok");
    expect(post?.body).not.toContain("evil.example");
    expect(post?.body).not.toContain("javascript:");
    expect(JSON.stringify(await db.prepare("SELECT * FROM topics").all())).not.toMatch(/FB-AAAA|someone/);
  });

  it("is read-only to the forum's own replies", async () => {
    await run(feed([{ items: [item()], next: null }]).fetchFn);
    const row = await db.prepare("SELECT source FROM topics").first<{ source: string }>();
    expect(row?.source).toBe("feedback");
  });

  it("refuses to withdraw a large share of the board because one scan came back thin", async () => {
    const many = Array.from({ length: 30 }, (_, i) => item({ issue: 14000 + i, title: `Report number ${i}` }));
    await run(feed([{ items: many, next: null }]).fetchFn);
    expect(await topics()).toHaveLength(30);
    const empty = await run(feed([{ items: [], next: null }]).fetchFn);
    expect(empty.stopped).toBe("refusing mass withdrawal");
    expect(await topics()).toHaveLength(30);
    const one = await run(feed([{ items: many.slice(1), next: null }]).fetchFn);
    expect(one.tombstoned).toBe(1);
    expect(await topics()).toHaveLength(29);
  });

  it("writes nothing when a second scan finds nothing new", async () => {
    const same = { items: [item(), item({ issue: 13221, title: "Second report here" })], next: null };
    await run(feed([same]).fetchFn);
    let batches = 0;
    const counting = { prepare: (q: string) => db.prepare(q), batch: (s: never) => { batches++; return db.batch(s); } } as unknown as D1Database;
    const report = await pullFeedback({ db: counting, url: URL_FEED, token: "tok", fetchFn: feed([same]).fetchFn, now: () => NOW });
    expect(report).toMatchObject({ items: 0, unchanged: 2, tombstoned: 0 });
    expect(batches).toBe(0);
  });

  it("pages through the feed with the cursor it was given", async () => {
    const { fetchFn, seen } = feed([
      { items: [item()], next: "2026-10-15T02:00:00.000Z|5" },
      { items: [item({ issue: 13221, title: "Second report here" })], next: null },
    ]);
    const report = await run(fetchFn);
    expect(report.requests).toBe(2);
    expect(seen[1]!.url).toContain("after=" + encodeURIComponent("2026-10-15T02:00:00.000Z|5"));
    expect(await topics()).toHaveLength(2);
  });
});
