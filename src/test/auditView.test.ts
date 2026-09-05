/**
 * READING THE AUDIT LOG — the pure half (`src/features/admin/lib/auditView.ts`).
 *
 * Every write to `assignments`, `operators`, `products`, `runs`,
 * `shift_templates` and `skills` has been recorded since migration 0007/0029,
 * with the WHOLE row as jsonb in `before`/`after`. Nothing in `src/` has ever
 * read it. The hard part is not the query, it is that a person cannot read a
 * jsonb row dump: `{"operator_id":"b8ab…","efficiency":1.000,…}` answers
 * "something changed" and nothing else.
 *
 * ⭐ SO THE UNIT UNDER TEST IS THE SENTENCE, NOT THE FETCH. Given a raw audit
 * row, what does a reader see — which THING changed, what it is called, and
 * which FIELDS moved from what to what. That is all pure, so it is all here,
 * and `AuditPanel.tsx` is left holding only layout.
 *
 * ⚠️ THE SUBJECT'S NAME COMES OUT OF THE SNAPSHOT, NEVER OUT OF A JOIN. For a
 * DELETE the row is gone — a join would render a blank where the most important
 * word on the line belongs. `before`/`after` carry `display_name` / `name` /
 * `product_name`, which is the name AS IT WAS AT THE TIME, and that is the only
 * correct answer for a history.
 *
 * ⚠️ THE FOUR OMITTED COLUMNS ARE ASSERTED, not assumed. `updated_at` moves on
 * every single UPDATE (an unconditional `set_updated_at` trigger, migration
 * 0003 — the very reason `write_audit_log` compares rows with it excluded), so
 * listing it would put one meaningless line on every change. `id`/`org_id` are
 * constants. Anything else is shown, because an audit log that silently drops
 * fields is worse than no audit log.
 */
import { describe, expect, it } from "vitest";
import { formatCalendarDay, type DateFormat } from "@/lib/format/dates";
import {
  OMITTED_FIELDS,
  describeActor,
  describeEntry,
  describeTable,
  fieldLabel,
  formatAuditValue,
  formatInstant,
} from "@/features/admin/lib/auditView";

const FMT: DateFormat = "d_mon_yyyy";

/** The local calendar day of an instant, built the way the module must build
 *  it: LOCAL, never `toISOString().slice(0,10)` (which is the UTC day and is a
 *  day out west of Greenwich). Computed here so no case hard-codes a string
 *  that only holds in one timezone. */
function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function localHm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

describe("the six audited tables are named in words, not in table names", () => {
  it("names every table that carries the trigger", () => {
    // The six `*_audit` triggers on the database, 0007 (runs, assignments) and
    // 0029 §6 (products, operators, skills, shift_templates).
    expect(describeTable("assignments")).toBe("Assignment");
    expect(describeTable("operators")).toBe("Operator");
    expect(describeTable("products")).toBe("Product");
    expect(describeTable("runs")).toBe("Run");
    // ⚠️ `skills` IS THE TRAININGS TABLE. The product renamed the concept and
    // the table did not follow; showing "Skills" here would name a thing the
    // app's own Trainings tab does not have.
    expect(describeTable("skills")).toBe("Training");
    expect(describeTable("shift_templates")).toBe("Shift pattern");
  });

  it("falls back to a readable form for a table the client has not been taught", () => {
    // A seventh trigger added server-side must not render as a blank or throw.
    expect(describeTable("node_shift_templates")).toBe("Node shift templates");
  });
});

describe("column names are read as words", () => {
  it("turns snake_case into a sentence", () => {
    expect(fieldLabel("operator_display_name")).toBe("Operator display name");
  });

  it("names the columns whose prettified form would be wrong or bare", () => {
    expect(fieldLabel("sku")).toBe("SKU");
    expect(fieldLabel("timerange")).toBe("When");
    expect(fieldLabel("node_id")).toBe("Place");
  });
});

