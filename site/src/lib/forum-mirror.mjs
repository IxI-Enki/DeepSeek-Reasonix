// A forum thread with source "github" is a mirror of a GitHub Discussion: its text
// is GitHub's, so the page shows where it lives instead of a reply box.
export const DISCUSSIONS_URL = "https://github.com/esengine/DeepSeek-Reasonix/discussions";

export function mirrorOf(topic) {
  if (!topic || topic.source !== "github") return null;
  const url = Number.isInteger(topic.ghNumber) && topic.ghNumber > 0 ? `${DISCUSSIONS_URL}/${topic.ghNumber}` : DISCUSSIONS_URL;
  const status = ["recorded", "in_progress", "fixed"].includes(topic.ghStatus) ? topic.ghStatus : null;
  const version = status === "fixed" && typeof topic.fixedIn === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(topic.fixedIn) ? topic.fixedIn : null;
  return { url, status, version };
}

const LABELS = {
  recorded: ["Recorded", "已记录"],
  in_progress: ["In progress", "处理中"],
  fixed: ["Fixed", "已修复"],
};

// [en, zh] for the status badge, with the shipped version when there is one.
export function statusText(mirror) {
  if (!mirror?.status) return null;
  const [en, zh] = LABELS[mirror.status];
  return mirror.version ? [`${en} in v${mirror.version.replace(/^v/, "")}`, `${zh}于 v${mirror.version.replace(/^v/, "")}`] : [en, zh];
}
