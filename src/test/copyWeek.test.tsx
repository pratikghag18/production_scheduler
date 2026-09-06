/**
 * Copy Week at the level a person reads it (R-339 / S35).
 *
 * The maintainer's rule, verbatim: "For the copy week, if there are conflicts
 * lets present them to the user and let them decide what they want to keep, the
 * prior plan or the copied plan." Every case below is one clause of that
 * sentence seen from the screen: the clashes are LISTED (both candidates, side
 * by side); each is DECIDED individually (Apply waits for the last answer);
 * nothing is decided FOR the person (a `["prior"]` item draws no copied
 * control -- R-239, the choices are the server's); and the answers go up as
 * exactly one decision per clash, none for a clean item, in one call.
 *
 * ⚠️ THE MOCKS STOP AT THE NETWORK BOUNDARY. `@/lib/api` is the real module
 * with only the two RPC wrappers replaced, so `isSchedulerError`,
 * `describeSchedulerError` and the parser run for real; the toast store, the
 * shared Popover and the time formatters run for real. Asserted on what a
 * person can perceive -- text, accessible names, the disabled state -- never on
 * a CSS class.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CopyWeekPlan, CopyWeekResult, SchedulerError } from "@/lib/api";
import { parseCopyWeekPlan } from "@/lib/api/copyWeek";
import {
  CopyWeekDialog,
  describeCopyWeekError,
  describeCopyWeekResult,
  describeCounts,
  describeWeekProblem,
  planDrifted,
} from "@/features/board/components/CopyWeekDialog";
import { BoardToolbar } from "@/features/board/components/BoardToolbar";
import { useToastStore } from "@/features/board/hooks/useSchedulerToast";
import { boardKeys } from "@/features/board/hooks/useBoardWindow";

const h = vi.hoisted(() => ({
  fetchPlan: vi.fn(),
  apply: vi.fn(),
  isAdminFor: vi.fn(),
  profile: {
    id: "p1",
    userId: "u1",
    orgId: "org-1",
    role: "viewer",
    defaultCreateMode: "run",
    adminAnywhere: true,
  },
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchCopyWeekPlan: h.fetchPlan,
  applyCopyWeek: h.apply,
  fetchIsAdminFor: h.isAdminFor,
}));

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({ session: { user: { id: "u1" } }, profile: h.profile, loading: false }),
}));

/* ===========================================================================
 * The fixture: one clean run and four clashes, one of each shape the server
 * can send. Monday 14 Sep 2026 is the target week; the source is the week
 * before, which is what the dialog defaults to when the board shows 7 Sep.
 * ======================================================================== */

const WINDOW_START = new Date("2026-09-07T00:00:00.000Z");
const PLANT = { id: "plant-a", name: "Plant A", path: "plant_a" };

const at = (iso: string) => new Date(iso);

function copied(over: Partial<CopyWeekPlan["items"][number]["copied"]> = {}) {
  return {
    nodeId: "n-line-2",
    nodeName: "Line 2",
    productId: "pr-c",
    productName: "Widget C",
    operatorId: null,
    operatorName: null,
    start: at("2026-09-14T06:00:00.000Z"),
    end: at("2026-09-14T14:00:00.000Z"),
    plannedHeadcount: 2,
    notes: null,
    efficiency: null,
    targetQty: null,
    targetUnit: null,
    ...over,
  };
}

