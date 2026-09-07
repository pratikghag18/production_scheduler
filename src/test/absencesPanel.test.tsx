/**
 * absencesPanel.test.tsx — the Absences admin section (R-357).
 *
 * Two things: the SECTION is offered to a supervisor and a viewer never reaches
 * the admin screen at all (adminSectionsFor / adminAccess, run for real); and the
 * PANEL records and removes through the api and shows a refusal as a sentence
 * rather than swallowing it (CLAUDE.md section 4 — the screen surfaces what the
 * server refuses). The mocks stop at the network boundary and at the two hooks
 * that would otherwise pull the whole api behind them.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminAccess, adminSectionsFor } from "@/features/auth/session";

const h = vi.hoisted(() => ({
  operator: (id: string, displayName: string) => ({
    id,
    displayName,
    employeeRef: null,
    active: true,
    siteNodeId: "root-1",
    source: "manual",
    externalId: null,
  }),
  absence: (id: string, operatorId: string) => ({
    id,
    operatorId,
    from: "2027-03-02",
    to: "2027-03-06",
    reason: "Sick leave",
    source: "manual",
    externalId: null,
  }),
  setAbsence: vi.fn(),
  removeAbsence: vi.fn(),
  fetchAbsences: vi.fn(),
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
  describeSchedulerError: (e: unknown) =>
    (e as { message?: string })?.message ?? "Something went wrong.",
}));

vi.mock("@/features/admin/hooks/useOperators", () => ({
  useOperatorsAdmin: () => ({
    data: { operators: [h.operator("O1", "Elena"), h.operator("O2", "Tom")], nodes: [] },
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
  h.setAbsence.mockReset().mockResolvedValue(h.absence("A-new", "O1"));
  h.removeAbsence.mockReset().mockResolvedValue(undefined);
  h.fetchAbsences.mockReset().mockResolvedValue({ absences: [h.absence("A1", "O1")], skipped: 0 });
});

describe("who is offered the section", () => {
  it("a supervisor is offered Absences beside Operators", () => {
    const sections = adminSectionsFor("supervisor", false);
    expect(Array.isArray(sections) && sections.includes("absences")).toBe(true);
  });

  it("a company admin is offered everything (so Absences too)", () => {
    expect(adminSectionsFor("admin", false)).toBe("all");
  });

  it("a viewer never reaches the admin screen, so the tab is not offered", () => {
    expect(adminAccess("viewer", false, false)).toBe("denied");
  });
});

describe("the panel", () => {
  it("lists absences for the visible people, with the reason and a formatted date", async () => {
    wrap(<AbsencesPanel />);
    expect(await screen.findByText("Sick leave")).toBeTruthy();
    expect(screen.getByText("2027-03-02")).toBeTruthy();
    // The person's name is resolved from the operators list. "Elena" also
    // appears as a <select> option, so target the table CELL specifically.
    expect(screen.getByRole("cell", { name: "Elena" })).toBeTruthy();
  });

  it("records an absence through setAbsence with the entered values", async () => {
    wrap(<AbsencesPanel />);
    await screen.findByText("Sick leave");
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: "O2" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2027-05-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2027-05-03" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "  Annual leave  " } });
    fireEvent.click(screen.getByRole("button", { name: "Record absence" }));
    await waitFor(() => expect(h.setAbsence).toHaveBeenCalledTimes(1));
    expect(h.setAbsence).toHaveBeenCalledWith({
      operatorId: "O2",
      from: "2027-05-01",
      to: "2027-05-03",
      reason: "Annual leave",
    });
  });

  it("shows a server refusal as a sentence and does not clear silently", async () => {
    h.setAbsence.mockRejectedValueOnce({
      kind: "NotPermitted",
      message: "You cannot record an absence for someone at that place.",
    });
    wrap(<AbsencesPanel />);
    await screen.findByText("Sick leave");
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: "O2" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2027-05-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2027-05-03" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Leave" } });
    fireEvent.click(screen.getByRole("button", { name: "Record absence" }));
    expect(
      await screen.findByText("You cannot record an absence for someone at that place."),
    ).toBeTruthy();
  });

  it("rejects an end date before the start without calling the api", async () => {
    wrap(<AbsencesPanel />);
    await screen.findByText("Sick leave");
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: "O2" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2027-05-05" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2027-05-01" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Leave" } });
    fireEvent.click(screen.getByRole("button", { name: "Record absence" }));
    expect(await screen.findByText(/before the start date/i)).toBeTruthy();
    expect(h.setAbsence).not.toHaveBeenCalled();
  });

  it("removes an absence through removeAbsence", async () => {
    wrap(<AbsencesPanel />);
    await screen.findByText("Sick leave");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(h.removeAbsence).toHaveBeenCalledWith("A1"));
  });
});
