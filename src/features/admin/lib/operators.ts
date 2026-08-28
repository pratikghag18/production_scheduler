/**
 * Operators — the pure half, and the heart of this section.
 *
 * Dependency-free: no runtime import of any kind, no React, no CSS, no
 * `supabase`, no snake_case leaking out. Runs under
 * `node --experimental-strip-types` with nothing to resolve, which is what
 * lets `src/test/operators.test.ts` cover it without a network.
 *
 * ---------------------------------------------------------------------------
 * ⭐ THE SHAPE OF THIS SCREEN, IN ONE SENTENCE (the user's own framing):
 *
 *     "is the operator trained to work in this particular work cell —
 *      a simple yes/no."
 *
 * So the vocabulary of this module is WHERE A PERSON CAN WORK, not a
 * catalogue of skills. `workPlacesFor` is the primary function here; tickets
 * (a held skill, with or without an expiry) exist only because granting one
 * is how you CHANGE the answer. One ticket turns several crosses green at
 * once, and the person granting it never touches a cell.
 *
 * ---------------------------------------------------------------------------
 * ⚠️⚠️ THIS IS A MIRROR. THE SERVER IS THE AUTHORITY. ⚠️⚠️
 *
 * `check_eligibility(p_operator_id, p_node_id, p_timerange)` — migration
 * `20260821000009_api_surface.sql:341-378`, the ONLY definition of
 * eligibility that exists — decides this question, and it is re-asked at
 * assignment time against the real shift window. Everything computed here is
 * an INDICATION: what the arrays this module was handed imply, on the date it
 * was handed. It exists so an admin can see the consequence of granting a
 * ticket without dragging a chip onto a board to find out.
 *
 * The invariant runs ONE WAY: **this must never show a tick where the server
 * would refuse.** The converse — a cross here that the server would have
 * allowed — is a worse screen but not a false promise, so every case where a
 * fact cannot be resolved from the arrays given (a parent node missing, an
 * ancestor cycle, a required skill row the caller cannot see) resolves to a
 * CROSS carrying an honest reason, never to a tick. `NodeRequirements.complete`
 * and `WorkPlace.unnamed` are the two places that honesty is recorded.
 *
 * The mirror is written against the SQL clause by clause; each is quoted at
 * its counterpart below. Three details are easy to get wrong and all three
 * are deliberate here:
 *
 *  1. `required` is the ANCESTOR UNION (`target.path <@ anc.path`), which in
 *     ltree includes the target itself. A requirement on a Line applies to
 *     every cell under it AND a requirement on the cell applies to the cell.
 *  2. `missing` is computed against `held` WITHOUT regard to expiry. An
 *     expired-but-held ticket is EXPIRING, not MISSING — it must never be
 *     reported twice, and `expiring` is what makes it a cross.
 *  3. `missing_skills` / `expiring_skills` join `skills` for a NAME, so a
 *     required skill whose row the caller cannot read DROPS OUT OF THE LIST
 *     while `count(*) FROM missing` still counts it: the server answers
 *     `eligible: false` with an empty list. `unnamed` mirrors exactly that.
 *
 * ---------------------------------------------------------------------------
 * THE WINDOW. The server compares `expires_at < upper(p_timerange)::date`,
 * and treats an unbounded window as expiring ANY dated ticket. This screen
 * has no shift to ask about, so `asOf` IS that upper bound: "can this person
 * work here, for work booked up to this date". Default it to today and it
 * answers "right now"; move it forward and tickets that lapse before then
 * turn to crosses, which is precisely what the server will do to them.
 *
 * ---------------------------------------------------------------------------
 * WHITESPACE PARITY. `operators.display_name` and `skills.name` have NO trim
 * trigger and no CHECK — verified against every migration, not assumed
 * (`20260825000011_trim_whitespace.sql` covers hierarchy names only). So the
 * client is the only thing standing between a user and an operator called
 * `"  "`. Plain `.trim()`, matching `app_trim_ws`'s code-point-exact
 * reimplementation of `String.prototype.trim()`. No `\s` regex, no character
 * class; both have been tried in this project and both were wrong.
 */

/* ===========================================================================
 * Inputs.
 *
 * Structural, and deliberately NARROWER than the row types
 * `src/lib/api/operators.ts` returns: the api layer's records are assignable
 * to these, so the panel hands its query result straight in, while this
 * module stays readable and its fixtures stay small. Nothing here imports
 * that file — not even a type — so this module has no path to `supabase`.
 * =========================================================================== */