function planFixture(): CopyWeekPlan {
  return {
    plantId: PLANT.id,
    sourceStart: "2026-09-07",
    targetStart: "2026-09-14",
    shiftDays: 7,
    counts: { clean: 1, clash: 4 },
    history: { runs: 1, assignments: 0 },
    items: [
      {
        key: "run:r1",
        kind: "run",
        parentKey: null,
        copied: copied({ nodeId: "n-line-1", nodeName: "Line 1", productName: "Widget A" }),
        status: "clean",
        clash: null,
      },
      {
        key: "run:r2",
        kind: "run",
        parentKey: null,
        copied: copied(),
        status: "clash",
        clash: {
          reason: "run_overlap",
          policy: null,
          prior: [
            {
              id: "p-run-1",
              kind: "run",
              nodeName: "Line 2",
              productName: "Gadget B",
              operatorName: null,
              start: at("2026-09-14T08:00:00.000Z"),
              end: at("2026-09-14T16:00:00.000Z"),
            },
          ],
          choices: ["prior", "copied"],
        },
      },
      {
        key: "assignment:a1",
        kind: "assignment",
        parentKey: null,
        copied: copied({
          nodeName: "Line 3",
          productName: null,
          operatorId: "op-dana",
          operatorName: "Dana",
        }),
        status: "clash",
        clash: {
          reason: "operator_busy",
          policy: null,
          prior: [
            {
              id: "p-asg-1",
              kind: "assignment",
              nodeName: "Line 4",
              productName: "Widget A",
              operatorName: "Dana",
              start: at("2026-09-14T06:00:00.000Z"),
              end: at("2026-09-14T14:00:00.000Z"),
            },
          ],
          choices: ["prior", "copied"],
        },
      },
      {
        key: "assignment:a2",
        kind: "assignment",
        parentKey: "run:r1",
        copied: copied({
          nodeName: "Line 1",
          productName: "Widget A",
          operatorId: "op-marco",
          operatorName: "Marco",
        }),
        status: "clash",
        clash: { reason: "not_eligible", policy: "block", prior: [], choices: ["prior"] },
      },
      {
        key: "assignment:a3",
        kind: "assignment",
        parentKey: null,
        copied: copied({
          nodeName: "Line 5",
          productName: "Widget C",
          operatorId: "op-ana",
          operatorName: "Ana",
        }),
        status: "clash",
        clash: { reason: "not_eligible", policy: "warn", prior: [], choices: ["prior", "copied"] },
      },
    ],
  };
}

function cleanPlan(): CopyWeekPlan {
  const p = planFixture();
  return {
    ...p,
    counts: { clean: 2, clash: 0 },
    history: { runs: 0, assignments: 0 },
    items: p.items
      .filter((i) => i.status === "clean")
      .concat({
        key: "assignment:a9",
        kind: "assignment",
        parentKey: "run:r1",
        copied: copied({ nodeName: "Line 1", operatorId: "op-ana", operatorName: "Ana" }),
        status: "clean",
        clash: null,
      }),
  };
}

const RESULT: CopyWeekResult = {
  created: { runs: 2, assignments: 3 },
  removed: { runs: 1, assignments: 0 },
  skipped: 1,
};

function renderDialog(over: Partial<React.ComponentProps<typeof CopyWeekDialog>> = {}) {
  const onClose = vi.fn();
  const onApplied = vi.fn();
  render(
    <CopyWeekDialog
      plantId={PLANT.id}
      plantName={PLANT.name}
      windowStart={WINDOW_START}
      anchor={{ x: 10, y: 10 }}
      onClose={onClose}
      onApplied={onApplied}
      {...over}
    />,
  );
  return { onClose, onApplied };
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Copy week" });
}

function applyButton(): HTMLButtonElement {
  return within(dialog()).getByRole("button", { name: /^Apply/ }) as HTMLButtonElement;
}

function clashGroup(name: RegExp): HTMLElement {
  return within(dialog()).getByRole("group", { name });
}

function radio(group: HTMLElement, label: string): HTMLInputElement {
  return within(group).getByRole("radio", { name: label }) as HTMLInputElement;
}

beforeEach(() => {
  h.fetchPlan.mockReset();
  h.apply.mockReset();
  h.isAdminFor.mockReset();
  h.isAdminFor.mockResolvedValue(true);
  h.profile.role = "viewer";
  h.profile.adminAnywhere = true;
  useToastStore.setState({ toasts: [] });
});

/* ===========================================================================
 * The plan on screen.
 * ======================================================================== */

