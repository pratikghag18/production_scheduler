/**
 * Shift patterns — `shift_templates`, `shifts`, `shift_breaks` and
 * `node_shift_templates` (migration `20260821000005_shifts.sql`, owners and
 * write policies from `20260827000023_shared_list_owners.sql`).
 *
 * ⚠️ THE STUB THIS REPLACED SAID "every wrapper calls one RPC". THERE IS NO
 * RPC FOR ANY OF THIS, and there was none when the stub was written — 0005
 * ships exactly one function, `resolve_shift_template`, which answers "which
 * pattern does this node run" and writes nothing. Every write below is a plain
 * `supabase.from(...)` against a table whose RLS policy is the authorisation.
 * The rest of the stub's contract holds verbatim and is followed here:
 * `toSchedulerError` on every PostgREST error, a hand-rolled runtime guard on
 * every row, camelCase out, and snake_case confined to this file.
 *
 * ---------------------------------------------------------------------------
 * ⭐ EVERY WRITE ENDS `.select()` → `toSchedulerError` → `requireWritten`.
 *
 * A policy's `WITH CHECK` clause RAISES; its `USING` clause merely FILTERS. So
 * a refused INSERT is an error and a refused UPDATE or DELETE is a SUCCESS
 * THAT CHANGED NOTHING — measured, `51_shared_list_owners_test.sql:251`.
 * `requireWritten` turns the empty result into `{kind:"WriteRefused"}` so "you
 * may not touch that pattern" cannot arrive as "saved". `.single()` is
 * deliberately NOT used: it turns zero rows into a PostgREST `PGRST116`, which
 * `toSchedulerError` has no reason to read as a permission answer.
 *
 * ---------------------------------------------------------------------------
 * ⭐ TWO DIFFERENT PERMISSIONS LIVE IN THIS FILE AND MUST NOT BE CONFLATED.
 *
 *   - EDITING a pattern (`shift_templates`, and through it `shifts` and
 *     `shift_breaks`) needs ownership: company admin, or
 *     `app_is_admin_for(site_node_id)`. `site_node_id IS NULL` means
 *     company-wide, which only a COMPANY admin may edit.
 *   - ATTACHING a pattern to a node (`node_shift_templates`) needs
 *     `app_is_admin_for(node_id)` and says nothing about the pattern.
 *
 * So a site's admin CAN attach the company-wide "Standard 3-shift" to their
 * own plant, and CANNOT rename it. `attachPattern` and `renamePattern` are
 * therefore separate calls with separate refusals, not two modes of one.
 *
 * ---------------------------------------------------------------------------
 * ⭐ `org_id` IS SUPPLIED ON EVERY INSERT. It is `not null` with NO DEFAULT on
 * all four tables (D7), so an insert that omits it fails with a 23502 that
 * reads like a bug in the schema. Callers pass `useSession().profile.orgId`.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ NOTHING TRIMS A NAME SERVER-SIDE. Migration 0011's `app_trim_ws` triggers
 * cover `nodes` and the hierarchy tables and do NOT cover these four. The
 * trim in `validatePatternDraft` is the only one that happens; these wrappers
 * write what they are given.
 *
 * AUTHOR-ONLY — imports `@/lib/supabase` and `database.types.ts`, so it is not
 * runnable under `node --experimental-strip-types`. The logic worth testing
 * lives in `src/features/admin/lib/shiftDraft.ts`, which is pure.
 */
import { supabase } from "@/lib/supabase";
import { requireWritten, shapeMismatch, toSchedulerError } from "./errors";

/* ===========================================================================
 * ROW SHAPES + RUNTIME GUARDS
 *
 * The guards take `unknown` and return `null` on a shape mismatch rather than
 * throwing, and the LIST read below keeps the nulls in place instead of
 * dropping them. That is deliberate: `patternRows` in
 * `src/features/admin/lib/shiftDraft.ts` is what skips them AND COUNTS them,
 * because a silently shortened list of shift patterns is indistinguishable
 * from a company that has fewer of them. Same division as
 * `fetchSitePeople`/`buildAccessRows` (access.ts), with the snake_case→
 * camelCase mapping kept on this side of the boundary where house rule 1 puts
 * it.
 * =========================================================================== */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function isStrOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

