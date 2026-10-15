import { repos } from "./db";
import type { Bindings } from "./env";

const ASSERTION_TTL_SECONDS = 300;
// The feedback worker accepts an assertion up to 360 s ahead, so a link can still be
// created that long after the deletion; the row stays until a send lands after it.
const SETTLE_MS = (ASSERTION_TTL_SECONDS + 60) * 1000;
const STALE_BACKLOG_MS = 3 * 86_400_000;
const STALE_ATTEMPTS = 3;
const ERASE_TIMEOUT_MS = 5000;
const RETRY_BATCH = 50;
const DEFAULT_FEEDBACK_ORIGIN = "https://crash.reasonix.io";
const enc = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret: string, label: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${label}:${value}`))));
}

// `v1.<payload>.<signature>`, the format the feedback worker verifies: audience
// "feedback", the numeric account id, a five minute expiry.
export async function mintFeedbackAssertion(secret: string, userId: number, now: Date): Promise<{ assertion: string; expiresAt: string }> {
  const exp = Math.floor(now.getTime() / 1000) + ASSERTION_TTL_SECONDS;
  const payload = base64url(enc.encode(JSON.stringify({ aud: "feedback", exp, sub: String(userId) })));
  return { assertion: `v1.${payload}.${await sign(secret, "feedback-assertion", payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

async function sendErasure(env: Bindings, userId: number): Promise<boolean> {
  if (!env.FEEDBACK_ACCOUNT_SECRET) return false;
  const body = JSON.stringify({ sub: String(userId) });
  try {
    const response = await fetch(`${(env.FEEDBACK_ORIGIN ?? DEFAULT_FEEDBACK_ORIGIN).replace(/\/+$/, "")}/v1/feedback/account/erase`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-erase-signature": await sign(env.FEEDBACK_ACCOUNT_SECRET, "feedback-account-erase", body) },
      body,
      signal: AbortSignal.timeout(ERASE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function deliver(env: Bindings, userId: number, createdAt: string, now: Date): Promise<boolean> {
  const queue = repos(env).feedbackErasures;
  if (!env.FEEDBACK_ACCOUNT_SECRET) return false;
  const delivered = await sendErasure(env, userId);
  if (delivered && now.getTime() >= Date.parse(createdAt) + SETTLE_MS) await queue.done(userId);
  else await queue.recordAttempt(userId, now);
  return delivered && now.getTime() >= Date.parse(createdAt) + SETTLE_MS;
}

// The request is recorded first so a failed or unreachable worker never loses it;
// the deletion itself never waits on, or fails because of, this call.
export async function notifyFeedbackErasure(env: Bindings, userId: number, now = new Date()): Promise<void> {
  try {
    await repos(env).feedbackErasures.enqueue(userId, now);
    await deliver(env, userId, now.toISOString(), now);
  } catch {
    console.warn("feedback erasure could not be recorded");
  }
}

// Bounded per run, least recently attempted first. The worker deletes by account
// hash, so a repeat is harmless; the backlog warning carries counts only.
export async function retryFeedbackErasures(env: Bindings, now = new Date()): Promise<number> {
  if (!env.FEEDBACK_ACCOUNT_SECRET) return 0;
  const queue = repos(env).feedbackErasures;
  let settled = 0;
  for (const row of await queue.pending(RETRY_BATCH)) {
    if (await deliver(env, row.userId, row.createdAt, now)) settled += 1;
  }
  const backlog = await queue.backlog();
  const age = backlog.oldest === null ? 0 : now.getTime() - Date.parse(backlog.oldest);
  if (backlog.count > 0 && (age > STALE_BACKLOG_MS || backlog.maxAttempts >= STALE_ATTEMPTS)) {
    console.warn(`feedback erasure backlog: ${backlog.count} pending, oldest ${Math.floor(age / 86_400_000)}d, max attempts ${backlog.maxAttempts}`);
  }
  return settled;
}

const OVERVIEW_TIMEOUT_MS = 5000;
const OVERVIEW_ITEMS = 10;
const TRUST_STATES = new Set(["active", "legacy_active", "lapsed", "revoked", "none"]);

const count = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

function standing(raw: unknown) {
  const p = (raw ?? {}) as Record<string, unknown>;
  const limits = (p.effectiveLimits ?? {}) as Record<string, unknown>;
  const level = count(p.level);
  const adoptedCount = count(p.adoptedCount);
  if (level === null || adoptedCount === null || typeof p.trustState !== "string" || !TRUST_STATES.has(p.trustState)) return null;
  return {
    level,
    adoptedCount,
    currentThreshold: count(p.currentThreshold),
    nextLevel: count(p.nextLevel),
    nextThreshold: count(p.nextThreshold),
    remaining: count(p.remaining),
    trustState: p.trustState,
    trustExpiresAt: text(p.trustExpiresAt, 40),
    effectiveLimits: { reportsPerHour: count(limits.reportsPerHour), reportsPerDay: count(limits.reportsPerDay), repliesPerHour: count(limits.repliesPerHour) },
  };
}

export type FeedbackOverview = "unavailable" | { profile: ReturnType<typeof standing> & { scope: string } | null; installs: { id: string; linkedAt: string; profile: ReturnType<typeof standing> }[]; items: Record<string, unknown>[] };

// The account's feedback standing and recent reports, read from the feedback worker
// with a fresh assertion. Only a whitelist of fields is passed on, so the page gets
// no install hash and no reply bodies whatever the worker adds later.
export async function fetchFeedbackOverview(env: Bindings, userId: number, now = new Date()): Promise<FeedbackOverview> {
  if (!env.FEEDBACK_ACCOUNT_SECRET) return "unavailable";
  const { assertion } = await mintFeedbackAssertion(env.FEEDBACK_ACCOUNT_SECRET, userId, now);
  let res: Response;
  try {
    res = await fetch(`${(env.FEEDBACK_ORIGIN ?? DEFAULT_FEEDBACK_ORIGIN).replace(/\/+$/, "")}/v1/feedback/account/mine`, {
      headers: { "x-account-assertion": assertion, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(OVERVIEW_TIMEOUT_MS),
    });
  } catch {
    return "unavailable";
  }
  if (!res.ok) return "unavailable";
  const body = (await res.json().catch(() => null)) as { profile?: Record<string, unknown>; installs?: Record<string, unknown>[]; items?: Record<string, unknown>[] } | null;
  if (!body || !Array.isArray(body.installs) || !Array.isArray(body.items)) return "unavailable";
  const headline = standing(body.profile);
  return {
    profile: headline ? { ...headline, scope: body.profile?.scope === "install" ? "install" : "best_install" } : null,
    installs: body.installs.flatMap((i) => {
      const id = typeof i.id === "string" && /^[0-9a-f]{12}$/.test(i.id) ? i.id : null;
      const linkedAt = text(i.linkedAt, 40);
      return id && linkedAt ? [{ id, linkedAt, profile: standing(i.profile) }] : [];
    }),
    items: body.items.slice(0, OVERVIEW_ITEMS).map((it) => ({
      receipt: text(it.receipt, 20),
      category: text(it.category, 20),
      titleSnippet: text(it.titleSnippet, 80),
      status: text(it.status, 20),
      issueNumber: count(it.issueNumber),
      issueUrl: typeof it.issueUrl === "string" && it.issueUrl.startsWith("https://github.com/") ? it.issueUrl : null,
      resolvedVersion: text(it.resolvedVersion, 32),
      createdAt: text(it.createdAt, 40),
      updatedAt: text(it.updatedAt, 40),
    })),
  };
}
