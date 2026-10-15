// A read-only feed of the feedback that is already public on GitHub, for the forum
// to mirror. It answers only to a shared bearer secret, only for reports that were
// converted to a GitHub issue, and only with fields the issue itself shows: no
// receipt, no name, no contact, no install, no environment, no unreleased image.
import type { Env } from "./env";
import { attachmentUrl } from "./feedback_attachments";
import { constantTimeEqual } from "./feedback_crypto";
import { refuse, jsonResponse } from "./feedback_http";
import { CONCRETE_VERSION } from "./feedback_types";

const PUBLIC_STATUSES = ["recorded", "in_progress", "fixed", "wontfix", "duplicate"] as const;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const CURSOR = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\|(\d{1,12})$/;
const ISSUE_URL = /^https:\/\/github\.com\/esengine\/DeepSeek-Reasonix\/issues\/\d+$/;
const TITLE_CHARS = 120;

interface PublicRow {
  id: number;
  receipt: string;
  category: string;
  body: string;
  status: string;
  issue_number: number;
  issue_url: string | null;
  resolved_version: string | null;
  duplicate_of: string | null;
  created_at: string;
  updated_at: string;
}

const titleOf = (body: string) => {
  const first = body.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return first.length > TITLE_CHARS ? first.slice(0, TITLE_CHARS) : first;
};

// Absent from the route table until the secret exists, like the other optional routes.
export async function handlePublicFeed(request: Request, env: Env, url: URL): Promise<Response> {
  const secret = env.FEEDBACK_PUBLIC_TOKEN;
  if (!secret) return new Response("not found", { status: 404 });
  if (request.method !== "GET") return refuse("feedback.method_not_allowed", "method not allowed");
  const presented = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (presented === "" || !(await constantTimeEqual(presented, secret))) return refuse("feedback.unauthorized", "unauthorized");

  const limitParam = url.searchParams.get("limit");
  const limit = limitParam === null ? DEFAULT_LIMIT : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return refuse("feedback.invalid", `limit must be 1 to ${MAX_LIMIT}`);
  const after = url.searchParams.get("after");
  const cursor = after === null ? null : CURSOR.exec(after);
  if (after !== null && !cursor) return refuse("feedback.invalid", "after is not a cursor this feed issued");

  const marks = PUBLIC_STATUSES.map(() => "?").join(",");
  const keyset = cursor ? "AND (updated_at > ? OR (updated_at = ? AND id > ?))" : "";
  const bound = cursor ? [cursor[1], cursor[1], Number(cursor[2])] : [];
  const { results } = await env.DB.prepare(
    `SELECT id, receipt, category, body, status, issue_number, issue_url, resolved_version, duplicate_of, created_at, updated_at
       FROM feedback
      WHERE issue_number IS NOT NULL AND status IN (${marks}) ${keyset}
      ORDER BY updated_at, id LIMIT ?`,
  ).bind(...PUBLIC_STATUSES, ...bound, limit + 1).all<PublicRow>();
  const page = results.slice(0, limit);
  const images = await publicImages(env, page.map((r) => r.receipt));
  const origin = url.origin;
  const last = page[page.length - 1];
  return jsonResponse({
    items: page.map((r) => ({
      issue: r.issue_number,
      url: r.issue_url && ISSUE_URL.test(r.issue_url) ? r.issue_url : null,
      title: titleOf(r.body),
      body: r.body,
      category: r.category,
      status: r.status,
      version: r.resolved_version === "next" || (r.resolved_version !== null && CONCRETE_VERSION.test(r.resolved_version)) ? r.resolved_version : null,
      duplicateOf: r.duplicate_of !== null && /^#?\d{1,9}$/.test(r.duplicate_of) ? r.duplicate_of.replace(/^#/, "") : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      images: (images.get(r.receipt) ?? []).map((key) => attachmentUrl(origin, key)),
    })),
    next: results.length > limit && last ? `${last.updated_at}|${last.id}` : null,
  });
}

// Only an image a maintainer released is public; a takedown removes its row.
async function publicImages(env: Env, receipts: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (receipts.length === 0) return out;
  const marks = receipts.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT receipt, key FROM feedback_public_images WHERE receipt IN (${marks}) ORDER BY created_at, key`)
    .bind(...receipts)
    .all<{ receipt: string; key: string }>();
  for (const r of results) out.set(r.receipt, [...(out.get(r.receipt) ?? []), r.key]);
  return out;
}
