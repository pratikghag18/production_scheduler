/**
 * READING THE AUDIT LOG — turning a jsonb row snapshot into a sentence.
 *
 * ⭐⭐ THE QUERY WAS NEVER THE PROBLEM. `audit_log` has been filling since
 * migration 0007 (runs, assignments) and 0029 §6 (products, operators, skills,
 * shift patterns), with the WHOLE row as jsonb in `before`/`after`. Nothing in
 * `src/` had ever read a row of it, and the reason a screen was never built is
 * visible the moment you look at one: a person cannot read
 * `{"operator_id":"b8ab…","efficiency":1.000,"timerange":"[\"2026-09-04 16:30…"}`.
 * Printing that on a page is not showing somebody their history.
 *
 * So the work is here, and it is pure: given one audit row, WHICH thing changed,
 * what is it called, and which fields moved from what to what.
 * `AuditPanel.tsx` is left holding layout and nothing else.
 *
 * ⚠️⚠️ THE SUBJECT'S NAME COMES OUT OF THE SNAPSHOT, NEVER OUT OF A JOIN, and
 * that is a correctness rule rather than a shortcut. For a DELETE the row is
 * gone — a join renders a blank exactly where the most important word on the
 * line belongs, and a deletion is the entry a reader most wants named. The
 * snapshot carries the name AS IT WAS AT THE TIME, which is also the only right
 * answer after a rename: a log saying "Widget Z was renamed" when the row is now
 * called something else is a log that rewrites its own past.
 *
 * ⚠️ NO RUNTIME DEPENDENCY BEYOND THE DATE SEAM. This module imports
 * `src/lib/format/dates.ts` (itself pure) so that a date in the log reads the
 * way every other date in the app reads — the maintainer, 3 Sept: *"can we make
 * sure we add something so any new date displayed on the app in future
 * automatically adopts this?"* The org's token is passed IN; nothing here
 * fetches anything.
 *
 * AUDIT-LOG-SPECIFIC AND DELIBERATELY DUMB ABOUT THE DOMAIN. It knows six table
 * names and a handful of column labels, and falls back to a readable default for
 * anything it has not been taught, because the set of audited tables is decided
 * by triggers on the database and can grow without this file being told.
 */
import { formatCalendarDay, type DateFormat } from "@/lib/format/dates";

export type AuditAction = "insert" | "update" | "delete";

/** One field that moved. `null` on a side means "not present there". */
export interface AuditFieldChange {
  /** The raw column name — the stable identity, used for keys and omissions. */
  field: string;
  /** What the reader sees. */
  label: string;
  before: string | null;
  after: string | null;
}

export interface AuditLine {
  /** "Product", "Training", "Assignment" — the KIND of thing. */
  kind: string;
  /** What it is called: "Widget X", or a short row id when it has no name. */
  subject: string;
  /** "Product added" / "Operator changed" / "Training deleted". */
  headline: string;
  /**
   * Whether this entry destroyed the row.
   *
   * ⚠️ FOR THE PANEL'S ACCENT AND ITS "Removed" WORD, so that one rule decides
   * what counts as a deletion and the two do not drift. It is a FACT, not a
   * style: nothing here knows about colours, and the per-field strikethrough
   * stays where it is, in the panel's own CSS.
   */
  removed: boolean;
  changes: AuditFieldChange[];
}

/** The minimum an entry must carry to be described. Structurally typed so the
 *  api layer's `AuditEntry` satisfies it without this module importing it. */
