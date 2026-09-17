/**
 * S48-a — the corner launcher's own component tests (brief
 * docs/agent-briefs/s48-a-launcher-brief.md, R-396, CL-1..CL-9).
 *
 * `CommandLauncher` owns exactly one thing `CommandBar` did not already own:
 * whether the panel is open. Every case below either drives that (open/close,
 * the slash key, Escape's hand-off through `onEscapeIdle`, mousedown-outside)
 * or checks that closing does not have to ask the bar to tidy up first
 * (unmounting it is enough -- `commandBar.test.tsx`'s own CB-yes-6 already
 * proves the highlight cleanup fires on unmount; CL-6 here proves the SAME
 * fact reached through a close, not an Escape, inside this bar).
 *
 * CL-8/CL-9 (review fixes, added after first landing): CL-8 proves "Esc
 * closes" holds when focus is elsewhere in the panel (the mic button), not
 * only in the bar's own input -- the panel's own `onKeyDown`, not the bar's.
 * CL-9 proves `close` picks where focus goes next: back to the launcher
 * button for Escape and for a mousedown on inert board chrome, but NOT for a
 * mousedown on something outside that is itself focusable (the browser is
 * about to focus that element as part of the same click).
 *
 * `ctx`/`BLK1`/`UNASSIGN_SENTENCE` mirror `commandBar.test.tsx`'s own fixture
 * exactly (not imported -- that file exports none of it) since CL-6 needs a
 * real standing block question, not a mock.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ResolveContext, ContextRun, ContextAssignment } from "@/lib/command/resolve";
import type { Recognizer } from "@/lib/voice/recognizer";
import { CommandLauncher } from "@/features/board/components/CommandLauncher";

function findRunOverlap(
  range: { startMin: number; endMin: number },
  runs: ContextRun[],
  excludeRunId: string | null,
): ContextRun | null {
  for (const r of runs) {
    if (excludeRunId !== null && r.id === excludeRunId) continue;
    if (range.startMin < r.endMin && r.startMin < range.endMin) return r;
  }
  return null;
}

/** Same fixture as `commandBar.test.tsx`'s own `buildCtx` (brief §5). */
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
      // F-163 (CB-keep-5): a second person, so a several sentence can reach
      // the lot's own "Do all N" status in this file too.
      { id: "sp", displayName: "Sam Patel", employeeRef: "E101", active: true },
    ],
    products: [{ id: "ha", sku: "HA-1", name: "Housing A" }],
    offeredAt: () => [{ id: "ha" }],
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
    assignments: [],
    overlaps: (a, b) => a.startMin < b.endMin && b.startMin < a.endMin,
    findRunOverlap,
    shiftsAt: () => [],
    // S55 (D130 item 3): same defaults as `commandBar.test.tsx`'s own
    // `buildCtx` -- this file never touches a boundary shift name.
    nowMinuteOfDay: null,
    wallOf: (m: number) => ({ dayIndex: Math.floor(m / 1440), minuteOfDay: m % 1440 }),
    // S61-b (R-425, F-155): same defaults as `commandBar.test.tsx`'s own
    // `buildCtx` -- "fully eligible, no gaps", which keeps every case in
    // this file byte for byte its pre-R-425 behaviour (this file's own
    // scope is the launcher panel's open/close/focus, not certification).
    certificateGaps: () => [],
    eligibilityPolicy: () => "warn",
    ...over,
  };
}

/** R-385's fixture: Operator 1 / Housing A / Cell 1 (c1a), 10:00-14:00,
 *  Thursday (day index 3) -- the one block `UNASSIGN_SENTENCE` below names. */
const BLK1: ContextAssignment = {
  id: "blk1",
  nodeId: "c1a",
  operatorId: "op1",
  productId: "ha",
  productName: "Housing A",
  startMin: 3 * 1440 + 600,
  endMin: 3 * 1440 + 840,
  label: "10:00–14:00",
  runId: null,
};

const UNASSIGN_SENTENCE = "Unassign Operator 1 from Cell 1 in Line 1 from 10 to 2";