describe("CW1: the plan is read on open and its counts are shown", () => {
  it("fetches for the board's week and the week after, then shows the counts", async () => {
    h.fetchPlan.mockResolvedValue(planFixture());
    renderDialog();
    await screen.findByText(
      "1 item copies cleanly; 4 clash with the prior plan and need an answer.",
    );
    expect(h.fetchPlan).toHaveBeenCalledTimes(1);
    expect(h.fetchPlan).toHaveBeenCalledWith({
      plantId: PLANT.id,
      sourceStart: WINDOW_START,
      targetStart: new Date("2026-09-14T00:00:00.000Z"),
    });
    expect(within(dialog()).getByText("Plant A")).toBeTruthy();
  });

  it("says how many rows are history and stay, only when there are any", async () => {
    h.fetchPlan.mockResolvedValue(planFixture());
    renderDialog();
    await screen.findByText(/1 row is history/);
  });

  it("says nothing about history when there is none", async () => {
    h.fetchPlan.mockResolvedValue(cleanPlan());
    renderDialog();
    await screen.findByText("2 items copy cleanly; nothing clashes with the prior plan.");
    expect(within(dialog()).queryByText(/history/)).toBeNull();
  });

  it("the parser defaults history to zeros when the server does not send it", () => {
    const wire = {
      plant_id: PLANT.id,
      source_start: "2026-09-07",
      target_start: "2026-09-14",
      shift_days: 7,
      counts: { clean: 0, clash: 0 },
      items: [],
    };
    expect(parseCopyWeekPlan(wire)?.history).toEqual({ runs: 0, assignments: 0 });
    expect(parseCopyWeekPlan({ ...wire, history: { runs: 2, assignments: 1 } })?.history).toEqual({
      runs: 2,
      assignments: 1,
    });
    // Present but not saying what it means is a shape mismatch, not zero.
    expect(parseCopyWeekPlan({ ...wire, history: { runs: "2" } })).toBeNull();
  });
});

describe("CW2: every clash lists both candidates, prior and copied", () => {
  it("names node, product, person and time for the prior row and the copied row", async () => {
    h.fetchPlan.mockResolvedValue(planFixture());
    renderDialog();
    await screen.findByRole("group", { name: /Run: Widget C on Line 2/ });

    const overlap = clashGroup(/Run: Widget C on Line 2/);
    expect(within(overlap).getByText("Line 2 · Gadget B · Mon Sep 14 08:00–16:00")).toBeTruthy();
    expect(within(overlap).getByText("Line 2 · Widget C · Mon Sep 14 06:00–14:00")).toBeTruthy();
    expect(within(overlap).getByText("Line 2 already has a run at this time.")).toBeTruthy();

    const busy = clashGroup(/Assignment: Dana on Line 3/);
    expect(
      within(busy).getByText("Line 4 · Widget A · Dana · Mon Sep 14 06:00–14:00"),
    ).toBeTruthy();
    expect(within(busy).getByText("Line 3 · Dana · Mon Sep 14 06:00–14:00")).toBeTruthy();
    expect(within(busy).getByText("Dana is already booked at this time.")).toBeTruthy();

    // Four clashes, four groups; the clean run is not listed.
    expect(within(dialog()).getAllByRole("group")).toHaveLength(4);
    expect(within(dialog()).queryByRole("group", { name: /Widget A on Line 1/ })).toBeNull();
  });

  /**
   * ⚠️ THIS CASE USED TO ASSERT "a person on loan from another plant", AND THAT
   * SENTENCE WENT WITH R-345. Migration 0058's table guard refuses a
   * cross-plant placement override or not, so no live assignment holds someone
   * from another plant and there is nothing to be on loan. F-099's rule is the
   * part that survives and is what this case is really for: a null name is
   * never drawn blank and never as "no person" -- an assignment always has one,
   * and the copy takes them. It now reads as a missing name rather than as a
   * story about why it is missing.
   */
  it("a person the server could not name is drawn as unnamed, never blank (F-099)", async () => {
    const plan = planFixture();
    const busy = plan.items.find((i) => i.key === "assignment:a1");
    if (busy === undefined || busy.clash === null) throw new Error("fixture");
    busy.copied = { ...busy.copied, operatorName: null };
    busy.clash = {
      ...busy.clash,
      prior: [{ ...busy.clash.prior[0], operatorName: null }],
    };
    h.fetchPlan.mockResolvedValue(plan);
    renderDialog();
    const group = await screen.findByRole("group", {
      name: /Assignment: \(unnamed person\) on Line 3/,
    });
    expect(
      within(group).getByText("Line 4 · Widget A · (unnamed person) · Mon Sep 14 06:00–14:00"),
    ).toBeTruthy();
    expect(
      within(group).getByText("Line 3 · (unnamed person) · Mon Sep 14 06:00–14:00"),
    ).toBeTruthy();
    expect(
      within(group).getByText("(unnamed person) is already booked at this time."),
    ).toBeTruthy();
    // A run's prior row has no person and must not be given a person's label.
    const overlap = clashGroup(/Run: Widget C on Line 2/);
    expect(within(overlap).queryByText(/unnamed person/)).toBeNull();
  });

  it("an assignment attached to a copied run says it follows that run", async () => {
    h.fetchPlan.mockResolvedValue(planFixture());
    renderDialog();
    const attached = await screen.findByRole("group", { name: /Assignment: Marco on Line 1/ });
    expect(
      within(attached).getByText(/If that run keeps the prior plan, this is skipped/),
    ).toBeTruthy();
    const free = clashGroup(/Assignment: Dana on Line 3/);
    expect(within(free).queryByText(/this is skipped/)).toBeNull();
  });
});

