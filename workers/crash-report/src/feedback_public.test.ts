// @ts-expect-error Node 22+ provides node:sqlite; Worker production code does not import it.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "./env";
import { d1 } from "./feedback_testkit";
import { handleFeedbackRoute } from "./feedback_routes";
import feedbackMigrationSQL from "../migrate-feedback.sql?raw";
import triageMigrationSQL from "../migrate-feedback-triage.sql?raw";
import adoptionsMigrationSQL from "../migrate-feedback-adoptions.sql?raw";

const TOKEN = "public-feed-secret";
let raw: DatabaseSync;
let env: Env;
let seq = 0;

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  raw.exec(feedbackMigrationSQL);
  raw.exec(triageMigrationSQL);
  raw.exec(adoptionsMigrationSQL);
  env = { DB: d1(raw), FEEDBACK_ENABLED: "true", FEEDBACK_TOKEN_SECRET: "t", FEEDBACK_ADMIN_TOKEN: "admin", FEEDBACK_PUBLIC_TOKEN: TOKEN } as unknown as Env;
  seq = 0;
});

function row(over: Record<string, unknown> = {}) {
  seq++;
  const r = {
    receipt: `FB-${String(1000 + seq).padStart(4, "0")}-ABCD`, install_hash: "hash-secret", idempotency_key: `k${seq}`, category: "bug",
    body: "Add folder does nothing\nmore detail", display_name: "Private Name", contact: "private@example.com",
    env_json: '{"os":"windows"}', attachments_json: '[{"key":"secret-unreleased-key-1","name":"a.png","contentType":"image/png","size":1}]',
    status: "recorded", issue_number: 100 + seq, issue_url: `https://github.com/esengine/DeepSeek-Reasonix/issues/${100 + seq}`,
    resolved_version: null, duplicate_of: null, created_at: `2026-10-15T0${seq % 10}:00:00Z`, updated_at: `2026-10-15T0${seq % 10}:30:00Z`, ...over,
  };
  raw.prepare(`INSERT INTO feedback (${Object.keys(r).join(",")}) VALUES (${Object.keys(r).map(() => "?").join(",")})`).run(...Object.values(r));
  return r;
}

const get = (path = "", headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, method = "GET") =>
  handleFeedbackRoute(new Request(`https://crash.reasonix.io/v1/feedback/public${path}`, { method, headers }), env);

describe("the public feedback feed", () => {
  it("does not exist until its secret is set, and refuses any other bearer the same way", async () => {
    row();
    delete env.FEEDBACK_PUBLIC_TOKEN;
    expect((await get())!.status).toBe(404);
    env.FEEDBACK_PUBLIC_TOKEN = TOKEN;
    const bad: Record<string, string>[] = [{}, { authorization: "Bearer nope" }, { authorization: `Bearer ${TOKEN}x` }];
    for (const headers of bad) {
      const res = (await get("", headers))!;
      expect(res.status).toBe(401);
    }
    expect((await get("", { authorization: `Bearer ${TOKEN}` }, "POST"))!.status).toBe(405);
  });

  it("returns only converted reports in a public status, and only the fields their issue shows", async () => {
    const shown = row({ status: "fixed", resolved_version: "v2.41.0" });
    row({ status: "held" });
    row({ status: "rejected" });
    row({ status: "received" });
    row({ status: "needs_info" });
    row({ status: "answered" });
    row({ status: "recorded", issue_number: null, issue_url: null });
    const body = await (await get())!.json() as { items: Record<string, unknown>[]; next: string | null };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ issue: shown.issue_number, title: "Add folder does nothing", status: "fixed", version: "v2.41.0", category: "bug" });
    const text = JSON.stringify(body);
    for (const secret of [shown.receipt, "hash-secret", "Private Name", "private@example.com", "windows", "secret-unreleased-key-1", "install_hash", "receipt"]) {
      expect(text).not.toContain(secret);
    }
    expect(Object.keys(body.items[0]!).sort()).toEqual(["body", "category", "createdAt", "duplicateOf", "images", "issue", "status", "title", "updatedAt", "url", "version"]);
  });

  it("publishes an image only once a maintainer released it, and not after a takedown", async () => {
    const r = row();
    raw.prepare("INSERT INTO feedback_public_images (key, receipt, created_at) VALUES ('released-image-key-0001', ?, '2026-10-15T00:00:00Z')").run(r.receipt);
    let items = (await (await get())!.json() as { items: { images: string[] }[] }).items;
    expect(items[0]!.images).toEqual(["https://crash.reasonix.io/v1/feedback/attachments/released-image-key-0001"]);
    raw.prepare("DELETE FROM feedback_public_images WHERE receipt = ?").run(r.receipt);
    items = (await (await get())!.json() as { items: { images: string[] }[] }).items;
    expect(items[0]!.images).toEqual([]);
  });

  it("drops a version, duplicate or url that is not the shape it should be", async () => {
    row({ resolved_version: "<script>", duplicate_of: "evil", issue_url: "https://evil.example/x" });
    row({ status: "duplicate", resolved_version: "next", duplicate_of: "#321" });
    const { items } = await (await get())!.json() as { items: Record<string, unknown>[] };
    expect(items[0]).toMatchObject({ version: null, duplicateOf: null, url: null });
    expect(items[1]).toMatchObject({ version: "next", duplicateOf: "321", status: "duplicate" });
  });

  it("pages by a cursor the feed issued, stable under equal timestamps, and refuses any other", async () => {
    for (let i = 0; i < 5; i++) row({ updated_at: "2026-10-15T05:00:00Z" });
    const seen: number[] = [];
    let next: string | null = "";
    while (next !== null) {
      const res: Response = (await get(`?limit=2${next ? `&after=${encodeURIComponent(next)}` : ""}`))!;
      const page = await res.json() as { items: { issue: number }[]; next: string | null };
      seen.push(...page.items.map((i) => i.issue));
      next = page.next;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect((await get("?after=" + encodeURIComponent("x' OR 1=1 --")))!.status).toBe(400);
    expect((await get("?limit=0"))!.status).toBe(400);
    expect((await get("?limit=201"))!.status).toBe(400);
  });
});
