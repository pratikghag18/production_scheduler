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
import {
  ACTOR_IDENTITY_COLUMNS,
  AUDIT_COLUMNS,
  AUDIT_PAGE_SIZE,
  actorIdentityMap,
  parseActorIdentity,
  parseAuditEntry,
} from "@/lib/api/audit";

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

/* ===========================================================================
 * The SECOND read: who the actors are (0046, R-329).
 *
 * Same idiom as everything above — a column list and a guard, held against each
 * other — with one extra reason to bother, and it is a big one:
 *
 * ⛔⛔ `database.types.ts` DECLARES `email: string`, AND THAT IS A LIE. The
 * function is `returns table (user_id uuid, role text, email text)`, and
 * `supabase gen types` has no way to know a RETURNS TABLE column can come back
 * NULL, so it types every one of them non-nullable. `auth.users.email` HAS no
 * NOT NULL constraint (a phone-only signup carries none) and migration 0046
 * deliberately lists such a person rather than dropping them. So `tsc` will
 * cheerfully accept `identity.email.toLowerCase()` on a value that is null at
 * runtime. The guard below is the only thing standing between that and a
 * TypeError on the Activity screen, and these cases are the only thing standing
 * behind the guard — `tsc` cannot see either.
 * ======================================================================== */

/** A row built FROM THE COLUMN LIST, never typed out by hand. */
function identityFromColumns(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sample: Record<string, unknown> = {
    user_id: "00000000-0000-0000-0000-0000000000a2",
    role: "supervisor",
    email: "ana@example.test",
    display_name: "Ana Ruiz",
  };
  const row: Record<string, unknown> = {};
  for (const col of ACTOR_IDENTITY_COLUMNS.split(",").map((c) => c.trim())) row[col] = sample[col];
  return { ...row, ...overrides };
}

describe("the identity read asks for exactly what its guard requires", () => {
  it("every column the guard needs is one the function actually returns", () => {
    expect(parseActorIdentity(identityFromColumns())).toEqual({
      role: "supervisor",
      email: "ana@example.test",
      displayName: "Ana Ruiz",
    });
  });

  it("names the four columns `audit_actor_identities()` returns and no more", () => {
    // Held against migration 0047's `returns table (...)`. This list said THREE
    // until the name landed, and the comment then read "adding a `display_name`
    // there means adding it here" — which is exactly what happened, in the same
    // commit, and this line is what would have gone red had it not.
    // `69_actor_identities_test.sql` E12 is the server-side half of the pair:
    // it reads the function's declared result columns out of `pg_proc`.
    expect(
      ACTOR_IDENTITY_COLUMNS.split(",")
        .map((c) => c.trim())
        .sort(),
    ).toEqual(["display_name", "email", "role", "user_id"].sort());
  });
});