describe("CW3: R-239 -- the controls are exactly the server's choices", () => {
  it("a [prior] item offers no copied control and says why", async () => {
    h.fetchPlan.mockResolvedValue(planFixture());
    renderDialog();
    const blocked = await screen.findByRole("group", { name: /Assignment: Marco on Line 1/ });
    expect(within(blocked).getByRole("radio", { name: "Keep the prior plan" })).toBeTruthy();
    expect(within(blocked).queryByRole("radio", { name: "Take the copied plan" })).toBeNull();
    expect(within(blocked).getByText(/this plant refuses uncertified placements/)).toBeTruthy();
  });

  it("a two-choice item offers both", async () => {
    h.fetchPlan.mockResolvedValue(planFixture());
    renderDialog();
    const overlap = await screen.findByRole("group", { name: /Run: Widget C on Line 2/ });
    expect(within(overlap).getAllByRole("radio")).toHaveLength(2);
  });

  it("not_eligible under warn shows the warning with both choices offered", async () => {
    h.fetchPlan.mockResolvedValue(planFixture());
    renderDialog();
    const warned = await screen.findByRole("group", { name: /Assignment: Ana on Line 5/ });
    expect(within(warned).getAllByRole("radio")).toHaveLength(2);
    expect(within(warned).getByText(/Warning: Ana is not certified for this work/)).toBeTruthy();
  });
});

/* ===========================================================================
 * Deciding, and sending the decisions.
 * ======================================================================== */

describe("CW4: Apply waits for the last answer", () => {
  it("is disabled with one clash unanswered and enabled once every clash has an answer", async () => {
    h.fetchPlan.mockResolvedValue(planFixture());
    renderDialog();
    await screen.findByRole("group", { name: /Run: Widget C on Line 2/ });
    expect(applyButton().disabled).toBe(true);

    fireEvent.click(radio(clashGroup(/Run: Widget C on Line 2/), "Take the copied plan"));
    fireEvent.click(radio(clashGroup(/Assignment: Dana on Line 3/), "Keep the prior plan"));
    fireEvent.click(radio(clashGroup(/Assignment: Marco on Line 1/), "Keep the prior plan"));
    // Three of four answered.
    expect(applyButton().disabled).toBe(true);

    fireEvent.click(radio(clashGroup(/Assignment: Ana on Line 5/), "Take the copied plan"));
    expect(applyButton().disabled).toBe(false);
  });

  it("an answer can be changed before Apply", async () => {
    h.fetchPlan.mockResolvedValue(planFixture());
    renderDialog();
    const overlap = await screen.findByRole("group", { name: /Run: Widget C on Line 2/ });
    fireEvent.click(radio(overlap, "Take the copied plan"));
    expect(radio(overlap, "Take the copied plan").checked).toBe(true);
    fireEvent.click(radio(overlap, "Keep the prior plan"));
    expect(radio(overlap, "Keep the prior plan").checked).toBe(true);
    expect(radio(overlap, "Take the copied plan").checked).toBe(false);
  });
});

