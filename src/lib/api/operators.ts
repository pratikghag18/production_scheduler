/**
 * Operators — PRE-SEATED, EMPTY ON PURPOSE (§19.62).
 *
 * The RPC wrappers for operators go here. The file exists before they do so
 * that the lane which writes them never has to append a line to
 * `src/lib/api/index.ts` — measured across four concurrent surveys (§19.57),
 * that one line was a shared anchor every queued section would have edited.
 *
 * The house rules for what goes in here, so the lane does not have to go
 * looking: every wrapper calls one RPC, throws `toSchedulerError(error)` on
 * failure, and parses `data` through a runtime guard that returns `null` on a
 * shape mismatch rather than trusting the generated types — see
 * `hierarchy.ts` for the pattern. `src/lib/api/` is the ONLY place allowed to
 * touch `supabase.rpc`, snake_case field names, or `database.types.ts`.
 */
/* ---------------------------------------------------------------------------
   ⚠️ ONE CORRECTION TO THE HEADER ABOVE, MEASURED RATHER THAN ASSUMED.

   It says "every wrapper calls one RPC". For operators there is no RPC to
   call: `20260821000009_api_surface.sql` exposes nothing for operators,
   skills, operator_skills or node_skill_requirements, and
   `20260827000023_shared_list_owners.sql:484-530` puts the whole contract in
   RLS policies on the tables themselves. Every write below is therefore a
   plain `supabase.from(...)`, and the rest of the header stands verbatim:
   snake_case stops at this file, reads go through a guard that returns `null`
   rather than trusting the generated types, and errors become
   `toSchedulerError(error)`.

   ⭐ AND THAT CHANGE OF MECHANISM BRINGS ONE RULE AN RPC DID NOT NEED.
   **Every write ends `.select()`, then `if (error) throw
   toSchedulerError(error)`, then `requireWritten(data)`.** A policy's `WITH
   CHECK` clause RAISES, but its `USING` clause merely FILTERS — so a refused
   UPDATE or DELETE is a *success that changed nothing*, with no error to map.
   `requireWritten` (errors.ts) turns an empty result into
   `{kind:"WriteRefused"}`. This matters here more than anywhere: migration
   0023 lets a SITE admin edit their own site's operators and refuses them the
   company-wide ones, and without `.select()` the refusal looks exactly like a
   save.

   AUTHOR-ONLY — imports `@/lib/supabase`, so it is not runnable under
   `node --experimental-strip-types`. The logic worth testing lives in
   `src/features/admin/lib/operators.ts`, which is.
   --------------------------------------------------------------------------- */
import { supabase } from "@/lib/supabase";
import { requireWritten, shapeMismatch, toSchedulerError } from "./errors";
import type { BoardNode, HierarchyLevel } from "./shapes";

// ---------------------------------------------------------------------------
// Row shapes. camelCase out; `home_node_id` and `certified_at` are read by
// NOTHING in this app and are deliberately absent — a field on a type is an
// invitation to surface it.
// ---------------------------------------------------------------------------

export interface OperatorRecord {
  id: string;
  displayName: string;
  employeeRef: string | null;
  active: boolean;
  /**
   * The node this person belongs to.
   *
   * ⚠️ SAME DRIFT AS `CreateSkillInput.siteNodeId` BELOW, FOUND WHILE FIXING
   * IT: this read `"null = company-wide (0023). Otherwise the ROOT node…"` on a
   * field typed `string`, and BOTH halves had expired. D108 made the column NOT
   * NULL (`parseOperatorRecord` rejects a null here and says so), and 0025 /
   * D103 stopped `app_check_site_owner` requiring a root — somebody can belong
   * to a line, which is the fact `workPlacesFor`'s whole area rule turns on.
   */
  siteNodeId: string;
  /** `'manual'` by default; an imported person carries their source here. */
  source: string;
  externalId: string | null;
}

