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
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTOR_IDENTITY_COLUMNS,
  AUDIT_COLUMNS,
  AUDIT_PAGE_SIZE,
  PLACE_CLAUSE_BUDGET,
  PLACE_KEYS,
  PLACE_PATHS,
  SNAPSHOT_COLUMNS,
  actorIdentityMap,
  buildPlaceClause,
  entryPlaceIds,
  fetchAuditPage,
  parseActorIdentity,
  parseAuditEntry,
  placeFilterFits,
  type AuditEntry,
} from "@/lib/api/audit";

/* ---------------------------------------------------------------------------
   A RECORDING POSTGREST BUILDER.

   ⭐ THE FILTER IS NOW THE SERVER'S JOB, and the only way to prove a `.gte` was
   actually sent is to watch the call. Every builder method returns the same
   object and writes down what it was asked for; the object is thenable, so
   `await query` in `fetchAuditPage` resolves to whatever `sb.reply` holds.
   ------------------------------------------------------------------------ */
const sb = vi.hoisted(() => {
  const calls: unknown[][] = [];
  let reply: { data: unknown; error: unknown } = { data: [], error: null };
  const builder: Record<string, unknown> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return builder;
    };
  for (const method of ["select", "order", "limit", "lt", "gte", "in", "eq", "or"]) {
    builder[method] = record(method);
  }
  builder.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(reply).then(onFulfilled);
  return {
    calls,
    reset(rows: unknown[] = []) {
      calls.length = 0;
      reply = { data: rows, error: null };
    },
    client: { from: record("from") },
    /** Every argument list one builder method was called with. */
    argsOf(name: string): unknown[][] {
      return calls.filter((c) => c[0] === name).map((c) => c.slice(1));
    },
  };
});

vi.mock("@/lib/supabase", () => ({ supabase: sb.client }));

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

/* ===========================================================================
 * THE FILTER IS THE SERVER'S JOB NOW.
 *
 * ⭐⭐ WHY THIS MATTERS MORE THAN THE ROUND TRIPS IT SAVES. While the filter was
 * applied to rows already fetched, a page was fifty ROWS and the screen could
 * only ever say "all" by an argument about ORDERING — it had to read past the
 * period's edge and reason that nothing unread could still match. Pushed into
 * the query, a page is fifty MATCHES and `hasMore` is a measured fact about the
 * matching set: "are there older rows that match?". The screen's honesty then
 * rests on one boolean the server computed rather than on a proof the client
 * assembled, and a period with BOTH ends becomes expressible at all.
 *
 * ⚠️ SO THESE CASES WATCH THE CALL, not the result. A filter that is quietly
 * dropped on the floor returns exactly the same rows as no filter at all when
 * the log is small, which is the sort of failure that ships.
 * ======================================================================== */
const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-04T00:00:00.000Z";

