/**
 * Pin for DEF-0035 — the Absences "Person" dropdown offered every visible
 * operator, but `set_absence` (migration 0069, `app_can_edit_node(coalesce(
 * home_node_id, site_node_id))`) refuses whoever is off the reader's grant. A
 * Line 1 supervisor was offered five of Plant A's six people and refused
 * `not_permitted` on four — the screen offered what the server refuses
 * (CLAUDE.md section 4, R-431).
 *
 * ⚠️ REWRITTEN 21 SEPT AFTER THE TESTER REOPENED THE DEFECT (session 183t).
 * The first fix filtered the list with `canEditNode` over the person's home
 * node, and this pin passed while the app was broken: a line supervisor
 * cannot READ the cells on other lines the plant's people are homed at, so
 * the client held no path for them and the preview failed open (its own
 * rule). A gate on a node the caller cannot see is not one a client can
 * transcribe, so the form now ASKS: `fetchRecordableAbsencePeople()` is
 * migration 0084's `absence_recordable_people()`, SECURITY DEFINER, running
 * the same expression `set_absence` gates on, and the Person list is the
 * visible people intersected with that answer. The server side of the
 * contract — that the function names exactly the people `set_absence`
 * accepts — is `88_absences_test.sql` AB35, person by person; this pin holds
 * the client side: the form offers the answer, all of it and nothing else,
 * and says Loading or an error rather than guessing while it has none.
 *
 * The mocks stop at the network boundary (`@/lib/api`), the same shape
 * `absencesPanel.test.tsx` uses.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
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
    from: "2027-03-02",
    to: "2027-03-06",
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

/** The Person `<select>`'s options, by their visible label. */
function personOptions(): string[] {
  const select = screen.getByRole("combobox", { name: "Person" });
  return within(select)
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
}

// The tester's live measurement as Ana on a fresh seed (session 183t): six
// people visible, the server accepts two.
const PLANT_A = [
  ["sam", "Sam Patel"],
  ["maria", "Maria Lopez"],
  ["john", "John Kim"],
  ["lena", "Lena Novak"],
  ["priya", "Priya Shah"],
  ["tom", "Tom Baker"],
] as const;
const SERVER_ACCEPTS = ["sam", "maria"];

beforeEach(() => {
  h.operators = PLANT_A.map(([id, name]) => h.operator(id, name));
  h.fetchAbsences.mockReset().mockResolvedValue({ absences: [], skipped: 0 });
  h.setAbsence.mockReset();
  h.removeAbsence.mockReset();
  h.fetchNodeSetting.mockReset().mockResolvedValue("America/Chicago");
  h.fetchRecordableAbsencePeople.mockReset();
});

describe("DEF-0035: the Person dropdown offers exactly who the server says set_absence accepts", () => {
  it("Ana is offered the two the server names and none of the other four — the table still lists everyone", async () => {
    h.fetchAbsences.mockResolvedValue({
      absences: [h.absence("A1", "sam"), h.absence("A2", "john")],
      skipped: 0,
    });
    h.fetchRecordableAbsencePeople.mockResolvedValue(SERVER_ACCEPTS);

    wrap(<AbsencesPanel />);

    await waitFor(() =>
      expect(personOptions()).toEqual(["Choose a person…", "Sam Patel", "Maria Lopez"]),
    );
    // The absences TABLE narrows nothing: John Kim's row is still there.
    expect(screen.getByRole("cell", { name: "John Kim" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Sam Patel" })).toBeTruthy();
  });

  it("the answer is used as given — nobody the server did not name slips in, nobody it named is dropped", async () => {
    h.fetchRecordableAbsencePeople.mockResolvedValue(["tom", "lena", "not-a-visible-person"]);

    wrap(<AbsencesPanel />);

    await waitFor(() =>
      expect(personOptions()).toEqual(["Choose a person…", "Lena Novak", "Tom Baker"]),
    );
  });

  it("an empty answer (a viewer) offers nobody, and the form still renders", async () => {
    h.fetchRecordableAbsencePeople.mockResolvedValue([]);

    wrap(<AbsencesPanel />);

    await waitFor(() => expect(personOptions()).toEqual(["Choose a person…"]));
  });

  it("while the answer is pending the panel says Loading — it never offers a list it cannot vouch for", async () => {
    h.fetchRecordableAbsencePeople.mockReturnValue(new Promise(() => {}));

    wrap(<AbsencesPanel />);

    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Person" })).toBeNull();
  });

  it("when the answer fails the panel says so in words, and offers nobody", async () => {
    h.fetchRecordableAbsencePeople.mockRejectedValue({
      kind: "Unknown",
      message: "the recordable people could not be read",
    });

    wrap(<AbsencesPanel />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "the recordable people could not be read",
    );
    expect(screen.queryByRole("combobox", { name: "Person" })).toBeNull();
  });
});
