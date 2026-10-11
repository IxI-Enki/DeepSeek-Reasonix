import { describe, expect, it } from "vitest";
import { FETCH_TIMEOUT_MS, MIRROR_CACHE_CONTROL, MIRROR_MAX_BYTES, mirrorKey, mirrorSkill, pruneMirrors, purgeEdge, rawSkillURL, skillContentDigest, type MirrorDeps } from "./mirror";

const FILE = new TextEncoder().encode("---\nname: x\n---\nhello\n");
const PIN = "sha256:c03df675d3fad822238724c1e75c992e63d80939c5a7d8a9dcea2033d017c0cc";
const pkg = { kind: "skill", install_kind: "skill", name: "x", slug: "o/x", source: "https://github.com/o/r/blob/main/x/SKILL.md" } as const;
const version = { version: "1.0", content_hash: PIN, source: pkg.source };

function bucket() {
  const objects = new Map<string, Uint8Array>();
  const meta = new Map<string, unknown>();
  const deleted: string[] = [];
  const api = {
    async put(key: string, value: Uint8Array, options: unknown) {
      objects.set(key, value);
      meta.set(key, options);
    },
    async head(key: string) {
      return objects.has(key) ? ({ key } as unknown as R2Object) : null;
    },
    async delete(keys: string | string[]) {
      for (const k of [keys].flat()) {
        deleted.push(k);
        objects.delete(k);
      }
    },
  };
  return { bucket: api as unknown as R2Bucket, objects, meta, deleted };
}

interface Over {
  license?: string | null;
  file?: Uint8Array | Response;
  live?: () => Promise<boolean>;
  elsewhere?: (hash: string) => Promise<boolean>;
  onFetch?: (url: string, init?: RequestInit) => void;
}

function deps(b: R2Bucket, over: Over = {}): MirrorDeps {
  const license = over.license === undefined ? "MIT" : over.license;
  return {
    bucket: b,
    stillLive: over.live ?? (async () => true),
    referencedElsewhere: over.elsewhere ?? (async () => false),
    fetch: (async (url: string, init?: RequestInit) => {
      over.onFetch?.(url, init);
      if (url.startsWith("https://api.github.com/repos/o/r/license")) {
        return license === null ? new Response("", { status: 404 }) : Response.json({ license: { spdx_id: license } });
      }
      if (url === "https://raw.githubusercontent.com/o/r/main/x/SKILL.md") {
        return over.file instanceof Response ? over.file : new Response((over.file ?? FILE) as BodyInit);
      }
      return new Response("", { status: 404 });
    }) as typeof fetch,
  };
}

