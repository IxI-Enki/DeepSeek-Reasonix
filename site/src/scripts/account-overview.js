import { backupCount, deviceSummary, forumState, forumSummary, initials, trustName } from "../lib/account-overview.mjs";

const ACCOUNTS = (import.meta.env.PUBLIC_ACCOUNTS_API || "https://id.reasonix.io").replace(/\/$/, "");
const FORUM = (import.meta.env.PUBLIC_FORUM_API || "https://forum.reasonix.io").replace(/\/$/, "");

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const L = (en, zh) => `<span class="l-en">${esc(en)}</span><span class="l-zh">${esc(zh)}</span>`;
const num = (n) => (n === null || n === undefined ? "—" : String(n));

async function get(base, path) {
  const res = await fetch(base + path, { credentials: "include" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

function day(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function paintIdentity(user) {
  const av = $("acct-avatar");
  if (user.avatarUrl && /^https:\/\//.test(user.avatarUrl)) {
    const img = document.createElement("img");
    img.src = user.avatarUrl;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => { av.textContent = initials(user.handle); img.remove(); });
    av.replaceChildren(img);
  } else {
    av.textContent = initials(user.handle);
  }
  $("acct-name").textContent = user.displayName || user.handle;
  $("acct-verified").innerHTML = user.emailVerified ? L("✓ Email verified", "✓ 邮箱已验证") : L("Email not verified", "邮箱未验证");
  $("acct-verified").classList.toggle("warn", !user.emailVerified);
  $("acct-joined").innerHTML = user.createdAt ? `${L("Joined", "加入于")} ${esc(day(user.createdAt))}` : "";
}

function paintForum(raw) {
  const f = forumSummary(raw);
  const state = forumState(f);
  if (state === "unavailable") {
    $("forum-level").innerHTML = "—";
    $("forum-level-note").innerHTML = L("Community figures are unavailable right now.", "暂时无法获取社区数据。");
    return;
  }
  if (state === "empty") {
    $("forum-level").innerHTML = L("Not started", "尚未参与");
    $("forum-level-note").innerHTML = L("Post your first topic or reply to join the community.", "发一个话题或回复，加入社区。");
    return;
  }
  const name = trustName(f.trust);
  $("forum-level").innerHTML = name ? `L${f.trust} · ${L(name[0], name[1])}` : "—";
  $("forum-level-note").innerHTML = f.role === "admin" ? L("Administrator", "管理员") : f.role === "moderator" ? L("Moderator", "版主") : "";
  $("st-topics").textContent = num(f.topics);
  $("st-posts").textContent = num(f.posts);
  $("st-likes").textContent = num(f.likesReceived);
  $("st-solved").textContent = num(f.solved);
  const perms = [];
  if (f.dailyPostCap !== null) perms.push(L(`Up to ${f.dailyPostCap} posts a day`, `每天最多发 ${f.dailyPostCap} 条`));
  perms.push(f.canPostLinks ? L("Links allowed", "可以发链接") : L("Links unlock at the next level", "升到下一级后可发链接"));
  if (f.silencedUntil) perms.push(L(`Restricted until ${day(f.silencedUntil)}`, `发帖受限至 ${day(f.silencedUntil)}`));
  $("forum-perms").innerHTML = perms.join(" · ");
  $("forum-recent").innerHTML = f.recent.map((r) => `<li><a href="/community/topic/?id=${r.id}">${esc(r.title)}</a><span>${Number.isInteger(r.replyCount) ? r.replyCount : 0} ${r.replyCount === 1 ? L("reply", "回复") : L("replies", "回复")}</span></li>`).join("");
}

function paintDevices(raw) {
  const d = deviceSummary(raw);
  $("dev-total").textContent = String(d.total);
  $("dev-online").innerHTML = d.online === null ? L("Online status is unavailable right now.", "暂时无法获取在线状态。") : L(`${d.online} online now`, `${d.online} 台在线`);
}

document.addEventListener("account:ready", (e) => {
  paintIdentity(e.detail);
  get(FORUM, "/me").then(paintForum).catch(() => paintForum(null));
  get(ACCOUNTS, "/me/devices").then(paintDevices).catch(() => { $("dev-total").textContent = "—"; });
  get(ACCOUNTS, "/me/backups").then((d) => { $("bk-total").textContent = num(backupCount(d)); }).catch(() => {});
});