export interface SkillRecord {
  id: string;
  name: string;
  siteNodeId: string;
  /**
   * `false` = retired: still held by whoever holds it, still on every record it
   * has ever been part of, and no longer offered for new work.
   *
   * ⭐ THE COLUMN SHIPPED IN 0029 WITH DELIBERATELY NO UI, and §19.74 named
   * that as owed rather than half-building it: *"no screen reads or writes
   * them, so `DeleteDialog` offers no 'Deactivate instead' for those two
   * kinds."* The Trainings screen is where it finally gets read, which is what
   * makes retiring the primary action there and deleting the secondary one —
   * the same shape Products already has.
   *
   * ⚠️ ADVISORY, exactly as on products and operators: the database does not
   * refuse a person who already holds a retired training, and 0029 does not
   * start refusing one. Retiring answers "stop offering this", never "revoke
   * what people have".
   */
  active: boolean;
}

export interface OperatorSkillRecord {
  operatorId: string;
  skillId: string;
  /** `YYYY-MM-DD`, or `null` for "no expiry". */
  expiresAt: string | null;
}

export interface NodeSkillRequirementRecord {
  nodeId: string;
  skillId: string;
}

// ---------------------------------------------------------------------------
// Runtime guards.
//
// Each returns `null` on a shape mismatch rather than throwing, and the
// caller SKIPS AND COUNTS. That is the opposite of `hierarchy.ts`'s
// `parseXResult`/`shapeMismatch` idiom and the difference is deliberate:
// those guard a single row whose absence is genuinely an error, while these
// guard LISTS a screen renders, where one malformed row must never blank the
// panel. The count is reported (`skipped`) rather than swallowed — a silently
// shortened list is indistinguishable from a smaller company.
//
// The single-row payloads of the WRITES below are the other case, and they
// use `shapeMismatch` accordingly.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function strOrNull(v: unknown): string | null | undefined {
  return v === null || typeof v === "string" ? (v as string | null) : undefined;
}

export function parseOperatorRecord(v: unknown): OperatorRecord | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const displayName = str(v.display_name);
  const employeeRef = strOrNull(v.employee_ref);
  // ⭐ `str`, not `strOrNull`, since 0028. The column is NOT NULL, so a null
  // here means the read did not come from a database this client understands.
  // The row is REJECTED rather than coerced — it is then counted as skipped and
  // said out loud, which is the only honest thing to do with a person whose
  // plant the screen cannot name.
  const siteNodeId = str(v.site_node_id);
  const source = str(v.source);
  const externalId = strOrNull(v.external_id);
  if (id === null || displayName === null || source === null || siteNodeId === null) return null;
  if (employeeRef === undefined || externalId === undefined) return null;
  if (typeof v.active !== "boolean") return null;
  return { id, displayName, employeeRef, active: v.active, siteNodeId, source, externalId };
}

export function parseSkillRecord(v: unknown): SkillRecord | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const name = str(v.name);
  const siteNodeId = str(v.site_node_id);
  // ⚠️ A MISSING OR NON-BOOLEAN `active` REJECTS THE ROW rather than defaulting
  // to `true`. The column is NOT NULL with a default, so absent here means the
  // select forgot to ask for it — and a silent `true` would render every
  // retired training as live, on the one screen whose job is to tell them
  // apart. §19.76's lesson: a hand-written guard is the only thing between a
  // shape change and a screen that quietly says the wrong thing.
  if (id === null || name === null || siteNodeId === null || typeof v.active !== "boolean") {
    return null;
  }
  return { id, name, siteNodeId, active: v.active };
}

export function parseOperatorSkillRecord(v: unknown): OperatorSkillRecord | null {
  if (!isRecord(v)) return null;
  const operatorId = str(v.operator_id);
  const skillId = str(v.skill_id);
  const expiresAt = strOrNull(v.expires_at);
  if (operatorId === null || skillId === null || expiresAt === undefined) return null;
  return { operatorId, skillId, expiresAt };
}

