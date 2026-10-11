import { describe, expect, it } from "vitest";
import { initialState, reduce, fromHistory } from "./session";
import { elapsed } from "../i18n/format";

const run = (done: object) => reduce(reduce(reduce(initialState, { kind: "turn_started" }), { kind: "message", text: "答复" }), { kind: "turn_done", ...done });

describe("the turn's run time", () => {
  it("is drawn after the answer on the kernel's figure, before the receipt", () => {
    const s = run({ workDurationMs: 65_000, receipt: { saysSomething: true, verdict: "done" } });
    expect(s.items.map((i) => i.t)).toEqual(["say", "worked", "receipt"]);
    expect(s.items[1]).toMatchObject({ t: "worked", ms: 65_000 });
  });

  it("is not invented when the kernel sent none", () => {
    expect(run({}).items.map((i) => i.t)).toEqual(["say"]);
    expect(run({ workDurationMs: 300 }).items.map((i) => i.t)).toEqual(["say"]);
  });

  it("comes back with the answer when the session is reopened", () => {
    const { items } = fromHistory([
      { role: "user", content: "问" },
      { role: "assistant", content: "答", workDurationMs: 83_000 },
      { role: "assistant", content: "旧会话没有记录" },
    ]);
    expect(items.map((i) => i.t)).toEqual(["user", "say", "worked", "say"]);
    expect(items[2]).toMatchObject({ t: "worked", ms: 83_000 });
  });
});

describe("elapsed", () => {
  it("rounds to seconds, then minutes and hours, dropping zero units", () => {
    expect(elapsed(0)).toBe("0s");
    expect(elapsed(59_400)).toBe("59s");
    expect(elapsed(60_000)).toBe("1m");
    expect(elapsed(65_000)).toBe("1m 5s");
    expect(elapsed(3_725_000)).toBe("1h 2m 5s");
    expect(elapsed(3_605_000)).toBe("1h 5s");
  });
});