/** An operator, as this module needs them. `home_node_id` is NOT here: nothing reads it. */
export interface OperatorLike {
  id: string;
  displayName: string;
  employeeRef: string | null;
  active: boolean;
  /**
   * The node this person belongs to. NOT NULL since migration 0028 / D108 —
   * there is no company-wide operator, and it need not be a root (D109).
   */
  siteNodeId: string;
}

/**
 * A training. Names are unique per ORG (`unique (org_id, name)`), not per site
 * — which is why `describeSkillNameClash` exists at all.
 *
 * ⚠️ THE NAME IS COMPANY-UNIQUE AND THE ROW IS NOT COMPANY-WIDE, AND AFTER
 * 0028 THOSE TWO FACTS PULL AGAINST EACH OTHER. Plant 2 can no longer see
 * Plant 1's "Forklift" and can no longer create one, so the clash message can
 * now name a row the reader cannot open. That is recorded rather than fixed
 * here; the fix is a per-owner uniqueness rule and it belongs with D111's
 * starter library, where "copy this into my plant" is the answer.
 */
export interface SkillLike {
  id: string;
  name: string;
  siteNodeId: string;
}

/** A ticket: this person holds this skill. `expiresAt === null` means no expiry. */
export interface OperatorSkillLike {
  operatorId: string;
  skillId: string;
  /** An ISO `YYYY-MM-DD` day, or `null` for "never expires". */
  expiresAt: string | null;
}

/** A requirement sitting on a node. Inherits DOWNWARD to every descendant. */
export interface RequirementLike {
  nodeId: string;
  skillId: string;
}

/** A place. `parentId === null` marks a root. */
export interface NodeLike {
  id: string;
  parentId: string | null;
  levelId: string;
  name: string;
  active: boolean;
}

/** A level. `isSchedulable` is what makes a node a place work can be booked into. */
export interface LevelLike {
  id: string;
  isSchedulable: boolean;
}

/* ===========================================================================
 * effectiveRequirements — the ancestor union.
 *
 * Mirrors, from `check_eligibility`:
 *
 *     WITH required AS (
 *       SELECT DISTINCT nsr.skill_id
 *       FROM nodes target
 *       JOIN nodes anc ON target.path <@ anc.path AND anc.org_id = target.org_id
 *       JOIN node_skill_requirements nsr ON nsr.node_id = anc.id
 *       WHERE target.id = p_node_id
 *     )
 *
 * ⭐ WALKED THROUGH `parentId`, NOT THROUGH `path` STRINGS, and that is a
 * decision rather than a convenience. `nodes.path` is a Postgres `ltree` that
 * `supabase gen types` cannot express (it arrives as `unknown` and is cast at
 * the api boundary); re-deriving `<@` from it here would mean reimplementing
 * ltree's label-boundary rules in JavaScript, where `a.b` is a prefix of
 * `a.bb` as a plain string and is NOT an ancestor of it in ltree. The parent
 * links carry the same tree with no parsing at all.
 *
 * `complete` is the honesty flag. The walk stops at a root (`parentId ===
 * null`) and that is the only ending that means "I saw everything". A parent
 * id with no node beside it, or a cycle, ends the walk early — requirements
 * above the break are invisible, so eligibility below it cannot be affirmed.
 * =========================================================================== */

export interface NodeRequirements {
  nodeId: string;
  /** DISTINCT skill ids required here: this node's own, plus every ancestor's. */
  skillIds: readonly string[];
  /**
   * `true` only when the walk reached a root. `false` means a missing parent
   * or an ancestor cycle cut it short, so this list may be incomplete and
   * `workPlacesFor` must not answer "eligible" from it.
   */
  complete: boolean;
}