/** A minute column. `smallint`, so a non-integer is a shape mismatch, not a value. */
function isMin(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * ⭐ THE COLUMN LIST, ONCE. It is read by `fetchShiftPatterns` and read BACK by
 * three separate writes, and a list that appears four times is four chances for
 * the next column to be added to three of them. `SKILL_COLUMNS` in
 * `operators.ts` is the same constant for the same reason.
 */
// Exported so `apiShiftShape.test.ts` can hold it against
// `parseShiftTemplateRow`. `SKILL_COLUMNS` is exported for the same reason
// and after the same accident.
export const SHIFT_TEMPLATE_COLUMNS = "id, name, site_node_id, active";

/** `shift_templates`. `siteNodeId === null` is company-wide (0023). */
export interface ShiftTemplateRow {
  id: string;
  name: string;
  siteNodeId: string;
  /**
   * `false` = retired. `not null default true` since migration 0029.
   *
   * ⚠️⚠️ IT IS ADVISORY AND THE DATABASE ENFORCES NOTHING WITH IT. 0029's own
   * comment on the column: *"False = retired: not offered when attaching a
   * pattern to a node. ADVISORY, exactly as skills.active — nodes already
   * attached keep resolving to it."* `resolve_shift_template` never reads it,
   * `board_window` does not even emit it, and no policy or trigger mentions it.
   * So retiring a pattern detaches nothing and changes no board: the ONLY thing
   * that acts on this flag is the screen, which stops offering the pattern for
   * new attachments. Anything that reads this column and then claims a place
   * stopped running the pattern is claiming something the server never did.
   */
  active: boolean;
}

/** `shifts`. `endMin` may exceed 1440 — that is what a night shift IS. */
export interface ShiftRow {
  id: string;
  templateId: string;
  name: string;
  startMin: number;
  endMin: number;
}

/** `shift_breaks`. Minutes share the shift's coordinate space, 1440 included. */
export interface ShiftBreakRow {
  id: string;
  shiftId: string;
  name: string;
  startMin: number;
  endMin: number;
}

/** `node_shift_templates`. PK is `node_id`: ONE pattern per node. */
export interface NodeShiftTemplateRow {
  nodeId: string;
  templateId: string;
}

/**
 * The slice of `nodes` this screen needs: a name for the owning site, and the
 * places a pattern can be attached to.
 */
export interface ShiftNodeRow {
  id: string;
  name: string;
  parentId: string | null;
  /** `nodes.path` is an `ltree`; the generated type is `unknown`. See below. */
  path: string;
}

export function parseShiftTemplateRow(v: unknown): ShiftTemplateRow | null {
  if (!isRecord(v)) return null;
  const { id, name, site_node_id, active } = v;
  // ⭐ `isStr`, not `isStrOrNull`, since 0028: the column is NOT NULL, so a
  // null here means the row did not come from a database this client
  // understands. Reject it rather than coerce it — the panel already counts
  // and reports what it skipped.
  if (!isStr(id) || !isStr(name) || !isStr(site_node_id)) return null;
  // ⭐ AND `active` IS CHECKED, NOT DEFAULTED. `?? true` here would be the
  // guard failing open: a row that arrived without the column would render as
  // "in use" — the safe-looking answer that is a positive claim about a pattern
  // this client could not read. The column is `not null default true`, so its
  // absence means the database is not the one this client was built for, and
  // `patternRows` counts the rejection into `view.skipped` where somebody sees
  // it.
  if (!isBool(active)) return null;
  return { id, name, siteNodeId: site_node_id, active };
}

export function parseShiftRow(v: unknown): ShiftRow | null {
  if (!isRecord(v)) return null;
  const { id, template_id, name, start_min, end_min } = v;
  if (!isStr(id) || !isStr(template_id) || !isStr(name)) return null;
  if (!isMin(start_min) || !isMin(end_min)) return null;
  return { id, templateId: template_id, name, startMin: start_min, endMin: end_min };
}

export function parseShiftBreakRow(v: unknown): ShiftBreakRow | null {
  if (!isRecord(v)) return null;
  const { id, shift_id, name, start_min, end_min } = v;
  if (!isStr(id) || !isStr(shift_id) || !isStr(name)) return null;
  if (!isMin(start_min) || !isMin(end_min)) return null;
  return { id, shiftId: shift_id, name, startMin: start_min, endMin: end_min };
}

export function parseNodeShiftTemplateRow(v: unknown): NodeShiftTemplateRow | null {
  if (!isRecord(v)) return null;
  const { node_id, template_id } = v;
  if (!isStr(node_id) || !isStr(template_id)) return null;
  return { nodeId: node_id, templateId: template_id };
}

export function parseShiftNodeRow(v: unknown): ShiftNodeRow | null {
  if (!isRecord(v)) return null;
  const { id, name, parent_id, path } = v;
  if (!isStr(id) || !isStr(name) || !isStrOrNull(parent_id)) return null;
  // `nodes.path` is a Postgres `ltree`, which has no JS mapping, so
  // `supabase gen types` emits it as `unknown`. It is a string over the wire —
  // the same single-boundary note `fetchHierarchyTree` carries. Here it is
  // CHECKED rather than cast, because this is a guard and a cast in a guard is
  // the guard failing open.
  if (!isStr(path)) return null;
  return { id, name, parentId: parent_id, path };
}

/* ===========================================================================
 * THE READ
 * =========================================================================== */

export interface ShiftPatternsPayload {
  templates: readonly (ShiftTemplateRow | null)[];
  shifts: readonly (ShiftRow | null)[];
  breaks: readonly (ShiftBreakRow | null)[];
  attachments: readonly (NodeShiftTemplateRow | null)[];
  nodes: readonly (ShiftNodeRow | null)[];
}

/**
 * Everything the shift-pattern admin screen shows, in ONE round trip, modelled
 * on `fetchHierarchyTree`.
 *
 * ⚠️ `board_window` CANNOT BE THIS READ, and it is worth writing down why so
 * nobody optimises it into one later. It returns only the templates ATTACHED
 * somewhere in the loaded subtree — an unattached pattern, which is exactly
 * what a newly created one is, never appears — and it omits `site_node_id`
 * entirely, so there would be no way to say who owns a row or who may edit it.
 * The tables are read directly, org-wide, which is what the SELECT policies
 * allow.
 *
 * ⚠️ FIVE READS, NOT THE FOUR TABLES. `nodes` is the fifth and it is in the
 * SAME `Promise.all` on purpose: the owning site's NAME and the attach picker
 * both need it, and §19.47 settled that a second `useQuery` is a second
 * unresolved window to fold into the loading state (D91: `enabled: false`
 * leaves `isLoading` FALSE). One read, one spinner. It is the same slice of
 * `nodes` the hierarchy tree already reads, so nothing new is exposed.
 *
 * Every one of the five THROWS on error. All five are the screen's content;
 * without any of them there is nothing honest to draw, and an empty pattern
 * list is a claim ("this company has no shift patterns") rather than a gap.
 */
export async function fetchShiftPatterns(): Promise<ShiftPatternsPayload> {
  const [templatesRes, shiftsRes, breaksRes, attachmentsRes, nodesRes] = await Promise.all([
    supabase.from("shift_templates").select(SHIFT_TEMPLATE_COLUMNS).order("name"),
    supabase.from("shifts").select("id, template_id, name, start_min, end_min").order("start_min"),
    supabase
      .from("shift_breaks")
      .select("id, shift_id, name, start_min, end_min")
      .order("start_min"),
    supabase.from("node_shift_templates").select("node_id, template_id"),
    supabase.from("nodes").select("id, name, parent_id, path").order("path"),
  ]);
  if (templatesRes.error) throw toSchedulerError(templatesRes.error);
  if (shiftsRes.error) throw toSchedulerError(shiftsRes.error);
  if (breaksRes.error) throw toSchedulerError(breaksRes.error);
  if (attachmentsRes.error) throw toSchedulerError(attachmentsRes.error);
  if (nodesRes.error) throw toSchedulerError(nodesRes.error);

  return {
    templates: (templatesRes.data ?? []).map(parseShiftTemplateRow),
    shifts: (shiftsRes.data ?? []).map(parseShiftRow),
    breaks: (breaksRes.data ?? []).map(parseShiftBreakRow),
    attachments: (attachmentsRes.data ?? []).map(parseNodeShiftTemplateRow),
    nodes: (nodesRes.data ?? []).map(parseShiftNodeRow),
  };
}

/* ===========================================================================
 * THE WRITES
 * =========================================================================== */

/**
 * The three lines every write below ends with, in one place: rows back from
 * `.select()`, `requireWritten` for the silently-filtered refusal, then the
 * same runtime guard the read uses.
 */
function writtenRow<T>(rows: unknown[] | null, parse: (v: unknown) => T | null, where: string): T {
  const written = requireWritten(rows);
  const parsed = parse(written[0]);
  if (parsed === null) throw shapeMismatch(where, "expected the row just written");
  return parsed;
}

/** Just the id, for the deletes — nothing else is worth reading back. */
function parseIdRow(v: unknown): { id: string } | null {
  if (!isRecord(v)) return null;
  return isStr(v.id) ? { id: v.id } : null;
}

export interface CreatePatternInput {
  /** `useSession().profile.orgId`. `not null`, NO default (D7). */
  orgId: string;
  /** Already trimmed — nothing trims it after this point. */
  name: string;
  /**
   * The ROOT node whose site owns this, or `null` for company-wide.
   *
   * ⚠️ `null` IS NOT "let the server decide". The INSERT policy is
   * `app_is_admin() or (site_node_id is not null and
   * app_is_admin_for(site_node_id))`, so a site admin passing `null` is
   * refused outright, and a company admin passing `null` creates a pattern
   * that only company admins can ever edit. It is a real choice; the panel
   * makes the caller make it.
   */
  siteNodeId: string;
}

/**
 * Raises: `{kind:"DuplicateValue"}` for `unique (org_id, name)` — which is
 * ORG-WIDE, not per-site, so two sites cannot both own a "Standard";
 * `{kind:"InvalidArgument", field:"site_node_id"}` when the owner is not a
 * root node (trigger `shift_templates_check_site`, 0023);
 * `{kind:"WriteRefused"}` when the policy refuses.
 */
export async function createPattern(input: CreatePatternInput): Promise<ShiftTemplateRow> {
  const { data, error } = await supabase
    .from("shift_templates")
    .insert({ org_id: input.orgId, name: input.name, site_node_id: input.siteNodeId })
    .select(SHIFT_TEMPLATE_COLUMNS);
  if (error) throw toSchedulerError(error);
  return writtenRow(data, parseShiftTemplateRow, "shift_templates.insert");
}

/**
 * ⭐ THE RENAME IS WHERE `requireWritten` EARNS ITS KEEP. `shift_templates`'
 * UPDATE policy names the owner predicate in `USING`, which FILTERS: a site
 * admin renaming a company-wide pattern gets `error === null` and zero rows.
 * Without the check below that arrives on screen as "saved".
 */
export async function renamePattern(
  templateId: string,
  name: string,
  /**
   * Where the pattern belongs. **Omit to leave it alone**; `null` moves it
   * company-wide. `null` is a real value in this column, so "not supplied"
   * cannot be spelled the same way as "make it company-wide". ⭐ 0028/D108
   * deleted the company-wide half; an ABSENT key still means "leave it alone".
   *
   * ⭐ IT TAKES A SCOPE BECAUSE THE CREATE FORM DOES. The maintainer had to ask three
   * times for the equivalent on products and operators, and the shape of the
   * mistake was the same every time: a picker on the create form and nothing
   * on the edit, so the value was frozen at birth. Adding it here before he
   * finds it is the cheap half of that lesson.
   */
  siteNodeId?: string,
): Promise<ShiftTemplateRow> {
  const patch: { name: string; site_node_id?: string } =
    siteNodeId === undefined ? { name } : { name, site_node_id: siteNodeId };

  const { data, error } = await supabase
    .from("shift_templates")
    .update(patch)
    .eq("id", templateId)
    .select(SHIFT_TEMPLATE_COLUMNS);
  if (error) throw toSchedulerError(error);
  return writtenRow(data, parseShiftTemplateRow, "shift_templates.update");
}

export interface SetPatternActiveInput {
  templateId: string;
  active: boolean;
}

/**
 * Retire a shift pattern, or bring a retired one back — `shift_templates.active`.
 *
 * ⭐⭐ THE MAIN ACTION, AND `deletePattern` BELOW IS THE SECONDARY ONE. The
 * maintainer's standing decision is that deactivating comes first wherever a
 * thing has an on/off flag; `shift_templates` gained one in migration 0029 and
 * nothing on any screen could reach it, so until now a pattern could only be
 * created and destroyed. Modelled on `setSkillActive` (operators.ts) rather
 * than invented: same one-column update, same read-back, same vocabulary on the
 * screen.
 *
 * ⚠️⚠️ WHAT IT DOES **NOT** DO IS THE HALF WORTH WRITING DOWN. Retiring is
 * ADVISORY (see `ShiftTemplateRow.active`): it does not detach the pattern from
 * anything, and every node already attached goes on resolving to it, because
 * `resolve_shift_template` does not read the flag. A place stops running a
 * retired pattern when somebody points that place somewhere else — `detachPattern`
 * or `attachPattern` — and not one moment sooner. The panel says so on the row.
 *
 * ⭐ SAME `USING`-CLAUSE FILTER AS THE RENAME, so it ends the same three lines.
 * `shift_templates`' UPDATE policy is `app_is_admin() or
 * app_is_admin_for(site_node_id)` in `USING`, which FILTERS rather than raises:
 * a site admin retiring another site's pattern gets `error === null` and zero
 * rows, and without `requireWritten` that arrives on screen as "retired".
 */
export async function setPatternActive(input: SetPatternActiveInput): Promise<ShiftTemplateRow> {
  const { data, error } = await supabase
    .from("shift_templates")
    .update({ active: input.active })
    .eq("id", input.templateId)
    .select(SHIFT_TEMPLATE_COLUMNS);
  if (error) throw toSchedulerError(error);
  return writtenRow(data, parseShiftTemplateRow, "shift_templates.setActive");
}

/**
 * ⚠️ THE SECONDARY REMOVAL SINCE `setPatternActive` LANDED. It used to be the
 * only one there was, and the comment here said so — *"`shift_templates` has
 * none, so there is nothing to deactivate and delete is the whole of it"* —
 * which stopped being true when migration 0029 added the column and stopped
 * being an excuse when the control above reached it. Retiring is reversible and
 * this is not; the panel offers both and puts Retire first.
 *
 * Its shifts and their breaks CASCADE (0005's `on delete cascade` on the
 * composite FK). Its ATTACHMENTS DO NOT: `node_shift_templates`' FK to
 * `shift_templates` carries no `ON DELETE` at all, so a pattern attached to
 * even one node cannot be deleted and Postgres raises 23503 →
 * `{kind:"StillInUse"}`. The panel says so by name and shows the count, which
 * it already has from its own read of `node_shift_templates` — detach first,
 * then delete.
 */
export async function deletePattern(templateId: string): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("shift_templates")
    .delete()
    .eq("id", templateId)
    .select("id");
  if (error) throw toSchedulerError(error);
  return writtenRow(data, parseIdRow, "shift_templates.delete");
}

