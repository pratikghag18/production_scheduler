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
): string {
  if (actorId === null) return "System";
  if (viewerUserId !== null && actorId === viewerUserId) return "You";
  const role = roles.get(actorId);
  if (role === undefined) return `Unknown account · ${tail(actorId)}`;
  return `${ROLE_WORD[role] ?? prettify(role)} · ${tail(actorId)}`;
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
): AuditFieldChange[] {
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
      before: hadBefore ? formatAuditValue(b, fmt) : null,
      after: hasAfter ? formatAuditValue(a, fmt) : null,
    });
  }
  // Stable, so two renders of the same row never reorder. Alphabetical by the
  // label a reader sees, not by the column name they do not.
  out.sort((x, y) => x.label.localeCompare(y.label));
  return out;
}

/** One audit row, as a reader sees it. */
export function describeEntry(entry: DescribableEntry, fmt: DateFormat): AuditLine {
  const kind = describeTable(entry.tableName);
  const before = isRecord(entry.before) ? entry.before : null;
  const after = isRecord(entry.after) ? entry.after : null;
  return {
    kind,
    subject: subjectFor({ ...entry, before, after }),
    headline: `${kind} ${VERB[entry.action] ?? entry.action}`,
    changes: changesBetween(before, after, fmt),
  };
}
