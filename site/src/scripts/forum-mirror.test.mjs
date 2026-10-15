import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DISCUSSIONS_URL, mirrorOf, statusText } from "../lib/forum-mirror.mjs";

test("only a github-sourced thread is a mirror, and it points at its own discussion", () => {
  assert.equal(mirrorOf({ source: "forum", ghNumber: 7 }), null);
  assert.equal(mirrorOf(null), null);
  assert.equal(mirrorOf({ source: "github", ghNumber: 7 }).url, `${DISCUSSIONS_URL}/7`);
  assert.equal(mirrorOf({ source: "github", ghNumber: "7; drop" }).url, DISCUSSIONS_URL);
});

test("status and shipped version are shown only when they are well formed", () => {
  assert.deepEqual(statusText(mirrorOf({ source: "github", ghStatus: "fixed", fixedIn: "2.42.0" })), ["Fixed in v2.42.0", "已修复于 v2.42.0"]);
  assert.deepEqual(statusText(mirrorOf({ source: "github", ghStatus: "in_progress", fixedIn: "9.9" })), ["In progress", "处理中"]);
  assert.equal(statusText(mirrorOf({ source: "github", ghStatus: "<script>" })), null);
  assert.deepEqual(statusText(mirrorOf({ source: "github", ghStatus: "fixed", fixedIn: "<img onerror=x>" })), ["Fixed", "已修复"]);
});

test("the thread page replaces the reply box on a mirror, and the list marks it", async () => {
  const page = await readFile(new URL("./community.js", import.meta.url), "utf8");
  assert.match(page, /from "\.\.\/lib\/forum-mirror\.mjs"/);
  assert.match(page, /const mirror = mirrorOf\(topic\)/);
  assert.match(page, /if \(mirror\) \{[^}]*reply-zone|if \(mirror\)[\s\S]{0,400}zone\.innerHTML/);
  assert.match(page, /read_only_mirror:/);
});
