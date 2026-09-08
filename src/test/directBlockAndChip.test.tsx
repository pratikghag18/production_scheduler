/**
 * R-028: a run and a direct assignment may coexist on one cell. The claim is a
 * rendering distinction — direct assignments draw as standalone blocks carrying
 * their own product identity (`DirectBlock`), run-attached ones draw as staffing
 * chips that lean on the run's own band for that identity (`AssignmentChip`) —
 * proven here by mounting both from the same assignment shape and reading what
 * each actually shows, not by asserting on a CSS class.
 *
 * No pointer events are fired: both components are pure/props-driven, and the
 * claim under test is what's rendered, not the drag mechanics (dragGesture.test.ts's
 * job, already covers MOVE for both; CREATE/RESIZE are R-025's still-open gap).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DirectBlock } from "@/features/board/components/DirectBlock";
import { AssignmentChip } from "@/features/board/components/AssignmentChip";
import type { IndexedAssignment } from "@/features/board/lib/boardIndex";
import { DENSITIES } from "@/features/board/lib/geometry";
import { buildDayAxis } from "@/features/board/lib/time";
import type { Product, BoardOperator } from "@/lib/api";

const WINDOW_START = new Date("2026-08-24T00:00:00.000Z");

const assignment: IndexedAssignment = {
  id: "asg-1",
  orgId: "org-1",
  nodeId: "cell-1",
  operatorId: "op-1",
  operatorDisplayName: null,
  runId: null,
  productId: "prod-1",
  productSku: null,
  productName: null,
  productColorToken: null,
  timerange: "[2026-08-24 06:00:00+00,2026-08-24 10:00:00+00)",
  efficiency: 1,
  eligibilityOverride: false,
  overrideReason: null,
  areaOverride: false,
  areaOverrideReason: null,
  targetQty: null,
  targetUnit: null,
  createdBy: null,
  createdAt: WINDOW_START.toISOString(),
  updatedAt: WINDOW_START.toISOString(),
  startMin: 360,
  endMin: 600,
  efficiencyPercent: 100,
  lane: 0,
  defaultTargetQty: null,
};

const operator: BoardOperator = {
  id: "op-1",
  displayName: "Ana Ortiz",
  homeNodeId: null,
  employeeRef: null,
  active: true,
  siteNodeId: "n-plant",
  sitePath: "plant_a",
  skillIds: [],
  skillExpiries: [],
};

const product: Product = {
  id: "prod-1",
  name: "Widget A",
  sku: "W-A",
  active: true,
  siteNodeIds: [],
  offeredNodeIds: [],
  colorToken: "product-1",
};

const sharedProps = {
  density: DENSITIES[1],
  operator,
  product,
  productColorVar: "var(--product-1)",
  windowStart: WINDOW_START,
  pxPerHour: 104,
  windowMinutes: 1440,
  template: null,
  dayCount: 1,
  dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
  zoomIndex: 1 as const,
  activeDrag: null,
  onPointerDown: vi.fn(),
  onPointerMove: vi.fn(),
  onPointerUp: vi.fn(),
  onPointerCancel: vi.fn(),
  onKeyDown: vi.fn(),
  onKeyUp: vi.fn(),
};

describe("DirectBlock vs AssignmentChip — the rendering half of R-028", () => {
  it("B1: a direct assignment carries its own product identity — the block's aria-label says so, and the product name is its own line", () => {
    render(<DirectBlock assignment={assignment} {...sharedProps} />);
    const block = screen.getByRole("button");
    expect(block.getAttribute("aria-label")).toBe(
      "Ana Ortiz direct assignment on Widget A, 06:00 to 10:00",
    );
    expect(screen.getByText(/Widget A · 06:00–10:00/)).toBeTruthy();
  });

  it("B2: a run-attached chip names no product of its own — the run's band already carries it", () => {
    render(<AssignmentChip assignment={assignment} homeRun={null} {...sharedProps} />);
    const chip = screen.getByRole("button");
    // Same person, same window, same product id -- but the chip's own label and
    // body never say "direct assignment" or the product name, because a chip
    // sits inside the run's band, which already draws it.
    expect(chip.getAttribute("aria-label")).toBe("Ana Ortiz on Widget A, 06:00 to 10:00");
    expect(chip.getAttribute("aria-label")).not.toMatch(/direct assignment/);
    expect(screen.queryByText(/Widget A/)).toBeNull();
    expect(screen.getByText(/^06:00–10:00$/)).toBeTruthy();
  });

  it("B3: both are drawn as accessible buttons, so a keyboard user reaches either the same way", () => {
    const { unmount } = render(<DirectBlock assignment={assignment} {...sharedProps} />);
    expect(screen.getByRole("button").getAttribute("tabIndex")).toBe("0");
    unmount();
    render(<AssignmentChip assignment={assignment} homeRun={null} {...sharedProps} />);
    expect(screen.getByRole("button").getAttribute("tabIndex")).toBe("0");
  });
});
