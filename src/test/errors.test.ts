import { describe, expect, it } from "vitest";
import { isSchedulerError, toSchedulerError } from "@/lib/api";
import * as fixtures from "./fixtures/postgrest-errors";

describe("toSchedulerError", () => {
  it("parses capacity_exceeded with every field", () => {
    const err = toSchedulerError(fixtures.capacityExceeded);
    expect(err.kind).toBe("CapacityExceeded");
    if (err.kind !== "CapacityExceeded") throw new Error("unreachable");
    expect(err.operatorId).toBe("50000000-0000-0000-0000-000000000003");
    expect(err.peak).toBe(1.5);
    expect(err.cap).toBe(1.0);
    expect(err.timerange).toBe('["2026-08-18 08:00:00+00","2026-08-18 12:00:00+00")');
  });

  it("parses not_eligible (missing skills) with every field", () => {
    const err = toSchedulerError(fixtures.notEligible);
    expect(err.kind).toBe("NotEligible");
    if (err.kind !== "NotEligible") throw new Error("unreachable");
    expect(err.operatorId).toBe("50000000-0000-0000-0000-000000000004");
    expect(err.nodeId).toBe("30000000-0000-0000-0000-000000000006");
    expect(err.missingSkills).toEqual([
      { id: "40000000-0000-0000-0000-000000000001", name: "CNC" },
    ]);
    expect(err.expiringSkills).toEqual([]);
    expect(err.policy).toBe("warn");
  });

  it("parses not_eligible (expiring skills) with every field", () => {
    const err = toSchedulerError(fixtures.notEligibleExpiring);
    expect(err.kind).toBe("NotEligible");
    if (err.kind !== "NotEligible") throw new Error("unreachable");
    expect(err.missingSkills).toEqual([]);
    expect(err.expiringSkills).toEqual([
      { id: "40000000-0000-0000-0000-000000000001", name: "CNC", expiresAt: "2099-06-15" },
    ]);
  });

  it("parses run_overlap with every field", () => {
    const err = toSchedulerError(fixtures.runOverlap);
    expect(err.kind).toBe("RunOverlap");
    if (err.kind !== "RunOverlap") throw new Error("unreachable");
    expect(err.nodeId).toBe("30000000-0000-0000-0000-000000000007");
    expect(err.timerange).toBe('["2026-08-18 06:00:00+00","2026-08-18 14:00:00+00")');
    expect(err.conflictingRunId).toBe("80000000-0000-0000-0000-000000000001");
  });

  it("parses run_node_mismatch with every field", () => {
    const err = toSchedulerError(fixtures.runNodeMismatch);
    expect(err.kind).toBe("RunNodeMismatch");
    if (err.kind !== "RunNodeMismatch") throw new Error("unreachable");
    expect(err.assignmentNodeId).toBe("30000000-0000-0000-0000-000000000007");
    expect(err.runNodeId).toBe("30000000-0000-0000-0000-000000000008");
    expect(err.runId).toBe("80000000-0000-0000-0000-000000000001");
  });

  it("parses not_permitted with every field", () => {
    const err = toSchedulerError(fixtures.notPermitted);
    expect(err.kind).toBe("NotPermitted");
    if (err.kind !== "NotPermitted") throw new Error("unreachable");
    expect(err.nodeId).toBe("30000000-0000-0000-0000-000000000002");
  });

  it("parses invalid_argument with every field", () => {
    const err = toSchedulerError(fixtures.invalidArgument);
    expect(err.kind).toBe("InvalidArgument");
    if (err.kind !== "InvalidArgument") throw new Error("unreachable");
    expect(err.field).toBe("p_timerange");
    expect(err.reason).toBe("null or empty");
  });

  it("falls through to Unknown when details is absent", () => {
    const err = toSchedulerError(fixtures.missingDetails);
    expect(err.kind).toBe("Unknown");
  });

  it("falls through to Unknown when details is not JSON", () => {
    const err = toSchedulerError(fixtures.nonJsonDetails);
    expect(err.kind).toBe("Unknown");
  });

  it("falls through to Unknown for an unrecognised error value", () => {
    const err = toSchedulerError(fixtures.unrecognisedErrorValue);
    expect(err.kind).toBe("Unknown");
  });

  it("maps a bare 23P01 to RaceLost regardless of its (non-JSON) details", () => {
    const err = toSchedulerError(fixtures.bareExclusionViolation);
    expect(err.kind).toBe("RaceLost");
  });

  it("maps SQLSTATE 42501 to Unauthenticated", () => {
    const err = toSchedulerError(fixtures.permissionDenied401);
    expect(err.kind).toBe("Unauthenticated");
  });

  it("maps an explicit status: 401 to Unauthenticated defensively", () => {
    const err = toSchedulerError({ message: "Unauthorized", status: 401 });
    expect(err.kind).toBe("Unauthenticated");
  });

  it("falls through to Unknown for a plain Error, carrying it verbatim", () => {
    const err = toSchedulerError(fixtures.plainError);
    expect(err.kind).toBe("Unknown");
    if (err.kind !== "Unknown") throw new Error("unreachable");
    expect(err.raw).toBe(fixtures.plainError);
  });

  it("falls through to Unknown for null", () => {
    const err = toSchedulerError(fixtures.nullError);
    expect(err.kind).toBe("Unknown");
  });

  it("falls through to Unknown for undefined", () => {
    const err = toSchedulerError(undefined);
    expect(err.kind).toBe("Unknown");
  });

  it("falls through to Unknown for a bare string, number, or array", () => {
    expect(toSchedulerError("boom").kind).toBe("Unknown");
    expect(toSchedulerError(42).kind).toBe("Unknown");
    expect(toSchedulerError([1, 2, 3]).kind).toBe("Unknown");
  });

  it("never throws, across every fixture and every additional edge case", () => {
    const inputs: unknown[] = [
      ...Object.values(fixtures),
      undefined,
      "boom",
      42,
      [1, 2, 3],
      {},
      { details: 42 },
      { details: "{}" },
      { details: "[1,2,3]" },
      { code: "23P01", details: 12345 },
      { code: 500 },
      { status: "401" },
    ];
    for (const input of inputs) {
      expect(() => toSchedulerError(input)).not.toThrow();
    }
  });
});

describe("isSchedulerError", () => {
  it("accepts every SchedulerError kind toSchedulerError can produce", () => {
    for (const fixture of Object.values(fixtures)) {
      expect(isSchedulerError(toSchedulerError(fixture))).toBe(true);
    }
  });

  it("rejects a raw PostgREST error object and other non-SchedulerError values", () => {
    expect(isSchedulerError(fixtures.capacityExceeded)).toBe(false);
    expect(isSchedulerError(new Error("boom"))).toBe(false);
    expect(isSchedulerError(null)).toBe(false);
    expect(isSchedulerError(undefined)).toBe(false);
    expect(isSchedulerError({ kind: "NotARealKind" })).toBe(false);
  });
});
