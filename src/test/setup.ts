import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom has no ResizeObserver, which the shared `Popover` (src/components/Popover.tsx)
// observes to keep its edge-clamp in sync with `--chrome-scale`. A no-op stub lets
// any component that opens a popover render in a test; the observer's effect is
// browser geometry, not logic, and the placement math is unit-tested separately
// (placement.test.ts). Real browsers provide the real one.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom has no Pointer Events capture API at all (setPointerCapture /
// releasePointerCapture / hasPointerCapture are undefined on
// HTMLElement.prototype), which crashes any component using it (the tree/level
// drag rows call `el.setPointerCapture(e.pointerId)` on pointerdown). A minimal
// per-element capture-set stand-in: not real capture-routing (jsdom event
// dispatch does not honour it, i.e. a captured pointer's move events do not
// actually reroute to the capturing element the way a real browser's would),
// only enough for `hasPointerCapture` to answer correctly and for the calls
// not to throw. Components that need real re-routing still can't be tested
// this way; this only unblocks ones that merely call these three methods.
if (typeof HTMLElement.prototype.setPointerCapture !== "function") {
  const captured = new WeakMap<HTMLElement, Set<number>>();
  HTMLElement.prototype.setPointerCapture = function (pointerId: number) {
    if (!captured.has(this)) captured.set(this, new Set());
    captured.get(this)!.add(pointerId);
  };
  HTMLElement.prototype.releasePointerCapture = function (pointerId: number) {
    captured.get(this)?.delete(pointerId);
  };
  HTMLElement.prototype.hasPointerCapture = function (pointerId: number) {
    return captured.get(this)?.has(pointerId) ?? false;
  };
}

// jsdom also has no PointerEvent CLASS at all -- @testing-library/dom's
// fireEvent.pointerDown/Up/Move/Cancel construct `new window.PointerEvent(...)`
// (see event-map.js's EventType: "PointerEvent"), which throws
// ReferenceError/TypeError without this. Minimal MouseEvent subclass carrying
// the pointer-specific fields React and this codebase's handlers read
// (pointerId, pointerType, isPrimary); real browsers provide the full spec.
if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;
    width: number;
    height: number;
    pressure: number;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "mouse";
      this.isPrimary = params.isPrimary ?? true;
      this.width = params.width ?? 1;
      this.height = params.height ?? 1;
      this.pressure = params.pressure ?? 0;
    }
  }
  globalThis.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

afterEach(() => {
  cleanup();
});
