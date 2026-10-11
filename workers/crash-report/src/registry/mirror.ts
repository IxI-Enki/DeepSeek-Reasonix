import type { PackageRow, VersionRow } from "./types";
import { CONTENT_DIGEST } from "./lib/validation";

export const MIRROR_PREFIX = "market/skills/";
// The installer fetches at most 2 MiB (defaultFetchLimit), so a larger file could never install.
export const MIRROR_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
// Short enough that a withdrawn object stops being served within the hour even
// when no edge purge is configured.
export const MIRROR_CACHE_CONTROL = "public, max-age=3600";
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
  // Re-reads the package: still live with this version's pin as its latest.
  stillLive: () => Promise<boolean>;
  // Whether another live package has a version with this pin.
  referencedElsewhere: (contentHash: string) => Promise<boolean>;
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
  | "digest_mismatch"
  | "not_live"
  | "withdrawn_during_write";

export function mirrorKey(contentHash: string): string {
  if (!CONTENT_DIGEST.test(contentHash)) throw new Error("mirror key needs a content digest");
  return `${MIRROR_PREFIX}${contentHash.slice("sha256:".length)}/SKILL.md`;
}

function guarded(keys: string[]): string[] {
  for (const key of keys) if (!key.startsWith(MIRROR_PREFIX)) throw new Error("mirror writes stay under market/skills/");
  return keys;
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
    const res = await deps.fetch(`https://api.github.com/repos/${owner}/${repo}/license`, { headers, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
    const res = await deps.fetch(raw.toString(), { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { state: "skipped", reason: "source_unreadable" };
    bytes = await readCapped(res, MIRROR_MAX_BYTES);
  } catch {
    return { state: "skipped", reason: "source_unreadable" };
  }
  if (!bytes) return { state: "skipped", reason: "too_large" };
  if ((await skillContentDigest(pkg.name, bytes)) !== version.content_hash) return { state: "skipped", reason: "digest_mismatch" };
  const key = mirrorKey(version.content_hash);
  // The package may have been taken down while the bytes were fetched.
  if (!(await deps.stillLive())) return { state: "skipped", reason: "not_live" };
  guarded([key]);
  await deps.bucket.put(key, bytes, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8", cacheControl: MIRROR_CACHE_CONTROL },
    customMetadata: { slug: pkg.slug, version: version.version, license },
  });
  // A takedown that landed between the check and the write removed nothing, so
  // look again and undo the write unless another live package uses this pin.
  if (!(await deps.stillLive()) && !(await deps.referencedElsewhere(version.content_hash))) {
    await deps.bucket.delete(key);
    return { state: "skipped", reason: "withdrawn_during_write" };
  }
  return { state: "stored", key, license };
}

// Applies retention to a package's mirrored versions (versions is newest
// first): the newest `keep` versions that actually have an object stay, every
// other object goes unless another live package uses the same pin or a kept
// version of this one does. keep = 0 is a takedown. Returns the removed keys.
export async function pruneMirrors(
  bucket: R2Bucket,
  versions: Pick<VersionRow, "content_hash">[],
  keep: number,
  referencedElsewhere: (contentHash: string) => Promise<boolean>,
): Promise<string[]> {
  const kept = new Set<string>();
  const candidates: string[] = [];
  for (const v of versions) {
    if (!CONTENT_DIGEST.test(v.content_hash)) continue;
    if (kept.size < keep && (await bucket.head(mirrorKey(v.content_hash)))) {
      kept.add(v.content_hash);
      continue;
    }
    candidates.push(v.content_hash);
  }
  const removable: string[] = [];
  for (const hash of new Set(candidates)) {
    if (kept.has(hash) || (await referencedElsewhere(hash))) continue;
    removable.push(mirrorKey(hash));
  }
  if (removable.length > 0) await bucket.delete(guarded(removable));
  return removable;
}

// Asks Cloudflare to drop removed objects from the edge, when the zone and an
// API token (Cache Purge) are configured. Without them the short cache lifetime
// bounds how long a withdrawn object keeps being served.
export async function purgeEdge(
  cfg: { origin?: string; zoneId?: string; token?: string; fetch: typeof fetch },
  keys: string[],
): Promise<void> {
  if (!cfg.origin || !cfg.zoneId || !cfg.token || keys.length === 0) return;
  for (let i = 0; i < keys.length; i += 30) {
    const files = keys.slice(i, i + 30).map((key) => `${cfg.origin}/${key}`);
    const res = await cfg.fetch(`https://api.cloudflare.com/client/v4/zones/${cfg.zoneId}/purge_cache`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ files }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`edge purge answered ${res.status}`);
  }
}