export interface CreateShiftInput {
  orgId: string;
  templateId: string;
  name: string;
  /** `0 <= startMin < 1440` (CHECK). */
  startMin: number;
  /**
   * `endMin > startMin` and `endMin - startMin <= 1440` (CHECK).
   *
   * ⚠️ AN OVERNIGHT SHIFT HAS `endMin > 1440` AND IS NOT WRAPPED. 22:00–06:00
   * is `1320..1800`, exactly as the seed stores it — never `1320..360`, which
   * the CHECK refuses outright.
   */
  endMin: number;
}

/**
 * Raises `{kind:"ShiftOverlap"}` (23P01 naming
 * `shifts_no_overlap_within_template`) when this shift shares minutes with
 * another in the SAME pattern, `{kind:"InvalidValue"}` for the range CHECKs,
 * and `{kind:"WriteRefused"}` when `app_is_admin_for_shift_template` says no.
 * `describeSchedulerError` already has the sentence for the first.
 */
export async function createShift(input: CreateShiftInput): Promise<ShiftRow> {
  const { data, error } = await supabase
    .from("shifts")
    .insert({
      org_id: input.orgId,
      template_id: input.templateId,
      name: input.name,
      start_min: input.startMin,
      end_min: input.endMin,
    })
    .select("id, template_id, name, start_min, end_min");
  if (error) throw toSchedulerError(error);
  return writtenRow(data, parseShiftRow, "shifts.insert");
}

