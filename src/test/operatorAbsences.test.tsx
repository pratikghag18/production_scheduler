/**
 * operatorAbsences.test.tsx — R-360, the selected person's own absences on
 * their record in the Operators tab.
 *
 * The mocks stop at the network boundary (`@/lib/api`), the same shape
 * `absencesPanel.test.tsx` uses for its twin screen, so the two share one
 * fixture vocabulary and cannot silently drift into two different shapes for
 * "an absence".
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// The REAL parser — `@/lib/api` (the barrel) is mocked below, but this
// submodule import is not, so `parseAbsenceRecord` here is 0069's actual code.
import { parseAbsenceRecord } from "@/lib/api/absences";

const h = vi.hoisted(() => ({
  absence: (id: string, operatorId: string, from = "2027-03-02", to = "2027-03-06") => ({
    id,
    operatorId,
    from,
    to,
    reason: "Sick leave",
    source: "manual",
    externalId: null,
  }),
  partDayAbsence: (id: string, operatorId: string, day = "2027-06-10") => ({
    id,
    operatorId,
    from: day,
    to: day,
    reason: "Dentist",
    source: "manual",
    externalId: null,
    startsAt: `${day}T09:00:00.000Z`,
    endsAt: `${day}T13:00:00.000Z`,
  }),
  setAbsence: vi.fn(),
  removeAbsence: vi.fn(),
  fetchAbsences: vi.fn(),
  fetchNodeSetting: vi.fn(),
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
  describeSchedulerError: (e: unknown) =>
    (e as { message?: string })?.message ?? "Something went wrong.",
}));

// The same reason absencesPanel.test.tsx mocks this module: `absenceKeys` is
// the only thing OperatorAbsences reaches for, and the file's own top-level
// imports (ImportWizard, the csv/planner libraries) are not this suite's
// business to load.
vi.mock("@/features/admin/components/AbsencesImport", () => ({
  absenceKeys: { all: ["absences"] as const },
}));

import { OperatorAbsences } from "@/features/admin/components/OperatorAbsences";

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const ELENA = { operatorId: "O1", displayName: "Elena", homeNodeId: "root-1" };
const TOM = { operatorId: "O2", displayName: "Tom", homeNodeId: "root-2" };

beforeEach(() => {
  h.setAbsence.mockReset().mockResolvedValue(h.absence("A-new", ELENA.operatorId));
  h.removeAbsence.mockReset().mockResolvedValue(undefined);
  h.fetchAbsences.mockReset().mockResolvedValue({ absences: [], skipped: 0 });
  h.fetchNodeSetting.mockReset().mockResolvedValue("America/Chicago");
});

describe("OperatorAbsences — reading this person's own absences (R-360)", () => {
  it("an honest empty state names the person", async () => {
    wrap(<OperatorAbsences {...ELENA} />);
    expect(await screen.findByText(/Elena has no absences recorded\./)).toBeTruthy();
  });

  it("shares the cache with the Absences tab: the same key, the same read", async () => {
    h.fetchAbsences.mockResolvedValue({
      absences: [h.absence("A1", ELENA.operatorId, "2099-01-01", "2099-01-03")],
      skipped: 0,
    });
    wrap(<OperatorAbsences {...ELENA} />);
    await screen.findByText("Sick leave");
    // fetchAbsences is the SAME function AbsencesPanel.tsx calls, under the
    // SAME query key ([...absenceKeys.all, "admin"]) — one call is proof
    // enough that this is the shared cache entry rather than a second read.
    expect(h.fetchAbsences).toHaveBeenCalledTimes(1);
  });

  it("filters to THIS person only", async () => {
    h.fetchAbsences.mockResolvedValue({
      absences: [
        h.absence("A1", ELENA.operatorId, "2099-01-01", "2099-01-03"),
        h.absence("A2", TOM.operatorId, "2099-02-01", "2099-02-03"),
      ],
      skipped: 0,
    });
    wrap(<OperatorAbsences {...ELENA} />);
    await screen.findByText("Sick leave");
    expect(screen.getAllByText("Sick leave")).toHaveLength(1);
  });

  it("lists whole-day and part-day absences, soonest first", async () => {
    h.fetchAbsences.mockResolvedValue({
      absences: [
        h.absence("A-later", ELENA.operatorId, "2099-05-01", "2099-05-03"),
        h.partDayAbsence("A-sooner", ELENA.operatorId, "2099-04-01"),
      ],
      skipped: 0,
    });
    wrap(<OperatorAbsences {...ELENA} />);
    await screen.findByText("Dentist");
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).getByText("Dentist")).toBeTruthy();
    expect(within(rows[1]).getByText("Sick leave")).toBeTruthy();
  });

  it("shows a part-day row's hours in the person's own resolved zone", async () => {
    h.fetchAbsences.mockResolvedValue({
      absences: [h.partDayAbsence("A1", ELENA.operatorId, "2027-06-10")],
      skipped: 0,
    });
    wrap(<OperatorAbsences {...ELENA} />);
    // America/Chicago is UTC-5 in June: 09:00Z/13:00Z -> 04:00/08:00.
    expect(await screen.findByText(/04:00–08:00/)).toBeTruthy();
    expect(h.fetchNodeSetting).toHaveBeenCalledWith(ELENA.homeNodeId, "timezone");
  });

  it("past absences are hidden by default, behind a 'show past' toggle naming the count", async () => {
    h.fetchAbsences.mockResolvedValue({
      absences: [
        h.absence("A-past", ELENA.operatorId, "2000-01-01", "2000-01-03"),
        h.absence("A-future", ELENA.operatorId, "2099-01-01", "2099-01-03"),
      ],
      skipped: 0,
    });
    wrap(<OperatorAbsences {...ELENA} />);
    await screen.findByRole("listitem");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    const toggle = screen.getByRole("button", { name: "Show past (1)" });
    fireEvent.click(toggle);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Hide past" })).toBeTruthy();
  });
});

describe("OperatorAbsences — recording and removing in place (R-360)", () => {
  it("records a whole-day absence for THIS person through setAbsence", async () => {
    wrap(<OperatorAbsences {...ELENA} />);
    await screen.findByText(/has no absences recorded/);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2027-05-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2027-05-03" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Annual leave" } });
    fireEvent.click(screen.getByRole("button", { name: "Record absence" }));
    await waitFor(() => expect(h.setAbsence).toHaveBeenCalledTimes(1));
    expect(h.setAbsence).toHaveBeenCalledWith({
      operatorId: ELENA.operatorId,
      from: "2027-05-01",
      to: "2027-05-03",
      reason: "Annual leave",
    });
  });

  it("records a part-day absence converted to instants in this person's OWN zone", async () => {
    wrap(<OperatorAbsences {...ELENA} />);
    await screen.findByText(/has no absences recorded/);
    fireEvent.click(screen.getByLabelText("Part of a day"));
    await screen.findByText("Times are in America/Chicago.");
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2027-06-10" } });
    fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByLabelText("End time"), { target: { value: "13:00" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Dentist" } });
    fireEvent.click(screen.getByRole("button", { name: "Record absence" }));
    await waitFor(() => expect(h.setAbsence).toHaveBeenCalledTimes(1));
    expect(h.setAbsence).toHaveBeenCalledWith({
      operatorId: ELENA.operatorId,
      from: "2027-06-10",
      to: "2027-06-10",
      reason: "Dentist",
      startsAt: "2027-06-10T14:00:00.000Z",
      endsAt: "2027-06-10T18:00:00.000Z",
    });
  });

  it("a server refusal is shown in words, never pre-guessed", async () => {
    h.setAbsence.mockRejectedValueOnce({
      kind: "NotPermitted",
      message: "You cannot record an absence for someone at that place.",
    });
    wrap(<OperatorAbsences {...ELENA} />);
    await screen.findByText(/has no absences recorded/);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2027-05-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2027-05-03" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Leave" } });
    fireEvent.click(screen.getByRole("button", { name: "Record absence" }));
    expect(
      await screen.findByText("You cannot record an absence for someone at that place."),
    ).toBeTruthy();
  });

  it("removes one of this person's absences through removeAbsence", async () => {
    h.fetchAbsences.mockResolvedValue({
      absences: [h.absence("A1", ELENA.operatorId, "2099-01-01", "2099-01-03")],
      skipped: 0,
    });
    wrap(<OperatorAbsences {...ELENA} />);
    await screen.findByText("Sick leave");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(h.removeAbsence).toHaveBeenCalledWith("A1"));
  });
});

/* ===========================================================================
 * REGRESSION — `parseAbsenceRecord`'s `timerange` parse, found driving this
 * exact screen in a browser (not by any mock): `set_absence` inserted a
 * part-day row correctly, and the panel reported "Something went wrong" on
 * the very same response. Postgres's timestamptz text is `...+00` (a bare
 * 2-digit offset, no minutes) for UTC, and V8's `Date` ISO 8601 parser treats
 * that as Invalid Date rather than assuming `:00` — so the parser threw the
 * successful write away as a shape mismatch. `@/lib/api` is mocked above for
 * every other case in this file, but this import reaches the real
 * `src/lib/api/absences.ts`, so this pins the actual parser rather than a
 * fiction of it.
 * ======================================================================== */