describe("the read narrows on the server, so a page is fifty matches", () => {
  beforeEach(() => sb.reset());

  it("sends no narrowing at all when nothing is filtered", async () => {
    await fetchAuditPage();
    expect(sb.argsOf("gte")).toEqual([]);
    expect(sb.argsOf("in")).toEqual([]);
    expect(sb.argsOf("lt")).toEqual([]);
    // Newest first on `id`, unchanged: the cursor is the primary key because a
    // tie on `at` has no stable boundary. See the api file's header.
    expect(sb.argsOf("order")).toEqual([["id", { ascending: false }]]);
    expect(sb.argsOf("select")).toEqual([[AUDIT_COLUMNS]]);
  });

  it("⭐ asks the server for the period instead of reading rows to throw them away", async () => {
    await fetchAuditPage(null, { since: T0 });
    expect(sb.argsOf("gte")).toEqual([["at", T0]]);
  });

  it("⭐ carries BOTH ends of a bounded period — which is what makes one offerable", async () => {
    await fetchAuditPage(null, { since: T0, until: T1 });
    expect(sb.argsOf("gte")).toEqual([["at", T0]]);
    // Exclusive at the top so two adjacent periods can never both claim the
    // same instant — "yesterday" ends where "today" starts.
    expect(sb.argsOf("lt")).toEqual([["at", T1]]);
  });

  it("narrows on the action and the table with `in`", async () => {
    await fetchAuditPage(null, { actions: ["delete"], tables: ["runs", "assignments"] });
    expect(sb.argsOf("in")).toEqual([
      ["action", ["delete"]],
      ["table_name", ["runs", "assignments"]],
    ]);
  });

  it("keeps the keyset cursor working beside the filter", async () => {
    // ⚠️ THE TWO ARE INDEPENDENT AND MUST STAY SO. `id < cursor` excludes what
    // is already on screen; the filter decides what counts as a row at all.
    // Ordering is by `id`, so the filter cannot disturb the boundary.
    await fetchAuditPage(233, { since: T0, actions: ["delete"] });
    expect(sb.argsOf("lt")).toEqual([["id", 233]]);
    expect(sb.argsOf("gte")).toEqual([["at", T0]]);
  });

  it("⚠️ still bounds a filtered read, so it cannot quietly become an unpaged one", async () => {
    // PostgREST caps a response at `max_rows = 1000`. A filtered read is the
    // easy place to lose the limit — it "obviously" returns few rows — and a
    // server-truncated page is indistinguishable from the end of the log.
    await fetchAuditPage(null, { since: T0, until: T1, actions: ["insert"], tables: ["runs"] });
    expect(sb.argsOf("limit")).toEqual([[AUDIT_PAGE_SIZE + 1]]);
    expect(AUDIT_PAGE_SIZE + 1).toBeLessThan(1000);
  });

  it("treats an empty list as no restriction, never as a query that matches nothing", async () => {
    // `.in(col, [])` renders as `col=in.()`, which matches no row. A list
    // nobody chose must not empty the one screen whose job is to show history.
    await fetchAuditPage(null, { actions: [], tables: [], since: null, until: null });
    expect(sb.argsOf("in")).toEqual([]);
    expect(sb.argsOf("gte")).toEqual([]);
  });

  it("⭐ measures hasMore with the extra row under a filter, so it means `older MATCHES exist`", async () => {
    sb.reset(
      Array.from({ length: AUDIT_PAGE_SIZE + 1 }, (_, i) => rowFromColumns({ id: 1000 - i })),
    );
    const page = await fetchAuditPage(null, { actions: ["insert"] });
    expect(page.entries.length).toBe(AUDIT_PAGE_SIZE);
    // This is the boolean the whole footer now rests on: false proves every
    // matching row has been read, whatever period was asked for.
    expect(page.hasMore).toBe(true);
    expect(page.entries[page.entries.length - 1].id).toBe(1000 - (AUDIT_PAGE_SIZE - 1));
  });

  it("says the search is finished when the filtered page is not full", async () => {
    sb.reset([rowFromColumns({ id: 7 })]);
    const page = await fetchAuditPage(null, { since: T0, until: T1, actions: ["delete"] });
    expect(page.hasMore).toBe(false);
    expect(page.entries.length).toBe(1);
  });
});

/* ===========================================================================
 * WHICH PLANT A CHANGE HAPPENED IN — the hardest of the four filters.
 *
 * ⭐⭐ `audit_log` HAS NO PLACE COLUMN, so the place is a key inside the jsonb
 * snapshot and which key it is depends on the table. Two measurements on the
 * live database decide the whole design, and both of them push the same way:
 *
 *   · a `products` row (31 of 232) carries NO place key at all — 0034 moved a
 *     product's plants into `product_sites`, which the snapshot does not hold;
 *   · **64 of the 201 rows that DO carry a place name a node that no longer
 *     exists.** A rebuilt seed, a deleted line. An audit row outliving its
 *     place is the log doing its job.
 *
 * ⭐⭐⭐ SO THE CLAUSE IS A COMPLEMENT — it is sent the places that are NOT the
 * chosen plant, and hides a row only when every place it names is a place the
 * company still has and none of them is the chosen one. The obvious version,
 * sending the plant's own ids, reads better and quietly drops all 95 of those
 * rows out of every plant's view under a footer claiming the whole log had been
 * searched. That is the one failure this screen exists to avoid, so these cases
 * pin the shape rather than merely the fact that something was sent.
 * ======================================================================== */
