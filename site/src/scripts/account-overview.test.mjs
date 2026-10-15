import assert from "node:assert/strict";
import test from "node:test";
import { backupCount, deviceSummary, feedbackSummary, forumState, forumSummary, initials, levelName, levelProgress, trustName } from "../lib/account-overview.mjs";

test("trust levels name themselves and refuse unknown values", () => {
  assert.deepEqual(trustName(0), ["New", "新成员"]);
  assert.deepEqual(trustName(4), ["Leader", "领袖"]);
  assert.equal(trustName(5), null);
  assert.equal(trustName("2"), null);
});

test("revoked devices do not count and a missing presence feed hides the online figure", () => {
  const devices = [{ online: true }, { online: false }, { online: true, revokedAt: "2026-01-01" }];
  assert.deepEqual(deviceSummary({ devices, presenceAvailable: true }), { total: 2, online: 1 });
  assert.deepEqual(deviceSummary({ devices, presenceAvailable: false }), { total: 2, online: null });
  assert.deepEqual(deviceSummary(null), { total: 0, online: 0 });
});

test("backup count is unknown unless the list is an array", () => {
  assert.equal(backupCount({ backups: [{}, {}] }), 2);
  assert.equal(backupCount({}), null);
});

test("the forum summary keeps well-formed numbers only", () => {
  const s = forumSummary({
    member: { trust: 1, role: "root", dailyPostCap: 20, canPostLinks: true, silencedUntil: null },
    stats: { topics: 3, posts: "9", likesReceived: -1, solved: 1.9 },
    recent: [{ id: 5, title: "Mine" }, { id: "x", title: "bad" }],
  });
  assert.equal(s.role, "member");
  assert.equal(s.topics, 3);
  assert.equal(s.posts, null);
  assert.equal(s.likesReceived, null);
  assert.equal(s.solved, 1);
  assert.deepEqual(s.recent, [{ id: 5, title: "Mine" }]);
  assert.equal(forumSummary({}), null);
});

test("initials fall back to a question mark", () => {
  assert.equal(initials("alice_dev"), "AL");
  assert.equal(initials("小明"), "?");
});

test("a failed forum answer is unavailable and only a zero-count answer is empty", () => {
  const stats = (topics, posts) => ({ member: { trust: 0, role: "member" }, stats: { topics, posts, likesReceived: 0, solved: 0 }, recent: [] });
  assert.equal(forumState(forumSummary(null)), "unavailable");
  assert.equal(forumState(forumSummary({ member: {} })), "unavailable");
  assert.equal(forumState(forumSummary(stats(0, 0))), "empty");
  assert.equal(forumState(forumSummary(stats(0, 17))), "active");
});

test("the page tells a failed request apart from an empty one", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("./account-overview.js", import.meta.url), "utf8");
  assert.match(page, /\.catch\(\(\) => paintForum\(null\)\)/);
  assert.match(page, /forumState\(f\)/);
});

const stand = (level, adopted, over = {}) => ({ level, adoptedCount: adopted, currentThreshold: 3, nextLevel: level + 1, nextThreshold: 6, remaining: 2, trustState: "active", trustExpiresAt: "2026-11-01T00:00:00Z", effectiveLimits: { reportsPerHour: 6, reportsPerDay: 20, repliesPerHour: 5 }, ...over });

test("a failed or malformed feedback answer is unavailable, a linkless one is none", () => {
  assert.equal(feedbackSummary(null).state, "unavailable");
  assert.equal(feedbackSummary({ installs: "x", items: [] }).state, "unavailable");
  assert.equal(feedbackSummary({ installs: [], items: [] }).state, "none");
  assert.equal(feedbackSummary({ installs: [{ id: "nope", profile: stand(1, 1) }], items: [] }).state, "none");
});

test("a linked account keeps well-formed standings, items and the shipped version only", () => {
  const s = feedbackSummary({
    profile: stand(2, 4),
    installs: [{ id: "0123456789ab", linkedAt: "2026-10-01", profile: stand(2, 4) }, { id: "ba9876543210", linkedAt: "2026-10-02", profile: { level: "x" } }],
    items: [{ receipt: "FB-AAAA-0001", titleSnippet: "t", status: "fixed", issueNumber: 7, resolvedVersion: "<img>" }, { receipt: 5 }],
  });
  assert.equal(s.state, "linked");
  assert.equal(s.headline.level, 2);
  assert.equal(s.installs[1].standing, null);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].version, null);
});

test("progress runs from this level's threshold to the next and vanishes at the top", () => {
  assert.equal(levelProgress(feedbackSummary({ profile: stand(2, 4), installs: [{ id: "0123456789ab", linkedAt: "x", profile: stand(2, 4) }], items: [] }).headline), 1 / 3);
  assert.equal(levelProgress({ nextThreshold: null, base: 48, adopted: 60 }), null);
  assert.equal(levelProgress({ nextThreshold: 3, base: 3, adopted: 3 }), null);
  assert.deepEqual(levelName(6), ["Grove", "共林"]);
  assert.equal(levelName(7), null);
});
