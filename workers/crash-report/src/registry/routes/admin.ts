import { Hono } from "hono";
import type { AppEnv } from "../env";
import { toPackageDTO } from "../types";
import { repos } from "../db";
import { currentUser, requireAdmin } from "../http/auth";
import { writeRateLimit } from "../http/ratelimit";
import { ApiError } from "../http/errors";
import { z } from "zod";
import { CONTENT_DIGEST } from "../lib/validation";
import { repinReviewedDigest } from "../pin";
import { rescore } from "../db/ranking";
import { MIRROR_KEEP_VERSIONS, mirrorKey, mirrorSkill, pruneMirrors, purgeEdge, type MirrorOutcome } from "../mirror";
import type { Context } from "hono";
import type { PackageRow, VersionRow } from "../types";

const admin = new Hono<AppEnv>();

const now = () => new Date().toISOString();

function mirrorEnabled(c: Context<AppEnv>): boolean {
  return c.env.MARKET_MIRROR_ENABLED === "true" && !!c.env.MARKET_MIRROR;
}

// Every version of a package, newest first, paged so retention also reaches
// objects older than the first page.
async function allVersions(c: Context<AppEnv>, row: PackageRow) {
  const out: VersionRow[] = [];
  let page: { before?: string; beforeId?: number } = {};
  for (let guard = 0; guard < 20; guard++) {
    const got = await repos(c.env).packages.versions(row.id, { limit: 50, ...page });
    out.push(...got.versions);
    if (!got.pageInfo.hasMore) break;
    page = { before: got.pageInfo.nextBefore ?? undefined, beforeId: got.pageInfo.nextBeforeId ?? undefined };
  }
  return out;
}

function edge(c: Context<AppEnv>) {
  return { origin: c.env.MARKET_MIRROR_ORIGIN, zoneId: c.env.CLOUDFLARE_ZONE_ID, token: c.env.CLOUDFLARE_API_TOKEN, fetch };
}

async function removeMirrors(c: Context<AppEnv>, row: PackageRow, keep: number): Promise<void> {
  const repo = repos(c.env).packages;
  const removed = await pruneMirrors(c.env.MARKET_MIRROR!, await allVersions(c, row), keep, (hash) => repo.activeReferencers(hash, row.id));
  await purgeEdge(edge(c), removed);
}

// Stores the live version of a pinned skill and drops versions past retention.
// Failures never reach the moderation answer: a package that could not be
// mirrored is installed from its source, as before.
async function mirrorLive(c: Context<AppEnv>, row: PackageRow): Promise<MirrorOutcome | null> {
  if (!mirrorEnabled(c) || row.status !== "active") return null;
  const repo = repos(c.env).packages;
  const versions = await allVersions(c, row);
  const live = versions.find((v) => v.version === row.latest_version);
  if (!live) return null;
  const outcome = await mirrorSkill(
    {
      bucket: c.env.MARKET_MIRROR!,
      fetch,
      githubToken: c.env.GITHUB_TOKEN,
      stillLive: async () => {
        const now = await repo.bySlug(row.slug);
        return now?.status === "active" && now.latest_version === row.latest_version;
      },
      referencedElsewhere: (hash) => repo.activeReferencers(hash, row.id),
    },
    row,
    live,
  );
  if (outcome.state === "stored") await removeMirrors(c, row, MIRROR_KEEP_VERSIONS);
  if (outcome.state === "skipped" && outcome.reason === "withdrawn_during_write") await purgeEdge(edge(c), [mirrorKey(live.content_hash)]);
  return outcome;
}

async function withdrawMirrors(c: Context<AppEnv>, row: PackageRow): Promise<void> {
  if (!c.env.MARKET_MIRROR) return;
  await removeMirrors(c, row, 0);
}

function inBackground(c: Context<AppEnv>, work: Promise<unknown>): void {
  const settled = work.catch((err) => console.warn("market mirror", err instanceof Error ? err.message : String(err)));
  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    void settled;
  }
}

const ApprovalRevisionSchema = z.object({
  expectedVersion: z.string().min(1).max(64),
  expectedUpdatedAt: z.string().min(1).max(64),
  expectedStatus: z.enum(["pending", "hidden", "rejected"]),
  contentHash: z.union([z.literal(""), z.string().regex(CONTENT_DIGEST)]).default(""),
});

const PinRevisionSchema = z.object({
  expectedVersion: z.string().min(1).max(64),
  expectedUpdatedAt: z.string().min(1).max(64),
  expectedStatus: z.literal("active"),
  contentHash: z.string().regex(CONTENT_DIGEST),
});

admin.use("*", requireAdmin);

// Review queue. ?status defaults to pending; also accepts rejected/hidden/active,
// and flagged: live packages the vote rules send back for another look.
admin.get("/packages", async (c) => {
  const status = new URL(c.req.url).searchParams.get("status") || "pending";
  const { packages: repo } = repos(c.env);
  const rows = status === "flagged" ? await repo.listFlagged(200) : await repo.listByStatus(status, 200);
  return c.json({ packages: rows.map(toPackageDTO) });
});

