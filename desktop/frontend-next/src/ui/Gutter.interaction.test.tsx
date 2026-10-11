// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import "./testkit";
import { DOCK, Gutter } from "./Gutter";

const pointer = (type: string, x: number) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0 }) as MouseEvent & { pointerId: number };
const send = (el: Element, type: string, x: number) => {
  const ev = pointer(type, x);
  Object.defineProperty(ev, "pointerId", { value: 1 });
  fireEvent(el, ev);
};

function mount(open: boolean) {
  const onOpen = vi.fn();
  const onWidth = vi.fn();
  const view = render(
    <div className="app">
      <Gutter edge="r" span={DOCK} width={560} label="resize" open={open} onWidth={onWidth} onOpen={onOpen} />
    </div>,
  );
  const bar = view.container.querySelector(".gutter") as HTMLElement;
  const grip = bar.querySelector(".grip") as HTMLElement;
  return { onOpen, onWidth, bar, grip, app: view.container.querySelector(".app") as HTMLElement };
}

beforeEach(() => {
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(cleanup);

describe("a column's drag handle", () => {
  it("opens a shut column when its grip is clicked", () => {
    const { grip, onOpen, app } = mount(false);
    send(grip, "pointerdown", 500);
    send(grip, "pointerup", 500);
    fireEvent.click(grip);
    expect(onOpen).toHaveBeenCalledWith(true);
    expect(app.dataset.drag).toBeUndefined();
  });

  it("starts a drag from the grip only once the press has travelled", () => {
    const { grip, bar, app, onOpen } = mount(false);
    send(grip, "pointerdown", 500);
    send(grip, "pointermove", 498);
    expect(app.dataset.drag).toBeUndefined();
    send(grip, "pointermove", 380);
    expect(app.dataset.drag).toBe("pointer");
    send(bar, "pointermove", 370);
    send(bar, "pointerup", 370);
    expect(app.dataset.drag).toBeUndefined();
    expect(onOpen).toHaveBeenCalledWith(true);
  });

  it("still drags from the strip beside the grip", () => {
    const { bar, app, onWidth } = mount(true);
    send(bar, "pointerdown", 500);
    expect(app.dataset.drag).toBe("pointer");
    send(bar, "pointermove", 450);
    send(bar, "pointerup", 450);
    expect(onWidth).toHaveBeenCalled();
  });

  it("toggles from the keyboard", () => {
    const { bar, onOpen } = mount(true);
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(false);
  });
});
