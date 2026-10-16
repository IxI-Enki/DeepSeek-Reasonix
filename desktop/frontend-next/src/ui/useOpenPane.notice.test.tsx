// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { setOpenSessionLimit } from "../state/prefs";
import { clearToasts, readToasts } from "../state/toasts";
import type { RuntimeView } from "../port/hub";
import type { AgentPort } from "../port/port";
import type { PaneReport } from "./Pane";
import { useOpenPane } from "./useOpenPane";

beforeEach(() => { localStorage.clear(); clearToasts(); });
afterEach(() => clearToasts());

const view = (n: number, root = "/w", sessionPath = `${root}/s${n}.jsonl`): RuntimeView => ({ id: `r${n}`, root, name: "w", sessionPath }) as RuntimeView;
const titled = (title: string) => ({ title }) as PaneReport;

function window(runtimes: RuntimeView[], reports: Record<string, PaneReport> = {}) {
  const resume = vi.fn(async () => {});
  const panePorts = new Map(runtimes.map((rt) => [rt.id, { resume } as unknown as AgentPort]));
  let next = runtimes.length;
  const hub = {
    open: vi.fn(async (req: { root?: string; sessionPath?: string }) => ({ id: `r${next++}`, root: req.root ?? "/w", name: "w", sessionPath: req.sessionPath }) as RuntimeView),
    close: vi.fn(async () => {}),
  };
  const sw = { path: "", pending: false, opening: () => false, begin: () => 1, current: () => true, landed: () => {}, end: () => {}, cancel: () => {} };
  const hook = renderHook(() =>
    useOpenPane({
      hub: hub as never, runtimes, panePorts, active: "r0",
      reportsRef: { current: reports }, runsRef: { current: {} },
      setRuntimes: vi.fn(), setActive: vi.fn(), setTakeover: vi.fn(), reloadPanes: async () => {}, sw,
    }),
  );
  const open = (path: string, root = "/w") => act(async () => void (await hook.result.current({ root, sessionPath: path })));
  return { hub, resume, open };
}

const four = () => Array.from({ length: 4 }, (_, i) => view(i));

describe("telling the person which session a full window folded away", () => {
  it("names the session whose pane was reused, the number that caused it, and that the conversation is still in the list", async () => {
    setOpenSessionLimit(4);
    const w = window(four(), { r1: titled("修复登录失败") });
    await w.open("/w/new.jsonl");
    const notes = readToasts();
    expect(notes).toHaveLength(1);
    expect(notes[0].tone).toBe("note");
    expect(notes[0].text).toContain("「修复登录失败」");
    expect(notes[0].text).toContain("4");
    expect(notes[0].text).toContain("对话仍在列表里");
  });

  it("says the same when the pane it closed belonged to another folder", async () => {
    setOpenSessionLimit(8);
    const w = window(Array.from({ length: 8 }, (_, i) => view(i)), { r1: titled("另一个项目里的会话") });
    await w.open("/other/new.jsonl", "/other");
    expect(w.hub.close).toHaveBeenCalledWith("r1");
    expect(readToasts().map((n) => n.text).join("\n")).toContain("「另一个项目里的会话」");
  });

  it("stays silent by default, where nothing is ever folded", async () => {
    const w = window(Array.from({ length: 9 }, (_, i) => view(i)));
    await w.open("/w/new.jsonl");
    expect(readToasts()).toHaveLength(0);
  });

  it("stays silent below the number the person chose", async () => {
    setOpenSessionLimit(6);
    const w = window(four());
    await w.open("/w/new.jsonl");
    expect(readToasts()).toHaveLength(0);
  });

  it("stays silent when the pane it takes over holds no conversation", async () => {
    setOpenSessionLimit(4);
    const runtimes = [view(0), view(1, "/w", ""), view(2), view(3)];
    const w = window(runtimes);
    await w.open("/other/new.jsonl", "/other");
    expect(w.hub.close).toHaveBeenCalledWith("r1");
    expect(readToasts()).toHaveLength(0);
  });

  it("falls back to a plain word when the folded session has no title yet", async () => {
    setOpenSessionLimit(4);
    const w = window(four());
    await w.open("/w/new.jsonl");
    expect(readToasts()[0].text).toContain("「新会话」");
  });
});
