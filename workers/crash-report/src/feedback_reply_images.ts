import type { Env } from "./env";
import { ATTACHMENT_PREFIX } from "./feedback_attachments";
import { load } from "./feedback_admin_store";
import { auditStatement } from "./feedback_blocks";
import { jsonResponse, refuse } from "./feedback_http";
import type { StoredAttachment } from "./feedback_types";

// A reply's images become public only on a maintainer's word, and only where the
// report itself already has a public issue to show them on.
const PUBLIC_STATUSES = ["recorded", "in_progress", "fixed"];

export interface ReplyImage {
  key: string;
  name: string;
  contentType: string;
  size: number;
  released: boolean;
}

// What each reply carries, for the admin detail. Keys only: the bytes are read
// through the existing admin attachment route.
export async function replyImagesOf(env: Env, receipt: string, released: ReadonlySet<string>): Promise<Map<number, ReplyImage[]>> {
  const { results } = await env.DB.prepare("SELECT reply_id, attachments_json FROM feedback_reply_attachments WHERE receipt = ?").bind(receipt).all<{ reply_id: number; attachments_json: string }>();
  const out = new Map<number, ReplyImage[]>();
  for (const r of results) {
    out.set(r.reply_id, (JSON.parse(r.attachments_json) as StoredAttachment[]).map((a) => ({ key: a.key, name: a.name, contentType: a.contentType, size: a.size, released: released.has(a.key) })));
  }
  return out;
}

async function replyAttachments(env: Env, receipt: string, replyId: number): Promise<StoredAttachment[] | null> {
  const row = await env.DB.prepare("SELECT attachments_json FROM feedback_reply_attachments WHERE reply_id = ? AND receipt = ?").bind(replyId, receipt).first<{ attachments_json: string }>();
  return row ? (JSON.parse(row.attachments_json) as StoredAttachment[]) : null;
}

// A mirrored comment shows what was public when it was written, so a change to
// a reply's images puts the reply back in the converter's queue to be re-rendered.
const requeueReply = (env: Env, id: number) => env.DB.prepare("UPDATE feedback_replies SET handled = 0 WHERE id = ? AND author = 'user' AND handled = 1").bind(id);

const replyId = (raw: string) => (/^\d{1,15}$/.test(raw) ? Number(raw) : 0);

export async function releaseReplyImages(env: Env, receipt: string, rawId: string): Promise<Response> {
  const id = replyId(rawId);
  const row = await load(env, receipt);
  if (!row || id === 0) return refuse("feedback.not_found", "unknown reply");
  const images = await replyAttachments(env, receipt, id);
  if (!images || images.length === 0) return refuse("feedback.not_found", "this reply carries no images");
  if (!PUBLIC_STATUSES.includes(row.status)) return refuse("feedback.bad_transition", "images can be made public only on a report that already has a public issue");
  const at = new Date().toISOString();
  await env.DB.batch([
    ...images.map((a) => env.DB.prepare("INSERT OR IGNORE INTO feedback_public_images (key, receipt, created_at) VALUES (?,?,?)").bind(a.key, receipt, at)),
    requeueReply(env, id),
    auditStatement(env, "release_reply_images", `${receipt} reply=${id} images=${images.length}`),
  ]);
  return jsonResponse({ receipt, replyId: id, released: images.length });
}

export async function removeReplyImages(env: Env, receipt: string, rawId: string): Promise<Response> {
  const id = replyId(rawId);
  const row = await load(env, receipt);
  if (!row || id === 0) return refuse("feedback.not_found", "unknown reply");
  const images = await replyAttachments(env, receipt, id);
  if (!images || images.length === 0) return refuse("feedback.not_found", "this reply carries no images");
  // Objects first: a failed delete leaves the rows so the removal can be repeated.
  if (env.TELEMETRY_RAW) await env.TELEMETRY_RAW.delete(images.map((a) => ATTACHMENT_PREFIX + a.key));
  await env.DB.batch([
    ...images.map((a) => env.DB.prepare("DELETE FROM feedback_public_images WHERE key = ?").bind(a.key)),
    env.DB.prepare("DELETE FROM feedback_reply_attachments WHERE reply_id = ? AND receipt = ?").bind(id, receipt),
    requeueReply(env, id),
    auditStatement(env, "remove_reply_images", `${receipt} reply=${id} images=${images.length}`),
  ]);
  return jsonResponse({ receipt, replyId: id, removed: images.length });
}
