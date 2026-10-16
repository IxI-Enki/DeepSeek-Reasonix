// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "./testkit";
import { PeersSwitch } from "./PeersSwitch";
import { MockPort } from "../port/mock";
import type { AgentPort } from "../port/port";

afterEach(cleanup);

const toggle = () => screen.findByRole("switch", { name: "会话间消息" });

describe("the messages-between-sessions switch", () => {
  it("starts off, says what it does and when it takes effect, and saves the opposite of what it shows", async () => {
    const p = new MockPort() as unknown as AgentPort;
    const save = vi.spyOn(p, "savePeersSettings");
    render(<PeersSwitch port={p} />);
    const sw = await toggle();
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/list_peers 和 send_peer_message/)).toBeTruthy();
    expect(screen.getByText(/只对之后新开的会话生效/)).toBeTruthy();
    await userEvent.click(sw);
    expect(save).toHaveBeenCalledWith(true);
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    await userEvent.click(sw);
    expect(save).toHaveBeenLastCalledWith(false);
  });

  it("keeps the switch where it was when the save is refused", async () => {
    const p = new MockPort() as unknown as AgentPort;
    p.savePeersSettings = async () => {
      throw new Error("disk full");
    };
    render(<PeersSwitch port={p} />);
    const sw = await toggle();
    await userEvent.click(sw);
    await screen.findByText(/disk full/);
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("says so when the setting cannot be read", async () => {
    const p = new MockPort() as unknown as AgentPort;
    p.peersSettings = async () => {
      throw new Error("down");
    };
    render(<PeersSwitch port={p} />);
    expect(await screen.findByText(/无法读取会话间消息的设置/)).toBeTruthy();
  });
});
