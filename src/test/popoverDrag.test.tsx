/**
 * DRAGGING A POP-UP ASIDE (R-344 / S38).
 *
 * The maintainer, verbatim: "The pop window cannot be moved across the screen
 * to see what's underneath, can we be able to move stuff?" Every pop-up in the
 * app is the one shared shell (`popoverStandard.test.ts` fails the build if a
 * second one appears), so these cases are written against that shell and cover
 * all of them at once.
 *
 * Each case is one clause of the requirement as a person experiences it: press
 * the title and the box follows the pointer; let go and it stays; a press that
 * did not move changes nothing; the box cannot be dragged off screen; Escape
 * still closes it afterwards; and the NEXT pop-up opens where its anchor says
 * rather than where the last one was left.
 *
 * TWO PIECES OF SCAFFOLDING, both because jsdom is not a browser:
 *   - jsdom 25 has no `PointerEvent`, and @testing-library/dom silently falls
 *     back to a plain `Event` when the constructor is missing -- which drops
 *     `clientX`/`clientY`, so every drag would look like a zero-pixel move and
 *     every case here would pass for the wrong reason. The polyfill below is a
 *     `MouseEvent` carrying `pointerId`/`pointerType`.
 *   - `getBoundingClientRect` returns zeroes in jsdom, so the shell would
 *     measure a 0x0 box and the edge clamp would have nothing to clamp. It is
 *     stubbed to a real size, the way a browser reports one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Popover } from "@/components/Popover";

const BOX = { width: 200, height: 150 };

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

function setViewport(width: number, height: number): void {
  window.innerWidth = width;
  window.innerHeight = height;
}

/** left/top as the browser would report them, as plain numbers. */
function positionOf(el: HTMLElement): { left: number; top: number } {
  return { left: parseFloat(el.style.left), top: parseFloat(el.style.top) };
}

function drag(handle: HTMLElement, from: { x: number; y: number }, by: { x: number; y: number }) {
  fireEvent.pointerDown(handle, {
    pointerId: 7,
    pointerType: "mouse",
    button: 0,
    clientX: from.x,
    clientY: from.y,
  });
  fireEvent.pointerMove(handle, {
    pointerId: 7,
    pointerType: "mouse",
    clientX: from.x + by.x,
    clientY: from.y + by.y,
  });
  fireEvent.pointerUp(handle, {
    pointerId: 7,
    pointerType: "mouse",
    clientX: from.x + by.x,
    clientY: from.y + by.y,
  });
}

let originalPointerEvent: unknown;

beforeEach(() => {
  originalPointerEvent = (window as unknown as Record<string, unknown>).PointerEvent;
  (window as unknown as Record<string, unknown>).PointerEvent = TestPointerEvent;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        width: BOX.width,
        height: BOX.height,
        top: 0,
        left: 0,
        right: BOX.width,
        bottom: BOX.height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  setViewport(1024, 768);
});

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as Record<string, unknown>).PointerEvent = originalPointerEvent;
});

function open(anchor: { x: number; y: number }, onClose = () => {}) {
  return render(
    <Popover anchor={anchor} onClose={onClose} title="Set shift">
      <button type="button">Save</button>
    </Popover>,
  );
}

describe("a pop-up can be dragged aside by its title (R-344)", () => {
  it("moves by exactly the distance the pointer travelled", () => {
    open({ x: 100, y: 100 });
    const dialog = screen.getByRole("dialog");
    const before = positionOf(dialog);

    drag(screen.getByRole("heading", { name: "Set shift" }), { x: 120, y: 110 }, { x: 40, y: 25 });

    expect(positionOf(dialog)).toEqual({ left: before.left + 40, top: before.top + 25 });
  });

  it("stays where it was put after the pointer is released", () => {
    open({ x: 100, y: 100 });
    const dialog = screen.getByRole("dialog");
    const handle = screen.getByRole("heading", { name: "Set shift" });
    const before = positionOf(dialog);

    drag(handle, { x: 120, y: 110 }, { x: 40, y: 25 });
    const afterDrag = positionOf(dialog);
    // A later pointermove with no button down must not keep moving it.
    fireEvent.pointerMove(handle, {
      pointerId: 7,
      pointerType: "mouse",
      clientX: 900,
      clientY: 700,
    });

    expect(afterDrag).toEqual({ left: before.left + 40, top: before.top + 25 });
    expect(positionOf(dialog)).toEqual(afterDrag);
  });

  it("does not move for a press that never moved -- a click on the title is not a drag", () => {
    open({ x: 100, y: 100 });
    const dialog = screen.getByRole("dialog");
    const handle = screen.getByRole("heading", { name: "Set shift" });
    const before = positionOf(dialog);

    fireEvent.pointerDown(handle, {
      pointerId: 7,
      pointerType: "mouse",
      button: 0,
      clientX: 120,
      clientY: 110,
    });
    fireEvent.pointerUp(handle, {
      pointerId: 7,
      pointerType: "mouse",
      clientX: 120,
      clientY: 110,
    });

    expect(positionOf(dialog)).toEqual(before);
  });

  it("cannot be dragged off the right or bottom edge", () => {
    setViewport(400, 300);
    open({ x: 100, y: 100 });
    const dialog = screen.getByRole("dialog");

    drag(
      screen.getByRole("heading", { name: "Set shift" }),
      { x: 120, y: 110 },
      { x: 900, y: 900 },
    );

    // margin 10, box 200x150: the far edge is 400-200-10 and 300-150-10.
    expect(positionOf(dialog)).toEqual({ left: 190, top: 140 });
  });

  it("cannot be dragged off the left or top edge", () => {
    setViewport(400, 300);
    open({ x: 100, y: 100 });
    const dialog = screen.getByRole("dialog");

    drag(
      screen.getByRole("heading", { name: "Set shift" }),
      { x: 120, y: 110 },
      { x: -900, y: -900 },
    );

    expect(positionOf(dialog)).toEqual({ left: 10, top: 10 });
  });

  it("comes back after being shoved past an edge -- the overshoot is not remembered", () => {
    setViewport(400, 300);
    open({ x: 100, y: 100 });
    const dialog = screen.getByRole("dialog");
    const handle = screen.getByRole("heading", { name: "Set shift" });
    drag(handle, { x: 120, y: 110 }, { x: -900, y: 0 });
    expect(positionOf(dialog).left).toBe(10);
    // The next drag starts from where the box IS, not from 900px off screen.
    drag(handle, { x: 20, y: 110 }, { x: 60, y: 0 });
    expect(positionOf(dialog).left).toBe(70);
  });

  it("still closes on Escape after being dragged", () => {
    const onClose = vi.fn();
    open({ x: 100, y: 100 }, onClose);

    drag(screen.getByRole("heading", { name: "Set shift" }), { x: 120, y: 110 }, { x: 40, y: 25 });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens the next pop-up where its anchor says, not where the last one was dragged", () => {
    const { rerender } = open({ x: 100, y: 100 });
    const dialog = screen.getByRole("dialog");
    const placed = positionOf(dialog);

    drag(screen.getByRole("heading", { name: "Set shift" }), { x: 120, y: 110 }, { x: 40, y: 25 });
    expect(positionOf(dialog).left).toBe(placed.left + 40);

    rerender(
      <Popover anchor={{ x: 300, y: 200 }} onClose={() => {}} title="Set shift">
        <button type="button">Save</button>
      </Popover>,
    );

    // The new anchor's own placement, with no leftover drag in it.
    expect(positionOf(screen.getByRole("dialog"))).toEqual({ left: 300, top: 208 });
  });
});