describe("skill mirror", () => {
  it("reproduces the installer's pin from the name and the file", async () => {
    expect(await skillContentDigest("x", FILE)).toBe(PIN);
  });

  it("stores bytes that match the pin, keyed by the pin, from an OSI-licensed repository", async () => {
    const { bucket: b, objects, meta } = bucket();
    const out = await mirrorSkill(deps(b), pkg, version);
    expect(out).toEqual({ state: "stored", key: mirrorKey(PIN), license: "MIT" });
    expect(mirrorKey(PIN)).toBe("market/skills/c03df675d3fad822238724c1e75c992e63d80939c5a7d8a9dcea2033d017c0cc/SKILL.md");
    expect(objects.get(mirrorKey(PIN))).toEqual(FILE);
    expect(JSON.stringify(meta.get(mirrorKey(PIN)))).toContain('"license":"MIT"');
    expect(JSON.stringify(meta.get(mirrorKey(PIN)))).toContain(MIRROR_CACHE_CONTROL);
    expect(MIRROR_CACHE_CONTROL).not.toContain("immutable");
  });

  it("never stores bytes that differ from the reviewed pin", async () => {
    const { bucket: b, objects } = bucket();
    const out = await mirrorSkill(deps(b, { file: new TextEncoder().encode("tampered") }), pkg, version);
    expect(out).toEqual({ state: "skipped", reason: "digest_mismatch" });
    expect(objects.size).toBe(0);
  });

  it.each([
    ["no licence", null, "license_unknown"],
    ["a non-OSI licence", "CC-BY-NC-4.0", "license_not_osi"],
    ["a missing SPDX id", "NOASSERTION", "license_not_osi"],
  ])("does not mirror a repository with %s", async (_n, license, reason) => {
    const { bucket: b, objects } = bucket();
    expect(await mirrorSkill(deps(b, { license }), pkg, version)).toEqual({ state: "skipped", reason });
    expect(objects.size).toBe(0);
  });

  it("skips what is not a pinned single-file skill from GitHub", async () => {
    const { bucket: b } = bucket();
    const d = deps(b);
    expect(await mirrorSkill(d, { ...pkg, kind: "plugin" }, version)).toEqual({ state: "skipped", reason: "not_a_single_file_skill" });
    expect(await mirrorSkill(d, pkg, { ...version, content_hash: "" })).toEqual({ state: "skipped", reason: "not_pinned" });
    expect(await mirrorSkill(d, pkg, { ...version, source: "https://example.com/SKILL.md" })).toEqual({ state: "skipped", reason: "source_not_github" });
    expect(await mirrorSkill(deps(b, { file: new Response("", { status: 500 }) }), pkg, version)).toEqual({ state: "skipped", reason: "source_unreadable" });
  });

  it("refuses a file past the size cap", async () => {
    const { bucket: b, objects } = bucket();
    const big = new Response("x", { headers: { "content-length": String(MIRROR_MAX_BYTES + 1) } });
    expect(MIRROR_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(await mirrorSkill(deps(b, { file: big }), pkg, version)).toEqual({ state: "skipped", reason: "too_large" });
    expect(objects.size).toBe(0);
  });

  it("reads GitHub blob and raw links, and nothing else", () => {
    expect(rawSkillURL("https://github.com/o/r/blob/main/x/SKILL.md")?.toString()).toBe("https://raw.githubusercontent.com/o/r/main/x/SKILL.md");
    expect(rawSkillURL("https://github.com/o/r/raw/main/x/SKILL.md")?.toString()).toBe("https://raw.githubusercontent.com/o/r/main/x/SKILL.md");
    expect(rawSkillURL("https://raw.githubusercontent.com/o/r/main/x/SKILL.md")?.hostname).toBe("raw.githubusercontent.com");
    expect(rawSkillURL("http://github.com/o/r/blob/main/x/SKILL.md")).toBeNull();
    expect(rawSkillURL("https://gist.github.com/o/abc")).toBeNull();
    expect(rawSkillURL("not a url")).toBeNull();
  });

  it("bounds every fetch with a timeout and refuses redirects", async () => {
    const { bucket: b } = bucket();
    const seen: RequestInit[] = [];
    await mirrorSkill(deps(b, { onFetch: (_u, init) => init && seen.push(init) }), pkg, version);
    expect(seen.length).toBe(2);
    for (const init of seen) {
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(FETCH_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    const hang = deps(b, { license: "MIT" });
    hang.fetch = (async () => { throw new DOMException("timed out", "TimeoutError"); }) as typeof fetch;
    expect(await mirrorSkill(hang, pkg, version)).toEqual({ state: "skipped", reason: "license_unknown" });
  });

  it("writes nothing when the package was taken down while the bytes were fetched", async () => {
    const { bucket: b, objects } = bucket();
    expect(await mirrorSkill(deps(b, { live: async () => false }), pkg, version)).toEqual({ state: "skipped", reason: "not_live" });
    expect(objects.size).toBe(0);
  });

  it("undoes a write that a takedown overtook, unless another live package uses the pin", async () => {
    let calls = 0;
    const flips = async () => ++calls === 1;
    const lost = bucket();
    expect(await mirrorSkill(deps(lost.bucket, { live: flips }), pkg, version)).toEqual({ state: "skipped", reason: "withdrawn_during_write" });
    expect(lost.objects.size).toBe(0);
    calls = 0;
    const shared = bucket();
    const out = await mirrorSkill(deps(shared.bucket, { live: flips, elsewhere: async () => true }), pkg, version);
    expect(out.state).toBe("stored");
    expect(shared.objects.size).toBe(1);
  });

  it("only ever writes under market/skills/ and only for a digest", () => {
    expect(() => mirrorKey("sha256:../../releases")).toThrow();
    expect(() => mirrorKey("")).toThrow();
  });
});

describe("retention and takedown", () => {
  const hashes = ["a", "b", "c", "d", "e"].map((c) => `sha256:${c.repeat(64)}`);
  function filled(which: string[]) {
    const bk = bucket();
    for (const h of which) bk.objects.set(mirrorKey(h), FILE);
    return bk;
  }

  it("keeps the newest two that are actually mirrored; unmirrored versions take no slot", async () => {
    const bk = filled([hashes[1], hashes[2], hashes[3]]);
    const versions = [{ content_hash: hashes[0] }, { content_hash: "" }, ...hashes.slice(1, 4).map((content_hash) => ({ content_hash }))];
    await pruneMirrors(bk.bucket, versions, 2, async () => false);
    expect([...bk.objects.keys()].sort()).toEqual([mirrorKey(hashes[1]), mirrorKey(hashes[2])].sort());
  });

  it("reaches versions past the first page because the caller passes them all", async () => {
    const many = Array.from({ length: 120 }, (_, i) => `sha256:${i.toString(16).padStart(64, "0")}`);
    const bk = filled(many);
    await pruneMirrors(bk.bucket, many.map((content_hash) => ({ content_hash })), 2, async () => false);
    expect(bk.objects.size).toBe(2);
  });

  it("never removes an object another live package still uses, nor a kept version's shared pin", async () => {
    const bk = filled(hashes.slice(0, 3));
    const versions = [hashes[0], hashes[1], hashes[0], hashes[2]].map((content_hash) => ({ content_hash }));
    const removed = await pruneMirrors(bk.bucket, versions, 2, async (h) => h === hashes[2]);
    expect(removed).toEqual([]);
    expect(bk.objects.size).toBe(3);
    const takedown = await pruneMirrors(bk.bucket, versions, 0, async (h) => h === hashes[2]);
    expect(takedown.sort()).toEqual([mirrorKey(hashes[0]), mirrorKey(hashes[1])].sort());
    expect([...bk.objects.keys()]).toEqual([mirrorKey(hashes[2])]);
  });

  it("purges the edge for removed objects when configured, in chunks, and not otherwise", async () => {
    const keys = Array.from({ length: 65 }, (_, i) => mirrorKey(`sha256:${i.toString(16).padStart(64, "0")}`));
    const calls: { url: string; body: { files: string[] } }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}");
    }) as unknown as typeof fetch;
    await purgeEdge({ fetch: f }, keys);
    expect(calls).toHaveLength(0);
    await purgeEdge({ origin: "https://dl.example", zoneId: "zone1", token: "t", fetch: f }, keys);
    expect(calls.map((c) => c.body.files.length)).toEqual([30, 30, 5]);
    expect(calls[0].url).toContain("/zones/zone1/purge_cache");
    expect(calls[0].body.files[0]).toBe(`https://dl.example/${keys[0]}`);
    const failing = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(purgeEdge({ origin: "https://dl.example", zoneId: "z", token: "t", fetch: failing }, keys)).rejects.toThrow("403");
  });
});