export function parseNodeSkillRequirementRecord(v: unknown): NodeSkillRequirementRecord | null {
  if (!isRecord(v)) return null;
  const nodeId = str(v.node_id);
  const skillId = str(v.skill_id);
  if (nodeId === null || skillId === null) return null;
  return { nodeId, skillId };
}

function parseList<T>(
  rows: unknown,
  parse: (v: unknown) => T | null,
): { ok: T[]; skipped: number } {
  if (!Array.isArray(rows)) return { ok: [], skipped: 0 };
  const ok: T[] = [];
  let skipped = 0;
  for (const row of rows as unknown[]) {
    const parsed = parse(row);
    if (parsed === null) skipped += 1;
    else ok.push(parsed);
  }
  return { ok, skipped };
}

function firstOrThrow<T>(rows: unknown, parse: (v: unknown) => T | null, what: string): T {
  const written = requireWritten(rows as unknown[] | null);
  const parsed = parse(written[0]);
  if (parsed === null) throw shapeMismatch(what, "the written row did not parse");
  return parsed;
}

/* ===========================================================================
 * fetchOperatorsAdmin — one read, one spinner.
 *
 * Modelled on `fetchHierarchyTree` in `hierarchy.ts`: everything the screen
 * needs in ONE `Promise.all`, deliberately, and not one `useQuery` per table.
 * §19.47 settled that a level up — a second unresolved window is a second
 * thing to fold into the loading state, and D91 is the standing reminder that
 * `enabled: false` leaves `isLoading` FALSE.
 *
 * ⭐ SIX READS, NOT THE FOUR THIS SECTION'S TABLES ACCOUNT FOR, AND THE TWO
 * EXTRA ARE THE POINT OF THE SCREEN. "Where can this person work" is half made
 * of `nodes` and `hierarchy_levels`: the requirements inherit down the tree, and
 * `is_schedulable` is what decides which nodes are places at all. The panel
 * takes NO props (it cannot be handed `AdminPage`'s tree — that read is local
 * to that component), so the tree is read here, in the same round trip, rather
 * than through a second query the panel would have to fold in by hand.
 *
 * Reads are ORG-WIDE under RLS (0023 changed the WRITE policies only), so this
 * is the whole company's answer, and a site admin sees people they may not
 * edit. That asymmetry is real and the panel shows it rather than hiding it.
 * =========================================================================== */

export interface OperatorsAdminData {
  operators: OperatorRecord[];
  skills: SkillRecord[];
  operatorSkills: OperatorSkillRecord[];
  requirements: NodeSkillRequirementRecord[];
  nodes: BoardNode[];
  levels: HierarchyLevel[];
  /** Rows across all six reads that did not parse. Shown, never swallowed. */
  skipped: number;
}