describe("CW5: Apply sends one decision per clash and none for a clean item", () => {
  it("sends exactly the four answers, keyed by the item, and nothing for run:r1", async () => {
    h.fetchPlan.mockResolvedValue(planFixture());
    h.apply.mockResolvedValue(RESULT);
    const { onApplied, onClose } = renderDialog();
    await screen.findByRole("group", { name: /Run: Widget C on Line 2/ });

    fireEvent.click(radio(clashGroup(/Run: Widget C on Line 2/), "Take the copied plan"));
    fireEvent.click(radio(clashGroup(/Assignment: Dana on Line 3/), "Keep the prior plan"));
    fireEvent.click(radio(clashGroup(/Assignment: Marco on Line 1/), "Keep the prior plan"));
    fireEvent.click(radio(clashGroup(/Assignment: Ana on Line 5/), "Take the copied plan"));
    fireEvent.click(applyButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(h.apply).toHaveBeenCalledTimes(1);
    const sent = h.apply.mock.calls[0][0];
    expect(sent.plantId).toBe(PLANT.id);
    expect(sent.sourceStart).toEqual(WINDOW_START);
    expect(sent.targetStart).toEqual(new Date("2026-09-14T00:00:00.000Z"));
    expect(sent.decisions).toEqual([
      { key: "run:r2", choice: "copied" },
      { key: "assignment:a1", choice: "prior" },
      { key: "assignment:a2", choice: "prior" },
      { key: "assignment:a3", choice: "copied" },
    ]);
    expect(sent.decisions.map((d: { key: string }) => d.key)).not.toContain("run:r1");
    expect(onApplied).toHaveBeenCalledWith(RESULT);
  });

  it("says what happened, in plain words, as a toast", async () => {
    h.fetchPlan.mockResolvedValue(cleanPlan());
    h.apply.mockResolvedValue(RESULT);
    renderDialog();
    await screen.findByText(/2 items copy cleanly/);
    fireEvent.click(applyButton());
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0].message).toBe(
      "Copied 2 runs and 3 assignments into the week of Mon Sep 14. Removed 1 run and 0 assignments from the prior plan. Skipped 1 item attached to a run that was kept.",
    );
  });
});

