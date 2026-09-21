/**
 * Pin for DEF-0035 — the Absences "Person" dropdown offered every visible
 * operator, but `set_absence` (migration 0069, `app_can_edit_node(coalesce(
 * home_node_id, site_node_id))`, line ~285) refuses whoever is off the
 * reader's grant. A Line 1 supervisor was offered five of Plant A's six
 * people and refused `not_permitted` on four — the screen offered what the
 * server refuses (CLAUDE.md section 4, R-431).
 *
 * The maintainer, 21 Sept, sided with the tester: filter the dropdown by the
 * server's own predicate rather than let every refusal arrive after the
 * click. The fix reads `useEditRights(canQuery, profile?.role ?? null)` and
 * narrows the create form's Person list to
 * `canEdit(nodesById.get(person.homeNodeId ?? person.siteNodeId)?.path ??
 * null)` — the SAME coalesce order the server uses — while the absences
 * TABLE keeps listing every visible person's rows (reading is wider than
 * writing, by design; only the create form narrows).
 *
 * ⚠️ THE MOCKS STOP AT THE NETWORK BOUNDARY, NOT AT `useEditRights`. The
 * whole point under test is the real `canEditNode` preview running inside
 * the real hook, so only `@/lib/api`'s RPCs are replaced (`fetchGrantPaths`
 * included) — the same shape `absencesPanel.test.tsx` uses, not
 * `trainingsPanel.test.tsx`'s delegate-to-the-real-function mock, because
 * here the "rights unknown" case needs to hold `fetchGrantPaths` itself
 * pending.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  profile: {
    orgId: "org-1",
    role: "supervisor" as string | null,
  },
  operator: (id: string, displayName: string, siteNodeId: string, homeNodeId: string | null) => ({
    id,
    displayName,
    employeeRef: null,
    active: true,
    siteNodeId,
    homeNodeId,
    source: "manual",
    externalId: null,
    homeShiftId: null,
  }),
  /** A schedulable node under the org root, path === the id (no tree needed). */
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
    from: "2027-03-02",
    to: "2027-03-06",
    reason: "Leave",
    source: "manual",
    externalId: null,
  }),
  operators: [] as unknown[],
  absences: [] as unknown[],
  fetchAbsences: vi.fn(),
  setAbsence: vi.fn(),
  removeAbsence: vi.fn(),
  fetchNodeSetting: vi.fn(),
  fetchGrantPaths: vi.fn(),
}));

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: { user: { id: "u1" } },
    profile: h.profile,
    loading: false,
  }),
}));

vi.mock("@/lib/api", () => ({
  fetchAbsences: () => h.fetchAbsences(),
  setAbsence: (input: unknown) => h.setAbsence(input),
  removeAbsence: (id: string) => h.removeAbsence(id),
  fetchNodeSetting: (nodeId: string, key: string) => h.fetchNodeSetting(nodeId, key),
  fetchGrantPaths: () => h.fetchGrantPaths(),
  describeSchedulerError: (e: unknown) =>
    (e as { message?: string })?.message ?? "Something went wrong.",
}));

vi.mock("@/features/admin/hooks/useOperators", () => ({
  useOperatorsAdmin: () => ({
    data: { operators: h.operators, nodes: [h.node("plant.line1"), h.node("plant.line2")] },
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

/** The Person `<select>`'s options, by their visible label. */
function personOptions(): string[] {
  const select = screen.getByRole("combobox", { name: "Person" });
  return within(select)
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
}

beforeEach(() => {
  h.profile.role = "supervisor";
  h.operators = [];
  h.fetchAbsences.mockReset().mockResolvedValue({ absences: [], skipped: 0 });
  h.setAbsence.mockReset();
  h.removeAbsence.mockReset();
  h.fetchNodeSetting.mockReset().mockResolvedValue("America/Chicago");
  h.fetchGrantPaths.mockReset();
});

describe("DEF-0035: the Person dropdown offers only who set_absence would accept", () => {
  it("a reader whose writable grant covers only plant.line1 is offered the line1 person, not line2 — the table still lists both", async () => {
    h.operators = [
      h.operator("O-line1", "Alice", "plant.line1", "plant.line1"),
      h.operator("O-line2", "Bob", "plant.line2", "plant.line2"),
    ];
    h.absences = [h.absence("A1", "O-line1"), h.absence("A2", "O-line2")];
    h.fetchAbsences.mockResolvedValue({ absences: h.absences, skipped: 0 });
    h.fetchGrantPaths.mockResolvedValue({ adminPaths: [], writablePaths: ["plant.line1"] });

    wrap(<AbsencesPanel />);

    // Wait for the grant read to land: an option list that only ever had one
    // entry would pass this assertion by accident before rights resolved.
    await waitFor(() => expect(personOptions()).toEqual(["Choose a person…", "Alice"]));

    // The absences TABLE narrows nothing — both people's rows still show.
    expect(screen.getByRole("cell", { name: "Alice" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Bob" })).toBeTruthy();
  });

  it("rights unknown (fetchGrantPaths still pending) fails OPEN and offers both", async () => {
    h.operators = [
      h.operator("O-line1", "Alice", "plant.line1", "plant.line1"),
      h.operator("O-line2", "Bob", "plant.line2", "plant.line2"),
    ];
    h.fetchAbsences.mockResolvedValue({ absences: [], skipped: 0 });
    // Never resolves: `rights.known` stays false for the life of the test.
    h.fetchGrantPaths.mockReturnValue(new Promise(() => {}));

    wrap(<AbsencesPanel />);

    await screen.findByLabelText("Person");
    expect(personOptions()).toEqual(["Choose a person…", "Alice", "Bob"]);
  });

  it("rights REFUSED (fetchGrantPaths rejects) also fails OPEN and offers both", async () => {
    h.operators = [
      h.operator("O-line1", "Alice", "plant.line1", "plant.line1"),
      h.operator("O-line2", "Bob", "plant.line2", "plant.line2"),
    ];
    h.fetchAbsences.mockResolvedValue({ absences: [], skipped: 0 });
    h.fetchGrantPaths.mockRejectedValue({ kind: "SchedulerError", message: "boom" });

    wrap(<AbsencesPanel />);

    await waitFor(() => expect(personOptions()).toEqual(["Choose a person…", "Alice", "Bob"]));
  });

  it("a person with homeNodeId: null is decided on siteNodeId, the same coalesce set_absence runs", async () => {
    h.operators = [
      // homeNodeId null -> falls back to siteNodeId, which IS covered.
      h.operator("O-site1", "Cara", "plant.line1", null),
      // homeNodeId null -> falls back to siteNodeId, which is NOT covered.
      h.operator("O-site2", "Dee", "plant.line2", null),
    ];
    h.fetchAbsences.mockResolvedValue({ absences: [], skipped: 0 });
    h.fetchGrantPaths.mockResolvedValue({ adminPaths: [], writablePaths: ["plant.line1"] });

    wrap(<AbsencesPanel />);

    await waitFor(() => expect(personOptions()).toEqual(["Choose a person…", "Cara"]));
  });
});
