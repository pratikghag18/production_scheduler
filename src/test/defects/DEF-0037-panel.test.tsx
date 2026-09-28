/**
 * DEF-0037, the Absences tab's half. The company-wide table lists every absence
 * the caller can READ (DEF-0035's own test asserts John Kim's row stays listed for
 * Ana), and every row carries a Remove button; `remove_absence` refuses the rows
 * whose person is not in `absence_recordable_people()` — the set the same panel
 * already fetches for its Person dropdown. Green when a row the server will not
 * let this caller remove has no Remove to press. Harness copied from
 * DEF-0035.test.tsx so the two describe the same six people.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  operator: (id: string, displayName: string) => ({
    id,
    displayName,
    employeeRef: null,
    active: true,
    siteNodeId: "plant",
    homeNodeId: null as string | null,
    source: "manual",
    externalId: null,
    homeShiftId: null,
  }),
  node: (id: string) => ({
    id,
    name: id,
    parentId: null,
    levelId: "lv",
    path: id,
    sortOrder: 1,
    active: true,
  }),
  absence: (id: string, operatorId: string) => ({
    id,
    operatorId,
    from: "2099-03-02",
    to: "2099-03-06",
    reason: "Leave",
    source: "manual",
    externalId: null,
  }),
  operators: [] as unknown[],
  fetchAbsences: vi.fn(),
  setAbsence: vi.fn(),
  removeAbsence: vi.fn(),
  fetchNodeSetting: vi.fn(),
  fetchRecordableAbsencePeople: vi.fn(),
}));

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: { user: { id: "u1" } },
    profile: { orgId: "org-1", role: "supervisor" },
    loading: false,
  }),
}));

vi.mock("@/lib/api", () => ({
  fetchAbsences: () => h.fetchAbsences(),
  setAbsence: (input: unknown) => h.setAbsence(input),
  removeAbsence: (id: string) => h.removeAbsence(id),
  fetchNodeSetting: (nodeId: string, key: string) => h.fetchNodeSetting(nodeId, key),
  fetchRecordableAbsencePeople: () => h.fetchRecordableAbsencePeople(),
  describeSchedulerError: (e: unknown) =>
    (e as { message?: string })?.message ?? "Something went wrong.",
}));

vi.mock("@/features/admin/hooks/useOperators", () => ({
  useOperatorsAdmin: () => ({
    data: { operators: h.operators, nodes: [h.node("plant")] },
    isLoading: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/features/admin/hooks/usePlantFilter", () => ({
  usePlantFilter: () => ({ choice: null, plants: [], visible: false, label: "All plants" }),
}));

vi.mock("@/features/admin/hooks/useOrgSettings", () => ({
  useDateFormat: () => "iso",
}));

vi.mock("@/features/admin/components/AbsencesImport", () => ({
  absenceKeys: { all: ["absences"] as const },
}));

import { AbsencesPanel } from "@/features/admin/components/AbsencesPanel";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  h.operators = [h.operator("sam", "Sam Patel"), h.operator("john", "John Kim")];
  h.fetchAbsences.mockReset().mockResolvedValue({
    absences: [h.absence("A-sam", "sam"), h.absence("A-john", "john")],
    skipped: 0,
  });
  h.setAbsence.mockReset();
  h.removeAbsence.mockReset();
  h.fetchNodeSetting.mockReset().mockResolvedValue("America/Chicago");
  // Ana's answer from the server: Sam (her line), not John.
  h.fetchRecordableAbsencePeople.mockReset().mockResolvedValue(["sam"]);
});

describe("DEF-0037 (Absences tab): Remove is offered only on rows remove_absence accepts", () => {
  it("John Kim's row is listed with no Remove; Sam Patel's row keeps its Remove", async () => {
    wrap(<AbsencesPanel />);

    const johnCell = await screen.findByRole("cell", { name: "John Kim" });
    const samCell = await screen.findByRole("cell", { name: "Sam Patel" });
    const johnRow = johnCell.closest("tr") as HTMLElement;
    const samRow = samCell.closest("tr") as HTMLElement;

    // The allowed direction must survive a fix: Sam's Remove stays.
    expect(within(samRow).getByRole("button", { name: "Remove" })).toBeTruthy();

    const johnRemove = within(johnRow).queryByRole("button", { name: "Remove" });
    expect(
      johnRemove === null || (johnRemove as HTMLButtonElement).disabled,
      "a Remove button is offered on John Kim's absence, which remove_absence refuses for this caller",
    ).toBe(true);
  });
});