export interface DescribableEntry {
  action: AuditAction;
  tableName: string;
  rowId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/* ---------------------------------------------------------------------------
   WHAT KIND OF THING
   ------------------------------------------------------------------------ */

/**
 * The six tables carrying `write_audit_log`, in the product's own words.
 *
 * ⚠️⚠️ `skills` IS THE TRAININGS TABLE. The product renamed the concept — there
 * is a Trainings tab, a `TrainingsPanel`, a `useTrainingImport` — and the table
 * never followed. Rendering "Skill" here would name a thing this app does not
 * have, and would make the audit log the one screen still speaking the old
 * vocabulary.
 *
 * ⚠️ NOT AN ALLOWLIST. `describeTable` falls back for anything absent, because
 * the set of audited tables is decided by triggers on the database (0029 §6
 * added four of these in one go) and a seventh must render as *something*
 * readable rather than as a blank or a throw.
 */
const TABLE_NOUN: Readonly<Record<string, string>> = {
  assignments: "Assignment",
  operators: "Operator",
  products: "Product",
  runs: "Run",
  shift_templates: "Shift pattern",
  skills: "Training",
};

/** `some_table_name` -> `Some table name`. */
function prettify(snake: string): string {
  const words = snake.replace(/_/g, " ").trim();
  if (words.length === 0) return snake;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function describeTable(tableName: string): string {
  return TABLE_NOUN[tableName] ?? prettify(tableName);
}

/* ---------------------------------------------------------------------------
   WHAT THE COLUMNS ARE CALLED
   ------------------------------------------------------------------------ */

/**
 * The columns whose prettified form would be wrong, bare or misleading.
 *
 * Everything else goes through `prettify`, which is right far more often than a
 * hand-written map would stay right: these are whole table rows, the tables grow
 * columns, and a map that has to be complete is a map that silently isn't.
 */
const FIELD_LABEL: Readonly<Record<string, string>> = {
  sku: "SKU",
  // A tstzrange on assignments and runs. "Timerange" is the column; "When" is
  // what a reader is actually looking at.
  timerange: "When",
  // These are node ids. "Node id" is database vocabulary; the app calls a node
  // a place everywhere a person can see it.
  node_id: "Place",
  home_node_id: "Home place",
  site_node_id: "Site",
  external_id: "External id",
  org_id: "Company",
  // ⚠️ THE `id` IS DROPPED FROM EVERY IDENTITY COLUMN'S LABEL because the column
  // no longer SHOWS an id when it can help it — see `IDENTITY_COLUMN` below.
  // "Operator id: Maria" reads like a mismatch; "Operator: Maria" is the fact.
  operator_id: "Operator",
  product_id: "Product",
  run_id: "Run",
  actor_id: "Actor",
};

export function fieldLabel(column: string): string {
  return FIELD_LABEL[column] ?? prettify(column);
}

/* ---------------------------------------------------------------------------
   WHAT IS LEFT OUT, AND WHY IT IS SAID OUT LOUD
   ------------------------------------------------------------------------ */

/**
 * ⚠️⚠️ THE ONLY FOUR COLUMNS THIS SCREEN DOES NOT LIST, and the panel names them
 * on screen. An audit log that quietly drops fields is worse than one that dumps
 * JSON: the dump is at least honest about being complete.
 *
 * `updated_at` is the load-bearing one. `set_updated_at` (migration 0003) bumps
 * it on EVERY update unconditionally — `write_audit_log` itself has to subtract
 * it (`to_jsonb(OLD) - 'updated_at'`) before it can tell a real change from a
 * no-op, and its own comment records why. Listing it would put one identical,
 * meaningless line on every single update in the log.
 *
 * `id` is `row_id`, shown once already; `org_id` is a constant for everything
 * this reader can see; `created_at` never moves after the insert that set it.
 */
export const OMITTED_FIELDS: readonly string[] = ["id", "org_id", "created_at", "updated_at"];
const OMITTED = new Set(OMITTED_FIELDS);

/* ---------------------------------------------------------------------------
   WHAT A VALUE LOOKS LIKE
   ------------------------------------------------------------------------ */

/**
 * A Postgres range literal: `["2026-09-04 16:30:00+00","2026-09-04 19:30:00+00")`.
 *
 * Either bound may be inclusive or exclusive; tstzrange canonicalises to `[…)`
 * but nothing here depends on that.
 */
const RANGE_LITERAL = /^[[(]\s*"([^"]*)"\s*,\s*"([^"]*)"\s*[)\]]$/;

/**
 * ⚠️ A POSTGRES TIMESTAMP IS NOT AN ISO STRING, and treating it as one is how
 * this screen would have rendered "NaN" down its busiest column. jsonb gives
 * back `2026-09-04 16:30:00+00`: a SPACE instead of `T`, and a two-digit offset
 * instead of `+00:00`. `new Date()` accepts that only by implementation grace.
 * Normalised here, and every caller checks for `null`.
 *
 * `at` on the audit row itself comes back properly ISO
 * (`2026-09-04T19:11:44.921206+00:00`), which this also accepts unchanged — one
 * parser for both rather than two that can disagree.
 */
function parseTimestamp(raw: string): Date | null {
  const iso = raw
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The LOCAL calendar day of an instant, as `YYYY-MM-DD`.
 *  ⚠️ NOT `toISOString().slice(0,10)`, which is the UTC day and is a day out
 *  west of Greenwich — the same trap `SettingsPanel`'s `todayIso` documents. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function localHm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * An instant, through the app's date seam plus a local clock time.
 *
 * Returns the raw string untouched when it cannot be parsed — evidence a reader
 * can still act on beats a tidy "Invalid Date", and this is a log.
 */
export function formatInstant(iso: string, fmt: DateFormat): string {
  const d = parseTimestamp(iso);
  if (d === null) return iso;
  return `${formatCalendarDay(localDay(d), fmt)}, ${localHm(d)}`;
}

/** `[a, b)` -> "day, hh:mm → hh:mm", collapsing the day when both ends share it. */
function formatRange(fromRaw: string, toRaw: string, fmt: DateFormat): string | null {
  const from = parseTimestamp(fromRaw);
  const to = parseTimestamp(toRaw);
  if (from === null || to === null) return null;
  const fromDay = localDay(from);
  if (fromDay === localDay(to)) {
    return `${formatCalendarDay(fromDay, fmt)}, ${localHm(from)} → ${localHm(to)}`;
  }
  return `${formatInstant(fromRaw, fmt)} → ${formatInstant(toRaw, fmt)}`;
}

/**
 * One jsonb value, rendered for a person.
 *
 * ⚠️ AN EMPTY STRING AND A NULL ARE DIFFERENT FACTS and are shown differently.
 * A note somebody CLEARED and a column that was never set are not the same
 * event, and collapsing them is the sort of small lie a log cannot afford.
 *
 * ⚠️ An unrecognised shape falls through to `JSON.stringify`, never to
 * `String(v)` — `[object Object]` is the classic way a value silently stops
 * being evidence.
 */
export function formatAuditValue(value: unknown, fmt: DateFormat): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value === "") return "(blank)";
    const range = RANGE_LITERAL.exec(value);
    if (range !== null) {
      const shown = formatRange(range[1], range[2], fmt);
      // A range whose bounds this code cannot read is still shown as stored;
      // swallowing it would delete evidence to keep the column tidy.
      if (shown !== null) return shown;
    }
    return value;
  }
  return JSON.stringify(value);
}