/**
 * A partial patch: only the fields present are written.
 *
 * `template_id` is deliberately NOT patchable. Moving a shift between patterns
 * is a different feature with a different overlap question, and nothing on
 * this screen offers it.
 */
export interface UpdateShiftInput {
  shiftId: string;
  name?: string;
  startMin?: number;
  endMin?: number;
}

export async function updateShift(input: UpdateShiftInput): Promise<ShiftRow> {
  const patch: { name?: string; start_min?: number; end_min?: number } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.startMin !== undefined) patch.start_min = input.startMin;
  if (input.endMin !== undefined) patch.end_min = input.endMin;

  const { data, error } = await supabase
    .from("shifts")
    .update(patch)
    .eq("id", input.shiftId)
    .select("id, template_id, name, start_min, end_min");
  if (error) throw toSchedulerError(error);
  return writtenRow(data, parseShiftRow, "shifts.update");
}

/** Its breaks cascade (0005). */
export async function deleteShift(shiftId: string): Promise<{ id: string }> {
  const { data, error } = await supabase.from("shifts").delete().eq("id", shiftId).select("id");
  if (error) throw toSchedulerError(error);
  return writtenRow(data, parseIdRow, "shifts.delete");
}

export interface CreateBreakInput {
  orgId: string;
  shiftId: string;
  /** `shift_breaks.name` defaults to `'Break'`; this always sends one. */
  name: string;
  startMin: number;
  endMin: number;
}

