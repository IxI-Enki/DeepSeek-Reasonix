import assert from "node:assert/strict";
import test from "node:test";
import { backupCount, deviceSummary, forumState, forumSummary, initials, trustName } from "../lib/account-overview.mjs";

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
