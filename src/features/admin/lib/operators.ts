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
 * CROSS carrying an honest reason, never to a tick. `NodeRequirements.complete`,
 * `WorkPlace.unnamed` and `AreaStanding`'s `"unknown"` are the three places
 * that honesty is recorded.
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ THERE ARE TWO SERVER RULES HERE, NOT ONE, AND THIS MODULE ONCE
 * MIRRORED ONLY THE FIRST.
 *
 *  1. TRAINING — `check_eligibility`: does this person hold every ticket this
 *     place requires? A capability question, and the whole of what this file
 *     used to answer.
 *  2. AREA — `app_guard_assignment_scope` (migration 0028 §4 / D109): an
 *     assignment is refused unless the operator's owning node is an
 *     ancestor-or-self of the cell. It is a BEFORE ROW trigger, so it fires
 *     ahead of the training check, for every writer, including a plain
 *     PostgREST `PATCH` that passes through no function at all.
 *
 * ⚠️⚠️ `OperatorLike.siteNodeId` HAS BEEN DECLARED HERE SINCE D108 MADE IT
 * NOT NULL, WITH A COMMENT CITING D109 — AND `workPlacesFor` DID NOT READ IT.
 * The screen therefore ticked every cell in every plant that a person's
 * TICKETS covered: 12 of 18 on the maintainer's own screen, for somebody whose
 * line holds 2, and all twelve of those ticks were cells the database refuses.
 * The fact was present and unread; this was never missing information.
 *
 * ⭐⭐ AND IT IS THE DANGEROUS DIRECTION OF §19.74'S DEFECT FAMILY.
 * `describeDeleteRefusal` and `deletePrecheck` were stale REFUSALS — they stop
 * people doing what they may, which is quiet and annoying. This was a stale
 * PERMISSION: the client showing what the server will not allow. That is the
 * one that produces a screen which looks like it works, right up to the moment
 * somebody tries to book the week they planned from it and is refused with an
 * error that says nothing about why the screen said yes.
 *
 * ⚠️ AND THE ANSWER IS NOT SIMPLY A CROSS EITHER. Migration 0030 / D113 gives
 * the area rule a door: anyone who may schedule at a cell may place somebody
 * from outside its area there, recording a reason (`assignments.area_override`
 * + `area_override_reason`). So the honest answer has THREE states and not two
 * — `PlaceVerdict` below — and it mirrors the board's own deliberate asymmetry
 * (§19.76): a PRODUCT outside its scope is filtered out of the picker, because
 * the database refuses it with no way through; a PERSON outside their area is
 * annotated rather than refused, because a supervisor can still say yes.
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ HOW FAR THE LIST REACHES IS A SEPARATE QUESTION, AND THE MAINTAINER
 * ANSWERED IT AFTER SEEING THE THREE STATES:
 *
 *     "I see all plants not just Plant A for him, it does say that he's not
 *      from this area for other plants, but those locations should not be
 *      visible at all is my point."   — 31 August
 *
 * **The list stops at the ROOT the person's own area sits under.** A system
 * admin can read every node in the org, so before this the list was every
 * schedulable cell in the company — eighteen of them across three plants for
 * somebody who works on one line. Annotating them was not enough: they are
 * noise on a screen whose whole job is "where can this person work".
 *
 * ⭐ AND THE CUT IS THE ROOT, NOT THE PERSON'S OWN AREA, WHICH IS THE WHOLE
 * POINT OF KEEPING THE ⚠ STATE. Lending somebody from Line 1 to Line 2 in the
 * same plant is a thing supervisors actually do, and D113 exists for it; the
 * override is realistic inside a site and not across sites. Cutting at the
 * person's own area instead would have removed the third state from this
 * screen entirely and made D113's door invisible here.
 *
 * ⚠️ THIS IS A PRESENTATION RULE AND NOT A SERVER ONE. Nothing in the database
 * knows about "the same plant" — D109 is ancestor-or-self of the OWNER, and
 * roots have no special standing in it. So it lives in `placesUnderSameRoot`,
 * which the panel applies, rather than inside `workPlacesFor`, which stays the
 * complete answer about every place it was handed. ⚠️ And it is COUNTED, not
 * silent: `scope.ts`'s header records why — hiding is invisible and permanent,
 * and a list that quietly shrank looks exactly like a person with no options.
 *
 * ⚠️ NOTHING HERE MAY BE COPIED ONTO THE PRODUCT HALF, which stays absolute:
 * §19.74's proof that `delete_owned_row` needs no escalation depends on a
 * product never sitting outside its owner.
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
 * A training. Names are unique PER OWNER since migration 0031 / D111a
 * (`skills_owner_name_unique`, `unique (org_id, site_node_id, name)`) — which
 * is why `findExistingSkillByName` takes an owner and why
 * `describeSkillNameClash` asks about THIS PLACE rather than about the company.
 *
 * ⭐ 0031 RESOLVED A CONTRADICTION THIS COMMENT USED TO RECORD AS UNFIXED, and
 * it was two rules from different migrations disagreeing rather than either one
 * being wrong: `unique (org_id, name)` (0002, company-wide) against
 * `app_can_read_owned(site_node_id)` (0026, your branch only). Plant A created
 * "Forklift"; Plant B's admin was refused with a 23505 naming a row they could
 * not see, open, edit or reuse. The demo seed worked around it by hand,
 * prefixing every training with its plant letter — `A-Welding`, `B-Welding` —
 * and 0031 drops that prefix in the same change.
 *
 * ⚠️ SO TWO TRAININGS MAY NOW SHARE A NAME, AND THE SCREEN HAS TO SAY WHOSE IS
 * WHOSE. `siteNodeId` is the fact that tells them apart, and it already sits on
 * every row: the panel renders it beside the name with `scope.ts`'s
 * `scopeLabel` / `scopePathLabel`. ⚠️ The plant belongs in the OWNER COLUMN and
 * never back in the text — a name that carries its own plant letter goes stale
 * the day the node is renamed, which is the workaround, not the fix.
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
 * The area rule — `app_guard_assignment_scope` (migration 0028 §4 / D109).
 *
 * The clause this mirrors, the operator half of that trigger:
 *
 *     if not exists (
 *       select 1 from nodes owner
 *       where owner.id = op.site_node_id
 *         and target.path <@ owner.path
 *     ) then raise ... 'not_offered_here';
 *
 * ⭐ `<@` IS REFLEXIVE, so a person owned by the very cell being scheduled is
 * inside it. `scope.ts`'s `isAtOrBelow` records the same fact and case S9 pins
 * it on the server. An implementation that tested strict descent would agree
 * everywhere except on the one node the user actually picked — which is the
 * hardest disagreement of all to notice.
 *
 * ⭐ WALKED THROUGH `parentId`, NOT THROUGH `path`, for exactly the reason
 * `effectiveRequirements` gives above: `nodes.path` is a Postgres `ltree` this
 * module is never handed (`NodeLike` has no `path`), and re-deriving `<@` from
 * a string is where `plant1.line1` becomes an ancestor of `plant1.line10`.
 *
 * ⚠️ THREE ANSWERS, NOT TWO. A walk that reaches a root without meeting the
 * owner is a confident `"outside"`. A walk that runs into a missing parent or
 * a cycle is `"unknown"` — and `"unknown"` must never be read as `"inside"`,
 * because that is precisely the tick the server would refuse.
 *
 * ⭐ AND `"unknown"` IMPLIES `NodeRequirements.complete === false`, ALWAYS. It
 * is the same walk over the same map, and the only two ways it can end early
 * are the two that also stop `effectiveRequirements` reaching a root. That is
 * why an unknown area adds no reason sentence of its own: *"the places above
 * this one could not be read"* is already in the list, saying it once.
 * ⚠️ The converse does NOT hold — an owner found BELOW a break higher up is a
 * confident `"inside"` on an incomplete chain, and that is right.
 * =========================================================================== */

