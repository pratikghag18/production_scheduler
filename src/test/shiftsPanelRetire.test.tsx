import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { ShiftsPanel } from "@/features/admin/components/ShiftsPanel";

/**
 * R-443 (S66-b): "retiring a band (or a pattern holding bands) that people
 * point at first shows the count ... and asks where they go: the other
 * bands of that pattern and of any newer pattern on that place, or 'Leave
 * them without a shift'." SH-1..SH-3 from the brief:
 *
 *   SH1  the count and the offered destinations (siblings, another live
 *        pattern's bands, and "leave without a shift")
 *   SH2  a save writes ONE updateOperator per affected person to the chosen
 *        band, THEN retires the shift — never the other order
 *   SH3  choosing "Leave them without a shift" writes NOTHING itself — the
 *        delete's own FK (0082) is what clears their home_shift_id
 *
 * `useShifts` and `useOperators` are mocked at the hook boundary, the same
 * shape `shiftsPanel.test.tsx` uses for the former; `useDeletion` is mocked
 * exactly as that file mocks it, `isPending: true`, since no case here needs
 * to get past the pattern-level DeleteDialog's own confirmation.
 */

const T1 = "t-standard";
const T2 = "t-nights";
const S1 = "s-shift1";
const S2 = "s-shift2";
const S3 = "s-night";
const PLANT = "n-plant";

const holders = vi.hoisted(() => ({ current: [] as unknown[] }));
const spies = vi.hoisted(() => ({
  deleteShift: vi.fn(),
  updateOperator: vi.fn(),
}));

function payload() {
  return {
    templates: [
      { id: T1, name: "Standard", siteNodeId: PLANT, active: true },
      { id: T2, name: "Nights", siteNodeId: PLANT, active: true },
    ],
    shifts: [
      { id: S1, templateId: T1, name: "Shift 1", startMin: 360, endMin: 840 },
      { id: S2, templateId: T1, name: "Shift 2", startMin: 840, endMin: 1320 },
      { id: S3, templateId: T2, name: "Night", startMin: 1320, endMin: 1800 },
    ],
    breaks: [] as unknown[],
    attachments: [{ nodeId: PLANT, templateId: T1 }],
    nodes: [{ id: PLANT, name: "Plant 1", parentId: null, path: "plant_1" }],
  };
}

vi.mock("@/features/admin/hooks/useShifts", () => ({
  useShiftPatterns: () => ({ data: payload(), isLoading: false, isError: false, error: null }),
  useCreatePattern: () => ({ mutate: vi.fn(), isPending: false }),
  useRenamePattern: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPatternActive: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateShift: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateShift: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteShift: () => ({ mutate: spies.deleteShift, isPending: false }),
  useCreateBreak: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateBreak: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteBreak: () => ({ mutate: vi.fn(), isPending: false }),
  useAttachPattern: () => ({ mutate: vi.fn(), isPending: false }),
  useDetachPattern: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/api", () => ({
  describeSchedulerError: (e: unknown) => String(e),
  isSchedulerError: () => false,
}));

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: { user: { id: "u1" } },
    profile: {
      id: "u1",
      orgId: "org-1",
      userId: "u1",
      role: "admin",
      defaultCreateMode: "run",
      adminAnywhere: true,
    },
    loading: false,
  }),
}));

