/**
 * absenceForm.test.tsx — S70-a / R-360 amended, R-449, R-431. `AbsenceForm` is
 * the one component `AbsencesPanel.tsx` (a dropdown of the server's own
 * recordable people) and `OperatorAbsences.tsx` (the person fixed) both mount
 * — see the component's own header. The dropdown half is already exercised
 * end to end by `absencesPanel.test.tsx` and `defects/DEF-0035.test.tsx`; this
 * file is the FIXED-person half those two never reach: the brief's own case
 * ("with a fixed person the server does not accept, the form offers no
 * Record and says so; with one it does, it records for exactly that
 * person").
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  setAbsence: vi.fn(),
  fetchNodeSetting: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  setAbsence: (input: unknown) => h.setAbsence(input),
  fetchNodeSetting: (nodeId: string, key: string) => h.fetchNodeSetting(nodeId, key),
  describeSchedulerError: (e: unknown) =>
    (e as { message?: string })?.message ?? "Something went wrong.",
}));

vi.mock("@/features/admin/components/AbsencesImport", () => ({
  absenceKeys: { all: ["absences"] as const },
}));

import { AbsenceForm } from "@/features/admin/components/AbsenceForm";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const ELENA = { id: "O1", displayName: "Elena", siteNodeId: "root-1" };

beforeEach(() => {
  h.setAbsence.mockReset().mockResolvedValue({
    id: "A-new",
    operatorId: ELENA.id,
    from: "2027-05-01",
    to: "2027-05-03",
    reason: "Annual leave",
    source: "manual",
    externalId: null,
  });
  h.fetchNodeSetting.mockReset().mockResolvedValue("America/Chicago");
});

describe("AbsenceForm — a fixed person the server does not accept (R-431)", () => {
  it("offers no Record button, and says a person-wide sentence, not the cell-shaped NotPermitted one", async () => {
    wrap(
      <AbsenceForm
        ariaLabel="Record an absence for Elena"
        people={[]}
        fixedPerson={ELENA}
        fixedPersonRecordable={false}
        canQuery
      />,
    );

    // Not describeSchedulerError's NotPermitted sentence ("You do not have
    // edit rights on this cell.") — this screen names a person, not a cell,
    // and the server's own `set_absence` wording never reaches the client
    // (errors.ts parses `not_permitted`'s detail into `{ nodeId }` only, no
    // message text). See AbsenceForm.tsx's header for why.
    expect((await screen.findByRole("alert")).textContent).toBe(
      "You cannot record an absence for this person from here.",
    );
    expect(screen.queryByRole("button", { name: "Record absence" })).toBeNull();
    expect(screen.queryByLabelText("Reason")).toBeNull();
    expect(h.setAbsence).not.toHaveBeenCalled();
  });

  it("says Loading while the recordable answer is still pending, and offers nothing either", () => {
    wrap(
      <AbsenceForm
        ariaLabel="Record an absence for Elena"
        people={[]}
        fixedPerson={ELENA}
        fixedPersonRecordable={null}
        canQuery
      />,
    );

    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record absence" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("AbsenceForm — a fixed person the server accepts", () => {
  it("shows the name as text, not a dropdown, and records for exactly that person", async () => {
    wrap(
      <AbsenceForm
        ariaLabel="Record an absence for Elena"
        people={[]}
        fixedPerson={ELENA}
        fixedPersonRecordable={true}
        canQuery
      />,
    );

    expect(screen.getByText("Elena")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Person" })).toBeNull();

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2027-05-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2027-05-03" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Annual leave" } });
    fireEvent.click(screen.getByRole("button", { name: "Record absence" }));

    await waitFor(() => expect(h.setAbsence).toHaveBeenCalledTimes(1));
    expect(h.setAbsence).toHaveBeenCalledWith({
      operatorId: ELENA.id,
      from: "2027-05-01",
      to: "2027-05-03",
      reason: "Annual leave",
    });
  });

  it("a server refusal after the click is shown in words, never pre-guessed", async () => {
    h.setAbsence.mockRejectedValueOnce({
      kind: "AbsenceOverlap",
      message: "This person already has an absence over some of those days.",
    });
    wrap(
      <AbsenceForm
        ariaLabel="Record an absence for Elena"
        people={[]}
        fixedPerson={ELENA}
        fixedPersonRecordable={true}
        canQuery
      />,
    );

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2027-05-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2027-05-03" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Leave" } });
    fireEvent.click(screen.getByRole("button", { name: "Record absence" }));

    expect(
      await screen.findByText("This person already has an absence over some of those days."),
    ).toBeTruthy();
  });
});

describe("AbsenceForm — the dropdown case (no fixed person)", () => {
  const TOM = { id: "O2", displayName: "Tom", siteNodeId: "root-2" };

  it("offers exactly the given people, and records for the one chosen", async () => {
    wrap(<AbsenceForm ariaLabel="Record an absence" people={[ELENA, TOM]} canQuery />);

    fireEvent.change(screen.getByLabelText("Person"), { target: { value: TOM.id } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2027-05-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2027-05-03" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "  Annual leave  " } });
    fireEvent.click(screen.getByRole("button", { name: "Record absence" }));

    await waitFor(() => expect(h.setAbsence).toHaveBeenCalledTimes(1));
    expect(h.setAbsence).toHaveBeenCalledWith({
      operatorId: TOM.id,
      from: "2027-05-01",
      to: "2027-05-03",
      reason: "Annual leave",
    });
  });

  it("refuses to submit with no person chosen, without calling the api", async () => {
    wrap(<AbsenceForm ariaLabel="Record an absence" people={[ELENA, TOM]} canQuery />);

    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Leave" } });
    fireEvent.click(screen.getByRole("button", { name: "Record absence" }));

    expect(await screen.findByText("Choose a person.")).toBeTruthy();
    expect(h.setAbsence).not.toHaveBeenCalled();
  });
});