describe("CW6: a clean plan can be applied at once", () => {
  it("Apply is enabled with nothing to answer, and closes after refreshing", async () => {
    h.fetchPlan.mockResolvedValue(cleanPlan());
    h.apply.mockResolvedValue({
      created: { runs: 1, assignments: 1 },
      removed: { runs: 0, assignments: 0 },
      skipped: 0,
    });
    const { onApplied, onClose } = renderDialog();
    await screen.findByText(/2 items copy cleanly/);
    expect(within(dialog()).queryAllByRole("group")).toHaveLength(0);
    expect(applyButton().disabled).toBe(false);

    fireEvent.click(applyButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(h.apply.mock.calls[0][0].decisions).toEqual([]);
    expect(onApplied).toHaveBeenCalledTimes(1);
    // Refresh before close, so the board is already reloading when the dialog goes.
    expect(onApplied.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
  });
});

/* ===========================================================================
 * Refusals are shown, never swallowed.
 * ======================================================================== */

const notAdmin: SchedulerError = { kind: "NotPermitted", nodeId: "plant-a" };
const notOffered: SchedulerError = {
  kind: "InvalidArgument",
  field: "p_decisions",
  reason: "choice_not_offered",
};

describe("CW7: a server error is shown in the dialog with its message", () => {
  it("a refused plan read shows the sentence and no Apply", async () => {
    h.fetchPlan.mockRejectedValue(notAdmin);
    renderDialog();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "You do not administer this plant, so you cannot copy its weeks.",
    );
    expect(applyButton().disabled).toBe(true);
  });

  it("a refused apply shows the sentence and keeps the dialog open", async () => {
    h.fetchPlan.mockResolvedValue(cleanPlan());
    h.apply.mockRejectedValue({ kind: "WriteRefused" } satisfies SchedulerError);
    const { onClose } = renderDialog();
    await screen.findByText(/2 items copy cleanly/);
    fireEvent.click(applyButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("You don't have permission to change that.");
    expect(onClose).not.toHaveBeenCalled();
    expect(applyButton().disabled).toBe(false);
  });

  it("an answer the server did not offer reads the plan again and says so", async () => {
    h.fetchPlan.mockResolvedValue(cleanPlan());
    h.apply.mockRejectedValue(notOffered);
    renderDialog();
    await screen.findByText(/2 items copy cleanly/);
    expect(h.fetchPlan).toHaveBeenCalledTimes(1);
    fireEvent.click(applyButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/not a choice the server offered/);
    await waitFor(() => expect(h.fetchPlan).toHaveBeenCalledTimes(2));
  });

  it("an unknown failure still says something", async () => {
    h.fetchPlan.mockRejectedValue(new Error("network"));
    renderDialog();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Something went wrong. Please try again.");
  });

  it("the words for each refusal the copy can meet", () => {
    const arg = (reason: string): SchedulerError => ({
      kind: "InvalidArgument",
      field: "x",
      reason,
    });
    expect(describeCopyWeekError(arg("not_a_plant"))).toMatch(/whole plant/);
    expect(describeCopyWeekError(arg("same_week"))).toMatch(/same week/);
    expect(describeCopyWeekError(arg("not_whole_weeks"))).toMatch(/whole number of weeks/);
    expect(describeCopyWeekError(arg("undecided"))).toMatch(/Every clash needs an answer/);
    expect(describeCopyWeekError(arg("unknown_key"))).toMatch(/plan has changed/);
    expect(describeCopyWeekError(arg("something_else"))).toBe("Invalid x: something_else.");
    expect(planDrifted(arg("unknown_key"))).toBe(true);
    expect(planDrifted(arg("not_a_plant"))).toBe(false);
    expect(planDrifted(notAdmin)).toBe(false);
  });
});

/* ===========================================================================
 * The dates: the same test the server runs, before asking it.
 * ======================================================================== */

describe("CW8: the two weeks must be a whole, non-zero number of weeks apart", () => {
  it("the pure rule", () => {
    const mon = new Date("2026-09-07T00:00:00.000Z");
    expect(describeWeekProblem(mon, new Date("2026-09-14T00:00:00.000Z"))).toBeNull();
    expect(describeWeekProblem(mon, new Date("2026-08-24T00:00:00.000Z"))).toBeNull();
    expect(describeWeekProblem(mon, mon)).toMatch(/same week/);
    expect(describeWeekProblem(mon, new Date("2026-09-10T00:00:00.000Z"))).toMatch(
      /whole number of weeks/,
    );
  });

  it("a target that is not whole weeks away shows the sentence and asks the server nothing", async () => {
    h.fetchPlan.mockResolvedValue(planFixture());
    renderDialog();
    await screen.findByRole("group", { name: /Run: Widget C on Line 2/ });
    fireEvent.change(within(dialog()).getByLabelText("Into the week starting"), {
      target: { value: "2026-09-10" },
    });
    expect(
      within(dialog()).getByText(
        "The target week must be a whole number of weeks from the source week.",
      ),
    ).toBeTruthy();
    expect(within(dialog()).queryAllByRole("group")).toHaveLength(0);
    expect(applyButton().disabled).toBe(true);
    expect(h.fetchPlan).toHaveBeenCalledTimes(1);
  });

  it("changing the source week reads a new plan and forgets the old answers", async () => {
    h.fetchPlan.mockResolvedValue(planFixture());
    renderDialog();
    const overlap = await screen.findByRole("group", { name: /Run: Widget C on Line 2/ });
    fireEvent.click(radio(overlap, "Take the copied plan"));
    expect(radio(overlap, "Take the copied plan").checked).toBe(true);

    await act(async () => {
      fireEvent.change(within(dialog()).getByLabelText("Copy the week starting"), {
        target: { value: "2026-08-31" },
      });
    });
    await waitFor(() => expect(h.fetchPlan).toHaveBeenCalledTimes(2));
    expect(h.fetchPlan.mock.calls[1][0].sourceStart).toEqual(new Date("2026-08-31T00:00:00.000Z"));
    await waitFor(() =>
      expect(radio(clashGroup(/Run: Widget C on Line 2/), "Take the copied plan").checked).toBe(
        false,
      ),
    );
  });
});

/* ===========================================================================
 * The words, pinned without a render.
 * ======================================================================== */

describe("CW9: the sentences", () => {
  it("counts", () => {
    const base = cleanPlan();
    expect(describeCounts({ ...base, counts: { clean: 0, clash: 0 } })).toBe(
      "Nothing is scheduled in that week, so there is nothing to copy.",
    );
    expect(describeCounts({ ...base, counts: { clean: 1, clash: 1 } })).toBe(
      "1 item copies cleanly; 1 clashes with the prior plan and needs an answer.",
    );
    expect(describeCounts({ ...base, counts: { clean: 3, clash: 0 } })).toBe(
      "3 items copy cleanly; nothing clashes with the prior plan.",
    );
  });

  it("results", () => {
    const week = new Date("2026-09-14T00:00:00.000Z");
    expect(
      describeCopyWeekResult(
        { created: { runs: 0, assignments: 0 }, removed: { runs: 0, assignments: 0 }, skipped: 0 },
        week,
        "d_mon_yyyy",
      ),
    ).toBe("Nothing was copied into the week of Mon Sep 14.");
    expect(
      describeCopyWeekResult(
        { created: { runs: 1, assignments: 1 }, removed: { runs: 0, assignments: 0 }, skipped: 0 },
        week,
        "iso",
      ),
    ).toBe("Copied 1 run and 1 assignment into the week of Mon 2026-09-14.");
  });
});

/* ===========================================================================
 * The toolbar: who is offered the button, and what happens after Apply.
 * ======================================================================== */

function renderToolbar(rootPath: string | null = PLANT.path) {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <BoardToolbar
        roots={[PLANT, { id: "plant-b", name: "Plant B", path: "plant_b" }]}
        rootPath={rootPath}
        onRootChange={() => {}}
        zoomIndex={1}
        onZoomChange={() => {}}
        windowStartDate={WINDOW_START}
        windowDayCount={3}
        onWindowChange={() => {}}
        onShiftWindowByDays={() => {}}
        onGoToToday={() => {}}
        products={[]}
        isFetching={false}
      />
    </QueryClientProvider>,
  );
  return { invalidate };
}

describe("CW10: the Copy week button on the board is offered by the server's own answer", () => {
  it("is offered when app_is_admin_for says yes for THIS plant, and opens the dialog for it", async () => {
    h.fetchPlan.mockResolvedValue(cleanPlan());
    renderToolbar();
    fireEvent.click(await screen.findByRole("button", { name: "Copy week" }));
    await screen.findByRole("dialog", { name: "Copy week" });
    expect(h.isAdminFor).toHaveBeenCalledWith(PLANT.id);
    expect(within(dialog()).getByText("Plant A")).toBeTruthy();
    expect(h.fetchPlan.mock.calls[0][0].plantId).toBe(PLANT.id);
  });

  it("is not offered when the server says no, even though the session says admin somewhere", async () => {
    h.profile.adminAnywhere = true;
    h.isAdminFor.mockResolvedValue(false);
    renderToolbar();
    await waitFor(() => expect(h.isAdminFor).toHaveBeenCalledWith(PLANT.id));
    expect(screen.queryByRole("button", { name: "Copy week" })).toBeNull();
  });

  it("is not offered to a company admin either until the server has said so: the session's role is not the predicate", async () => {
    h.profile.role = "admin";
    h.isAdminFor.mockResolvedValue(false);
    renderToolbar();
    await waitFor(() => expect(h.isAdminFor).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Copy week" })).toBeNull();
  });

  it("is not offered while the answer is loading, nor after the ask was refused", async () => {
    h.isAdminFor.mockReturnValue(new Promise(() => {}));
    const first = renderToolbar();
    expect(screen.queryByRole("button", { name: "Copy week" })).toBeNull();
    void first;
    h.isAdminFor.mockReset();
    h.isAdminFor.mockRejectedValue(notAdmin);
    renderToolbar();
    await waitFor(() => expect(h.isAdminFor).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Copy week" })).toBeNull();
  });

  it("asks nothing and offers nothing before the board knows where it is", () => {
    renderToolbar(null);
    expect(screen.queryByRole("button", { name: "Copy week" })).toBeNull();
    expect(h.isAdminFor).not.toHaveBeenCalled();
  });

  it("after Apply, refreshes the loaded board window the way every writer does", async () => {
    h.fetchPlan.mockResolvedValue(cleanPlan());
    h.apply.mockResolvedValue(RESULT);
    const { invalidate } = renderToolbar();
    fireEvent.click(await screen.findByRole("button", { name: "Copy week" }));
    await screen.findByText(/2 items copy cleanly/);
    fireEvent.click(applyButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: boardKeys.window(PLANT.path, WINDOW_START, new Date("2026-09-10T00:00:00.000Z")),
    });
  });
});

/* ===========================================================================
 * The parser on the wire, exactly as PostgREST returns the plan.
 * ======================================================================== */

describe("CW11: the parser accepts the server's wire shape and refuses a malformed one", () => {
  const wire = {
    plant_id: "plant-a",
    source_start: "2099-06-08",
    target_start: "2099-06-01",
    shift_days: -7,
    counts: { clean: 1, clash: 1 },
    history: { runs: 1, assignments: 1 },
    items: [
      {
        key: "run:r1",
        kind: "run",
        parent_key: null,
        copied: {
          node_id: "n1",
          node_name: "Cell W1",
          product_id: "p1",
          product_name: "Widget W",
          operator_id: null,
          operator_name: null,
          start: "2099-06-02T06:00:00+00:00",
          end: "2099-06-02T14:00:00+00:00",
          planned_headcount: 2,
          notes: "first shift",
          efficiency: null,
          target_qty: null,
          target_unit: null,
        },
        status: "clash",
        clash: {
          reason: "run_overlap",
          policy: null,
          prior: [
            {
              id: "rx",
              kind: "run",
              node_name: "Cell W1",
              product_name: "Gadget W",
              operator_name: null,
              start: "2099-06-02T10:00:00+00:00",
              end: "2099-06-02T18:00:00+00:00",
            },
          ],
          choices: ["prior", "copied"],
        },
      },
      {
        key: "assignment:a5",
        kind: "assignment",
        parent_key: null,
        copied: {
          node_id: "n1",
          node_name: "Cell W1",
          product_id: "p1",
          product_name: "Widget W",
          operator_id: "o5",
          operator_name: null,
          start: "2099-06-04T08:00:00+00:00",
          end: "2099-06-04T12:00:00+00:00",
          planned_headcount: null,
          notes: null,
          efficiency: 0.5,
          target_qty: 120,
          target_unit: "units",
          area_override: true,
          area_override_reason: "on loan",
        },
        status: "clean",
        clash: null,
      },
    ],
  };

  it("reads timestamps with a +00:00 offset, a negative shift, nulls, numerics, and ignores the extra keys", () => {
    const plan = parseCopyWeekPlan(wire);
    expect(plan).not.toBeNull();
    if (plan === null) return;
    expect(plan.shiftDays).toBe(-7);
    expect(plan.sourceStart).toBe("2099-06-08");
    expect(plan.history).toEqual({ runs: 1, assignments: 1 });
    expect(plan.items[0].copied.start.toISOString()).toBe("2099-06-02T06:00:00.000Z");
    expect(plan.items[0].clash?.policy).toBeNull();
    expect(plan.items[0].clash?.prior[0].end.toISOString()).toBe("2099-06-02T18:00:00.000Z");
    expect(plan.items[1].parentKey).toBeNull();
    expect(plan.items[1].copied.efficiency).toBe(0.5);
    expect(plan.items[1].copied.targetQty).toBe(120);
    expect(plan.items[1].copied.operatorName).toBeNull();
    expect("area_override" in plan.items[1].copied).toBe(false);
  });

  it("refuses a string where an object should be, an unknown choice, and an empty choices list", () => {
    expect(parseCopyWeekPlan({ ...wire, counts: "many" })).toBeNull();
    const badChoice = structuredClone(wire);
    const c0 = badChoice.items[0].clash;
    if (c0 === null) throw new Error("fixture");
    c0.choices = ["prior", "keep"];
    expect(parseCopyWeekPlan(badChoice)).toBeNull();
    const noChoice = structuredClone(wire);
    const c1 = noChoice.items[0].clash;
    if (c1 === null) throw new Error("fixture");
    c1.choices = [];
    expect(parseCopyWeekPlan(noChoice)).toBeNull();
    const badTime = structuredClone(wire);
    badTime.items[0].copied.start = "yesterday";
    expect(parseCopyWeekPlan(badTime)).toBeNull();
  });
});
