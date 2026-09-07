/**
 * R-356 on the board: the Copy Week dialog's source picker (another week vs a
 * template), that the same preview path runs with a template passed through,
 * and who is offered the "Save this week as a template" control.
 */
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CopyWeekPlan, CopyWeekResult, WeekTemplate } from "@/lib/api";
import { CopyWeekDialog } from "@/features/board/components/CopyWeekDialog";
import { BoardToolbar } from "@/features/board/components/BoardToolbar";

const h = vi.hoisted(() => ({
  fetchPlan: vi.fn(),
  apply: vi.fn(),
  listTemplates: vi.fn(),
  saveTemplate: vi.fn(),
  isAdminFor: vi.fn(),
  canPlace: vi.fn(),
  profile: {
    id: "p1",
    userId: "u1",
    orgId: "org-1",
    role: "supervisor",
    defaultCreateMode: "run",
    adminAnywhere: false,
  },
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchCopyWeekPlan: h.fetchPlan,
  applyCopyWeek: h.apply,
  listWeekTemplates: h.listTemplates,
  saveWeekTemplate: h.saveTemplate,
  fetchIsAdminFor: h.isAdminFor,
  fetchCanPlaceInPlant: h.canPlace,
}));

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({ session: { user: { id: "u1" } }, profile: h.profile, loading: false }),
}));

const WINDOW_START = new Date("2026-09-07T00:00:00.000Z");
const PLANT = { id: "plant-a", name: "Plant A", path: "plant_a" };
const TEMPLATE: WeekTemplate = {
  id: "tpl-1",
  name: "Day shift",
  savedFrom: "2026-09-01",
  runs: 2,
  assignments: 3,
};

function cleanPlan(): CopyWeekPlan {
  return {
    plantId: PLANT.id,
    sourceStart: "2026-09-14",
    targetStart: "2026-09-14",
    shiftDays: 0,
    counts: { clean: 2, clash: 0 },
    history: { runs: 0, assignments: 0 },
    items: [],
  };
}
const RESULT: CopyWeekResult = {
  created: { runs: 2, assignments: 0 },
  removed: { runs: 0, assignments: 0 },
  skipped: 0,
};

beforeEach(() => {
  h.fetchPlan.mockReset();
  h.fetchPlan.mockResolvedValue(cleanPlan());
  h.apply.mockReset();
  h.apply.mockResolvedValue(RESULT);
  h.listTemplates.mockReset();
  h.listTemplates.mockResolvedValue([TEMPLATE]);
  h.saveTemplate.mockReset();
  h.isAdminFor.mockReset();
  h.canPlace.mockReset();
  h.profile.role = "supervisor";
  h.profile.adminAnywhere = false;
});

function renderDialog(over: Partial<React.ComponentProps<typeof CopyWeekDialog>> = {}) {
  render(
    <CopyWeekDialog
      plantId={PLANT.id}
      plantName={PLANT.name}
      windowStart={WINDOW_START}
      anchor={{ x: 0, y: 0 }}
      onClose={() => {}}
      onApplied={() => {}}
      {...over}
    />,
  );
  return screen.getByRole("dialog", { name: "Copy week" });
}

describe("the source picker (R-356)", () => {
  it("an admin sees both sources and can switch to a template, which is passed to the same preview", async () => {
    renderDialog({ isAdmin: true });
    // Default is the WEEK source: the date input is shown and asked for.
    expect(within(dialog()).getByLabelText("Copy the week starting")).toBeTruthy();
    await waitFor(() => expect(h.fetchPlan).toHaveBeenCalled());
    expect(h.fetchPlan.mock.calls[0][0].templateId).toBeUndefined();

    // Switch the source to a template.
    fireEvent.change(within(dialog()).getByLabelText("Copy from"), {
      target: { value: "template" },
    });
    await waitFor(() => expect(h.listTemplates).toHaveBeenCalledWith(PLANT.id));
    // The template select replaces the source date input.
    const select = (await screen.findByLabelText("Template")) as HTMLSelectElement;
    expect(within(select).getByRole("option", { name: "Day shift" })).toBeTruthy();
    expect(screen.queryByLabelText("Copy the week starting")).toBeNull();

    // The same preview path runs, now with the template id threaded through.
    await waitFor(() => {
      const last = h.fetchPlan.mock.calls.at(-1)?.[0];
      expect(last.templateId).toBe(TEMPLATE.id);
      expect(last.sourceStart).toBeNull();
    });
    // And the counts sentence names the template as the source.
    expect(await within(dialog()).findByText(/From the template Day shift/)).toBeTruthy();
  });

  it("a supervisor who cannot copy a week gets only the template source, no week picker", async () => {
    renderDialog({ isAdmin: false });
    // No "Copy from" picker (there is no week source to choose), no week date.
    expect(screen.queryByLabelText("Copy from")).toBeNull();
    expect(screen.queryByLabelText("Copy the week starting")).toBeNull();
    // The template source is live from the start.
    await waitFor(() => expect(h.listTemplates).toHaveBeenCalledWith(PLANT.id));
    expect(await screen.findByLabelText("Template")).toBeTruthy();
    await waitFor(() => expect(h.fetchPlan.mock.calls.at(-1)?.[0].templateId).toBe(TEMPLATE.id));
  });

  it("applies with the template id when a template is the source", async () => {
    renderDialog({ isAdmin: false });
    await screen.findByLabelText("Template");
    await screen.findByText(/2 items copy cleanly/);
    fireEvent.click(within(dialog()).getByRole("button", { name: /^Apply/ }));
    await waitFor(() => expect(h.apply).toHaveBeenCalled());
    expect(h.apply.mock.calls[0][0].templateId).toBe(TEMPLATE.id);
  });
});

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Copy week" });
}

/* ===========================================================================
 * The toolbar: who is offered "Copy week" and "Save this week as a template".
 * ======================================================================== */

function renderToolbar() {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <BoardToolbar
        roots={[PLANT]}
        rootPath={PLANT.path}
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
}

describe("the save control's rights (R-356)", () => {
  it("a placing supervisor is offered Apply a template and Save as a template, but NOT Copy week", async () => {
    h.isAdminFor.mockResolvedValue(false);
    h.canPlace.mockResolvedValue(true);
    renderToolbar();
    expect(
      await screen.findByRole("button", { name: "Save this week as a template" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply a template" })).toBeTruthy();
    // Copy week (from another week) stays admin-only (S35).
    expect(screen.queryByRole("button", { name: "Copy week" })).toBeNull();
  });

  it("an admin is offered Copy week and Save, but not the supervisor-only Apply a template", async () => {
    h.isAdminFor.mockResolvedValue(true);
    h.canPlace.mockResolvedValue(true);
    renderToolbar();
    expect(await screen.findByRole("button", { name: "Copy week" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save this week as a template" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply a template" })).toBeNull();
  });

  it("a viewer who cannot place is offered none of the controls", async () => {
    h.isAdminFor.mockResolvedValue(false);
    h.canPlace.mockResolvedValue(false);
    renderToolbar();
    await waitFor(() => expect(h.canPlace).toHaveBeenCalledWith(PLANT.id));
    expect(screen.queryByRole("button", { name: "Save this week as a template" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply a template" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy week" })).toBeNull();
  });

  it("an admin is offered Copy week even before the place answer lands", async () => {
    h.isAdminFor.mockResolvedValue(true);
    h.canPlace.mockReturnValue(new Promise(() => {}));
    renderToolbar();
    expect(await screen.findByRole("button", { name: "Copy week" })).toBeTruthy();
  });
});