export async function fetchOperatorsAdmin(): Promise<OperatorsAdminData> {
  const [operatorsRes, skillsRes, operatorSkillsRes, requirementsRes, nodesRes, levelsRes] =
    await Promise.all([
      supabase
        .from("operators")
        .select("id, display_name, employee_ref, active, site_node_id, source, external_id")
        .order("display_name"),
      // ⚠⚠ `SKILL_COLUMNS`, NEVER A SECOND COPY OF THE SAME LIST. This read
      // spelled the columns out inline, so when `active` was added to the
      // constant and `parseSkillRecord` began REQUIRING it, this call kept
      // asking for three columns and every row it returned was rejected —
      // silently, into `skipped`, leaving the Trainings screen empty and the
      // Operators screen with nothing to grant. §19.76's rule with the
      // arrow reversed: there, a nullable COLUMN broke a hand-written guard;
      // here, a stricter GUARD broke a hand-written column list.
      supabase.from("skills").select(SKILL_COLUMNS).order("name"),
      supabase.from("operator_skills").select("operator_id, skill_id, expires_at"),
      supabase.from("node_skill_requirements").select("node_id, skill_id"),
      supabase
        .from("nodes")
        .select("id, parent_id, level_id, name, path, sort_order, active")
        .order("sort_order"),
      supabase
        .from("hierarchy_levels")
        .select("id, template_id, position, name, is_schedulable")
        .order("position"),
    ]);

  // All six THROW on error, with no `editable_shape_ids`-style exception.
  // Every one of them is this screen's content: without any of them the
  // answer to "where can this person work" is not a shorter list, it is a
  // WRONG list — and a wrong list here reads as a tick.
  if (operatorsRes.error) throw toSchedulerError(operatorsRes.error);
  if (skillsRes.error) throw toSchedulerError(skillsRes.error);
  if (operatorSkillsRes.error) throw toSchedulerError(operatorSkillsRes.error);
  if (requirementsRes.error) throw toSchedulerError(requirementsRes.error);
  if (nodesRes.error) throw toSchedulerError(nodesRes.error);
  if (levelsRes.error) throw toSchedulerError(levelsRes.error);

  const operators = parseList(operatorsRes.data, parseOperatorRecord);
  const skills = parseList(skillsRes.data, parseSkillRecord);
  const operatorSkills = parseList(operatorSkillsRes.data, parseOperatorSkillRecord);
  const requirements = parseList(requirementsRes.data, parseNodeSkillRequirementRecord);

  const nodes: BoardNode[] = (nodesRes.data ?? []).map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    levelId: r.level_id,
    name: r.name,
    // `nodes.path` is a Postgres `ltree`, which has no JS mapping, so
    // `supabase gen types` emits it as `unknown`. It is a string over the
    // wire; cast at the single boundary, exactly as `fetchHierarchyTree` does.
    // Nothing downstream of here parses it — `effectiveRequirements` walks
    // `parentId` instead, and that file's header says why.
    path: r.path as string,
    sortOrder: r.sort_order,
    active: r.active,
  }));
  const levels: HierarchyLevel[] = (levelsRes.data ?? []).map((r) => ({
    id: r.id,
    templateId: r.template_id,
    position: r.position,
    name: r.name,
    isSchedulable: r.is_schedulable,
  }));

  return {
    operators: operators.ok,
    skills: skills.ok,
    operatorSkills: operatorSkills.ok,
    requirements: requirements.ok,
    nodes,
    levels,
    skipped: operators.skipped + skills.skipped + operatorSkills.skipped + requirements.skipped,
  };
}

/* ===========================================================================
 * Writes.
 *
 * Every one ends `.select(...)` -> `if (error) throw toSchedulerError(error)`
 * -> `requireWritten(data)`. See the correction block at the top of this file
 * for why that third step is not optional.
 *
 * `org_id` HAS NO DEFAULT on any of these tables, so every insert takes an
 * explicit `orgId`. The caller reads it from `useSession().profile.orgId`;
 * this layer never guesses it, because the only other place to get it would
 * be a second query whose answer could disagree with the session's.
 *
 * The errors these raise, mapped by `toSchedulerError`:
 *   23505 -> `{kind:"DuplicateValue"}`  — `skills_owner_name_unique`,
 *                                         `unique (org_id, site_node_id,
 *                                         name)` on skills since 0031 (PER
 *                                         OWNER; it was org-wide up to 0002's
 *                                         `unique (org_id, name)`), `unique
 *                                         (org_id, external_id)` on operators,
 *                                         and the `(operator_id, skill_id)`
 *                                         primary key on a re-grant.
 *   23503 -> `{kind:"StillInUse"}`      — deleting someone `operator_skills`
 *                                         or `assignments` still references;
 *                                         neither FK has an ON DELETE clause.
 *   42501 -> `{kind:"WriteRefused"}`    — an INSERT a `WITH CHECK` refused.
 *   0 rows -> `{kind:"WriteRefused"}`   — an UPDATE or DELETE a `USING`
 *                                         clause filtered away. Silent
 *                                         without `requireWritten`.
 * =========================================================================== */