/** F-163 (CB-keep-5): BLK1's twin for Sam Patel -- the second block the lot
 *  sentence below names. */
const BLK_SP: ContextAssignment = { ...BLK1, id: "blkSp", operatorId: "sp" };
const LOT_REMOVE_SENTENCE = "Unassign Operator 1 and Sam Patel from Cell 1 in Line 1 from 10 to 2";

function renderLauncher(over: Partial<ResolveContext> = {}, recognizer: Recognizer | null = null) {
  const onOpen = vi.fn();
  const onRetime = vi.fn();
  const onBook = vi.fn();
  const onRetimeRun = vi.fn();
  const onUnassign = vi.fn();
  const onMove = vi.fn();
  // S58: required on `CommandBarProps`, unused by every case in this file --
  // none of them types a headcount sentence.
  const onSetHeadcount = vi.fn();
  const onHighlight = vi.fn();
  // S51: required on `CommandBarProps`, unused by every case in this file --
  // none of them types a several.
  const onRunLot = vi.fn(() => new Promise<never>(() => {}));
  render(
    <CommandLauncher
      ctx={buildCtx(over)}
      dateFormat="d_mon_yyyy"
      zone="UTC"
      recognizer={recognizer}
      onOpen={onOpen}
      onRetime={onRetime}
      onBook={onBook}
      onRetimeRun={onRetimeRun}
      onUnassign={onUnassign}
      onMove={onMove}
      onSetHeadcount={onSetHeadcount}
      onRunLot={onRunLot}
      onHighlight={onHighlight}
    />,
  );
  return { onOpen, onRetime, onBook, onRetimeRun, onUnassign, onMove, onSetHeadcount, onHighlight };
}

function launcherButton() {
  return screen.getByRole("button", { name: "Tell the board" });
}

function statusLine() {
  return document.querySelector('p[aria-live="polite"]');
}