const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";

/** An entry, built from the guard's own shape. */
function auditEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  const parsed = parseAuditEntry(rowFromColumns());
  expect(parsed).not.toBeNull();
  return { ...(parsed as AuditEntry), ...over };
}

describe("the place keys are written down once", () => {
  it("names the two keys a snapshot can carry a place in", () => {
    // A seventh audited table with a third key name is one edit HERE. The
    // clause, the guard and the panel's mark all read this list.
    expect([...PLACE_KEYS].sort()).toEqual(["node_id", "site_node_id"]);
  });

  it("tests both snapshots, because an insert has only `after` and a delete only `before`", () => {
    expect([...SNAPSHOT_COLUMNS].sort()).toEqual(["after", "before"]);
    expect(PLACE_PATHS).toEqual([
      "after->>node_id",
      "after->>site_node_id",
      "before->>node_id",
      "before->>site_node_id",
    ]);
  });

  it("⚠️ builds the paths from the two lists, so neither can be extended alone", () => {
    expect(PLACE_PATHS.length).toBe(SNAPSHOT_COLUMNS.length * PLACE_KEYS.length);
  });
});

describe("the screen and the server read a row's place the same way", () => {
  it("finds a place in `after` (an insert) and in `before` (a delete)", () => {
    expect(entryPlaceIds(auditEntry({ after: { node_id: A }, before: null }))).toEqual([A]);
    expect(entryPlaceIds(auditEntry({ after: null, before: { site_node_id: B } }))).toEqual([B]);
  });

  it("⭐ reports BOTH sides of a move, because the row belongs to both plants", () => {
    const moved = auditEntry({ before: { site_node_id: A }, after: { site_node_id: B } });
    expect(entryPlaceIds(moved).sort()).toEqual([A, B].sort());
  });

  it("⭐⭐ finds nothing on a products row, which is the point", () => {
    const product = auditEntry({
      tableName: "products",
      before: null,
      after: { name: "Widget X", sku: "WX-1", active: true },
    });
    expect(entryPlaceIds(product)).toEqual([]);
  });

  it("does not count a value that is not a usable id", () => {
    expect(entryPlaceIds(auditEntry({ after: { node_id: null }, before: null }))).toEqual([]);
    expect(entryPlaceIds(auditEntry({ after: { node_id: "" }, before: null }))).toEqual([]);
    expect(entryPlaceIds(auditEntry({ after: { node_id: 7 }, before: null }))).toEqual([]);
  });
});