vi.mock("@/features/admin/hooks/useDeletion", () => ({
  useDeletionPreview: () => ({ data: undefined, isPending: true, isError: false, error: null }),
  useDeleteOwnedRow: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/features/admin/hooks/useOperators", () => ({
  useHomeShiftHolders: () => ({
    data: holders.current,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useUpdateOperator: () => ({
    mutate: spies.updateOperator,
    mutateAsync: (vars: unknown) =>
      new Promise((resolve) => {
        spies.updateOperator(vars);
        resolve(vars);
      }),
    isPending: false,
  }),
}));

beforeEach(() => {
  holders.current = [
    { id: "op-ann", displayName: "Ann Adams", employeeRef: "A-1", homeShiftId: S1 },
    { id: "op-bob", displayName: "Bob Jones", employeeRef: null, homeShiftId: S1 },
  ];
  spies.deleteShift.mockReset();
  spies.updateOperator.mockReset();
});

/** One pattern's row, found by the name it shows — mirrors `shiftsPanel.test.tsx`'s own helper. */
function patternRow(name: string): HTMLElement {
  const opener = screen
    .queryAllByRole("button")
    .find(
      (b) =>
        b.getAttribute("aria-expanded") !== null && b.closest("li")?.textContent?.includes(name),
    );
  const li = opener?.closest("li");
  if (li === null || li === undefined) throw new Error(`no pattern row named ${name}`);
  return li as HTMLElement;
}

function openPattern(name: string) {
  render(<ShiftsPanel />);
  fireEvent.click(within(patternRow(name)).getByRole("button", { name: "Edit" }));
}

/** One shift's own row, found by the name it shows. */
function shiftRow(name: string): HTMLElement {
  const li = screen.getByText(name).closest("li");
  if (li === null) throw new Error(`no shift row named ${name}`);
  return li as HTMLElement;
}

describe("ShiftsPanel — retiring a band that people point at (R-443)", () => {
  it("SH1a: deleting a shift with holders warns with the count, not an immediate delete", () => {
    openPattern("Standard");
    fireEvent.click(within(shiftRow("Shift 1")).getByRole("button", { name: "Delete" }));
    expect(spies.deleteShift).not.toHaveBeenCalled();
    expect(
      screen.getByText((content) => content.startsWith("2 people work Shift 1.")),
    ).toBeTruthy();
  });

  it("SH1b: the destinations are the sibling band, the other pattern's band (named), and leave-without", () => {
    openPattern("Standard");
    fireEvent.click(within(shiftRow("Shift 1")).getByRole("button", { name: "Delete" }));
    const select = screen.getByRole("combobox", {
      name: "Where Shift 1's people go",
    }) as HTMLSelectElement;
    const labels = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(labels).toEqual(["Leave them without a shift", "Shift 2", "Night (Nights)"]);
  });

  it("SH1c: a shift with NO holders deletes immediately, no warning", () => {
    holders.current = [];
    openPattern("Standard");
    fireEvent.click(within(shiftRow("Shift 1")).getByRole("button", { name: "Delete" }));
    expect(spies.deleteShift).toHaveBeenCalledWith(
      { shiftId: S1 },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    expect(screen.queryByText(/people work/)).toBeNull();
  });

  it("SH2 ⭐⭐ choosing a band writes it for EVERY affected person, then retires the shift — reassign before delete", async () => {
    openPattern("Standard");
    fireEvent.click(within(shiftRow("Shift 1")).getByRole("button", { name: "Delete" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Where Shift 1's people go" }), {
      target: { value: S2 },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retire Shift 1" }));
    });
    expect(spies.updateOperator).toHaveBeenCalledTimes(2);
    const sent = spies.updateOperator.mock.calls.map(
      (c) =>
        c[0] as {
          id: string;
          homeShiftId: string;
          displayName: string;
          employeeRef: string | null;
        },
    );
    expect(sent.find((s) => s.id === "op-ann")).toEqual({
      id: "op-ann",
      displayName: "Ann Adams",
      employeeRef: "A-1",
      homeShiftId: S2,
    });
    expect(sent.find((s) => s.id === "op-bob")?.homeShiftId).toBe(S2);
    expect(spies.deleteShift).toHaveBeenCalledWith(
      { shiftId: S1 },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("SH3: choosing 'Leave them without a shift' writes NOTHING itself, only retires", async () => {
    openPattern("Standard");
    fireEvent.click(within(shiftRow("Shift 1")).getByRole("button", { name: "Delete" }));
    // Default selection is already "Leave them without a shift" ("").
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retire Shift 1" }));
    });
    expect(spies.updateOperator).not.toHaveBeenCalled();
    expect(spies.deleteShift).toHaveBeenCalledTimes(1);
  });

  it("Cancel closes the warning and writes nothing", () => {
    openPattern("Standard");
    fireEvent.click(within(shiftRow("Shift 1")).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(shiftRow("Shift 1")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/people work/)).toBeNull();
    expect(spies.deleteShift).not.toHaveBeenCalled();
    expect(spies.updateOperator).not.toHaveBeenCalled();
  });

  it("SH1d: retiring the whole PATTERN warns the same way, counting everyone on any of its bands", () => {
    render(<ShiftsPanel />);
    fireEvent.click(
      within(patternRow("Standard")).getByRole("button", { name: "Delete this pattern" }),
    );
    expect(
      screen.getByText((content) => content.startsWith("2 people work a shift in Standard.")),
    ).toBeTruthy();
    const select = screen.getByRole("combobox", {
      name: "Where Standard's people go",
    }) as HTMLSelectElement;
    // No sibling bands offered (the whole pattern is going) — only the other
    // live pattern's band, and leave-without.
    const labels = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(labels).toEqual(["Leave them without a shift", "Night (Nights)"]);
  });
});