/**
 * ⚠️ THE ONLY THING THE DATABASE CHECKS HERE IS `end_min > start_min`.
 *
 * A break may overlap another break and may sit entirely outside its shift as
 * far as Postgres is concerned — 0005:55-56 records that "break lies inside
 * its shift stays application-validated". `breakProblems` in
 * `src/features/admin/lib/shiftDraft.ts` is that application. This wrapper
 * writes what it is given; it is not the place to re-decide.
 */
export async function createBreak(input: CreateBreakInput): Promise<ShiftBreakRow> {
  const { data, error } = await supabase
    .from("shift_breaks")
    .insert({
      org_id: input.orgId,
      shift_id: input.shiftId,
      name: input.name,
      start_min: input.startMin,
      end_min: input.endMin,
    })
    .select("id, shift_id, name, start_min, end_min");
  if (error) throw toSchedulerError(error);
  return writtenRow(data, parseShiftBreakRow, "shift_breaks.insert");
}

export interface UpdateBreakInput {
  breakId: string;
  name?: string;
  startMin?: number;
  endMin?: number;
}

export async function updateBreak(input: UpdateBreakInput): Promise<ShiftBreakRow> {
  const patch: { name?: string; start_min?: number; end_min?: number } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.startMin !== undefined) patch.start_min = input.startMin;
  if (input.endMin !== undefined) patch.end_min = input.endMin;

  const { data, error } = await supabase
    .from("shift_breaks")
    .update(patch)
    .eq("id", input.breakId)
    .select("id, shift_id, name, start_min, end_min");
  if (error) throw toSchedulerError(error);
  return writtenRow(data, parseShiftBreakRow, "shift_breaks.update");
}

