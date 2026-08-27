import { describe, expect, it } from "vitest";
import {
  describeSchedulerError,
  isSchedulerError,
  requireWritten,
  toSchedulerError,
} from "@/lib/api";
import type { SchedulerError } from "@/lib/api";
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

  /*
   * ⚠️ THIS CASE CHANGED ITS ANSWER IN §19.63, AND IT IS THE SECOND KIND, NOT
   * THE FIRST (verification-standard rule 1b-ii): the case was right and the
   * CONTRACT changed. `nonJsonDetails` is a real foreign-key violation —
   * deleting a run that assignments still reference — and it fell through to
   * `Unknown` only because nothing yet had an answer for 23503. It has one now.
   *
   * The coverage the old case was legitimately providing — "a non-JSON
   * `details` must not crash the parse path" — is rescued by the case below it,
   * which uses an error with no recognised code so the parse path is actually
   * reached.
   */
  it("reports a foreign-key violation as StillInUse, naming the referencing table", () => {
    const err = toSchedulerError(fixtures.nonJsonDetails);
    expect(err.kind).toBe("StillInUse");
    if (err.kind !== "StillInUse") throw new Error("unreachable");
    expect(err.usedBy).toBe("assignments");
  });

  it("and reports no constraint when the message does not name one", () => {
    // This fixture's message stops at `violates foreign key constraint` with no
    // quoted name. The extractor must return undefined, not the table name it
    // could have scraped from earlier in the sentence.
    const err = toSchedulerError(fixtures.nonJsonDetails);
    if (err.kind !== "StillInUse") throw new Error("unreachable");
    expect(err.constraint).toBe(undefined);
  });

  it("falls through to Unknown when details is not JSON", () => {
    const err = toSchedulerError({
      message: "something went sideways",
      details: "not json at all",
      code: "XX000",
    });
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

/**
 * Design-session verification, P1-5d review.
 *
 * The six hierarchy codes (D74) are a CLOSED SET and every one is reachable by
 * ordinary use of the admin screens, so every one needs its own sentence.
 * Nothing guarded that: `describeSchedulerError` covered all six, but no test
 * would have noticed a missing or duplicated branch.
 *
 * P1-5d's brief compounded this by specifying a SECOND message map in the
 * admin feature, justified on the false premise that `src/lib/api/` holds only
 * the error contract and not its presentation. It holds both, and always did.
 * The duplicate was deleted; this is what should have been written instead.
 */
describe("describeSchedulerError — the six hierarchy codes (D74)", () => {
  const HIERARCHY_ERRORS: SchedulerError[] = [
    { kind: "PathCollision" } as SchedulerError,
    { kind: "NodeCycle" } as SchedulerError,
    { kind: "LevelMismatch" } as SchedulerError,
    { kind: "LevelInUse" } as SchedulerError,
    { kind: "NodeInUse" } as SchedulerError,
    { kind: "SchedulableLevelLocked" } as SchedulerError,
  ];

  it("every one produces a non-trivial sentence", () => {
    for (const e of HIERARCHY_ERRORS) {
      const msg = describeSchedulerError(e);
      expect(msg.length).toBeGreaterThan(10);
    }
  });

  it("none leaks its raw discriminant to the user", () => {
    for (const e of HIERARCHY_ERRORS) {
      expect(describeSchedulerError(e)).not.toContain(e.kind);
    }
  });

  it("all six messages are DISTINCT — a copy-paste branch is a real risk here", () => {
    const msgs = HIERARCHY_ERRORS.map(describeSchedulerError);
    expect(new Set(msgs).size).toBe(HIERARCHY_ERRORS.length);
  });

  /*
   * P1-5k gave `schedulable_level_locked` a SECOND caller that means something
   * different by it: `save_hierarchy_levels` refuses moving the schedulable
   * FLAG off a level with work, `app_relevel_subtree` refuses moving the NODES
   * off the schedulable rung. The old sentence described only the first and was
   * simply false about the second. These two cases pin the shape that has to
   * work for both, including the payload-less variant the list above builds.
   */
  it("the stranded-work message names the count when the payload carries one", () => {
    const msg = describeSchedulerError({
      kind: "SchedulableLevelLocked",
      blockingRows: 3,
      levelId: "lvl-1",
    } as SchedulerError);
    expect(msg).toContain("3 runs or assignments");
  });

  it("and it still reads as a sentence when the payload carries none", () => {
    const msg = describeSchedulerError({ kind: "SchedulableLevelLocked" } as SchedulerError);
    expect(msg).toContain("scheduled work");
    expect(msg).not.toContain("undefined");
  });
});

/* ---------------------------------------------------------------------------
   Group W (§19.63) — WHAT A TABLE WRITE FAILS WITH.

   Everything above this block describes a refusal raised by `api_raise` with a
   machine code in DETAIL. The three queued admin sections have no RPCs at all,
   so they write their tables directly and fail with a bare SQLSTATE. Three
   independent surveys found the same four wrong answers, and these cases are
   what stops them coming back.

   Every fixture used here was measured against the real schema; none was
   composed by hand. See the header of `fixtures/postgrest-errors.ts`.
   --------------------------------------------------------------------------- */
describe("toSchedulerError — table writes (§19.63)", () => {
  it("W1: a row refused by a policy is WriteRefused, not Unauthenticated", () => {
    // The user is signed in. Telling them to sign in is how someone ends up
    // signing out and back in to fix a permission they do not have.
    expect(toSchedulerError(fixtures.rlsInsertRefused).kind).toBe("WriteRefused");
  });

  it("W2: the SAME SQLSTATE on a revoked function is still Unauthenticated", () => {
    // 42501 means two things. If this case and W1 ever agree, the split is gone.
    expect(toSchedulerError(fixtures.functionGrantRefused).kind).toBe("Unauthenticated");
  });

  it("W3: a duplicate key is DuplicateValue and names the constraint", () => {
    const err = toSchedulerError(fixtures.duplicateSku);
    expect(err.kind).toBe("DuplicateValue");
    if (err.kind !== "DuplicateValue") throw new Error("unreachable");
    expect(err.constraint).toBe("products_org_id_sku_key");
  });

  it("W4: a foreign-key violation is StillInUse and names what is using it", () => {
    const err = toSchedulerError(fixtures.productStillReferenced);
    expect(err.kind).toBe("StillInUse");
    if (err.kind !== "StillInUse") throw new Error("unreachable");
    expect(err.usedBy).toBe("runs");
  });

  it("W5: and it names the CONSTRAINT, not the table quoted before it", () => {
    // The message is `update or delete on table "products" violates foreign key
    // constraint "runs_..."`. Taking the first quoted string returns "products",
    // which looks exactly like a correct answer.
    const err = toSchedulerError(fixtures.productStillReferenced);
    if (err.kind !== "StillInUse") throw new Error("unreachable");
    expect(err.constraint).toBe("runs_org_id_product_id_fkey");
  });

  it("W6: a foreign-key violation with no detail line still reports StillInUse", () => {
    const err = toSchedulerError({ ...fixtures.productStillReferenced, details: "" });
    expect(err.kind).toBe("StillInUse");
    if (err.kind !== "StillInUse") throw new Error("unreachable");
    expect(err.usedBy).toBe(undefined);
  });

  it("W7: a CHECK violation is InvalidValue", () => {
    const err = toSchedulerError(fixtures.badColourToken);
    expect(err.kind).toBe("InvalidValue");
    if (err.kind !== "InvalidValue") throw new Error("unreachable");
    expect(err.constraint).toBe("products_color_token_shape");
  });

  it("W8: 23P01 naming the SHIFTS constraint is ShiftOverlap", () => {
    expect(toSchedulerError(fixtures.shiftsOverlap).kind).toBe("ShiftOverlap");
  });

  it("W9: 23P01 naming the RUNS constraint is still RaceLost", () => {
    // The existing behaviour, unchanged — `useMoveRun` retries on it.
    expect(toSchedulerError(fixtures.bareExclusionViolation).kind).toBe("RaceLost");
  });

  it("W10: 23P01 naming an unknown constraint falls back to RaceLost", () => {
    // A retry is the safe default for an exclusion constraint nobody has
    // classified yet, so the fallback deliberately is not the new kind.
    const err = toSchedulerError({
      message: 'conflicting key value violates exclusion constraint "something_new"',
      code: "23P01",
    });
    expect(err.kind).toBe("RaceLost");
  });

  it("W11: requireWritten throws WriteRefused when a write matched nothing", () => {
    // A policy's USING clause filters instead of raising, so a refused UPDATE
    // is a success that changed nothing.
    let caught: unknown;
    try {
      requireWritten([]);
    } catch (e) {
      caught = e;
    }
    expect(isSchedulerError(caught)).toBe(true);
    expect((caught as SchedulerError).kind).toBe("WriteRefused");
  });

  it("W12: requireWritten treats a null payload the same way", () => {
    let caught: unknown;
    try {
      requireWritten(null);
    } catch (e) {
      caught = e;
    }
    expect((caught as SchedulerError).kind).toBe("WriteRefused");
  });

  it("W13: requireWritten returns the rows when the write landed", () => {
    const rows = [{ id: "a" }];
    expect(requireWritten(rows)).toEqual(rows);
  });

  it("W14: every new kind has its own sentence, and none leaks its discriminant", () => {
    const kinds: SchedulerError[] = [
      { kind: "WriteRefused" },
      { kind: "DuplicateValue" },
      { kind: "StillInUse" },
      { kind: "InvalidValue" },
      { kind: "ShiftOverlap" },
    ];
    const msgs = kinds.map(describeSchedulerError);
    expect(new Set(msgs).size).toBe(kinds.length);
    for (let i = 0; i < kinds.length; i++) {
      expect(msgs[i].length).toBeGreaterThan(10);
      expect(msgs[i]).not.toContain(kinds[i].kind);
    }
  });

  it("W15: StillInUse names the table in its sentence when it knows one", () => {
    expect(describeSchedulerError({ kind: "StillInUse", usedBy: "runs" })).toContain("runs");
  });

  it("W16: isSchedulerError recognises all five new kinds", () => {
    for (const kind of [
      "WriteRefused",
      "DuplicateValue",
      "StillInUse",
      "InvalidValue",
      "ShiftOverlap",
    ]) {
      expect(isSchedulerError({ kind })).toBe(true);
    }
  });
});