export function effectiveRequirements(
  nodes: readonly NodeLike[],
  requirements: readonly RequirementLike[],
): Map<string, NodeRequirements> {
  const byId = new Map<string, NodeLike>();
  for (const n of nodes) byId.set(n.id, n);

  const own = new Map<string, string[]>();
  for (const r of requirements) {
    const list = own.get(r.nodeId);
    if (list === undefined) own.set(r.nodeId, [r.skillId]);
    else list.push(r.skillId);
  }

  const out = new Map<string, NodeRequirements>();
  for (const node of nodes) {
    const skillIds = new Set<string>();
    const seen = new Set<string>();
    let complete = false;
    let cur: NodeLike | undefined = node;
    while (cur !== undefined) {
      if (seen.has(cur.id)) break; // a cycle: `complete` stays false
      seen.add(cur.id);
      for (const skillId of own.get(cur.id) ?? []) skillIds.add(skillId);
      if (cur.parentId === null) {
        complete = true; // reached a root, saw the whole chain
        break;
      }
      cur = byId.get(cur.parentId); // `undefined` -> broken chain, stays false
    }
    out.set(node.id, { nodeId: node.id, skillIds: [...skillIds], complete });
  }
  return out;
}

/* ===========================================================================
 * Day arithmetic and day formatting.
 *
 * `expires_at` is a Postgres `date`, which arrives as `YYYY-MM-DD`. Compared
 * as STRINGS, deliberately: ISO days sort lexicographically exactly as they
 * sort chronologically, and `new Date("2026-09-03")` parses as UTC midnight
 * while `new Date(2026, 8, 3)` parses as local midnight — a class of
 * off-by-one-day bug this project does not need a second instance of.
 * =========================================================================== */

const MONTHS: readonly string[] = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `"2026-09-03"` -> `"3 Sep 2026"`. Returns the input unchanged if it is not a day. */
export function formatDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (m === null) return day;
  const month = MONTHS[Number(m[2]) - 1];
  if (month === undefined) return day;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** Is `day` a well-formed `YYYY-MM-DD`? Anything else is not comparable. */
export function isDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day);
}

/* ===========================================================================
 * workPlacesFor — the answer this screen exists to give.
 *
 * One entry per SCHEDULABLE node: a tick, or a cross with the reason for it.
 * Mirrors the rest of `check_eligibility`:
 *
 *     held     := the operator's operator_skills rows
 *     missing  := required NOT IN held                       (expiry ignored)
 *     expiring := required AND held AND expires_at IS NOT NULL
 *                 AND (upper_inf(window) OR expires_at < upper(window)::date)
 *     eligible := count(missing) = 0 AND count(expiring) = 0
 * =========================================================================== */

/** A required ticket this person does not hold. */
export interface MissingTicket {
  skillId: string;
  name: string;
}

/** A required ticket this person holds, but which lapses inside the window. */
export interface ExpiringTicket {
  skillId: string;
  name: string;
  /** The raw `YYYY-MM-DD`; `formatDay` is what the screen renders. */
  expiresAt: string;
}

export interface WorkPlace {
  nodeId: string;
  /** Root-to-leaf names, `"Plant 1 › Line A › Cell 3"`. Prefixed `"… › "` when the chain broke. */
  label: string;
  /** The leaf's own name, for a compact column. */
  name: string;
  /** `nodes.active`. Requirements still inherit through an inactive ancestor. */
  active: boolean;
  eligible: boolean;
  missing: readonly MissingTicket[];
  expiring: readonly ExpiringTicket[];
  /**
   * How many required tickets counted against this place but could NOT be
   * named — the skill row is not readable, or a held ticket's `expires_at` is
   * not a day this module can compare. The server behaves the same way
   * (see the file header, point 3): they count, they cannot be listed.
   */
  unnamed: number;
  /** `false` when the ancestor walk did not reach a root — see `NodeRequirements`. */
  complete: boolean;
  /** One sentence per cross, in the order the screen should show them. */
  reasons: readonly string[];
}

export interface WorkPlaceInput {
  nodes: readonly NodeLike[];
  levels: readonly LevelLike[];
  requirements: readonly RequirementLike[];
  skills: readonly SkillLike[];
  operatorSkills: readonly OperatorSkillLike[];
}

function labelFor(node: NodeLike, byId: ReadonlyMap<string, NodeLike>): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let cur: NodeLike | undefined = node;
  let truncated = false;
  while (cur !== undefined) {
    if (seen.has(cur.id)) {
      truncated = true;
      break;
    }
    seen.add(cur.id);
    names.push(cur.name);
    if (cur.parentId === null) break;
    const parent = byId.get(cur.parentId);
    if (parent === undefined) {
      truncated = true;
      break;
    }
    cur = parent;
  }
  names.reverse();
  return truncated ? `… › ${names.join(" › ")}` : names.join(" › ");
}