export async function deleteBreak(breakId: string): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("shift_breaks")
    .delete()
    .eq("id", breakId)
    .select("id");
  if (error) throw toSchedulerError(error);
  return writtenRow(data, parseIdRow, "shift_breaks.delete");
}

export interface AttachPatternInput {
  orgId: string;
  nodeId: string;
  templateId: string;
}

/**
 * Point a node at a shift pattern.
 *
 * ⭐ AN UPSERT, BECAUSE `node_shift_templates`' PRIMARY KEY IS `node_id`
 * ALONE. One node runs exactly one pattern directly; attaching a second is
 * REPLACING the first, not adding to it. An insert would raise 23505 on every
 * change of mind, and "already uses that name or code" is a nonsense answer to
 * "use the late pattern here instead".
 *
 * ⚠️ THIS IS A DIFFERENT PERMISSION FROM EDITING THE PATTERN. The policy is
 * `app_is_admin_for(node_id)` and says nothing about who owns the template —
 * so a site's admin may attach the company-wide pattern to their own plant
 * without being able to change a minute of it. Conflating the two would hide a
 * feature the server permits, which is the forbidden direction.
 *
 * ⚠️ WHAT THIS DOES NOT DO: it does not decide which pattern a node RUNS. That
 * is `resolve_shift_template` (0005:72-81) — nearest ancestor along the ltree
 * path wins, unchanged by 0023 — so attaching here can be shadowed by a
 * descendant's own attachment, and detaching here can hand a node back to an
 * ancestor's pattern rather than to none.
 *
 * `onConflict: "node_id"` is named rather than inferred: the row's PK is
 * `node_id` and its uniqueness is the whole mechanic, so it is stated.
 */