describe("values are rendered for a reader", () => {
  it("says nothing rather than null", () => {
    expect(formatAuditValue(null, FMT)).toBe("—");
    expect(formatAuditValue(undefined, FMT)).toBe("—");
  });

  it("distinguishes an empty string from an absent value", () => {
    // Two different facts. "—" for both would make a cleared note look like a
    // column that was never set.
    expect(formatAuditValue("", FMT)).toBe("(blank)");
  });

  it("renders a boolean as a word", () => {
    expect(formatAuditValue(true, FMT)).toBe("yes");
    expect(formatAuditValue(false, FMT)).toBe("no");
  });

  it("renders numbers and plain strings as themselves", () => {
    expect(formatAuditValue(0.5, FMT)).toBe("0.5");
    expect(formatAuditValue("cancelled", FMT)).toBe("cancelled");
  });

  /**
   * ⭐ THE RANGE IS THE ONE VALUE WORTH DECODING. `timerange` is the single
   * most-changed column in the log (assignments and runs are most of it) and it
   * arrives as a raw Postgres range literal:
   *   ["2026-09-04 16:30:00+00","2026-09-04 19:30:00+00")
   * — which is a shift, written in a form no reader should be asked to parse.
   *
   * ⚠️ THE LITERAL IS NOT ISO. The bound is space-separated with a two-digit
   * offset (`+00`, not `+00:00`), which `new Date()` parses only by
   * implementation grace. The module must normalise it; this case is what says
   * so, because a silent `Invalid Date` would render "NaN" on most rows.
   */
  it("decodes a Postgres range into a start and an end", () => {
    const out = formatAuditValue('["2026-09-04 16:30:00+00","2026-09-04 19:30:00+00")', FMT);
    const day = formatCalendarDay(localDay("2026-09-04T16:30:00Z"), FMT);
    expect(out).toContain(day);
    expect(out).toContain(localHm("2026-09-04T16:30:00Z"));
    expect(out).toContain(localHm("2026-09-04T19:30:00Z"));
    expect(out).toContain("→");
    expect(out).not.toContain("NaN");
    expect(out).not.toContain('"');
  });

  it("keeps an undecodable range visible rather than swallowing it", () => {
    // Honesty beats tidiness in a log: a bound this code cannot read is still
    // evidence, so it is shown as stored.
    expect(formatAuditValue("[not-a-range)", FMT)).toBe("[not-a-range)");
  });

  it("renders an object or an array compactly instead of [object Object]", () => {
    expect(formatAuditValue({ a: 1 }, FMT)).toBe('{"a":1}');
    expect(formatAuditValue([1, 2], FMT)).toBe("[1,2]");
  });
});

describe("an instant is shown through the app's date seam", () => {
  it("renders the org's chosen format and the local time of day", () => {
    const iso = "2026-09-04T19:11:44.921206+00:00";
    const out = formatInstant(iso, "iso");
    expect(out).toContain(formatCalendarDay(localDay(iso), "iso"));
    expect(out).toContain(localHm(iso));
  });

  it("follows the org's format token rather than hard-coding one", () => {
    const iso = "2026-09-04T19:11:44.921206+00:00";
    expect(formatInstant(iso, "mdy_slash")).toContain(
      formatCalendarDay(localDay(iso), "mdy_slash"),
    );
  });

  it("shows an unparseable timestamp as stored rather than as NaN", () => {
    expect(formatInstant("not a time", FMT)).toBe("not a time");
  });
});

