/**
 * The two halves of the audit read, held against each other.
 *
 * Same failure this file's siblings (`apiCycleTimeShape.test.ts`,
 * `apiSkillShape.test.ts`) exist for: a read has a COLUMN LIST and a GUARD that
 * decides what is acceptable back, and when the two drift apart every row is
 * rejected and the screen renders empty. Empty is a legitimate state for an
 * audit log on a fresh org, so the drift would be invisible — exactly the
 * quietness that made the cycle-times version worth writing.
 *
 * ⚠️ `tsc` CANNOT SEE THIS. One side is a string; the other is a hand-written
 * predicate.
 *
 * ⚠️ AND THE PAGE SIZE IS PART OF THE CONTRACT. PostgREST caps a response at
 * `max_rows = 1000`; there is no `.range(` anywhere else in `src/lib/api/`, and
 * `audit_log` is the one table that will pass a thousand rows first. The page
 * size is asserted to sit well under the ceiling so a page can never be
 * silently truncated by the server instead of by this code.
 */
import { describe, expect, it } from "vitest";
import { AUDIT_COLUMNS, AUDIT_PAGE_SIZE, parseAuditEntry } from "@/lib/api/audit";

/** `"a, b, c"` -> `["a","b","c"]`. */
function selectedColumns(): string[] {
  return AUDIT_COLUMNS.split(",").map((c) => c.trim());
}

/** A row built FROM THE COLUMN LIST, never typed out by hand. */
function rowFromColumns(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sample: Record<string, unknown> = {
    id: 233,
    at: "2026-09-04T19:11:44.921206+00:00",
    actor_id: "00000000-0000-0000-0000-0000000000a1",
    table_name: "assignments",
    row_id: "4183a128-9494-4dbd-97de-1b60eddfa528",
    action: "insert",
    before: null,
    after: { id: "4183a128-9494-4dbd-97de-1b60eddfa528", efficiency: 1 },
  };
  const row: Record<string, unknown> = {};
  for (const col of selectedColumns()) row[col] = sample[col];
  return { ...row, ...overrides };
}

describe("the read asks for exactly what the guard requires", () => {
  it("every column the guard needs is one the read actually selects", () => {
    expect(parseAuditEntry(rowFromColumns())).toEqual({
      id: 233,
      at: "2026-09-04T19:11:44.921206+00:00",
      actorId: "00000000-0000-0000-0000-0000000000a1",
      tableName: "assignments",
      rowId: "4183a128-9494-4dbd-97de-1b60eddfa528",
      action: "insert",
      before: null,
      after: { id: "4183a128-9494-4dbd-97de-1b60eddfa528", efficiency: 1 },
    });
  });

  it("selects the eight columns the table has and no more", () => {
    expect(selectedColumns().sort()).toEqual(
      ["action", "actor_id", "after", "at", "before", "id", "row_id", "table_name"].sort(),
    );
  });
});

describe("the guard refuses a row it cannot render", () => {
  it("rejects a non-object", () => {
    expect(parseAuditEntry(null)).toBe(null);
    expect(parseAuditEntry("row")).toBe(null);
    expect(parseAuditEntry([])).toBe(null);
  });

  it("rejects a row with no id, or an id that is not a number", () => {
    // `id` is the paging cursor. A row without a usable one would break the
    // "load older" chain rather than merely render oddly.
    expect(parseAuditEntry(rowFromColumns({ id: undefined }))).toBe(null);
    expect(parseAuditEntry(rowFromColumns({ id: "233" }))).toBe(null);
  });

  it("rejects an action outside the three the CHECK constraint allows", () => {
    // `audit_log_action_check` (migration 0007) is insert|update|delete. A
    // fourth value has no rendering, so it is not accepted rather than shown
    // as an empty headline.
    expect(parseAuditEntry(rowFromColumns({ action: "truncate" }))).toBe(null);
    expect(parseAuditEntry(rowFromColumns({ action: "update" }))?.action).toBe("update");
    expect(parseAuditEntry(rowFromColumns({ action: "delete" }))?.action).toBe("delete");
  });

  it("keeps a NULL actor, which is a real and common value", () => {
    // `audit_current_actor()` degrades to NULL for a seed or server-side write
    // and the live table has such rows. Rejecting them would hide changes.
    expect(parseAuditEntry(rowFromColumns({ actor_id: null }))?.actorId).toBe(null);
  });

  it("refuses a snapshot that is not a row-shaped object", () => {
    // `before`/`after` are jsonb of a table row. A scalar or an array is not
    // something the field-by-field renderer can walk, so it is normalised to
    // null rather than crashing the list.
    expect(parseAuditEntry(rowFromColumns({ after: 7 }))?.after).toBe(null);
    expect(parseAuditEntry(rowFromColumns({ before: [1, 2] }))?.before).toBe(null);
  });
});

describe("the page size stays under the server's ceiling", () => {
  it("asks for far fewer rows than PostgREST would return", () => {
    expect(AUDIT_PAGE_SIZE).toBeGreaterThan(0);
    // 1000 is `max_rows`. A page at or above it would be truncated BY THE
    // SERVER, and a truncated page looks exactly like the end of the log.
    expect(AUDIT_PAGE_SIZE).toBeLessThan(1000);
  });
});