/** Where a place sits relative to the person's own area. */
export type AreaStanding = "inside" | "outside" | "unknown";

/**
 * Is `node` at or below `ownerId`, walking the parent chain?
 *
 * @param ownerId `operators.site_node_id` — NOT NULL since 0028 / D108, and
 *   not necessarily a root (D109).
 */
export function areaStandingFor(
  node: NodeLike,
  ownerId: string,
  byId: ReadonlyMap<string, NodeLike>,
): AreaStanding {
  const seen = new Set<string>();
  let cur: NodeLike | undefined = node;
  while (cur !== undefined) {
    // Reflexive, and tested FIRST: the owner may be this very node, and a
    // cycle that contains the owner should still answer "inside".
    if (cur.id === ownerId) return "inside";
    if (seen.has(cur.id)) return "unknown"; // a cycle, and no root was reached
    seen.add(cur.id);
    if (cur.parentId === null) return "outside"; // a whole chain, owner not on it
    cur = byId.get(cur.parentId);
  }
  return "unknown"; // a parent id with no node beside it
}

/* ===========================================================================
 * The ROOT a place sits under — what a reader calls its plant or its site.
 *
 * ⚠️ "ROOT" IS NOT "SITE" IN THIS CODEBASE'S VOCABULARY, and the two are easy
 * to confuse here. `operators.site_node_id` is the node a person BELONGS to,
 * which since D109 need not be a root at all — Operator A1 in the demo world
 * belongs to a LINE. The root is what that owner ultimately hangs from, and it
 * is only ever used for presentation (see the header).
 * =========================================================================== */