/**
 * @param asOf The window's UPPER BOUND, `YYYY-MM-DD` — see the file header.
 *   A ticket expiring strictly before this day is a cross, exactly as
 *   `expires_at < upper(p_timerange)::date` makes it one.
 */
export function workPlacesFor(
  operator: OperatorLike,
  input: WorkPlaceInput,
  asOf: string,
): WorkPlace[] {
  const byId = new Map<string, NodeLike>();
  for (const n of input.nodes) byId.set(n.id, n);

  const schedulable = new Set<string>();
  for (const l of input.levels) if (l.isSchedulable) schedulable.add(l.id);

  const skillName = new Map<string, string>();
  for (const s of input.skills) skillName.set(s.id, s.name);

  // `held` — the operator's own rows and nothing else. Expiry is NOT a filter
  // here: an expired ticket is still HELD, which is what keeps it out of
  // `missing` and puts it in `expiring` instead (file header, point 2).
  const held = new Map<string, string | null>();
  for (const os of input.operatorSkills) {
    if (os.operatorId === operator.id) held.set(os.skillId, os.expiresAt);
  }

  const required = effectiveRequirements(input.nodes, input.requirements);
  const asOfComparable = isDay(asOf);

  const places: WorkPlace[] = [];
  for (const node of input.nodes) {
    if (!schedulable.has(node.levelId)) continue;
    const req = required.get(node.id);
    // Unreachable in practice (`effectiveRequirements` writes an entry for
    // every node it is given, and this loop reads the same array), but an
    // absent entry means "we know nothing about this place" and the honest
    // answer to that is a cross, not a crash and not a tick.
    const skillIds = req?.skillIds ?? [];
    const complete = req?.complete ?? false;

    const missing: MissingTicket[] = [];
    const expiring: ExpiringTicket[] = [];
    let unnamed = 0;

    for (const skillId of skillIds) {
      const name = skillName.get(skillId);
      if (!held.has(skillId)) {
        // Required and not held. Named if we can read the skill row; counted
        // either way — this is the server's own asymmetry.
        if (name === undefined) unnamed += 1;
        else missing.push({ skillId, name });
        continue;
      }
      const expiresAt = held.get(skillId) ?? null;
      if (expiresAt === null) continue; // no expiry: nothing can lapse
      if (!isDay(expiresAt) || !asOfComparable) {
        // A date we cannot compare must not be read as "still valid".
        unnamed += 1;
        continue;
      }
      if (expiresAt < asOf) {
        if (name === undefined) unnamed += 1;
        else expiring.push({ skillId, name, expiresAt });
      }
    }

    const reasons: string[] = [];
    if (!complete) {
      reasons.push("the places above this one could not be read, so this is not a yes");
    }
    for (const m of missing) reasons.push(`missing ${m.name}`);
    for (const e of expiring) reasons.push(`${e.name} expires ${formatDay(e.expiresAt)}`);
    if (unnamed > 0) {
      reasons.push(
        unnamed === 1
          ? "1 required ticket could not be read"
          : `${unnamed} required tickets could not be read`,
      );
    }

    places.push({
      nodeId: node.id,
      label: labelFor(node, byId),
      name: node.name,
      active: node.active,
      eligible: complete && missing.length === 0 && expiring.length === 0 && unnamed === 0,
      missing,
      expiring,
      unnamed,
      complete,
      reasons,
    });
  }

  places.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return places;
}

/* ===========================================================================
 * The operator list, and the draft that adds to it.
 * =========================================================================== */

export interface OperatorRow {
  id: string;
  displayName: string;
  employeeRef: string | null;
  active: boolean;
  siteNodeId: string;
  /** How many tickets this person holds. Not eligibility — just the count. */
  ticketCount: number;
}

export interface OperatorRowsOptions {
  /** Free text, matched against the name and the employee reference. */
  query?: string;
  /** Deactivated people are hidden by default — deactivate is the main action. */
  includeInactive?: boolean;
}

function matches(row: OperatorRow, needle: string): boolean {
  if (needle === "") return true;
  const hay = `${row.displayName} ${row.employeeRef ?? ""}`.toLowerCase();
  return hay.includes(needle);
}