describe("who did it, given that the log stores an account id and nothing else", () => {
  const roles = new Map<string, string>([
    ["00000000-0000-0000-0000-0000000000a1", "admin"],
    ["00000000-0000-0000-0000-0000000000b2", "supervisor"],
  ]);

  it("a write with no actor is the system, not an unknown person", () => {
    // `audit_current_actor()` returns NULL for a seed or a server-side write
    // (migration 0007's own comment). There ARE such rows in the real table.
    expect(describeActor(null, "00000000-0000-0000-0000-0000000000a1", roles)).toBe("System");
  });

  it("names the reader's own changes as theirs", () => {
    expect(
      describeActor(
        "00000000-0000-0000-0000-0000000000a1",
        "00000000-0000-0000-0000-0000000000a1",
        roles,
      ),
    ).toBe("You");
  });

  /**
   * ⚠️ THIS IS THE HONEST CEILING AND IT IS DELIBERATE. `audit_log.actor_id` is
   * `auth.uid()`; `user_profiles` carries NO name and no address, and the email
   * lives in `auth.users`, which PostgREST does not expose — the one function
   * that reaches it (`site_people`) is keyed by a NODE and returns a profile id,
   * not a user id, so it cannot answer this question at all. A role plus a
   * distinguishing tail is everything the client can truthfully say today.
   */
  it("says the role and a distinguishing tail for somebody else", () => {
    const out = describeActor(
      "00000000-0000-0000-0000-0000000000b2",
      "00000000-0000-0000-0000-0000000000a1",
      roles,
    );
    expect(out).toContain("Supervisor");
    expect(out).toContain("0000b2");
  });

  it("does not invent a role for an account it cannot find", () => {
    const out = describeActor("11111111-2222-3333-4444-555566667777", null, roles);
    expect(out).toContain("6667777".slice(-6));
    expect(out).not.toContain("Supervisor");
    expect(out).not.toContain("Administrator");
  });
});

describe("an insert reads as a thing that was added, named", () => {
  const entry = {
    action: "insert" as const,
    tableName: "products",
    rowId: "60000000-0000-0000-0000-000000000001",
    before: null,
    after: {
      id: "60000000-0000-0000-0000-000000000001",
      org_id: "10000000-0000-0000-0000-000000000001",
      name: "Widget X",
      sku: "WX-1",
      active: true,
      color_token: null,
      created_at: "2026-09-01T10:00:00+00:00",
      updated_at: "2026-09-01T10:00:00+00:00",
    } as Record<string, unknown>,
  };

  it("names the subject out of the snapshot", () => {
    expect(describeEntry(entry, FMT).subject).toBe("Widget X");
  });

  it("says what kind of thing and what happened to it", () => {
    const line = describeEntry(entry, FMT);
    expect(line.kind).toBe("Product");
    expect(line.headline).toBe("Product added");
  });

  it("lists the fields the new row arrived with, and only those with a value", () => {
    const fields = describeEntry(entry, FMT).changes.map((c) => c.field);
    expect(fields).toContain("sku");
    expect(fields).toContain("active");
    // A column that was null at insert is not a fact worth a line.
    expect(fields).not.toContain("color_token");
    for (const omitted of OMITTED_FIELDS) expect(fields).not.toContain(omitted);
  });

  it("has no before side, because there was nothing before", () => {
    const sku = describeEntry(entry, FMT).changes.find((c) => c.field === "sku");
    expect(sku?.before).toBe(null);
    expect(sku?.after).toBe("WX-1");
  });
});