/**
 * The root `nodeId` descends from, or `null` if the chain cannot be walked to
 * one — a missing parent, or a cycle.
 *
 * ⚠️ `null` MEANS "CANNOT TELL" AND NEVER "NO ROOT". Every caller below
 * treats it as a reason to keep a place rather than to drop one.
 */
export function rootIdFor(nodeId: string, byId: ReadonlyMap<string, NodeLike>): string | null {
  const seen = new Set<string>();
  let cur: NodeLike | undefined = byId.get(nodeId);
  while (cur !== undefined) {
    if (seen.has(cur.id)) return null; // a cycle: nothing above it is a root
    seen.add(cur.id);
    if (cur.parentId === null) return cur.id;
    cur = byId.get(cur.parentId);
  }
  return null; // a parent id with no node beside it
}

/**
 * The places that sit under the same root as this person — what the screen
 * actually lists. The rest are counted in a footnote, never dropped silently.
 *
 * ⭐ FAILS OPEN, TWICE, and both directions matter:
 *
 *  1. A place whose own root cannot be resolved is KEPT. Hiding on uncertainty
 *     is the failure `scope.ts` warns about — invisible, permanent, and
 *     indistinguishable from a place nobody created.
 *  2. A person whose root cannot be resolved filters NOTHING. Showing too much
 *     is a worse screen; showing an arbitrary subset is a wrong one.
 */
