import type { PackageRow, VersionRow } from "./types";
import { CONTENT_DIGEST } from "./lib/validation";

export const MIRROR_PREFIX = "market/skills/";
export const MIRROR_MAX_BYTES = 20 * 1024 * 1024;
export const MIRROR_KEEP_VERSIONS = 2;

// OSI-approved licences a repository may carry for its skill to be redistributed.
// Anything else, including no licence at all, is not mirrored.
const OSI_LICENSES = new Set([
  "0BSD", "AGPL-3.0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "BSL-1.0", "EPL-2.0", "GPL-2.0",
  "GPL-3.0", "ISC", "LGPL-2.1", "LGPL-3.0", "MIT", "MPL-2.0", "Unlicense", "Zlib",
]);

export interface MirrorDeps {
  bucket: R2Bucket;
  fetch: typeof fetch;
  githubToken?: string;
}

export type MirrorOutcome =
  | { state: "stored"; key: string; license: string }
  | { state: "skipped"; reason: MirrorSkip };

export type MirrorSkip =
  | "not_a_single_file_skill"
  | "not_pinned"
  | "source_not_github"
  | "license_unknown"
  | "license_not_osi"
  | "source_unreadable"
  | "too_large"
  | "digest_mismatch";

export function mirrorKey(contentHash: string): string {
  return `${MIRROR_PREFIX}${contentHash.slice("sha256:".length)}/SKILL.md`;
}

// The raw form of a GitHub file URL, matching the installer's own rewrite of a
// blob or raw link. Any other host is not mirrored.
export function rawSkillURL(source: string): URL | null {
  let u: URL;
  try {
    u = new URL(source);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "raw.githubusercontent.com" && parts.length >= 4) return u;
  if (host === "github.com" && parts.length >= 5 && (parts[2] === "blob" || parts[2] === "raw")) {
    return new URL(`https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join("/")}`);
  }
  return null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The pin the installer computes for a single-file skill: a digest over the
// skill's name and the hash of its file, in the installer's field order.
export async function skillContentDigest(name: string, file: Uint8Array): Promise<string> {
  const body = JSON.stringify([{ kind: "skill", name, content: await sha256Hex(file) }]);
  return `sha256:${await sha256Hex(new TextEncoder().encode(body))}`;
}

async function readCapped(res: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > limit || !res.body) return declared > limit ? null : new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function repositoryLicense(deps: MirrorDeps, owner: string, repo: string): Promise<string | null> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "reasonix-registry-mirror" };
  if (deps.githubToken) headers.authorization = `Bearer ${deps.githubToken}`;
  try {
    const res = await deps.fetch(`https://api.github.com/repos/${owner}/${repo}/license`, { headers, redirect: "error" });
    if (!res.ok) return null;
    const body = (await res.json()) as { license?: { spdx_id?: string } };
    return body.license?.spdx_id ?? null;
  } catch {
    return null;
  }
}

// Stores a pinned single-file skill under its digest, but only bytes that
// reproduce the reviewed pin, from a repository with an OSI licence. The pin is
// the whole trust: a mirror object that did not match it could never install.
export async function mirrorSkill(
  deps: MirrorDeps,
  pkg: Pick<PackageRow, "kind" | "install_kind" | "name" | "slug" | "source">,
  version: Pick<VersionRow, "version" | "content_hash" | "source">,
): Promise<MirrorOutcome> {
  if (pkg.kind !== "skill" || pkg.install_kind !== "skill") return { state: "skipped", reason: "not_a_single_file_skill" };
  if (!CONTENT_DIGEST.test(version.content_hash)) return { state: "skipped", reason: "not_pinned" };
  const raw = rawSkillURL(version.source || pkg.source);
  if (!raw) return { state: "skipped", reason: "source_not_github" };
  const [owner, repo] = raw.pathname.split("/").filter(Boolean);
  const license = await repositoryLicense(deps, owner, repo);
  if (!license) return { state: "skipped", reason: "license_unknown" };
  if (!OSI_LICENSES.has(license)) return { state: "skipped", reason: "license_not_osi" };
  let bytes: Uint8Array | null;
  try {
    const res = await deps.fetch(raw.toString(), { redirect: "error" });
    if (!res.ok) return { state: "skipped", reason: "source_unreadable" };
    bytes = await readCapped(res, MIRROR_MAX_BYTES);
  } catch {
    return { state: "skipped", reason: "source_unreadable" };
  }
  if (!bytes) return { state: "skipped", reason: "too_large" };
  if ((await skillContentDigest(pkg.name, bytes)) !== version.content_hash) return { state: "skipped", reason: "digest_mismatch" };
  const key = mirrorKey(version.content_hash);
  await deps.bucket.put(key, bytes, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8", cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { slug: pkg.slug, version: version.version, license },
  });
  return { state: "stored", key, license };
}

// Withdraws every mirrored version of a package (a takedown) or all but the
// newest MIRROR_KEEP_VERSIONS of them (retention). versions is newest first.
export async function pruneMirrors(bucket: R2Bucket, versions: Pick<VersionRow, "content_hash">[], keep: number): Promise<number> {
  const stale = versions
    .slice(keep)
    .map((v) => v.content_hash)
    .filter((hash) => CONTENT_DIGEST.test(hash))
    .map(mirrorKey);
  if (stale.length > 0) await bucket.delete(stale);
  return stale.length;
}