describe("CommandLauncher (S48-a, R-396)", () => {
  it("CL-1: at rest, renders the button and no panel", () => {
    renderLauncher();
    expect(launcherButton()).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Tell the board" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Tell the board" })).toBeNull();
  });

  it("CL-2: pressing the button opens the panel with the bar's input focused", () => {
    renderLauncher();
    fireEvent.click(launcherButton());

    const dialog = screen.getByRole("dialog", { name: "Tell the board" });
    expect(dialog).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Tell the board" });
    expect(document.activeElement).toBe(input);
  });

  it("CL-3: the slash key opens the panel, but not while an input is focused", () => {
    render(<input aria-label="somewhere else" />);
    const other = screen.getByLabelText("somewhere else");
    other.focus();
    renderLauncher();

    fireEvent.keyDown(document, { key: "/" });
    expect(screen.queryByRole("dialog", { name: "Tell the board" })).toBeNull();

    other.blur();
    document.body.focus();
    fireEvent.keyDown(document, { key: "/" });
    expect(screen.getByRole("dialog", { name: "Tell the board" })).toBeTruthy();
  });

  it("CL-4: Escape with a status standing clears the status and keeps the panel; Escape again with empty input closes", () => {
    renderLauncher();
    fireEvent.click(launcherButton());
    const input = screen.getByRole("textbox", { name: "Tell the board" });

    // Enter on an empty input reads nothing and shows the shape hint --
    // exactly the "a status stands, input already empty" state CL-4 needs.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(statusLine()?.textContent).not.toBe("");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(statusLine()?.textContent).toBe("");
    expect(screen.getByRole("dialog", { name: "Tell the board" })).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Tell the board" })).toBeNull();
  });

  it("CL-5: a mousedown outside the panel and the button closes it, and (not itself focusable) refocuses the launcher button", () => {
    renderLauncher();
    fireEvent.click(launcherButton());
    expect(screen.getByRole("dialog", { name: "Tell the board" })).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Tell the board" })).toBeNull();
    expect(document.activeElement).toBe(launcherButton());
  });

  it("CL-5b: a mousedown inside a pop-up the bar opened (role=dialog) does not close the panel", () => {
    renderLauncher();
    fireEvent.click(launcherButton());
    expect(screen.getByRole("dialog", { name: "Tell the board" })).toBeTruthy();

    // Stands in for a `CreatePopover` and friends -- BoardPage renders those
    // as siblings, portaled through the shared `role="dialog"` shell.
    const otherDialog = document.createElement("div");
    otherDialog.setAttribute("role", "dialog");
    const inner = document.createElement("button");
    otherDialog.appendChild(inner);
    document.body.appendChild(otherDialog);

    fireEvent.mouseDown(inner);
    expect(screen.getByRole("dialog", { name: "Tell the board" })).toBeTruthy();

    document.body.removeChild(otherDialog);
  });

  it("CL-6: closing while a question stands calls onHighlight(null)", () => {
    const { onHighlight } = renderLauncher({ assignments: [BLK1] });
    fireEvent.click(launcherButton());
    const input = screen.getByRole("textbox", { name: "Tell the board" });

    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onHighlight).toHaveBeenLastCalledWith({ kind: "remove", assignmentIds: ["blk1"] });

    fireEvent.click(launcherButton());
    expect(screen.queryByRole("dialog", { name: "Tell the board" })).toBeNull();
    expect(onHighlight).toHaveBeenLastCalledWith(null);
  });

  it("CL-7: the button's aria-expanded tracks open/closed", () => {
    renderLauncher();
    expect(launcherButton().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(launcherButton());
    expect(launcherButton().getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(launcherButton());
    expect(launcherButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("CL-8: Escape whose target is not the bar's input still closes the panel (the panel's own rule), and unmounting the bar stops a listening session in flight", () => {
    const stop = vi.fn();
    const recognizer: Recognizer = () => ({ stop });
    renderLauncher({}, recognizer);
    fireEvent.click(launcherButton());
    const input = screen.getByRole("textbox", { name: "Tell the board" });

    // Text in the input (brief: "with text in the input and focus on the mic
    // button") -- CommandBar's own `onKeyDown` is bound to the input alone,
    // so an Escape whose target is the mic button never reaches it; only
    // this panel's own handler can act on it.
    fireEvent.change(input, { target: { value: "some text" } });

    const mic = screen.getByRole("button", { name: "Speak a sentence" });
    fireEvent.click(mic);
    mic.focus();
    expect(screen.getByText("Listening…")).toBeTruthy();

    fireEvent.keyDown(mic, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Tell the board" })).toBeNull();
    // Closing unmounted `CommandBar` outright -- its own S46-a unmount
    // cleanup stopped the in-flight session, proving the panel's Escape
    // rule did not have to know anything about listening to clear it.
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("CL-9: close() decides where focus goes next", () => {
    // Escape-idle (status already clear, input already empty) refocuses the
    // launcher button -- `onEscapeIdle={close}` with its default true.
    renderLauncher();
    fireEvent.click(launcherButton());
    const input = screen.getByRole("textbox", { name: "Tell the board" });
    fireEvent.keyDown(input, { key: "Enter" }); // shows the shape hint, input stays empty
    fireEvent.keyDown(input, { key: "Escape" }); // clears the status, panel stays open
    fireEvent.keyDown(input, { key: "Escape" }); // idle -- closes
    expect(screen.queryByRole("dialog", { name: "Tell the board" })).toBeNull();
    expect(document.activeElement).toBe(launcherButton());

    // A mousedown on something outside the panel that is ITSELF focusable
    // (a button, here standing in for a control on the board) is the one
    // exception: the browser is about to focus it as part of the same
    // click, so `close` must not fight it back to the launcher button.
    fireEvent.click(launcherButton());
    expect(screen.getByRole("dialog", { name: "Tell the board" })).toBeTruthy();
    render(<button type="button">Board chrome</button>);
    const outside = screen.getByRole("button", { name: "Board chrome" });
    outside.focus();

    fireEvent.mouseDown(outside);

    expect(screen.queryByRole("dialog", { name: "Tell the board" })).toBeNull();
    expect(document.activeElement).toBe(outside);
  });
});

// ---------------------------------------------------------------------------
// F-163 (the maintainer, 17 Sept): "The chatbot also vanished when I moved the
// slider something which you claimed would not happen." R-424 stopped
// `BoardPage` unmounting the bar for a refetch; it never touched THIS unmount
// -- the launcher closes its panel on any mousedown outside it, by design, and
// closing unmounted `CommandBar` with the whole conversation inside it. The
// conversation lives in a store this component owns now, so closing takes
// nothing with it.
//
// ⚠️ WHICH KEY CLOSES AND WHICH CANCELS: Escape CLOSES (it drops a standing
// question first, putting the sentence back in the box -- F-162 -- then clears
// the input, then closes), and a CANCEL WORD is the only cancel. These three
// pin that closing, by either route, keeps what stood.
// ---------------------------------------------------------------------------
describe("CB-keep: closing the panel never loses the conversation (F-163)", () => {
  it("CB-keep-4: a mousedown outside with a question standing closes the panel; reopening shows the same question and buttons", () => {
    renderLauncher({ assignments: [BLK1] });
    fireEvent.click(launcherButton());
    const input = screen.getByRole("textbox", { name: "Tell the board" });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    const question = statusLine()?.textContent ?? "";
    expect(question.startsWith("Remove Operator 1's Housing A block")).toBe(true);
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();

    // The slider, the day count, the zoom -- anything on the board.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Tell the board" })).toBeNull();

    fireEvent.click(launcherButton());

    expect(statusLine()?.textContent).toBe(question);
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    // And the answer box is still an answer box, with the sentence above it.
    const reopened = screen.getByRole("textbox", {
      name: "Tell the board",
    }) as HTMLInputElement;
    expect(reopened.value).toBe("");
    expect(reopened.placeholder).toBe("yes or no");
    expect(document.body.textContent).toContain(`You said: ${UNASSIGN_SENTENCE}`);
  });

  it("CB-keep-5: closing with a lot listing standing and reopening still offers 'Do all 2'", () => {
    renderLauncher({ assignments: [BLK1, BLK_SP] });
    fireEvent.click(launcherButton());
    const input = screen.getByRole("textbox", { name: "Tell the board" });
    fireEvent.change(input, { target: { value: LOT_REMOVE_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    const listing = statusLine()?.textContent ?? "";
    expect(listing.startsWith("2 commands ready: ")).toBe(true);

    fireEvent.mouseDown(document.body);
    fireEvent.click(launcherButton());

    expect(statusLine()?.textContent).toBe(listing);
    expect(screen.getByRole("button", { name: "Do all 2" })).toBeTruthy();
  });

  it("CB-keep-6: Escape closes the panel (R-396's own promise) and does NOT lose the conversation", () => {
    const { onUnassign } = renderLauncher({ assignments: [BLK1] });
    fireEvent.click(launcherButton());
    const input = screen.getByRole("textbox", { name: "Tell the board" });
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    const question = statusLine()?.textContent ?? "";

    // Escape from somewhere else in the panel is the panel's OWN rule: it
    // closes outright, without even reaching the bar's Escape ladder.
    const panel = screen.getByRole("dialog", { name: "Tell the board" });
    fireEvent.keyDown(panel, { key: "Escape", target: panel });
    expect(screen.queryByRole("dialog", { name: "Tell the board" })).toBeNull();

    fireEvent.click(launcherButton());

    expect(statusLine()?.textContent).toBe(question);
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    // Nothing ran in the meantime -- closing is not answering.
    expect(onUnassign).not.toHaveBeenCalled();
  });

  it("CH-5: the conversation thread survives close and reopen too (R-427)", () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    try {
      renderLauncher({ assignments: [BLK1] });
      fireEvent.click(launcherButton());
      const input = screen.getByRole("textbox", { name: "Tell the board" });
      fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
      expect(document.body.textContent).toContain(`You: ${UNASSIGN_SENTENCE}`);

      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole("dialog", { name: "Tell the board" })).toBeNull();
      fireEvent.click(launcherButton());

      expect(document.body.textContent).toContain(`You: ${UNASSIGN_SENTENCE}`);
      expect(document.body.textContent).toContain("Remove it ✓");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