// Recompute every recommended score now instead of at the next cron run — the
// step that follows the votes migration.
admin.post("/rescore", writeRateLimit, async (c) => {
  const updated = await rescore(c.env.DB, now().slice(0, 10));
  return c.json({ updated });
});

// Approve a pending package → live. Its publish event is emitted here (on first
// approval), so the activity feed only ever announces public packages.
admin.post("/packages/:handle/:name/approve", writeRateLimit, async (c) => {
  const slug = `${c.req.param("handle")}/${c.req.param("name")}`;
  const { packages: repo, events } = repos(c.env);
  const revision = ApprovalRevisionSchema.safeParse(await c.req.json().catch(() => null));
  if (!revision.success) {
    throw new ApiError(400, "invalid_review_revision", "Approval requires the reviewed package revision.");
  }
  const approvedAt = now();
  const row = await repo.setStatusIfCurrent(
    slug,
    "active",
    revision.data.expectedVersion,
    revision.data.expectedUpdatedAt,
    revision.data.expectedStatus,
    approvedAt,
    revision.data.contentHash,
  );
  if (!row) {
    const current = await repo.bySlug(slug);
    if (!current) throw new ApiError(404, "not_found", "No such package.");
    throw new ApiError(
      409,
      "stale_review",
      "Package changed since it was reviewed. Refresh and review the latest version.",
    );
  }
  await events.log({
    type: "publish",
    packageId: row.id,
    actorHandle: row.scope_handle,
    summary: `published ${row.slug}@${row.latest_version}`,
    now: approvedAt,
  });
  inBackground(c, mirrorLive(c, row));
  return c.json({ package: toPackageDTO(row) });
});

// Bind (or replace) the reviewed digest on a live package's current version,
// for packages approved before a digest could be recorded. Status is unchanged.
admin.post("/packages/:handle/:name/pin", writeRateLimit, async (c) => {
  const slug = `${c.req.param("handle")}/${c.req.param("name")}`;
  const revision = PinRevisionSchema.safeParse(await c.req.json().catch(() => null));
  if (!revision.success) {
    throw new ApiError(
      400,
      "invalid_pin",
      "Pinning requires the live package revision and a sha256:<64 lowercase hex> content digest.",
    );
  }
  const result = await repinReviewedDigest(c.env.DB, {
    slug,
    expectedVersion: revision.data.expectedVersion,
    expectedUpdatedAt: revision.data.expectedUpdatedAt,
    contentHash: revision.data.contentHash,
    actor: currentUser(c).handle,
    now: now(),
  });
  if (!result) {
    const current = await repos(c.env).packages.bySlug(slug);
    if (!current) throw new ApiError(404, "not_found", "No such package.");
    throw new ApiError(
      409,
      "stale_review",
      "Package changed since it was reviewed. Refresh and review the latest version.",
    );
  }
  inBackground(c, mirrorLive(c, result.row));
  return c.json({
    package: toPackageDTO(result.row),
    previousContentHash: result.previous,
    contentHash: revision.data.contentHash,
  });
});

admin.post("/packages/:handle/:name/reject", writeRateLimit, async (c) => {
  const slug = `${c.req.param("handle")}/${c.req.param("name")}`;
  const row = await repos(c.env).packages.setStatus(slug, "rejected", now());
  if (!row) throw new ApiError(404, "not_found", "No such package.");
  inBackground(c, withdrawMirrors(c, row));
  return c.json({ package: toPackageDTO(row) });
});

// Take a previously-approved package back down.
admin.post("/packages/:handle/:name/hide", writeRateLimit, async (c) => {
  const slug = `${c.req.param("handle")}/${c.req.param("name")}`;
  const row = await repos(c.env).packages.setStatus(slug, "hidden", now());
  if (!row) throw new ApiError(404, "not_found", "No such package.");
  inBackground(c, withdrawMirrors(c, row));
  return c.json({ package: toPackageDTO(row) });
});

// Grant or revoke the verified badge. Body {verified:false} revokes; default grants.
admin.post("/packages/:handle/:name/verify", writeRateLimit, async (c) => {
  const slug = `${c.req.param("handle")}/${c.req.param("name")}`;
  const body = (await c.req.json().catch(() => ({}))) as { verified?: boolean };
  const row = await repos(c.env).packages.setVerified(slug, body.verified !== false, now());
  if (!row) throw new ApiError(404, "not_found", "No such package.");
  return c.json({ package: toPackageDTO(row) });
});

// Mirror one live package now and say what happened, for packages approved
// before mirroring existed.
admin.post("/packages/:handle/:name/mirror", writeRateLimit, async (c) => {
  if (!mirrorEnabled(c)) throw new ApiError(409, "mirror_disabled", "Market mirroring is not enabled.");
  const slug = `${c.req.param("handle")}/${c.req.param("name")}`;
  const row = await repos(c.env).packages.bySlug(slug);
  if (!row || row.status !== "active") throw new ApiError(404, "not_found", "No such live package.");
  return c.json({ slug, outcome: await mirrorLive(c, row) });
});

export default admin;
