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

afterEach(() => {
  cleanup();
});