const OPERATOR_COLUMNS =
  "id, display_name, employee_ref, active, site_node_id, source, external_id";
/**
 * ⚠⚠ EXPORTED SO A TEST CAN HOLD IT AND `parseSkillRecord` TO EACH OTHER.
 * They are two halves of one contract — what we ask the database for, and what
 * we refuse to accept back — and they lived in two places that could drift.
 * They did: `active` was added here and required by the parser while a second,
 * inline copy of the column list three hundred lines up kept asking for three
 * columns, so every training silently failed to parse. `apiSkillShape.test.ts`
 * is what makes that a red case instead of an empty screen.
 */
export const SKILL_COLUMNS = "id, name, site_node_id, active";
const OPERATOR_SKILL_COLUMNS = "operator_id, skill_id, expires_at";

export interface CreateOperatorInput {
  orgId: string;
  displayName: string;
  employeeRef: string | null;
  /**
   * The node that owns this person — ANY node, at any level.
   *
   * ⚠️ THIS SAID "the ROOT node… or `null` for company-wide" AND BOTH CLAUSES
   * ARE FALSE. `operators_check_site` fires `app_check_site_owner`, and 0025 /
   * D103 deleted its not-a-root branch outright ("there are facilities where
   * certain people can only work in certain areas"); D108 then removed
   * company-wide and made the column NOT NULL, so there is no `null` to send.
   * What survives is the org check: the node must exist in this org.
   */
  siteNodeId: string;
}

export async function createOperator(input: CreateOperatorInput): Promise<OperatorRecord> {
  const { data, error } = await supabase
    .from("operators")
    .insert({
      org_id: input.orgId,
      display_name: input.displayName,
      employee_ref: input.employeeRef,
      site_node_id: input.siteNodeId,
    })
    .select(OPERATOR_COLUMNS);
  if (error) throw toSchedulerError(error);
  return firstOrThrow(data, parseOperatorRecord, "createOperator");
}

export interface UpdateOperatorInput {
  id: string;
  displayName: string;
  employeeRef: string | null;
  /**
   * Where this person belongs — `null` = company-wide. **Omit the field to
   * leave it alone**; passing `null` MOVES them to company-wide, which is a
   * different act and has to be expressible.
   *
   * ⚠️ OPTIONAL, AND THE REASON SURVIVED 0028 IN A NEW SHAPE. Before D108 the
   * three states were `string` (move them), `null` (company-wide) and
   * `undefined` (leave it alone), so "not supplied" could not be spelled as
   * `null`. D108 deleted the middle one. What still matters is the other pair:
   * an ABSENT key means "leave it alone", so a rename that forgot the field
   * must not send one — and a re-home that sent nothing would silently keep
   * the old owner while the screen showed the new one.
   */
  siteNodeId?: string;
}

export async function updateOperator(input: UpdateOperatorInput): Promise<OperatorRecord> {
  const patch: { display_name: string; employee_ref: string | null; site_node_id?: string } = {
    display_name: input.displayName,
    employee_ref: input.employeeRef,
  };
  // Only when the caller actually supplied it — see the interface comment.
  if (input.siteNodeId !== undefined) patch.site_node_id = input.siteNodeId;

  const { data, error } = await supabase
    .from("operators")
    .update(patch)
    .eq("id", input.id)
    .select(OPERATOR_COLUMNS);
  if (error) throw toSchedulerError(error);
  return firstOrThrow(data, parseOperatorRecord, "updateOperator");
}

/**
 * ⭐ THE MAIN ACTION (the maintainer's decision). Deactivating keeps every assignment,
 * every ticket and every audit trail intact and simply takes the person off
 * the board; deleting is the secondary path below and usually refused.
 */
