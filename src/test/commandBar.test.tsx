/**
 * P1-7a — the typed command bar's own component tests (brief §9, C1-C10).
 *
 * UNMOCKED. Lane A's `src/lib/command/parse.ts` and `resolve.ts` had already
 * landed real bodies (no more `"not implemented"`) by the time this lane
 * finished, so this file drives `CommandBar` against the REAL
 * `parseCommand`/`formatCommand`/`expectedShape`/`resolveCommand`/
 * `describeQuestion` — the mocked version the brief's "Working before Lane A
 * lands" section describes was not needed as the committed test. `ctx` is the
 * §5 fixture, verbatim (window, nodes, operators, products, run1).
 *
 * `CommandBar` itself holds no rule (§2, "no second door") -- it only turns
 * those two modules' answers into a text box, a status line and some buttons,
 * so this file is a thin behavioural test over that wiring, not a second copy
 * of `commandParse.test.ts`/`commandResolve.test.ts`'s own case tables.
 *
 * Same shape as `settingsPanel.test.tsx`: `@testing-library/react` + jsdom.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { formatDayLabel } from "@/features/board/lib/time";
import { formatCommand, type AssignCommand } from "@/lib/command/parse";
import type { ResolveContext, ResolvedCommand, ContextRun } from "@/lib/command/resolve";
import { CommandBar } from "@/features/board/components/CommandBar";

/** Brief §5's fixture, verbatim: a 7-day window from Monday 2026-08-31,
 *  today = index 3 (Thursday 2026-09-03), the plain (no-changeover) stub. */
function buildCtx(over: Partial<ResolveContext> = {}): ResolveContext {
  const nodes = [
    { id: "p1", name: "Plant 1", path: "plant_1" },
    { id: "asm", name: "Assembly", path: "plant_1.assembly" },
    { id: "l1", name: "Line 1", path: "plant_1.assembly.line_1" },
    { id: "l3", name: "Line 3", path: "plant_1.assembly.line_3" },
    { id: "c1a", name: "Cell 1", path: "plant_1.assembly.line_1.cell_1" },
    { id: "c2", name: "Cell 2", path: "plant_1.assembly.line_1.cell_2" },
    { id: "c1b", name: "Cell 1", path: "plant_1.assembly.line_3.cell_1" },
  ];
  return {
    cells: [nodes[4], nodes[5], nodes[6]],
    nodeById: new Map(nodes.map((n) => [n.id, n] as const)),
    operators: [
      { id: "op1", displayName: "Operator 1", employeeRef: "E100", active: true },
      { id: "sp", displayName: "Sam Patel", employeeRef: null, active: true },
      { id: "so", displayName: "Sam Ortiz", employeeRef: "E200", active: true },
      { id: "lin", displayName: "Lin On", employeeRef: null, active: true },
      { id: "gone", displayName: "Sam Gone", employeeRef: null, active: false },
    ],
    products: [
      { id: "ha", sku: "HA-1", name: "Housing A" },
      { id: "hb", sku: "HB-1", name: "Housing B" },
      { id: "cov", sku: "CV-9", name: "Cover" },
    ],
    offeredAt: (nodeId: string) =>
      nodeId === "c1b" ? [{ id: "cov" }] : [{ id: "ha" }, { id: "hb" }],
    days: [
      { index: 0, iso: "2026-08-31", weekday: 1 },
      { index: 1, iso: "2026-09-01", weekday: 2 },
      { index: 2, iso: "2026-09-02", weekday: 3 },
      { index: 3, iso: "2026-09-03", weekday: 4 },
      { index: 4, iso: "2026-09-04", weekday: 5 },
      { index: 5, iso: "2026-09-05", weekday: 6 },
      { index: 6, iso: "2026-09-06", weekday: 0 },
    ],
    todayIndex: 3,
    wallToOffset: (d: number, m: number) => d * 1440 + m,
    runs: [],
    fitsRun: (a, r) => a.startMin >= r.startMin && a.endMin <= r.endMin,
    minDurationMinutes: 15,
    ...over,
  };
}

/** R27's run: Housing A 08:00-16:00 on Cell 1 (c1a), Thursday (day index 3). */
const RUN1: ContextRun = {
  id: "run1",
  nodeId: "c1a",
  productId: "ha",
  startMin: 3 * 1440 + 480,
  endMin: 3 * 1440 + 960,
  label: "Housing A 08:00–16:00",
};

const P1_SENTENCE = "Assign Operator 1 to Housing A on Cell 1 in Line 1 from 10 to 2";
const SHAPE =
  "Say it like: assign <person> to <part> on <cell> [in <line>] [on <day>] from <time> to <time>";

