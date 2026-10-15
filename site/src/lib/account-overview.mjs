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