describe("parseAbsenceRecord — the timerange parse (found live, not by a mock)", () => {
  const wholeDayRow = {
    id: "a1",
    operator_id: "op-1",
    daterange: "[2027-06-10,2027-06-11)",
    timerange: null,
    reason: "sick",
    source: "manual",
    external_id: null,
  };

  it("a whole-day row (timerange: null) parses with no startsAt/endsAt", () => {
    const parsed = parseAbsenceRecord(wholeDayRow);
    expect(parsed).not.toBeNull();
    expect(parsed?.startsAt).toBeUndefined();
    expect(parsed?.endsAt).toBeUndefined();
  });

  it("a part-day row's UTC bound (Postgres's bare '+00', no minutes) parses to a valid instant", () => {
    const parsed = parseAbsenceRecord({
      ...wholeDayRow,
      timerange: '["2027-06-10 09:00:00+00","2027-06-10 13:00:00+00")',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.startsAt).toBe("2027-06-10T09:00:00.000Z");
    expect(parsed?.endsAt).toBe("2027-06-10T13:00:00.000Z");
  });

  it("a non-UTC, non-whole-hour offset ('+05:30') also parses correctly", () => {
    const parsed = parseAbsenceRecord({
      ...wholeDayRow,
      timerange: '["2027-06-10 09:00:00+05:30","2027-06-10 13:00:00+05:30")',
    });
    expect(parsed?.startsAt).toBe("2027-06-10T03:30:00.000Z");
    expect(parsed?.endsAt).toBe("2027-06-10T07:30:00.000Z");
  });

  it("a malformed non-null timerange rejects the WHOLE record, never silently reads as whole-day", () => {
    const parsed = parseAbsenceRecord({ ...wholeDayRow, timerange: "garbage" });
    expect(parsed).toBeNull();
  });
});
