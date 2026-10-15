// A forum thread with source "github" mirrors a GitHub Discussion, and one with source "feedback" mirrors an in-app report's issue: its text
// is GitHub's, so the page shows where it lives instead of a reply box.
export const DISCUSSIONS_URL = "https://github.com/esengine/DeepSeek-Reasonix/discussions";
export const ISSUES_URL = "https://github.com/esengine/DeepSeek-Reasonix/issues";

export function mirrorOf(topic) {
  if (!topic || (topic.source !== "github" && topic.source !== "feedback")) return null;
  const feedback = topic.source === "feedback";
  const base = feedback ? ISSUES_URL : DISCUSSIONS_URL;
  const url = Number.isInteger(topic.ghNumber) && topic.ghNumber > 0 ? `${base}/${topic.ghNumber}` : base;
  const status = ["recorded", "in_progress", "fixed"].includes(topic.ghStatus) ? topic.ghStatus : null;
  const version = status === "fixed" && typeof topic.fixedIn === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(topic.fixedIn) ? topic.fixedIn : null;
  return { url, status, version, feedback };
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