export function operatorRows(
  operators: readonly OperatorLike[],
  operatorSkills: readonly OperatorSkillLike[],
  options: OperatorRowsOptions = {},
): OperatorRow[] {
  const counts = new Map<string, number>();
  for (const os of operatorSkills) {
    counts.set(os.operatorId, (counts.get(os.operatorId) ?? 0) + 1);
  }
  const needle = (options.query ?? "").trim().toLowerCase();
  const rows: OperatorRow[] = [];
  for (const o of operators) {
    if (!o.active && options.includeInactive !== true) continue;
    const row: OperatorRow = {
      id: o.id,
      displayName: o.displayName,
      employeeRef: o.employeeRef,
      active: o.active,
      siteNodeId: o.siteNodeId,
      ticketCount: counts.get(o.id) ?? 0,
    };
    if (matches(row, needle)) rows.push(row);
  }
  // Name order, case-insensitive, `id` as the tiebreak so the list is stable
  // for two people genuinely called the same thing — which the schema allows:
  // there is no unique constraint on `display_name`.
  rows.sort((a, b) => {
    const an = a.displayName.toLowerCase();
    const bn = b.displayName.toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows;
}

export interface OperatorDraft {
  displayName: string;
  employeeRef: string;
}

export type OperatorDraftResult =
  | {
      ok: true;
      displayName: string;
      /** Empty after trimming becomes `null`, not `""` — the column is nullable. */
      employeeRef: string | null;
      /**
       * The id of someone already called this, or `null`. A WARNING, never an
       * error: `operators` has no unique constraint on `display_name`, so
       * refusing here would block something the database permits — the wrong
       * direction of the one-way invariant in this file's header.
       */
      duplicateNameOf: string | null;
    }
  | { ok: false; field: "displayName"; message: string };

export function validateOperatorDraft(
  draft: OperatorDraft,
  existing: readonly OperatorLike[] = [],
  selfId: string | null = null,
): OperatorDraftResult {
  const displayName = draft.displayName.trim();
  if (displayName === "") {
    return { ok: false, field: "displayName", message: "A name is needed." };
  }
  const employeeRefTrimmed = draft.employeeRef.trim();
  const lowered = displayName.toLowerCase();
  let duplicateNameOf: string | null = null;
  for (const o of existing) {
    if (o.id === selfId) continue;
    if (o.displayName.trim().toLowerCase() === lowered) {
      duplicateNameOf = o.id;
      break;
    }
  }
  return {
    ok: true,
    displayName,
    employeeRef: employeeRefTrimmed === "" ? null : employeeRefTrimmed,
    duplicateNameOf,
  };
}

/* ===========================================================================
 * Tickets: what this person holds today.
 * =========================================================================== */

export interface Ticket {
  skillId: string;
  name: string;
  expiresAt: string | null;
  /** `expiresAt` lapses strictly before `asOf` — the same test `workPlacesFor` uses. */
  lapsed: boolean;
}

export function ticketsFor(
  operator: OperatorLike,
  skills: readonly SkillLike[],
  operatorSkills: readonly OperatorSkillLike[],
  asOf: string,
): Ticket[] {
  const name = new Map<string, string>();
  for (const s of skills) name.set(s.id, s.name);
  const out: Ticket[] = [];
  for (const os of operatorSkills) {
    if (os.operatorId !== operator.id) continue;
    const expiresAt = os.expiresAt;
    out.push({
      skillId: os.skillId,
      // A ticket for a skill row we cannot read is still a ticket the person
      // holds; it is shown, unnamed, rather than silently dropped.
      name: name.get(os.skillId) ?? "(a ticket you can't see)",
      expiresAt,
      lapsed: expiresAt !== null && isDay(expiresAt) && isDay(asOf) ? expiresAt < asOf : false,
    });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/* ===========================================================================
 * findExistingSkillByName — the clash that is not an error.
 *
 * ⭐ THE MAINTAINER'S DECISION: SKILL NAMES STAY COMPANY-WIDE (`unique (org_id,
 * name)`, migration 0002:53). The consequence on a screen is the whole point
 * of this function: when someone types a name that already exists, they have
 * not made a mistake — they have found the ticket they were about to create.
 * The screen must say *"there is already a company-wide Forklift — use that
 * one"* and offer to attach it in one click. A raw duplicate-key error
 * reaching the user is a defect; `{kind:"DuplicateValue"}` is the fallback
 * for the race where somebody else creates it between the check and the
 * insert, not the normal path.
 *
 * `exact` distinguishes the two cases that behave differently in Postgres:
 *  - EXACT (byte-equal to the stored name, after trimming the input): the
 *    insert WILL fail with 23505. Offer the existing skill instead; do not
 *    offer to create.
 *  - CASE-INSENSITIVE only ("forklift" vs "Forklift"): the unique index is
 *    over plain `text`, so the insert WOULD succeed and leave the company
 *    with two Forklifts. Still say so, but the user may genuinely mean a
 *    different ticket, so creating stays available.
 * =========================================================================== */

export interface SkillNameClash {
  skill: SkillLike;
  /** `true` when the insert would actually be refused by `unique (org_id, name)`. */
  exact: boolean;
}

export function findExistingSkillByName(
  skills: readonly SkillLike[],
  name: string,
): SkillNameClash | null {
  const trimmed = name.trim();
  if (trimmed === "") return null;
  const lowered = trimmed.toLowerCase();
  let loose: SkillLike | null = null;
  for (const s of skills) {
    if (s.name === trimmed) return { skill: s, exact: true };
    if (loose === null && s.name.trim().toLowerCase() === lowered) loose = s;
  }
  return loose === null ? null : { skill: loose, exact: false };
}

/** The sentence the screen shows for a clash. Here so it is testable, not in JSX. */
export function describeSkillNameClash(clash: SkillNameClash): string {
  // "site-owned", not "existing". Nothing in this fixture was ever site-owned,
  // so this arm shipped unevaluated and read "There is already a existing
  // Welding" — ungrammatical, and it told the person nothing they did not
  // already know from the fact that we are refusing their name. WHOSE ticket it
  // is, is the part that decides whether they can reach it. Measured 27 Aug.
  // ⚠️ 0028 COLLAPSED THIS TO ONE ARM. It used to read "company-wide" or
  // "site-owned"; there is no company-wide row now, so the word that carried
  // the information is gone and every clash is site-owned. Left as a named
  // constant rather than inlined, because the sentence is about to need the
  // owner's NAME instead — see the SkillLike header.
  const scope = "site-owned";
  return clash.exact
    ? `There is already a ${scope} ${clash.skill.name} — use that one.`
    : `There is already a ${scope} ${clash.skill.name}. Attach that one unless this is a different ticket.`;
}

/* ===========================================================================
 * Deleting a person.
 *
 * ⭐ THE MAINTAINER'S DECISION: DEACTIVATE IS THE MAIN ACTION. Delete is secondary and
 * only when nothing is in the way, and the refusal must say WHAT is in the
 * way. `operator_skills` and `assignments` both reference `operators` with no
 * `ON DELETE` clause, so a delete that hits either fails with SQLSTATE 23503
 * -> `{kind:"StillInUse"}`, whose `usedBy` names the referencing table.
 *
 * This precheck answers only for the half this screen can SEE — the tickets,
 * which it already has in memory. Assignments are not read here, so a person
 * with no tickets can still be refused; the panel maps that refusal through
 * `describeSchedulerError`, which says "It's still used by assignments".
 * Reporting `allowed: true` therefore means "nothing I can see is blocking
 * this", never "this will succeed", and the button copy says so.
 * =========================================================================== */

export interface DeletePrecheck {
  allowed: boolean;
  /** What is in the way, as a sentence, or `null` when nothing visible is. */
  blockedBy: string | null;
}

export function deletePrecheck(
  operator: OperatorLike,
  operatorSkills: readonly OperatorSkillLike[],
): DeletePrecheck {
  let tickets = 0;
  for (const os of operatorSkills) if (os.operatorId === operator.id) tickets += 1;
  if (tickets === 0) return { allowed: true, blockedBy: null };
  return {
    allowed: false,
    blockedBy:
      tickets === 1
        ? "1 ticket is still attached to this person. Remove it first, or deactivate them instead."
        : `${tickets} tickets are still attached to this person. Remove them first, or deactivate them instead.`,
  };
}

/* ===========================================================================
 * A one-line summary of the whole answer, for the operator list.
 * =========================================================================== */

export interface PlacesSummary {
  total: number;
  eligible: number;
  /** How many crosses this module could not fully explain. */
  unresolved: number;
}

export function summarisePlaces(places: readonly WorkPlace[]): PlacesSummary {
  let eligible = 0;
  let unresolved = 0;
  for (const p of places) {
    if (p.eligible) eligible += 1;
    if (!p.complete || p.unnamed > 0) unresolved += 1;
  }
  return { total: places.length, eligible, unresolved };
}
