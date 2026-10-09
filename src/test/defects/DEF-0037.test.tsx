/**
 * DEF-0037 — the person's absence block in the Operators tab offers Remove on an
 * absence the server's `remove_absence` will refuse.
 *
 * `remove_absence` (0066) refuses unless `app_can_edit_node(coalesce(home, site))`
 * — the SAME gate `set_absence` runs and `absence_recordable_people()` (0084)
 * answers as a set. The block already asks that set for the record form (DEF-0035's
 * second fix: "You cannot record an absence for this person from here."), but the
 * Remove button beside each listed absence is rendered for every row the caller
 * can READ, and a line supervisor can read people on other lines (the operators
 * SELECT policy is plant-wide; `absences_select` follows `app_can_read_operator`).
 * So Ana, on Tom Baker's record, is told she cannot record for him and is offered
 * Remove on his absence in the same block; the press is refused with PT403
 * (measured live, see the defect's Actual).
 *
 * The mocks stop at the network boundary, as operatorAbsences.test.tsx does; the
 * server's recordable answer is mocked because AB35 already holds it to the writer
 * person by person — the gap is that the client does not use it for Remove.
 * Green when a person the server's answer does not name has no Remove to press.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  absence: (id: string, operatorId: string) => ({
    id,
    operatorId,
    from: "2099-03-02",
    to: "2099-03-06",
    reason: "Sick leave",
    source: "manual",
    externalId: null,
  }),
  setAbsence: vi.fn(),
  removeAbsence: vi.fn(),
  fetchAbsences: vi.fn(),
  fetchNodeSetting: vi.fn(),
  fetchRecordableAbsencePeople: vi.fn(),
}));

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: { user: { id: "u1" } },
    profile: { orgId: "org-1" },
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

vi.mock("@/features/admin/components/AbsencesImport", () => ({
  absenceKeys: { all: ["absences"] as const },
}));

import { OperatorAbsences } from "@/features/admin/components/OperatorAbsences";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

// Tom Baker is homed on a line Ana does not hold; she can read him and his
// absence, the server will neither record nor remove for him.
const TOM = { operatorId: "tom", displayName: "Tom Baker", homeNodeId: "line-2-cell" };

beforeEach(() => {
  h.setAbsence.mockReset();
  h.removeAbsence.mockReset().mockRejectedValue({
    code: "not_permitted",
    message: "you cannot remove an absence for someone at that place",
  });
  h.fetchAbsences.mockReset().mockResolvedValue({
    absences: [h.absence("A-tom", TOM.operatorId)],
    skipped: 0,
  });
  h.fetchNodeSetting.mockReset().mockResolvedValue("America/Chicago");
  // The server's answer for Ana: her two on-line people, not Tom.
  h.fetchRecordableAbsencePeople.mockReset().mockResolvedValue(["sam", "maria"]);
});

describe("DEF-0037: the person's absence block offers Remove only where remove_absence accepts", () => {
  it("on a person the server's recordable answer leaves out, the absence is listed with no Remove to press", async () => {
    wrap(<OperatorAbsences {...TOM} />);

    // The block does know Ana may not write for Tom: the form says so.
    expect(
      await screen.findByText("You cannot record an absence for this person from here."),
    ).toBeTruthy();
    // The absence itself is still listed (reading is allowed) ...
    expect(await screen.findByText("Sick leave")).toBeTruthy();
    // ... but nothing may offer the write the server refuses (R-431, CLAUDE.md §4).
    const remove = screen.queryByRole("button", { name: "Remove" });
    expect(
      remove === null || (remove as HTMLButtonElement).disabled,
      "a Remove button is offered on Tom Baker's absence, which remove_absence refuses for this caller",
    ).toBe(true);
  });
});