export async function setOperatorActive(input: {
  id: string;
  active: boolean;
}): Promise<OperatorRecord> {
  const { data, error } = await supabase
    .from("operators")
    .update({ active: input.active })
    .eq("id", input.id)
    .select(OPERATOR_COLUMNS);
  if (error) throw toSchedulerError(error);
  return firstOrThrow(data, parseOperatorRecord, "setOperatorActive");
}

/**
 * Secondary, and expected to fail whenever the person has ever been used:
 * `operator_skills` and `assignments` both reference `operators` with NO
 * `ON DELETE`, so a scheduled or certified person raises 23503 ->
 * `{kind:"StillInUse", usedBy}` — and `usedBy` is what lets the screen say
 * what is blocking it instead of only that something is.
 */
export async function deleteOperator(id: string): Promise<void> {
  const { data, error } = await supabase.from("operators").delete().eq("id", id).select("id");
  if (error) throw toSchedulerError(error);
  requireWritten(data as unknown[] | null);
}

export interface CreateSkillInput {
  orgId: string;
  name: string;
  /**
   * The node this training belongs to.
   *
   * ⚠️ THIS COMMENT SAID "`null` = company-wide, which is what the maintainer
   * chose for skills by default" WHILE SITTING ON A FIELD TYPED `string`. D108
   * removed company-wide from all four owned tables and made the column NOT
   * NULL; the type was corrected and the sentence above it was not. A doc line
   * that contradicts the type beside it is [[decision-record-drift]] rule 10 in
   * its cheapest form — nothing fails, and the next reader believes the prose.
   *
   * ⭐ AND SINCE 0031 IT IS HALF OF THE UNIQUE KEY: `unique (org_id,
   * site_node_id, name)`. Two plants may each hold a "Forklift"; one plant may
   * not hold it twice. So this field decides whether the name below is legal,
   * which is a much larger job than the one it used to have.
   */
  siteNodeId: string;
}

/**
 * ⭐ `unique (org_id, site_node_id, name)` IS PER OWNER SINCE 0031, and a 23505
 * from here really is the exception again — but not for the reason this comment
 * used to give.
 *
 * ⚠️ IT SAID a 23505 "is NOT something to show the user", because "the screen
 * checks `findExistingSkillByName` first… `DuplicateValue` covers only the race
 * where somebody else created it in between". **That was true when it was
 * written and false from the day reads were scoped (0026).** Once a caller
 * could only read trainings on their own branch, the pre-check could no longer
 * SEE the row that would refuse the insert — so the org-wide clash stopped
 * being a race and became the ordinary way this call failed, with the error
 * arriving as the first news of it.
 *
 * ⭐ 0031 MAKES THE OLD SENTENCE TRUE AGAIN, ON A DIFFERENT FOOTING. The only
 * clash left is one under the SAME owner: same branch, therefore readable,
 * therefore genuinely caught by `findExistingSkillByName` first. The pre-check
 * is no longer asking a question it cannot see the answer to.
 *
 * ⭐ WHICH IS ALSO WHAT MAKES THE SHARED ERROR STRING HONEST HERE.
 * `describeSchedulerError`'s `DuplicateValue` reads *"Something here already
 * uses that name or code."* — it is shared with several tables and is not this
 * file's to edit. Under 0031 its "here" is exactly right for skills: the row it
 * refers to is in the reader's own place. Before 0031 that word named a plant
 * they had never seen.
 */
export async function createSkill(input: CreateSkillInput): Promise<SkillRecord> {
  const { data, error } = await supabase
    .from("skills")
    .insert({ org_id: input.orgId, name: input.name, site_node_id: input.siteNodeId })
    .select(SKILL_COLUMNS);
  if (error) throw toSchedulerError(error);
  return firstOrThrow(data, parseSkillRecord, "createSkill");
}

export interface SetSkillActiveInput {
  id: string;
  active: boolean;
}