/* ---------------------------------------------------------------------------
   WHO DID IT
   ------------------------------------------------------------------------ */

const ROLE_WORD: Readonly<Record<string, string>> = {
  admin: "Administrator",
  supervisor: "Supervisor",
  viewer: "Viewer",
};

/** The last six characters of an id — enough to tell two accounts apart on a
 *  page without pretending to have named either of them. */
function tail(id: string): string {
  return id.slice(-6);
}

/**
 * ⚠️⚠️ THIS IS THE HONEST CEILING, AND IT IS A SERVER LIMITATION, NOT A CHOICE.
 *
 * `audit_log.actor_id` is `auth.uid()` — a row in `auth.users`, which PostgREST
 * does not expose. `user_profiles` (which an admin CAN read across their org)
 * carries no name and no address at all: `id, org_id, user_id, role,
 * default_create_mode, created_at, updated_at`. The single function that
 * reaches an email, `site_people`, is keyed by a NODE and returns a PROFILE id,
 * not a user id, so it cannot answer "who is `auth.uid()` X" even indirectly.
 *
 * **Turning an actor into a person's name needs a new SECURITY DEFINER function
 * on the database** — a migration, and a decision about exposing addresses that
 * is not this screen's to make. Until then: the reader's own changes are named
 * as theirs, and everybody else gets the role the client CAN read plus a tail
 * that distinguishes two people holding it.
 *
 * ⚠️ A NULL ACTOR IS "System", NOT "unknown". `audit_current_actor()` degrades
 * to NULL for a seed or a server-side write and says so in its own comment
 * (0007); the live table has such rows. Calling that an unknown person would
 * invent a suspect.
 */
