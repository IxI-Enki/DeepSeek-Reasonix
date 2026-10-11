import { describe, expect, it } from "vitest";
import { MIRROR_MAX_BYTES, mirrorKey, mirrorSkill, pruneMirrors, rawSkillURL, skillContentDigest, type MirrorDeps } from "./mirror";

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
    async delete(keys: string | string[]) {
      for (const k of [keys].flat()) {
        deleted.push(k);
        objects.delete(k);
      }
    },
  };
  return { bucket: api as unknown as R2Bucket, objects, meta, deleted };
}

function deps(b: R2Bucket, over: { license?: string | null; file?: Uint8Array | Response } = {}): MirrorDeps {
  const license = over.license === undefined ? "MIT" : over.license;
  return {
    bucket: b,
    fetch: (async (url: string) => {
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

  it("keeps the newest versions and removes the rest, and a takedown removes all", async () => {
    const digests = ["a", "b", "c", "d"].map((c) => `sha256:${c.repeat(64)}`);
    const rows = [...digests.map((content_hash) => ({ content_hash })), { content_hash: "" }];
    const kept = bucket();
    expect(await pruneMirrors(kept.bucket, rows, 2)).toBe(2);
    expect(kept.deleted).toEqual([mirrorKey(digests[2]), mirrorKey(digests[3])]);
    const all = bucket();
    expect(await pruneMirrors(all.bucket, rows, 0)).toBe(4);
  });
});