describe("the plant clause hides only what it can prove is somewhere else", () => {
  it("narrows nothing when there is nothing to narrow", () => {
    expect(buildPlaceClause(null)).toBeNull();
    expect(buildPlaceClause([])).toBeNull();
  });

  it("⭐⭐ tests every path against the ELSEWHERE list, not against the plant's own ids", () => {
    const clause = buildPlaceClause([A, B]) as string;
    for (const path of PLACE_PATHS) expect(clause).toContain(`${path}.not.in.(${A},${B})`);
    // And nothing anywhere says `in.(` without the `not` — a positive test on
    // the plant's own ids is the version that deletes 95 rows of history.
    expect(/(?<!not\.)in\.\(/.test(clause)).toBe(false);
  });

  it("⭐⭐⭐ keeps a row that names no place at all, which SQL would otherwise drop", () => {
    // `NULL NOT IN (…)` is NULL, not TRUE. Without this branch every products
    // row falls out of every plant's view at once.
    const clause = buildPlaceClause([A]) as string;
    const nowhere = `and(${PLACE_PATHS.map((p) => `${p}.is.null`).join(",")})`;
    expect(clause).toContain(nowhere);
  });

  it("⚠️ sends ids unquoted, because the clause is pressing on a request-size ceiling", () => {
    expect(buildPlaceClause([A])).not.toContain('"');
  });
});

describe("the plant clause is refused rather than silently dropped", () => {
  beforeEach(() => sb.reset());

  it("sends the clause as one `or` beside the other filters", async () => {
    await fetchAuditPage(233, { since: T0, elsewhere: [A, B] });
    expect(sb.argsOf("or")).toEqual([[buildPlaceClause([A, B])]]);
    // The cursor and the period are untouched by it: one is a boundary on
    // `id`, the others are predicates on rows.
    expect(sb.argsOf("lt")).toEqual([["id", 233]]);
    expect(sb.argsOf("gte")).toEqual([["at", T0]]);
  });

  it("sends nothing for `All plants`", async () => {
    await fetchAuditPage(null, { elsewhere: null });
    expect(sb.argsOf("or")).toEqual([]);
    await fetchAuditPage(null, { elsewhere: [] });
    expect(sb.argsOf("or")).toEqual([]);
  });

  it("⛔ refuses a value that is not a node id rather than rewriting the logic tree", async () => {
    // Unlike `.in()`, this clause is a string this code builds. A value
    // carrying a comma or a paren cannot reach anyone else's rows — RLS decided
    // that long before — but it would silently ask a different question.
    await expect(fetchAuditPage(null, { elsewhere: [`${A}),foo.eq.bar,(`] })).rejects.toBeTruthy();
    expect(sb.argsOf("or")).toEqual([]);
  });

  /**
   * ⛔⛔ THE MEASURED CEILING. Kong caps a request line at 8 KB and this clause
   * repeats the list once per path: against the running stack a 48-id list is
   * served and a 52-id list comes back 414. The failure that matters is not the
   * 414 — it is a version of this function that noticed and sent the read
   * UNNARROWED, handing the screen a page of the whole company under a header
   * naming one plant.
   */
  it("⛔⛔ refuses an over-long list instead of quietly reading every plant", async () => {
    const many = Array.from(
      { length: 400 },
      (_, i) => `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, "0")}`,
    );
    expect(placeFilterFits(many)).toBe(false);
    await expect(fetchAuditPage(null, { elsewhere: many })).rejects.toBeTruthy();
    expect(sb.argsOf("or")).toEqual([]);
  });

  it("the budget leaves room for the rest of the request", () => {
    // Measured with a whole real page request beside it: a 7328-character
    // clause is served and a 7624-character one is refused. The budget sits
    // below the first of those, not merely below Kong's 8 KB line.
    expect(PLACE_CLAUSE_BUDGET).toBeLessThan(7328);
    // And it has to be big enough for the database in front of us: each of the
    // live org's four plants leaves 36 places outside it.
    const live = Array.from(
      { length: 36 },
      (_, i) => `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, "0")}`,
    );
    expect(placeFilterFits(live)).toBe(true);
  });
});

describe("a bound that is not a bound is not sent", () => {
  beforeEach(() => sb.reset());

  it("⚠️ drops a blank timestamp rather than posting `at=gte.`", async () => {
    // Postgres answers an empty timestamp with `22007 invalid input syntax`,
    // which is a 400 on the whole page: the screen would show a read failure
    // rather than a narrower list. An unset bound must reach the query as
    // nothing at all.
    await fetchAuditPage(null, { since: "", until: "   " });
    expect(sb.argsOf("gte")).toEqual([]);
    expect(sb.argsOf("lt")).toEqual([]);
  });
});