export function placesUnderSameRoot(
  places: readonly WorkPlace[],
  operatorSiteNodeId: string,
  byId: ReadonlyMap<string, NodeLike>,
): WorkPlace[] {
  const ownRoot = rootIdFor(operatorSiteNodeId, byId);
  if (ownRoot === null) return [...places];
  return places.filter((p) => p.rootId === null || p.rootId === ownRoot);
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
  /**
   * The root this place descends from — its plant, as a reader would say it.
   * `null` when the chain could not be walked to one.
   *
   * ⚠️ PRESENTATION ONLY, and unlike `area` it mirrors no server rule at all.
   * It exists so `placesUnderSameRoot` can trim the list to the person's own
   * site; `workPlacesFor` itself still answers about every place it was given.
   */
  rootId: string | null;
  /**
   * Where this place sits relative to the person's own area (D109). `"outside"`
   * is not a refusal on this screen — D113 lets whoever may schedule here place
   * them anyway, recording a reason — but it is never a tick.
   */
  area: AreaStanding;
  /**
   * TRAININGS ALONE: every required ticket held, none of them lapsed inside the
   * window, and every one of them readable. This is exactly what `eligible`
   * meant before the area rule was mirrored, and it is kept as its own field
   * because a place OUTSIDE somebody's area still has a training answer worth
   * showing beside it — waving through "not from this area" must not silently
   * also wave through "no Welding ticket".
   */
  qualified: boolean;
  /**
   * The whole answer, and the only thing that draws a tick: `qualified` AND
   * inside their area.
   *
   * ⚠️ DO NOT LET A CALLER GO BACK TO READING `qualified` HERE. A tick on
   * trainings alone is the defect this field was split to fix.
   */
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

    const qualified = complete && missing.length === 0 && expiring.length === 0 && unnamed === 0;
    const area = areaStandingFor(node, operator.siteNodeId, byId);

    const reasons: string[] = [];
    // The headline fact first — it is what decides the mark on the row, and the
    // training sentences under it are a second, separate decision.
    // ⚠️ Only `"outside"` speaks here. `"unknown"` is covered by the sentence
    // below it, which is the same walk breaking; see `areaStandingFor`.
    if (area === "outside") {
      reasons.push("not from this area — needs a recorded reason");
    }
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
      rootId: rootIdFor(node.id, byId),
      area,
      qualified,
      eligible: qualified && area === "inside",
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
 * placeVerdict — the three states, in ONE place, so the screen cannot invent a
 * fourth and every case can be pinned.
 *
 *   ✓ can-work         in their area AND holds the trainings
 *   ✗ missing-training  in their area, not capable — a capability answer
 *   ⚠ outside-area      allowed only with a recorded reason (D113)
 *
 * ⚠️ THE AREA IS TESTED FIRST, and an UNRESOLVED area lands on `outside-area`
 * with it. Somebody outside their area who also lacks the ticket reads as
 * `outside-area`, because the area is the fact that decides whether there is a
 * way through at all — the missing ticket is still named in `reasons`, since
 * they are two decisions and a supervisor waving one through has not waved
 * through the other.
 * =========================================================================== */

export type PlaceVerdict = "can-work" | "missing-training" | "outside-area";

export function placeVerdict(place: WorkPlace): PlaceVerdict {
  if (place.area !== "inside") return "outside-area";
  return place.qualified ? "can-work" : "missing-training";
}

/* ===========================================================================
 * Which person the screen is about.
 *
 * ⭐ IT LIVES HERE, NOT IN THE PANEL, AND THAT IS THE POINT OF §19.77. A rule
 * about who may appear on a screen, written inside the component that draws
 * it, is a rule nothing can pin — which is exactly how `workPlacesFor` came to
 * disagree with the server for a whole release. Beside `placesUnderSameRoot`
 * it is one import away from `operators.test.ts`.
 * =========================================================================== */

/**
 * Which person the detail pane is about. Falls back, never sticks.
 *
 * ⭐ RESOLVED AGAINST THE PEOPLE THIS SCREEN IS SHOWING, not against every
 * operator the reader can read. `selectedId` outlives a plant switch, and
 * reading it out of the unfiltered array put somebody from Plant B in the
 * detail pane while the list beside it held only Plant A — a selection
 * outliving the list it was made from, which is the whole reason
 * `resolveSelectedShape` and `resolvePlace` exist.
 *
 * ⚠️ IT FALLS BACK TO NOBODY, NOT TO THE FIRST ROW, and that is the one place
 * it differs from those two. "Pick someone on the left" is this screen's real
 * opening state rather than a failure of one, so a first-row fallback would
 * open a person nobody asked for on every visit — and on this screen that
 * person's name, area and tickets are the entire right-hand column.
 */
export function resolveSelectedOperator(
  people: readonly OperatorLike[],
  selectedId: string | null,
): OperatorLike | null {
  if (selectedId === null) return null;
  return people.find((o) => o.id === selectedId) ?? null;
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
 * findExistingSkillByName — the clash that is not an error, and is now LOCAL.
 *
 * ⭐⭐ MIGRATION 0031 / D111a MADE A TRAINING'S NAME UNIQUE PER OWNER —
 * `unique (org_id, site_node_id, name)`, replacing 0002's `unique (org_id,
 * name)`. So this function is asked about ONE OWNER and answers about that
 * owner only. A same-named training under a DIFFERENT owner is not a clash at
 * all: the insert succeeds, the database is content, and since read-scoping
 * (0026) the reader usually cannot see the other row anyway.
 *
 * ⚠️ REPORTING IT WAS THE WORST OF BOTH, AND THAT IS WHY THE PARAMETER EXISTS.
 * The old scan went over every readable training and refused on any name match,
 * which meant a refusal citing a row the reader could not open, edit or reuse —
 * and after 0031 it would also refuse a name the database would have accepted.
 * A stale REFUSAL: it never fails loudly, it just quietly stops people doing
 * something they are allowed to do (the §19.74 family, `deletePrecheck`'s
 * shape).
 *
 * The consequence on a screen is unchanged, and it is still the point of this
 * function: when someone types a name their own place already holds, they have
 * not made a mistake — they have found the ticket they were about to create.
 * The screen says so and attaches it in one click.
 *
 * ⭐ THE EXACT / LOOSE SPLIT SURVIVES 0031, AND THE REASON IS THAT THE
 * CONSTRAINT IS CASE-SENSITIVE. It is a plain `text` unique, not `citext` and
 * not over `lower(name)`, so under ONE owner "forklift" and "Forklift" are two
 * storable rows. The three answers:
 *
 *  - EXACT (byte-equal to the stored name, after trimming the input), SAME
 *    OWNER: the insert WILL be refused with 23505. Offer the existing one; do
 *    not offer to create.
 *  - CASE-ONLY, SAME OWNER: legal, and leaves this one place with two
 *    Forklifts. Warn, but the user may genuinely mean a different ticket, so
 *    creating stays available.
 *  - EITHER, DIFFERENT OWNER: not a clash. `null`.
 * =========================================================================== */

export interface SkillNameClash {
  skill: SkillLike;
  /**
   * `true` when the insert would actually be refused — byte-equal, under the
   * SAME owner, which is the whole of what `unique (org_id, site_node_id,
   * name)` forbids.
   */
  exact: boolean;
  /**
   * How close the clash is, and it decides whether the screen REFUSES or merely
   * WARNS — they are different answers and must not be collapsed.
   *
   * `"here"`       same owner. `skills_owner_name_unique` WILL refuse this
   *                insert, so the screen refuses first and offers the row.
   * `"this-plant"` same root, different owner. **Perfectly legal** — 0031's
   *                constraint is per owner, so Line A and Line B inside one
   *                plant may each hold a "Forklift". Confusing, though, so it
   *                is said out loud and the create stays available.
   *
   * ⚠⚠ A `"this-plant"` clash MUST NOT BLOCK. Blocking it would be a client
   * enforcing a rule the database does not have — §19.74's stale-refusal defect,
   * which is the quiet kind that never fails and just stops people working.
   */
  where: "here" | "this-plant";
}

/**
 * @param owner The `site_node_id` the new training would be created under. On
 *   this screen that is where the person being ticketed belongs, because
 *   `createAndAttach` has no other place to put it.
 *
 *   ⚠️ `null` MEANS "NOTHING TO CLASH WITH", NEVER "CHECKED AND CLEAR". With
 *   nobody selected there is no owner, so there is no insert to refuse and
 *   nothing to warn about; the panel refuses the create separately, with a
 *   sentence, rather than leaning on this `null`.
 */
export function findExistingSkillByName(
  skills: readonly SkillLike[],
  name: string,
  owner: string | null,
  nodesById?: ReadonlyMap<string, NodeLike>,
): SkillNameClash | null {
  const trimmed = name.trim();
  // ⚠️ `owner === null` HERE IS A CONTRACT MARKER, NOT A DECISION, AND NO CASE
  // CAN TELL IT FROM ITS ABSENCE — deleting it was tried and every case stayed
  // green. It is redundant TODAY because `SkillLike.siteNodeId` is a `string`
  // (NOT NULL since D108), so the comparison below rejects every row against a
  // `null` owner anyway. It is kept for the case 0031's own header flags: **if a
  // later migration ever makes `site_node_id` nullable again**, `null !== null`
  // is false and a company-wide row would start matching a caller who has no
  // owner at all — silently, and in the direction that invents a clash.
  // Recorded as unpinned rather than left looking load-bearing.
  if (trimmed === "" || owner === null) return null;
  const lowered = trimmed.toLowerCase();

  // ⭐⭐ TWO PASSES, AND THE ORDER IS THE POINT. A clash under THIS owner is
  // what the database will refuse, so it always wins over one merely in the
  // same plant — reporting the softer one first would offer a warning where a
  // refusal was owed and let the create go through to a 23505.
  let looseHere: SkillLike | null = null;
  for (const s of skills) {
    if (s.siteNodeId !== owner) continue;
    if (s.name === trimmed) return { skill: s, exact: true, where: "here" };
    if (looseHere === null && s.name.trim().toLowerCase() === lowered) looseHere = s;
  }
  if (looseHere !== null) return { skill: looseHere, exact: false, where: "here" };

  // ⭐⭐ THE PLANT-WIDE WARNING, AND IT IS WHAT PAYS FOR 0031's LOOSENING.
  // The constraint is per OWNER, so the migration knowingly allows Line A and
  // Line B in one plant to each hold a "TRN-4471". Its header justifies that by
  // promising this warning — *"the database refuses per owner; the screen warns
  // per plant"* — and the promise is only honest because a plant admin can READ
  // their whole plant, which is exactly what was never true across plants.
  //
  // ⚠️ WITHOUT `nodesById` THERE IS NO PLANT PASS AT ALL, and that is silence
  // rather than a clean bill of health. A caller that cannot resolve the tree
  // gets the owner answer only; it must not report "nothing found" as if the
  // wider question had been asked and answered.
  if (nodesById === undefined) return null;
  const ownerRoot = rootIdFor(owner, nodesById);
  // ⚠️ An unresolvable root means "cannot tell", and the honest response is to
  // say nothing rather than to compare against `null` and match every other
  // row whose root is equally unresolvable.
  if (ownerRoot === null) return null;

  let loosePlant: SkillLike | null = null;
  for (const s of skills) {
    if (s.siteNodeId === owner) continue; // already answered above
    if (rootIdFor(s.siteNodeId, nodesById) !== ownerRoot) continue;
    if (s.name === trimmed) return { skill: s, exact: true, where: "this-plant" };
    if (loosePlant === null && s.name.trim().toLowerCase() === lowered) loosePlant = s;
  }
  return loosePlant === null ? null : { skill: loosePlant, exact: false, where: "this-plant" };
}

/** The sentence the screen shows for a clash. Here so it is testable, not in JSX. */
export function describeSkillNameClash(clash: SkillNameClash, ownerLabel?: string): string {
  // ⭐ "THIS PLACE", NOT "SITE-OWNED", AND THE CHANGE IS AN AXIS AND NOT A
  // WORDING PREFERENCE. "Site-owned" was the word that survived 0028: it once
  // told a company-wide row from a site's own, and once D108 deleted
  // company-wide it described every training equally and so described none of
  // them. Under 0031 the question the reader is actually asking is not what
  // KIND of row this is — it is whether the place they are creating in already
  // holds one, because that is now the only way a name can collide.
  //
  // ⚠️ THE OWNER IS NOT RESOLVED HERE, ON PURPOSE. This module is
  // dependency-free and holds node IDS, not node names, so a caller that wants
  // the other place NAMED passes `ownerLabel` in — the panel gets it from
  // `scope.ts`'s `scopeLabel`, which stays the one place an id becomes a name.
  if (clash.where === "this-plant") {
    // ⭐⭐ A WARNING, AND ITS WORDS HAVE TO SAY SO. This one is not a refusal:
    // 0031 allows two places in one plant to hold the same name, and the create
    // stays live underneath this sentence. So it reports a fact and hands the
    // decision back — "already has", not "cannot" — because a sentence that
    // sounds like a refusal in front of a working button is how people learn to
    // ignore the ones that are.
    //
    // ⭐ And it NAMES THE OTHER PLACE when it can. "Somewhere else in this
    // plant" sends a reader hunting through a list; "Line B already has one"
    // ends the question. That is the maintainer's *"easily identify"* arriving
    // as a sentence rather than as a prefix baked into the name.
    const who = ownerLabel === undefined ? "Another place in this plant" : ownerLabel;
    return clash.exact
      ? `${who} already has a ${clash.skill.name}. Create this one only if it is a different ticket.`
      : `${who} has a ${clash.skill.name}, spelled differently. Create this one only if it is a different ticket.`;
  }
  return clash.exact
    ? `This place already has a ${clash.skill.name} — use that one.`
    : `This place already has a ${clash.skill.name}. Attach that one unless this is a different ticket.`;
}

/* ===========================================================================
 * ⚠️ `DeletePrecheck` / `deletePrecheck` LIVED HERE AND 0029 DELETED THEM.
 *
 * They refused to delete anybody still holding a ticket — "Remove it first, or
 * deactivate them instead" — because `operator_skills`' foreign key to
 * `operators` carried no `ON DELETE` and the delete would have failed with
 * 23503 anyway. Migration 0029 gives that key `ON DELETE CASCADE`: a person's
 * tickets now go with them, and `deletion_preview` COUNTS them so the dialog
 * can say how many.
 *
 * ⭐ THE REASON THIS HAD TO GO RATHER THAN BE RELAXED. A precheck that refuses
 * what the server would allow is the worst kind of client rule: the way out it
 * names ("remove them first") is work that no longer needs doing, and nobody
 * reading this screen has any way to find that out. A stale permission check
 * fails loudly the first time somebody tries; a stale REFUSAL never fails at
 * all, it just quietly stops people doing something they are allowed to do.
 * =========================================================================== */

/* ===========================================================================
 * A one-line summary of the whole answer, for the operator list.
 * =========================================================================== */

export interface PlacesSummary {
  /** Every place in the list. `ownArea + outsideArea === total`. */
  total: number;
  /**
   * Places inside this person's own area — the DENOMINATOR of the count line.
   *
   * ⭐ A COUNT LINE HAS TO NAME WHAT IT COUNTS. *"0 of 2 places in their own
   * area"* is a true sentence about the same person this screen used to
   * describe as *"12 of 18 places"*, where the eighteen were every cell in
   * three plants and all twelve ticks were refusals.
   */
  ownArea: number;
  /** Places they can simply work: inside their area AND qualified. */
  eligible: number;
  /**
   * Places outside their area — still reachable, but only by recording a
   * reason (D113), which is why they are counted rather than hidden.
   *
   * ⚠️ An area this module could NOT resolve is counted here, not in
   * `ownArea`. Same call as `placeVerdict`, same reason: an unproven "inside"
   * is the one answer that puts a number in front of a reader which the server
   * will not honour.
   */
  outsideArea: number;
  /** How many crosses this module could not fully explain. */
  unresolved: number;
}

export function summarisePlaces(places: readonly WorkPlace[]): PlacesSummary {
  let ownArea = 0;
  let eligible = 0;
  let outsideArea = 0;
  let unresolved = 0;
  for (const p of places) {
    if (p.area === "inside") ownArea += 1;
    else outsideArea += 1;
    if (p.eligible) eligible += 1;
    if (!p.complete || p.unnamed > 0) unresolved += 1;
  }
  return { total: places.length, ownArea, eligible, outsideArea, unresolved };
}