describe("an update reads as the fields that actually moved", () => {
  const entry = {
    action: "update" as const,
    tableName: "operators",
    rowId: "b8ab8f86-03fc-443c-8123-ab8c9cd01a18",
    before: {
      id: "b8ab8f86-03fc-443c-8123-ab8c9cd01a18",
      org_id: "10000000-0000-0000-0000-000000000001",
      display_name: "Alex Green",
      active: true,
      employee_ref: "E-1",
      updated_at: "2026-09-01T10:00:00+00:00",
    } as Record<string, unknown>,
    after: {
      id: "b8ab8f86-03fc-443c-8123-ab8c9cd01a18",
      org_id: "10000000-0000-0000-0000-000000000001",
      display_name: "Alex Green",
      active: false,
      employee_ref: "E-1",
      updated_at: "2026-09-02T11:00:00+00:00",
    } as Record<string, unknown>,
  };

  it("lists ONLY the column that changed", () => {
    const line = describeEntry(entry, FMT);
    expect(line.changes.map((c) => c.field)).toEqual(["active"]);
  });

  /**
   * ⚠️⚠️ THE CASE THIS WHOLE OMISSION LIST EXISTS FOR. `set_updated_at`
   * (migration 0003) bumps `updated_at` on EVERY update unconditionally —
   * `write_audit_log` itself has to subtract it before it can tell a real change
   * from a no-op. Listing it here would put one identical, meaningless line on
   * every single update in the log.
   */
  it("never lists the bookkeeping timestamp that moves on every write", () => {
    expect(describeEntry(entry, FMT).changes.map((c) => c.field)).not.toContain("updated_at");
  });

  it("shows both sides of the move, in words", () => {
    const change = describeEntry(entry, FMT).changes[0];
    expect(change.label).toBe("Active");
    expect(change.before).toBe("yes");
    expect(change.after).toBe("no");
  });

  it("says the thing changed, and names it by its snapshot name", () => {
    const line = describeEntry(entry, FMT);
    expect(line.headline).toBe("Operator changed");
    expect(line.subject).toBe("Alex Green");
  });

  it("reports a column that only exists on one side", () => {
    // A migration that adds a column mid-life leaves rows whose `before` lacks
    // it. That IS a change and must not be silently dropped.
    const line = describeEntry(
      {
        action: "update",
        tableName: "products",
        rowId: "p1",
        before: { name: "A" },
        after: { name: "A", source: "import" },
      },
      FMT,
    );
    expect(line.changes.map((c) => c.field)).toEqual(["source"]);
    expect(line.changes[0].before).toBe(null);
    expect(line.changes[0].after).toBe("import");
  });
});

describe("a delete keeps the row it destroyed", () => {
  const entry = {
    action: "delete" as const,
    tableName: "skills",
    rowId: "70000000-0000-0000-0000-000000000009",
    before: {
      id: "70000000-0000-0000-0000-000000000009",
      org_id: "10000000-0000-0000-0000-000000000001",
      name: "Forklift",
      active: true,
    } as Record<string, unknown>,
    after: null,
  };

  it("still names what was deleted, because the row itself is gone", () => {
    const line = describeEntry(entry, FMT);
    expect(line.subject).toBe("Forklift");
    expect(line.headline).toBe("Training deleted");
  });

  it("lists what the row held, on the before side", () => {
    const name = describeEntry(entry, FMT).changes.find((c) => c.field === "name");
    expect(name?.before).toBe("Forklift");
    expect(name?.after).toBe(null);
  });
});

describe("a row with no name of its own is still identified", () => {
  it("falls back to a short row id rather than an empty label", () => {
    // Assignments carry no name column; `operator_display_name` is only filled
    // in on the delete path (0029), so a live one has nothing to be called.
    const line = describeEntry(
      {
        action: "insert",
        tableName: "assignments",
        rowId: "4183a128-9494-4dbd-97de-1b60eddfa528",
        before: null,
        after: {
          id: "4183a128-9494-4dbd-97de-1b60eddfa528",
          operator_display_name: null,
          product_name: null,
          timerange: '["2026-09-04 16:30:00+00","2026-09-04 19:30:00+00")',
        },
      },
      FMT,
    );
    expect(line.subject).toContain("4183a128");
    expect(line.kind).toBe("Assignment");
  });

  it("prefers a display name when the snapshot carries one", () => {
    const line = describeEntry(
      {
        action: "delete",
        tableName: "assignments",
        rowId: "4183a128-9494-4dbd-97de-1b60eddfa528",
        before: { operator_display_name: "Alex Green", product_name: "Widget X" },
        after: null,
      },
      FMT,
    );
    expect(line.subject).toBe("Alex Green");
  });
});

describe("a snapshot that is not an object does not take the screen down", () => {
  it("renders an entry whose before/after are missing entirely", () => {
    const line = describeEntry(
      { action: "update", tableName: "runs", rowId: "r1", before: null, after: null },
      FMT,
    );
    expect(line.changes).toEqual([]);
    expect(line.subject).toContain("r1");
  });
});
