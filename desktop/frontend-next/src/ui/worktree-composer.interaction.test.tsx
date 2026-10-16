// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";
import { MockPort } from "../port/mock";
import type { SessionStatus } from "../port/port";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

function draw(fresh = true) {
  const port = new MockPort();
  vi.spyOn(port, "status").mockResolvedValue({ workspaceRoot: "~/projects/DeepSeek-Reasonix" } as SessionStatus);
  const isolate = vi.spyOn(port, "isolateWorkspace").mockResolvedValue();
  const submit = vi.fn(async () => true);
  const error = vi.fn();
  const status = { workspaceRoot: "/work/demo", modelRef: "deepseek/deepseek-v4-pro", preset: "balanced", toolApprovalMode: "ask", plan: false } as SessionStatus;
  render(<Composer port={port} status={status} running={false} fresh={fresh} git={{ repo: true, name: "demo", branch: "main", detached: false, added: 0, removed: 0, untracked: 0 }} onSubmit={submit} onChanged={vi.fn()} onTreeChanged={vi.fn()} onError={error} />);
  return { port, isolate, submit, error };
}

async function choose() {
  fireEvent.click(await screen.findByRole("button", { name: "配置工作目录" }));
  fireEvent.click(screen.getByRole("switch", { name: "新建 worktree" }));
  fireEvent.click(screen.getByRole("button", { name: /起始分支/ }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "studio" } });
  fireEvent.click(screen.getByRole("option", { name: /studio/ }));
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.change(screen.getByRole("combobox", { name: "任务输入" }), { target: { value: "添加搜索功能" } });
}

it("selects a source without switching the checkout and creates only when sending", async () => {
  const { port, isolate, submit } = draw();
  const switchBranch = vi.spyOn(port, "switchBranch");
  expect((await screen.findByRole("button", { name: "配置工作目录" })).closest(".turntools")).not.toBeNull();
  await choose();
  expect(isolate).not.toHaveBeenCalled();
  expect(switchBranch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith("添加搜索功能"));
  expect(isolate).toHaveBeenCalledExactlyOnceWith({ ref: "refs/heads/studio", sourceRoot: "~/projects/DeepSeek-Reasonix" });
  expect(isolate.mock.invocationCallOrder[0]).toBeLessThan(submit.mock.invocationCallOrder[0]);
});

it("restores the draft on creation failure and retries without submitting in the source", async () => {
  const { isolate, submit } = draw();
  isolate.mockRejectedValueOnce(new Error("disk full"));
  await choose();
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect((screen.getByRole("combobox", { name: "任务输入" }) as HTMLTextAreaElement).value).toBe("添加搜索功能"));
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(isolate).toHaveBeenCalledTimes(2);
});

it("reuses the prepared worktree when the first submission is refused", async () => {
  const { isolate, submit } = draw();
  submit.mockResolvedValueOnce(false);
  await choose();
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect((screen.getByRole("combobox", { name: "任务输入" }) as HTMLTextAreaElement).value).toBe("添加搜索功能"));
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(isolate).toHaveBeenCalledOnce();
});

it("retains the branch switcher for existing conversations", async () => {
  const { port } = draw(false);
  expect(screen.queryByRole("button", { name: "配置工作目录" })).toBeNull();
  expect(screen.getByRole("button", { name: /当前 Git 分支/ }).closest(".turntools")).not.toBeNull();
  expect(vi.spyOn(port, "worktreeSources")).not.toHaveBeenCalled();
});
