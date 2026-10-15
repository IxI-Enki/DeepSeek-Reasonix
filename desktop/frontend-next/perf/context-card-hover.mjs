// The context card opens on hover and holds buttons (compress now, manage MCP).
// Reaching them means crossing the gap between the meter and the card; a card
// that closes while the pointer is in that gap can never be used. Hover is a
// layout question, so it is asked of a real browser, with the pointer moving
// the way a hand does: in steps, through the gap.
import { chromium } from "playwright";

const BASE = process.env.PERF_URL ?? "http://localhost:4399/perf.html";
const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) fails.push(name);
};

const browser = await chromium.launch();
try {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme, locale: "zh-CN" });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector(".studio-meter-context", { timeout: 20000 });
    const trigger = page.locator(".studio-meter-context").first();
    const tb = await trigger.boundingBox();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await page.waitForTimeout(250);
    const card = page.locator(".studio-context-anchor .chrome-context-card");
    check(`${scheme}: the card opens while the pointer is on the meter`, await card.isVisible());
    const target = card.locator("button, a").first();
    const cb = await target.boundingBox();
    // Up through the gap in small steps, then onto the card's own control.
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, { steps: 40 });
    await page.waitForTimeout(250);
    check(`${scheme}: the card is still open after crossing the gap`, await card.isVisible());
    const hit = await target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at === el || el.contains(at);
    });
    check(`${scheme}: its first control takes the pointer`, hit);
    await ctx.close();
  }
} finally {
  await browser.close();
}
if (fails.length) {
  console.error(`\n${fails.length} failed: ${fails.join("; ")}`);
  process.exit(1);
}
console.log("\nall passed");
