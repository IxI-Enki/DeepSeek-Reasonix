// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "./testkit";
import { PeerHeldBar } from "./PeerHeldBar";
import { MockPort } from "../port/mock";
import type { AgentPort, PeersState } from "../port/port";

afterEach(cleanup);

const held = { id: "m-1", fromSession: "s-1", fromTitle: "拾音", fromProject: "alpha", sentAt: "2026-10-16T12:00:00Z", body: "请核对第三节" };

class PeerPort extends MockPort {
  constructor(state: PeersState) {
    super();
    this.peerState = state;
  }
}
const port = (state: PeersState) => new PeerPort(state) as unknown as AgentPort;

describe("the held-message bar above the composer", () => {
  it("draws nothing when peers are off or nothing is held", async () => {
    const { container, rerender } = render(<PeerHeldBar port={port({ enabled: false, peers: [], held: [held] })} />);
    await waitFor(() => expect(container.querySelector(".peerbar")).toBeNull());
    rerender(<PeerHeldBar port={port({ enabled: true, peers: [], held: [] })} />);
    await waitFor(() => expect(container.querySelector(".peerbar")).toBeNull());
  });

  it("shows the first held message with its decision buttons and counts the rest", async () => {
    render(<PeerHeldBar port={port({ enabled: true, peers: [], held: [held, { ...held, id: "m-2", body: "第二条" }] })} />);
    expect(await screen.findByText("请核对第三节")).toBeTruthy();
    expect(screen.getByText(/还有 1 条等你决定/)).toBeTruthy();
    expect(screen.queryByText("第二条")).toBeNull();
  });

  it("labels the words as another session's and delivers them only on approval", async () => {
    const p = port({ enabled: true, peers: [], held: [held] });
    const resolve = vi.spyOn(p, "resolvePeerMessage");
    render(<PeerHeldBar port={p} />);
    expect(await screen.findByTitle(/不是你写的/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "批准并交给模型" }));
    expect(resolve).toHaveBeenCalledWith("m-1", true);
    await waitFor(() => expect(screen.queryByText("请核对第三节")).toBeNull());
  });

  it("refuses without delivering and shows a refusal from the kernel", async () => {
    const p = port({ enabled: true, peers: [], held: [held] });
    const resolve = vi.spyOn(p, "resolvePeerMessage");
    render(<PeerHeldBar port={p} />);
    await userEvent.click(await screen.findByRole("button", { name: "拒绝" }));
    expect(resolve).toHaveBeenCalledWith("m-1", false);
  });

  it("expands a clamped body", async () => {
    render(<PeerHeldBar port={port({ enabled: true, peers: [], held: [held] })} />);
    const body = await screen.findByText("请核对第三节");
    expect(body.hasAttribute("data-clamped")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(body.hasAttribute("data-clamped")).toBe(false);
  });
});