export async function attachPattern(input: AttachPatternInput): Promise<NodeShiftTemplateRow> {
  const { data, error } = await supabase
    .from("node_shift_templates")
    .upsert(
      { org_id: input.orgId, node_id: input.nodeId, template_id: input.templateId },
      { onConflict: "node_id" },
    )
    .select("node_id, template_id");
  if (error) throw toSchedulerError(error);
  return writtenRow(data, parseNodeShiftTemplateRow, "node_shift_templates.upsert");
}

/**
 * Remove a node's own attachment. Keyed on `node_id` alone, which is the PK,
 * so there is nothing else to identify.
 *
 * A refusal is silent (DELETE `USING` filters) — hence `.select()` and
 * `requireWritten`. An empty result here means either "not yours to detach" or
 * "there was nothing attached"; both reach the panel as `WriteRefused`, and
 * the panel only offers the button when its own read says a row exists, which
 * leaves the permission reading as the truthful one.
 */
export async function detachPattern(nodeId: string): Promise<{ nodeId: string }> {
  const { data, error } = await supabase
    .from("node_shift_templates")
    .delete()
    .eq("node_id", nodeId)
    .select("node_id, template_id");
  if (error) throw toSchedulerError(error);
  const row = writtenRow(data, parseNodeShiftTemplateRow, "node_shift_templates.delete");
  return { nodeId: row.nodeId };
}