describe("the identity guard survives the address being absent", () => {
  it("⭐ keeps a NULL email, because the generated type says it cannot happen", () => {
    // `auth.users.email` is nullable and 0046 lists the person anyway. The row
    // must SURVIVE with `email: null` — a dropped row is indistinguishable from
    // an actor who was never in this company.
    const parsed = parseActorIdentity(identityFromColumns({ email: null }));
    expect(parsed).not.toBe(null);
    expect(parsed?.email).toBe(null);
    expect(parsed?.role).toBe("supervisor");
  });

  /**
   * The name is the SECOND nullable identity column and it is nullable for a
   * blunter reason than the address: NOTHING WRITES IT YET (migration 0047 adds
   * the column and no editor), so `display_name` is NULL on every row in every
   * database this ships against today. A guard that required a string here
   * would empty the whole map on the live product, and the Who column would go
   * back to what the maintainer complained about.
   *
   * `database.types.ts` says `display_name: string` on the RPC's return, the
   * same lie it tells about `email`, and for the same reason: F-085, the
   * generator cannot see nullability through a `RETURNS TABLE`.
   */
  it("keeps a NULL display_name, which is what every live row carries", () => {
    const parsed = parseActorIdentity(identityFromColumns({ display_name: null }));
    expect(parsed).not.toBe(null);
    expect(parsed?.displayName).toBe(null);
    // and the row is otherwise intact — the address is still the fallback.
    expect(parsed?.email).toBe("ana@example.test");
    expect(parsed?.role).toBe("supervisor");
  });

  it("normalises a blank or non-string display_name to null", () => {
    // ⚠️ A BLANK IS NOT A NAME, and it is the one value that would be WORSE
    // than null: `describeActor` reads "present" as "this is who it was", so a
    // "" would win the precedence and render an empty Who cell — a present
    // answer meaning nothing. There is no CHECK constraint on the column
    // (migration 0047 says why), so the normalising has to happen here.
    expect(parseActorIdentity(identityFromColumns({ display_name: "" }))?.displayName).toBe(null);
    expect(parseActorIdentity(identityFromColumns({ display_name: "   " }))?.displayName).toBe(
      null,
    );
    expect(parseActorIdentity(identityFromColumns({ display_name: undefined }))?.displayName).toBe(
      null,
    );
    expect(parseActorIdentity(identityFromColumns({ display_name: 7 }))?.displayName).toBe(null);
  });

  it("normalises a missing or non-string email to null rather than passing it on", () => {
    // undefined, a number, an object: none of them are an address, and every
    // one of them would satisfy `email: string` at the type level.
    expect(parseActorIdentity(identityFromColumns({ email: undefined }))?.email).toBe(null);
    expect(parseActorIdentity(identityFromColumns({ email: 7 }))?.email).toBe(null);
    expect(parseActorIdentity(identityFromColumns({ email: { a: 1 } }))?.email).toBe(null);
  });

  it("refuses a row with no usable role", () => {
    // `user_profiles.role` is NOT NULL and the screen's fallback label is built
    // from it, so a row without one has nothing left to say.
    expect(parseActorIdentity(identityFromColumns({ role: null }))).toBe(null);
    expect(parseActorIdentity(identityFromColumns({ role: 4 }))).toBe(null);
  });

  it("refuses a non-object", () => {
    expect(parseActorIdentity(null)).toBe(null);
    expect(parseActorIdentity("ana@example.test")).toBe(null);
    expect(parseActorIdentity([])).toBe(null);
  });
});

describe("the identity map is keyed by the id the audit log actually carries", () => {
  it("keys on user_id — `auth.uid()`, which is what `actorId` is", () => {
    const map = actorIdentityMap([identityFromColumns()]);
    // ⚠️ NOT `user_profiles.id`. `audit_log.actor_id` is `auth.uid()`, and the
    // profile id is a different uuid entirely; keying on it would produce a map
    // that never matches and a screen that looks exactly like the old one.
    expect([...map.keys()]).toEqual(["00000000-0000-0000-0000-0000000000a2"]);
  });

  it("⭐ holds an identity OBJECT, not a bare string", () => {
    // The forward-compatibility promise 0046 is designed around: a
    // `display_name` arriving later is one more field here and no change to any
    // caller that already reads `.email`. A `Map<string, string>` would have to
    // be rewritten everywhere the day it lands.
    const value = actorIdentityMap([identityFromColumns()]).get(
      "00000000-0000-0000-0000-0000000000a2",
    );
    expect(typeof value).toBe("object");
    // ⭐ AND THE PROMISE WAS KEPT. 0047 added the name; `fetchActorIdentities`
    // kept its signature, the Map kept its shape, and no caller reading
    // `.email` was touched. This assertion is the receipt.
    expect(value).toEqual({
      role: "supervisor",
      email: "ana@example.test",
      displayName: "Ana Ruiz",
    });
  });

  it("skips a row it cannot read instead of throwing the whole map away", () => {
    // Same call as `fetchAuditPage`'s: this read DECORATES a column. One bad
    // row must cost one name, not the list.
    const map = actorIdentityMap([
      identityFromColumns(),
      null,
      identityFromColumns({ user_id: 42 }),
      identityFromColumns({ user_id: "00000000-0000-0000-0000-0000000000a1", email: null }),
    ]);
    expect(map.size).toBe(2);
    expect(map.get("00000000-0000-0000-0000-0000000000a1")).toEqual({
      role: "supervisor",
      email: null,
      displayName: "Ana Ruiz",
    });
  });

  it("tolerates a null payload, because a refused call is cosmetic here", () => {
    expect(actorIdentityMap(null).size).toBe(0);
    expect(actorIdentityMap(undefined).size).toBe(0);
    expect(actorIdentityMap("not a list").size).toBe(0);
  });
});