/**
 * Retire / bring back a training — the MAIN action on the Trainings screen,
 * mirroring `setProductActive` deliberately rather than inventing a second
 * shape for the same idea.
 *
 * ⭐ RETIRING IS NOT DELETING AND THE DIFFERENCE IS THE WHOLE POINT. Deleting
 * a training cascades it off everyone who holds it (0029 gave
 * `operator_skills → skills` `ON DELETE CASCADE`, which is what made "delete
 * this training" completable at all). Retiring changes nothing anybody holds;
 * it stops the training being offered for new work. "We do not run that course
 * any more" is the second thing, and it was unreachable until this screen.
 */
export async function setSkillActive(input: SetSkillActiveInput): Promise<SkillRecord> {
  const { data, error } = await supabase
    .from("skills")
    .update({ active: input.active })
    .eq("id", input.id)
    .select(SKILL_COLUMNS);
  if (error) throw toSchedulerError(error);
  return firstOrThrow(data, parseSkillRecord, "setSkillActive");
}

export async function renameSkill(input: { id: string; name: string }): Promise<SkillRecord> {
  const { data, error } = await supabase
    .from("skills")
    .update({ name: input.name })
    .eq("id", input.id)
    .select(SKILL_COLUMNS);
  if (error) throw toSchedulerError(error);
  return firstOrThrow(data, parseSkillRecord, "renameSkill");
}

/** Raises 23503 -> `{kind:"StillInUse"}` while any person holds it or any place requires it. */
export async function deleteSkill(id: string): Promise<void> {
  const { data, error } = await supabase.from("skills").delete().eq("id", id).select("id");
  if (error) throw toSchedulerError(error);
  requireWritten(data as unknown[] | null);
}

export interface GrantSkillInput {
  orgId: string;
  operatorId: string;
  skillId: string;
  /** `YYYY-MM-DD`, or `null` for a ticket that never expires. */
  expiresAt: string | null;
}

/**
 * ⭐ THE ONE WRITE THAT CHANGES SEVERAL ANSWERS AT ONCE. One row here can turn
 * a handful of crosses green across the tree, because requirements inherit
 * downward and this ticket satisfies every one of them.
 *
 * ⚠️ `operator_skills` FOLLOWS THE OPERATOR, not the skill:
 * `app_is_admin_for_operator(operator_id)` (0023:402). So a SITE admin may
 * legitimately say THEIR operator holds a COMPANY-WIDE skill they cannot
 * themselves edit or delete. That is the intended asymmetry, not a bug to
 * defend against here.
 *
 * `certified_at` is deliberately not written: nothing in this app reads it.
 */
export async function grantSkill(input: GrantSkillInput): Promise<OperatorSkillRecord> {
  const { data, error } = await supabase
    .from("operator_skills")
    .insert({
      org_id: input.orgId,
      operator_id: input.operatorId,
      skill_id: input.skillId,
      expires_at: input.expiresAt,
    })
    .select(OPERATOR_SKILL_COLUMNS);
  if (error) throw toSchedulerError(error);
  return firstOrThrow(data, parseOperatorSkillRecord, "grantSkill");
}

export async function updateSkillExpiry(input: {
  operatorId: string;
  skillId: string;
  expiresAt: string | null;
}): Promise<OperatorSkillRecord> {
  const { data, error } = await supabase
    .from("operator_skills")
    .update({ expires_at: input.expiresAt })
    .eq("operator_id", input.operatorId)
    .eq("skill_id", input.skillId)
    .select(OPERATOR_SKILL_COLUMNS);
  if (error) throw toSchedulerError(error);
  return firstOrThrow(data, parseOperatorSkillRecord, "updateSkillExpiry");
}

export async function revokeSkill(input: { operatorId: string; skillId: string }): Promise<void> {
  const { data, error } = await supabase
    .from("operator_skills")
    .delete()
    .eq("operator_id", input.operatorId)
    .eq("skill_id", input.skillId)
    .select("skill_id");
  if (error) throw toSchedulerError(error);
  requireWritten(data as unknown[] | null);
}