export function describeActor(
  actorId: string | null,
  viewerUserId: string | null,
  roles: ReadonlyMap<string, string>,
  emails?: ReadonlyMap<string, string>,
): string {
  if (actorId === null) return "System";
  if (viewerUserId !== null && actorId === viewerUserId) return "You";
  // ⭐ THE ADDRESS WINS WHERE THERE IS ONE, and migration 0046 is what put it
  // within reach — `audit_actor_identities()`, company-admin-only and
  // org-scoped. The maintainer's objection to the old answer was exactly right:
  // "Supervisor · 0000a2" tells you a role and a fragment of a uuid, neither of
  // which is a person you can go and ask about a change.
  //
  // ⚠️ AN OPTIONAL FOURTH ARGUMENT RATHER THAN A CHANGED THIRD. This module is
  // pure and is called from a component and from `describeEntry`; widening the
  // existing map to an object would have rewritten every call site and every
  // fixture for a value that is allowed to be absent anyway. Absent means "not
  // looked up" here, exactly as it does for the name maps.
  const email = emails?.get(actorId);
  if (email !== undefined && email !== "") return email;
  const role = roles.get(actorId);
  if (role === undefined) return `Unknown account · ${tail(actorId)}`;
  return `${ROLE_WORD[role] ?? prettify(role)} · ${tail(actorId)}`;
}

/* ---------------------------------------------------------------------------
   WHICH COLUMNS POINT AT SOMETHING, AND WHAT IT IS CALLED
   ------------------------------------------------------------------------ */

/**
 * ⭐⭐ THE CHANGE COLUMN SHOWS NAMES. The maintainer, 4 Sept: *"We should show
 * the names in the change column, IDs are not fun when trying to troubleshoot
 * something."* A real assignment row out of the running database is
 *
 *   { node_id: "30000000-…0007", operator_id: "50000000-…0004",
 *     product_id: null, product_name: null, operator_display_name: null, … }
 *
 * so the line a reader troubleshooting actually sees is
 * `Operator: 50000000-0000-0000-0000-000000000004`, which answers nothing.
 *
 * ⚠️⚠️ AND THE DENORMALISED COLUMNS DO NOT SAVE US. `product_name`,
 * `product_sku` and `operator_display_name` exist on `runs` and `assignments`
 * but are **NULL on every live row** — 0029 fills them in on the DELETE path
 * only. "The snapshot already carries the name" is therefore true exactly when
 * the row is gone, which is the one case a lookup could not have answered
 * anyway. Both halves are needed and neither is redundant.
 */
type IdentityKind = "node" | "operator" | "product" | "run" | "user";

/**
 * The columns that hold a reference to another row, and to what.
 *
 * `home_node_id` and `site_node_id` are on every operator snapshot and are node
 * ids like `node_id` is; `created_by` is on runs and assignments and is an
 * `auth.uid()`, the same kind of thing `audit_log.actor_id` is.
 *
 * ⚠️ NOT A GUESS FROM THE SUFFIX. `external_id` ends in `_id` and is a customer's
 * own string; `org_id` is omitted entirely. A column earns a lookup by being
 * named here, so a new `*_id` column renders as itself rather than as an
 * "unknown" something this file invented a kind for.
 */
const IDENTITY_COLUMN: Readonly<Record<string, IdentityKind>> = {
  node_id: "node",
  home_node_id: "node",
  site_node_id: "node",
  operator_id: "operator",
  product_id: "product",
  run_id: "run",
  created_by: "user",
  actor_id: "user",
};

/**
 * The name the SNAPSHOT already carries for a reference, best first.
 *
 * ⭐ THE SAME RULE `NAME_FIELDS` FOLLOWS FOR THE ROW'S OWN SUBJECT, one step
 * out: the snapshot's name beats a live lookup, because for a DELETE the row it
 * points at may be gone and after a RENAME the current name is not what
 * happened. These are the very columns 0029 fills in on the delete path, and
 * they are read from the SIDE the id came from.
 */
const SNAPSHOT_NAME_FOR: Readonly<Record<string, readonly string[]>> = {
  operator_id: ["operator_display_name"],
  product_id: ["product_name", "product_sku"],
};

/** The app's own word for each kind, for the sentence said when it cannot be
 *  named. `node` is "place" because that is what the app calls a node. */
const IDENTITY_NOUN: Readonly<Record<IdentityKind, string>> = {
  node: "place",
  operator: "operator",
  product: "product",
  run: "run",
  user: "account",
};

