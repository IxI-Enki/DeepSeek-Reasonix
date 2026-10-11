import { afterEach, describe, expect, it, vi } from "vitest";
import registryApp from "../app";
import type { Bindings } from "../env";
import { mirrorKey, skillContentDigest } from "../mirror";
import type { PackageRow } from "../types";

const FILE = new TextEncoder().encode("---\nname: x\n---\nhello\n");

const live: PackageRow = {
  id: 7, kind: "skill", scope_handle: "o", name: "x", slug: "o/x", summary: "", description: "",
  source: "https://github.com/o/r/blob/main/x/SKILL.md", install_kind: "skill", homepage: "", repo_url: "", tags: "",
  latest_version: "1.0", install_count: 0, star_count: 0, up_count: 0, down_count: 0, rec_score: 0, verified: 0,
  status: "active", publisher_id: 1, created_at: "2026-07-22T00:00:00.000Z", updated_at: "2026-07-22T00:30:00.000Z",
};

function database(row: PackageRow, pin: string) {
  const versions = [{ id: 1, version: "1.0", source: row.source, content_hash: pin, risk_level: "", created_at: "2026-07-22T00:00:00.000Z" }];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind: () => statement,
        async first() {
          return sql.startsWith("UPDATE packages SET status") || sql.startsWith("SELECT * FROM packages") ? row : null;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
        async all() {
          return { results: sql.includes("FROM package_versions") ? versions : [] };
        },
      };
      return statement;
    },
  };
  return db as unknown as D1Database;
}

function r2() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, value: Uint8Array) {
      objects.set(key, value);
    },
    async delete(keys: string | string[]) {
      for (const k of [keys].flat()) objects.delete(k);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

function env(db: D1Database, bucket: R2Bucket, enabled: boolean): Bindings {
  return {
    DB: db, ACCOUNTS_ORIGIN: "https://id.reasonix.test", APP_ORIGIN: "https://reasonix.test", ALLOWED_ORIGINS: "https://reasonix.test",
    MARKET_MIRROR: bucket, MARKET_MIRROR_ENABLED: enabled ? "true" : "false",
  };
}

function stubNetwork() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/me")) return Response.json({ user: { id: 1, handle: "admin", role: "admin", emailVerified: true } });
    if (String(url).startsWith("https://api.github.com/")) return Response.json({ license: { spdx_id: "MIT" } });
    if (String(url).startsWith("https://raw.githubusercontent.com/")) return new Response(FILE as BodyInit);
    return new Response("", { status: 404 });
  }));
}

function post(path: string, body: object = {}) {
  return new Request(`https://registry.reasonix.test/v1/admin/packages/o/x/${path}`, {
    method: "POST", headers: { cookie: "rxid=test", "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

function context() {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext, settled: () => Promise.all(pending) };
}

afterEach(() => vi.unstubAllGlobals());

describe("admin moderation and the market mirror", () => {
  it("mirrors a skill when it is approved with its pin, and a takedown removes it", async () => {
    stubNetwork();
    const pin = await skillContentDigest("x", FILE);
    const { bucket, objects } = r2();
    const e = env(database(live, pin), bucket, true);
    const first = context();
    const approved = await registryApp.fetch(post("approve", { expectedVersion: "1.0", expectedUpdatedAt: live.updated_at, expectedStatus: "pending", contentHash: pin }), e, first.ctx);
    expect(approved.status).toBe(200);
    await first.settled();
    expect([...objects.keys()]).toEqual([mirrorKey(pin)]);

    const second = context();
    expect((await registryApp.fetch(post("hide"), e, second.ctx)).status).toBe(200);
    await second.settled();
    expect(objects.size).toBe(0);
  });

  it("does nothing while the switch is off", async () => {
    stubNetwork();
    const pin = await skillContentDigest("x", FILE);
    const { bucket, objects } = r2();
    const c = context();
    const e = env(database(live, pin), bucket, false);
    const res = await registryApp.fetch(post("approve", { expectedVersion: "1.0", expectedUpdatedAt: live.updated_at, expectedStatus: "pending", contentHash: pin }), e, c.ctx);
    expect(res.status).toBe(200);
    await c.settled();
    expect(objects.size).toBe(0);
    expect((await registryApp.fetch(post("mirror"), e, c.ctx)).status).toBe(409);
  });

  it("answers the backfill route with what happened", async () => {
    stubNetwork();
    const pin = await skillContentDigest("x", FILE);
    const { bucket, objects } = r2();
    const res = await registryApp.fetch(post("mirror"), env(database(live, pin), bucket, true), context().ctx);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ slug: "o/x", outcome: { state: "stored" } });
    expect(objects.size).toBe(1);
  });
});