function renderBar(over: Partial<ResolveContext> = {}) {
  const onOpen = vi.fn();
  render(<CommandBar ctx={buildCtx(over)} dateFormat="d_mon_yyyy" zone="UTC" onOpen={onOpen} />);
  const input = screen.getByRole("textbox", { name: "Tell the board" }) as HTMLInputElement;
  return { onOpen, input };
}

/** The one `aria-live="polite"` status element (brief §6). */
function statusText(): string {
  return document.querySelector('[aria-live="polite"]')?.textContent ?? "";
}

describe("CommandBar (P1-7a, brief §9)", () => {
  it("C1: the input has the accessible name 'Tell the board' and the example placeholder", () => {
    const { input } = renderBar();
    expect(input.placeholder).toBe("Assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2");
  });

  it("C2: a resolvable sentence opens the popover and shows the readout with the day rendered", () => {
    const { onOpen, input } = renderBar({ runs: [] });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.nodeId).toBe("c1a");
    expect(resolved.operatorId).toBe("op1");
    expect(resolved.target).toEqual({ kind: "direct", productId: "ha" });
    expect(resolved.range).toEqual({ startMin: 3 * 1440 + 600, endMin: 3 * 1440 + 840 });

    const dayLabel = formatDayLabel(new Date("2026-09-03T00:00:00Z"), "d_mon_yyyy", "UTC");
    const status = statusText();
    expect(status).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(status).toContain(dayLabel);
    expect(status).toBe(
      `Operator 1 → Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · ${dayLabel} · 10:00–14:00`,
    );
  });

  it("C3: an ambiguous operator shows the question and both candidates, and opens nothing", () => {
    const { onOpen, input } = renderBar();

    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe('Which person? "Sam" matches 2:');
    expect(screen.getByRole("button", { name: "Sam Patel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sam Ortiz" })).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("C4: clicking a candidate rewrites the input and resolves the chosen person", () => {
    const { onOpen, input } = renderBar();
    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Sam Patel" }));

    const expectedCommand: AssignCommand = {
      intent: "assign",
      operator: "Sam Patel",
      product: "Housing A",
      place: ["Cell 1", "Line 1"],
      day: null,
      start: { hour: 10, minute: 0 },
      end: { hour: 14, minute: 0 },
      attach: null,
    };
    expect(input.value).toBe(formatCommand(expectedCommand));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.operatorId).toBe("sp");
  });

  it("C5: an empty Enter shows the expected shape and calls nothing", () => {
    const { onOpen, input } = renderBar();

    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(SHAPE);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("C6: a bad time shows 'I could not read \"10:75\".' before the shape", () => {
    const { input } = renderBar();

    fireEvent.change(input, {
      target: { value: "assign Sam to Housing A on Cell 1 from 10:75 to 2" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(`I could not read "10:75". ${SHAPE}`);
  });

  it("C7: Escape once clears the status line and keeps the input; Escape twice clears the input", () => {
    const { input } = renderBar();

    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusText()).toBe(SHAPE);
    expect(input.value).toBe("gibberish");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(statusText()).toBe("");
    expect(input.value).toBe("gibberish");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });

  it("C8: onOpen's anchor is the input's bounding-rect bottom-left", () => {
    const { onOpen, input } = renderBar();
    input.getBoundingClientRect = () =>
      ({ left: 123, bottom: 456, top: 0, right: 0, width: 0, height: 0 }) as DOMRect;

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledTimes(1);
    const [, anchor] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(anchor).toEqual({ x: 123, y: 456 });
  });

  it("C9: a span landing inside an existing run asks to join it, verbatim, with both buttons", () => {
    const { onOpen, input } = renderBar({ runs: [RUN1] });

    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(statusText()).toBe(
      "A Housing A job is already booked on Cell 1, Housing A 08:00–16:00. Join it, or make a separate block?",
    );
    expect(screen.getByRole("button", { name: "Housing A 08:00–16:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Separate block" })).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("C10: joining the run sends the run target, unchanged input; Separate block sends direct", () => {
    const { onOpen, input } = renderBar({ runs: [RUN1] });
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Housing A 08:00–16:00" }));

    expect(input.value).toBe(P1_SENTENCE);
    expect(onOpen).toHaveBeenCalledTimes(1);
    const [resolved] = onOpen.mock.calls[0] as [ResolvedCommand, { x: number; y: number }];
    expect(resolved.target).toEqual({ kind: "run", runId: "run1" });
    expect(resolved.readout.endsWith("· joining Housing A 08:00–16:00")).toBe(true);

    cleanup();
    const second = renderBar({ runs: [RUN1] });
    fireEvent.change(second.input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(second.input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Separate block" }));

    expect(second.onOpen).toHaveBeenCalledTimes(1);
    const [resolvedDirect] = second.onOpen.mock.calls[0] as [
      ResolvedCommand,
      { x: number; y: number },
    ];
    expect(resolvedDirect.target).toEqual({ kind: "direct", productId: "ha" });
  });
});