/**
 * Id -> name, per kind. **Every field is optional and this whole argument is
 * optional**, because this module fetches nothing: the caller reads the
 * catalogues it already holds and passes them in.
 *
 * `actorRoles` is the role half of `fetchActorIdentities()` (0046) and `AuditPanel`
 * already holds, so a user column in a snapshot is described by `describeActor`
 * itself rather than by a second, drifting vocabulary for the same fact.
 *
 * `runs` is a caption, not a name — see `resolveIdentity`.
 */
export interface AuditNames {
  nodes?: ReadonlyMap<string, string>;
  operators?: ReadonlyMap<string, string>;
  products?: ReadonlyMap<string, string>;
  runs?: ReadonlyMap<string, string>;
  /** `auth.uid()` -> org-wide role, from `fetchActorIdentities()` (0046). */
  actorRoles?: ReadonlyMap<string, string>;
  /** uid -> email, from `audit_actor_identities()` (0046). Absent = not looked up.
   *  Threaded through so a `created_by` in a snapshot names the same person the
   *  Who column does — two vocabularies for one account is how a log starts
   *  contradicting itself. */
  actorEmails?: ReadonlyMap<string, string>;
  /** The reader's own `auth.uid()`, so their own hand reads "You". */
  viewerUserId?: string | null;
}

function lookupFor(names: AuditNames, kind: IdentityKind): ReadonlyMap<string, string> | undefined {
  switch (kind) {
    case "node":
      return names.nodes;
    case "operator":
      return names.operators;
    case "product":
      return names.products;
    case "run":
      return names.runs;
    case "user":
      return undefined;
  }
}

/**
 * One identity column's value, as a name. `null` means "not an identity column,
 * or nothing here to name" — the caller then formats it as any other value.
 *
 * ⚠️⚠️ AN UNRESOLVED ID MUST NOT LOOK RESOLVED. A blank, or a bare name-shaped
 * placeholder, would tell a reader troubleshooting that the row points at
 * nothing. `describeActor` set the pattern: a word saying so, then the tail of
 * the id, which is enough to tell two rows apart and to search for.
 *
 * ⚠️⚠️ A RUN HAS NO NAME AT ALL. `runs` is `id, org_id, node_id, product_id,
 * timerange, planned_headcount, notes, created_by, product_*` — there is no
 * `name` column and there never was; a run is identified by its product, its
 * place and its hours. So an unmapped run is NOT an "unknown": reporting a
 * failed lookup where there is nothing to look up is its own small lie. It
 * renders as its kind plus its tail, and a caller that has composed a caption
 * ("Widget X on Line 1") passes one in `runs` and that caption wins.
 */
