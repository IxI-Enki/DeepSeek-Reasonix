const TIERS = [
  ["New", "新成员"],
  ["Basic", "基础"],
  ["Member", "成员"],
  ["Regular", "常客"],
  ["Leader", "领袖"],
];

// [en, zh] for a forum trust level; a value outside the known range reads as unknown.
export function trustName(level) {
  return Number.isInteger(level) && level >= 0 && level < TIERS.length ? TIERS[level] : null;
}

export function deviceSummary(payload) {
  const list = Array.isArray(payload?.devices) ? payload.devices.filter((d) => d && !d.revokedAt) : [];
  return { total: list.length, online: payload?.presenceAvailable === false ? null : list.filter((d) => d.online === true).length };
}

export function backupCount(payload) {
  return Array.isArray(payload?.backups) ? payload.backups.length : null;
}

const whole = (n) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : null);

// Only well-formed numbers reach the page; anything else renders as "—".
export function forumSummary(payload) {
  const m = payload?.member;
  const s = payload?.stats;
  if (!m || !s) return null;
  return {
    trust: Number.isInteger(m.trust) ? m.trust : null,
    role: m.role === "admin" || m.role === "moderator" ? m.role : "member",
    dailyPostCap: whole(m.dailyPostCap),
    canPostLinks: m.canPostLinks === true,
    silencedUntil: typeof m.silencedUntil === "string" ? m.silencedUntil : null,
    topics: whole(s.topics),
    posts: whole(s.posts),
    likesReceived: whole(s.likesReceived),
    solved: whole(s.solved),
    recent: Array.isArray(payload.recent)
      ? payload.recent.filter((r) => Number.isInteger(r?.id) && typeof r.title === "string").slice(0, 5)
      : [],
  };
}

export function initials(handle) {
  return String(handle || "?").replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

// "empty" is only for an answered request whose counts are all zero; a failed or
// malformed answer is "unavailable", never a claim that the member has not taken part.
export function forumState(summary) {
  if (!summary) return "unavailable";
  return summary.topics === 0 && summary.posts === 0 ? "empty" : "active";
}

const LEVELS = [
  ["New seed", "新种"],
  ["Sprout", "萌芽"],
  ["Seedling", "幼苗"],
  ["Sapling", "小树"],
  ["Bloom", "繁花"],
  ["Canopy", "成荫"],
  ["Grove", "共林"],
];

// [en, zh] for a feedback level, null outside the known ladder.
export function levelName(level) {
  return Number.isInteger(level) && level >= 0 && level < LEVELS.length ? LEVELS[level] : null;
}

const TRUST = new Set(["active", "legacy_active", "lapsed", "revoked", "none"]);
const count = (n) => (Number.isInteger(n) && n >= 0 ? n : null);

function standing(p) {
  if (!p || count(p.level) === null || count(p.adoptedCount) === null || !TRUST.has(p.trustState)) return null;
  const limits = p.effectiveLimits ?? {};
  return {
    level: p.level,
    adopted: p.adoptedCount,
    base: count(p.currentThreshold),
    nextLevel: count(p.nextLevel),
    nextThreshold: count(p.nextThreshold),
    remaining: count(p.remaining),
    trustState: p.trustState,
    trustExpiresAt: typeof p.trustExpiresAt === "string" ? p.trustExpiresAt : null,
    perHour: count(limits.reportsPerHour),
    perDay: count(limits.reportsPerDay),
    repliesPerHour: count(limits.repliesPerHour),
  };
}

// Share of the way to the next level, or null at the top or when the thresholds do not hold together.
export function levelProgress(s) {
  if (!s || s.nextThreshold === null || s.base === null || s.nextThreshold <= s.base) return null;
  return Math.min(1, Math.max(0, (s.adopted - s.base) / (s.nextThreshold - s.base)));
}

// "unavailable" is a failed or malformed answer; "none" is an answered request with no linked install.
export function feedbackSummary(payload) {
  if (!payload || !Array.isArray(payload.installs) || !Array.isArray(payload.items)) return { state: "unavailable" };
  const installs = payload.installs.map((i) => ({ id: String(i?.id ?? ""), linkedAt: i?.linkedAt, standing: standing(i?.profile) })).filter((i) => /^[0-9a-f]{12}$/.test(i.id));
  if (installs.length === 0) return { state: "none" };
  const items = payload.items
    .filter((it) => typeof it?.receipt === "string" && typeof it.titleSnippet === "string")
    .slice(0, 5)
    .map((it) => ({
      receipt: it.receipt,
      title: it.titleSnippet,
      status: typeof it.status === "string" ? it.status : "",
      issueNumber: count(it.issueNumber),
      version: typeof it.resolvedVersion === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(it.resolvedVersion) ? it.resolvedVersion : null,
    }));
  return { state: "linked", headline: standing(payload.profile), installs, items };
}