function resolveIdentity(
  column: string,
  value: unknown,
  row: Record<string, unknown> | null,
  names: AuditNames,
): string | null {
  const kind = IDENTITY_COLUMN[column];
  if (kind === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") return null;

  // The snapshot's own word first — see `SNAPSHOT_NAME_FOR`.
  for (const key of SNAPSHOT_NAME_FOR[column] ?? []) {
    const carried = row === null ? undefined : row[key];
    if (typeof carried === "string" && carried.trim() !== "") return carried;
  }

  // A user is described by the one function that knows what the client can
  // truthfully say about an account, so the two columns cannot drift apart.
  if (kind === "user") {
    return describeActor(
      value,
      names.viewerUserId ?? null,
      names.actorRoles ?? new Map(),
      names.actorEmails,
    );
  }

  const named = lookupFor(names, kind)?.get(value);
  if (named !== undefined && named.trim() !== "") return named;

  if (kind === "run") return `${describeTable("runs")} · ${tail(value)}`;
  return `Unknown ${IDENTITY_NOUN[kind]} · ${tail(value)}`;
}

/* ---------------------------------------------------------------------------
   THE LINE ITSELF
   ------------------------------------------------------------------------ */

/**
 * The columns a row might be CALLED by, best first.
 *
 * `display_name` before `name` because an assignment/run snapshot carries
 * `operator_display_name` and `product_name` at once and the person is the
 * subject; `sku` last because a product with a name should not be listed by its
 * code.
 */
const NAME_FIELDS: readonly string[] = [
  "display_name",
  "operator_display_name",
  "name",
  "product_name",
  "sku",
  "product_sku",
];

function snapshot(entry: DescribableEntry): Record<string, unknown> | null {
  return entry.after ?? entry.before;
}

function subjectFor(entry: DescribableEntry): string {
  const row = snapshot(entry);
  if (row !== null) {
    for (const key of NAME_FIELDS) {
      const v = row[key];
      if (typeof v === "string" && v.trim() !== "") return v;
    }
  }
  // ⚠️ NEVER EMPTY. An assignment has no name column at all — `product_name` and
  // `operator_display_name` are only filled in on the delete path (0029) — so
  // the id is what identifies it, shortened to the part a person can compare.
  return `#${entry.rowId.slice(0, 8)}`;
}

const VERB: Readonly<Record<AuditAction, string>> = {
  insert: "added",
  update: "changed",
  delete: "deleted",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The fields that moved.
 *
 * ⚠️ THE KEY SET IS THE UNION OF BOTH SIDES, not `after`'s. A migration that
 * adds a column mid-life leaves rows whose `before` lacks it entirely, and that
 * IS a change; walking only one side drops it silently.
 *
 * ⚠️ COMPARED BY JSON, not by `===`. jsonb gives back nested objects and arrays
 * for some columns, and reference equality would report every one of them as
 * changed on every update.
 */
function changesBetween(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  fmt: DateFormat,
  names: AuditNames | undefined,
): AuditFieldChange[] {
  /**
   * ⚠️ EACH SIDE IS NAMED FROM ITS OWN SNAPSHOT. `before.product_name`
   * describes `before.product_id` and `after.product_name` describes
   * `after.product_id`; reading one row's name for both sides would report a
   * swap of parts as a change from a part to itself.
   *
   * ⛔ AND WITH NO LOOKUPS THIS IS EXACTLY WHAT IT WAS. Omitting the argument
   * is a truthful state of its own — nobody LOOKED, which is not the same fact
   * as "looked and could not find it" — so the whole raw id is shown, and the
   * call site that has not been wired up yet renders precisely as before.
   */
  const show = (field: string, v: unknown, row: Record<string, unknown> | null): string =>
    (names === undefined ? null : resolveIdentity(field, v, row, names)) ??
    formatAuditValue(v, fmt);
  const keys = new Set<string>([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: AuditFieldChange[] = [];
  for (const field of keys) {
    if (OMITTED.has(field)) continue;
    const b = before === null ? undefined : before[field];
    const a = after === null ? undefined : after[field];
    const hadBefore = before !== null && field in before && b !== null;
    const hasAfter = after !== null && field in after && a !== null;
    // An INSERT's `before` is null and a DELETE's `after` is null, so this same
    // comparison also produces "arrived with" / "held" lists; a field that was
    // null on the only side present is simply not a fact worth a line.
    if (!hadBefore && !hasAfter) continue;
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue;
    out.push({
      field,
      label: fieldLabel(field),
      before: hadBefore ? show(field, b, before) : null,
      after: hasAfter ? show(field, a, after) : null,
    });
  }
  // Stable, so two renders of the same row never reorder. Alphabetical by the
  // label a reader sees, not by the column name they do not.
  out.sort((x, y) => x.label.localeCompare(y.label));
  return out;
}

/**
 * One audit row, as a reader sees it.
 *
 * ⛔ `names` IS OPTIONAL AND ITS ABSENCE IS THE OLD BEHAVIOUR, EXACTLY. Callers
 * that have not been wired to the catalogues keep compiling and keep rendering
 * what they rendered — and, since nothing here fetches, that is the only way a
 * pure module can offer names at all.
 *
 * ⚠️ THE SUBJECT IS STILL SNAPSHOT-ONLY and deliberately so. `subjectFor` names
 * the row itself, and every table whose rows have names carries that name in
 * the snapshot (`display_name`, `name`, `product_name`) — a lookup would add
 * nothing there but a way for a rename to rewrite the log's past. `names` only
 * ever names a row this one POINTS AT.
 */
export function describeEntry(
  entry: DescribableEntry,
  fmt: DateFormat,
  names?: AuditNames,
): AuditLine {
  const kind = describeTable(entry.tableName);
  const before = isRecord(entry.before) ? entry.before : null;
  const after = isRecord(entry.after) ? entry.after : null;
  return {
    kind,
    subject: subjectFor({ ...entry, before, after }),
    headline: `${kind} ${VERB[entry.action] ?? entry.action}`,
    removed: entry.action === "delete",
    changes: changesBetween(before, after, fmt, names),
  };
}
