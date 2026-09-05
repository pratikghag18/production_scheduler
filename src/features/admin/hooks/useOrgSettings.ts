/**
 * The settings seam: the company's answers, and one place's answers.
 *
 * `useDateFormat` is the client half of the calendar-date seam
 * (`src/lib/format/dates.ts`): it resolves the `date_format` token that
 * `formatCalendarDay` takes, defaulting through `coerceDateFormat` so a screen
 * renders correctly before the read lands and against a bag that has never had
 * the key set.
 *
 * ⚠️ `enabled` IS REQUIRED, never defaulted: `orgs_select` is RLS-scoped to the
 * caller's org, so firing before the session resolves can only be a 401. Callers
 * pass `canQueryAsUser(session?.user.id ?? null, sessionLoading)` (D91) — the
 * same contract `useShiftPatterns` keeps.
 *
 * ---------------------------------------------------------------------------
 * ⭐ EVERY READER TAKES AN OPTIONAL PLACE, AND OMITTING IT MEANS THE COMPANY'S
 * ANSWER (R-333). `useDateFormat(canQuery)` is what it always was and answers
 * `orgs.settings`; `useDateFormat(canQuery, plantNodeId)` answers that plant's
 * override, falling back to the company's. The argument is optional rather than
 * required because of what the callers ARE:
 *
 *   `BoardPage` shows ONE plant and can resolve that plant's value.
 *   `AuditPanel` — the Activity screen — lists changes from EVERY plant at
 *   once, and a per-plant date format has no single answer there. A screen that
 *   spans plants has no plant to ask, so it uses the COMPANY value and says
 *   nothing misleading by doing so.
 *
 * ⛔ SO THE DEFAULT MUST NOT MOVE. Making the plant argument required, or
 * defaulting it to "whatever plant is selected somewhere", would put a plant's
 * display convention on a screen showing three plants' rows.
 *
 * AUTHOR-ONLY — imports React Query and, through `@/lib/api`, the Supabase
 * client; not runnable under `node --experimental-strip-types`. The logic worth
 * testing (the token mapping, the defensive fallbacks, the write gate and the
 * scope rule) is pure and is exported: `src/lib/format/dates.ts` and the
 * bottom half of this file, driven by `src/test/plantSettings.test.ts`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  clearPlantSetting,
  fetchOrgSettings,
  fetchPlantSettings,
  setOrgDateFormat,
  setOrgEligibilityPolicy,
  setPlantSetting,
  type EligibilityPolicy,
  type Json,
  type NodeSettingKey,
  type PlantSettingRow,
  type SchedulerError,
} from "@/lib/api";
import {
  coerceDateFormat,
  DATE_FORMATS,
  DEFAULT_DATE_FORMAT,
  type DateFormat,
} from "@/lib/format/dates";
import { coveredByAnyGrant, isCompanyAdmin, type EditRights } from "../lib/editRights";
import { plantControlVisible, type PlantChoice, type PlantOption } from "../lib/plantFilter";

export const orgSettingsKeys = {
  all: ["org-settings"] as const,
};

/** The one read: the caller's `orgs.settings` bag. */
export function useOrgSettings(enabled: boolean) {
  return useQuery<Json, SchedulerError>({
    queryKey: orgSettingsKeys.all,
    queryFn: fetchOrgSettings,
    enabled,
  });
}

/**
 * The COMPANY's date-display format, resolved defensively. Returns the default
 * while the read is in flight or absent, and for any unrecognised stored value —
 * so a date is never shown raw because a setting was missing or malformed.
 *
 * Exported on its own because the Settings screen needs it even while it is
 * editing a plant: the plant's "use the company setting" option carries the
 * company's current answer in its own label.
 */
export function useCompanyDateFormat(enabled: boolean): DateFormat {
  const { data } = useOrgSettings(enabled);
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return coerceDateFormat((data as Record<string, Json | undefined>).date_format);
  }
  return DEFAULT_DATE_FORMAT;
}

/**
 * The date-display format in force — at `plantNodeId` when one is given, and for
 * the company when one is not. See the file header on why the argument is
 * optional and why the default must not move.
 *
 * ⚠️ THE HOOKS BELOW ARE CALLED UNCONDITIONALLY and the plant read is gated by
 * `enabled`, not by an `if`. React forbids a conditional hook, and the whole
 * point of the optional argument is that `useDateFormat(canQuery)` costs the
 * same one request it always did — the second query never fires.
 *
 * ⛔ ONLY CORRECT FOR A ROOT. `fetchPlantSettings`' header carries the argument:
 * "its own override, else the company's" is the server's rule reduced to a node
 * with no ancestors. A deeper node must be resolved on the server.
 */
export function useDateFormat(enabled: boolean, plantNodeId: string | null = null): DateFormat {
  const company = useCompanyDateFormat(enabled);
  const overrides = usePlantOverridesFor(enabled && plantNodeId !== null, "date_format");
  if (plantNodeId === null) return company;
  return asDateFormat(ownOverride(overrides.data, plantNodeId)) ?? company;
}

/**
 * Set the COMPANY-wide format. Refused server-side unless the caller is a system
 * admin; the Settings screen only offers it to one, but the RPC is the
 * authority. Invalidate-and-refetch, no optimistic update — the write's outcome
 * (a typed refusal) is not something the client should paint over.
 */
export function useSetDateFormat() {
  const queryClient = useQueryClient();
  return useMutation<void, SchedulerError, DateFormat>({
    mutationFn: (format) => setOrgDateFormat(format),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orgSettingsKeys.all });
    },
  });
}

/* ---------------------------------------------------------------------------
   THE ELIGIBILITY POLICY (R-014, writeable from migration 0049 onward).

   The same read and the same bag as the date format above — one PostgREST
   select, one RPC — so nothing new is fetched to answer it.

   ⚠️ THE DEFAULT IS `warn` AND IT IS THE PERMISSIVE ONE, which is the opposite
   of how a defensive fallback usually runs. It is nonetheless the right value:
   `warn` is what migration 0001 writes into every new org's bag, what every
   server function COALESCEs to when the key is absent, and what
   `readEligibilityPolicy` in `src/features/board/lib/boardIndex.ts` returns.
   Guessing `block` here would make the Settings screen disagree with the server
   about what the plant is currently doing — a screen showing the stricter rule
   while the server allows overrides is a worse lie than the permissive default,
   because it is the one a reader would not go and check.
   --------------------------------------------------------------------------- */

/** Every policy, in the order the settings screen offers them. */
export const ELIGIBILITY_POLICIES: readonly EligibilityPolicy[] = ["warn", "block"];

/** Absent or unrecognised setting resolves to this — migration 0001's default. */
export const DEFAULT_ELIGIBILITY_POLICY: EligibilityPolicy = "warn";

/** Pure, never throws; the peer of `coerceDateFormat`. Exported so it can be
 *  tested without a network. */
export function coerceEligibilityPolicy(value: unknown): EligibilityPolicy {
  return value === "warn" || value === "block" ? value : DEFAULT_ELIGIBILITY_POLICY;
}

/**
 * The COMPANY's eligibility policy, resolved defensively. Returns the default
 * while the read is in flight or absent, and for any unrecognised stored value.
 */
export function useCompanyEligibilityPolicy(enabled: boolean): EligibilityPolicy {
  const { data } = useOrgSettings(enabled);
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return coerceEligibilityPolicy((data as Record<string, Json | undefined>).eligibility_policy);
  }
  return DEFAULT_ELIGIBILITY_POLICY;
}

/**
 * The eligibility policy in force — at `plantNodeId` when one is given, and for
 * the company when one is not. The same shape as `useDateFormat` above.
 *
 * ⚠️ THIS IS A PREVIEW, NOT THE RULE. `check_eligibility`, `create_assignment`,
 * `move_run` and `apply_split_coverage` resolve the policy on the SERVER,
 * through `app_resolve_node_setting`, and a supervisor who cannot read the
 * plant root would get the wrong answer if the browser tried the walk itself
 * (73's P16/P17, measured). This renders what the server will do; it never
 * decides it.
 */
export function useEligibilityPolicy(
  enabled: boolean,
  plantNodeId: string | null = null,
): EligibilityPolicy {
  const company = useCompanyEligibilityPolicy(enabled);
  const overrides = usePlantOverridesFor(enabled && plantNodeId !== null, "eligibility_policy");
  if (plantNodeId === null) return company;
  return asEligibilityPolicy(ownOverride(overrides.data, plantNodeId)) ?? company;
}

/**
 * Set the COMPANY-wide eligibility policy. Refused server-side unless the caller
 * is a system admin; the Settings screen only offers it to one, but the RPC is
 * the authority. Invalidate-and-refetch, no optimistic update — a setting that
 * decides whether the plant can schedule an untrained person must never be
 * painted as changed before the server has said it is.
 */
export function useSetEligibilityPolicy() {
  const queryClient = useQueryClient();
  return useMutation<void, SchedulerError, EligibilityPolicy>({
    mutationFn: (policy) => setOrgEligibilityPolicy(policy),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orgSettingsKeys.all });
    },
  });
}

/* ===========================================================================
 * PER-PLANT SETTINGS — R-331 (migration 0050), R-333 (migration 0052).
 *
 * The maintainer, session 62: *"There is a filter at the top for selecting
 * plants. Once we select the plant at the top we should be able to assign the
 * settings to that particular plant, and it should be all types of settings on
 * the settings tab, not just this one."*
 *
 * ⛔⛔ THREE STATES, NOT TWO, AND EVERYTHING IN THIS SECTION EXISTS TO KEEP
 * THE FIRST ONE ALIVE. A plant is INHERITING (no `node_settings` row), or SET
 * to one of the values. "Inheriting, currently refuse" and "set to refuse" are
 * different states — the second survives the company changing its mind and the
 * first does not — and migration 0050 spent a whole TABLE rather than a second
 * jsonb bag precisely because `settings->>'k'` cannot tell an absent key from a
 * key holding a JSON null (F-088, measured). `null` is the absence and it is
 * load-bearing all the way to the screen.
 *
 * ⚠️ SO THE WRITE IS TWO VERBS AND NEVER ONE WITH A NULL. `INHERIT_CHOICE` is a
 * token this client understands and the server never sees: `useSetPlantSetting`
 * turns it into `clear_node_setting`, and every other value into
 * `set_node_setting`. A binding that sent a null would silently return a strict
 * plant to the company's permissive default — the one direction nobody goes and
 * checks.
 * ======================================================================== */

/** The option value that means "no row — follow the company". Never sent. */
export const INHERIT_CHOICE = "inherit";

/** What a reader can choose for one plant: a stored value, or back to inheriting. */
export type PlantSettingChoice = string;

export const plantSettingsKeys = {
  all: ["plant-settings"] as const,
  /** ⚠️ PREFIXED BY `all`, so one mutation's invalidate reaches every key. */
  forKey: (key: NodeSettingKey) => ["plant-settings", key] as const,
};

/**
 * Every plant's own answer for ONE setting.
 *
 * ⭐ THE COMPANY'S VALUE IS NOT IN THE QUERY KEY, AND THAT IS THE POINT. The
 * eligibility-only version fetched `effective` — the resolved value — which
 * meant the company's answer had to be in the cache key or a stale list would
 * keep showing the OLD company value against every inheriting plant after the
 * company setting moved. This returns overrides only and lets the caller
 * resolve, so there is nothing cached that can disagree with the company row
 * rendered beside it.
 */
function usePlantOverridesFor(enabled: boolean, key: NodeSettingKey) {
  return useQuery<PlantSettingRow[], SchedulerError>({
    queryKey: plantSettingsKeys.forKey(key),
    queryFn: () => fetchPlantSettings(key),
    enabled,
  });
}

/** One plant's raw stored answer out of the list, or `null` for "no row". */
function ownOverride(rows: PlantSettingRow[] | undefined, nodeId: string): string | null {
  return rows?.find((r) => r.nodeId === nodeId)?.override ?? null;
}

/* ---------------------------------------------------------------------------
   THE NULL-RETURNING TWINS OF THE `coerce*` FUNCTIONS.

   ⛔ `coerceDateFormat` AND `coerceEligibilityPolicy` ARE THE WRONG TOOL HERE
   AND USING THEM WOULD BE A SILENT BUG. They turn anything unrecognised into
   the DEFAULT, which is exactly right for a company bag that has never had the
   key set — a date must render somehow. Here, "unrecognised" and "absent" must
   both come back as `null`, because `null` is the third state: a plant with a
   junk row read as "set to the default" would show as OVERRIDING when it is
   not, and would keep that appearance the day the company changed its mind.
   --------------------------------------------------------------------------- */

/** A stored date-format token, or `null` for absent or unrecognised. */
export function asDateFormat(value: unknown): DateFormat | null {
  return typeof value === "string" && (DATE_FORMATS as readonly string[]).includes(value)
    ? (value as DateFormat)
    : null;
}

/** A stored eligibility token, or `null` for absent or unrecognised. */
export function asEligibilityPolicy(value: unknown): EligibilityPolicy | null {
  return value === "warn" || value === "block" ? value : null;
}

/** What one plant has said for itself. `null` on a field means "inheriting". */
export interface PlantOverrides {
  dateFormat: DateFormat | null;
  policy: EligibilityPolicy | null;
  isLoading: boolean;
  error: SchedulerError | null;
}

/**
 * Both settings' own answers at ONE plant, for the Settings screen.
 *
 * ⚠️ ONE QUERY PER KEY, NOT ONE PER PLANT. The reads are keyed by SETTING and
 * return every plant, so the two hooks here are the same two cache entries
 * `useDateFormat(enabled, plantId)` uses on the board — switching the plant
 * filter re-renders from cache rather than refetching.
 */
export function usePlantOverrides(enabled: boolean, nodeId: string | null): PlantOverrides {
  const on = enabled && nodeId !== null;
  const format = usePlantOverridesFor(on, "date_format");
  const policy = usePlantOverridesFor(on, "eligibility_policy");
  return {
    dateFormat: nodeId === null ? null : asDateFormat(ownOverride(format.data, nodeId)),
    policy: nodeId === null ? null : asEligibilityPolicy(ownOverride(policy.data, nodeId)),
    isLoading: on && (format.isLoading || policy.isLoading),
    error: format.error ?? policy.error ?? null,
  };
}

/**
 * Set or clear ONE place's answer for ONE setting.
 *
 * ⭐ ONE MUTATION FOR EVERY ROW, and the screen tells them apart by
 * `variables.key` — React Query hands the in-flight variables back. One
 * mutation per row would mean a hook inside a loop, which React forbids; a
 * single `isPending` painted across both settings would say the date format was
 * saving when the eligibility rule was.
 *
 * ⛔ `INHERIT_CHOICE` IS DISPATCHED TO `clear_node_setting`, THE SEPARATE VERB.
 * There is no "set to null to clear" on the server and there must not be one
 * here: the whole of migration 0050 is about a row existing or not.
 *
 * Invalidate-and-refetch, no optimistic update — the same reasoning as the
 * company-wide writers above, and it matters more per plant: a setting that
 * decides whether an untrained person can be scheduled AT THIS SITE must never
 * be painted as changed before the server has said it is.
 */
export function useSetPlantSetting() {
  const queryClient = useQueryClient();
  return useMutation<
    void,
    SchedulerError,
    { nodeId: string; key: NodeSettingKey; choice: PlantSettingChoice }
  >({
    mutationFn: ({ nodeId, key, choice }) =>
      choice === INHERIT_CHOICE
        ? clearPlantSetting(nodeId, key)
        : setPlantSetting(nodeId, key, choice),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: plantSettingsKeys.all });
    },
  });
}

/* ---------------------------------------------------------------------------
   ⛔⛔ THE WRITE GATE IS **NOT** `canEditNode`, AND CONFUSING THE TWO IS THE
   ONE MISTAKE THIS FILE IS MOST LIKELY TO INVITE.

   `node_settings`' three write policies (0050 §2) are, each of them,

       org_id = app_current_org() and (app_is_admin() or app_is_admin_for(node_id))

   and `app_is_admin_for(n)` is `app_is_admin() or app_is_admin_on_path(n.path)`.
   That is arms (1) and (2) of `app_can_edit_node` — and NOT arm (3).
   `canEditNode` in `../lib/editRights.ts` mirrors all three, because the rows it
   was written for (trainings, operators) are governed by `app_can_edit_node`,
   which does carry arm (3): `app_can_write() AND covered by a WRITABLE grant`.
   An org-wide supervisor holding a SUPERVISOR grant on a plant satisfies that
   arm and is refused by `node_settings_update`. Reusing `canEditNode` here would
   put a live picker in front of exactly that person and the server would refuse
   every move of it — `CLAUDE.md` §4's "a screen that shows what the server will
   refuse is worse than one that refuses what the server allows".

   ⭐ SO IT IS COMPOSED FROM THE ARMS RATHER THAN RE-DERIVED. `isCompanyAdmin`
   and `coveredByAnyGrant` are the same two functions `canEditNode` calls, and
   `coveredByAnyGrant` is `isAtOrBelow` underneath — the ltree `<@` the server
   compares, label by label, so `plant_1` is not an ancestor of `plant_10`. This
   file does not contain a second implementation of ancestry.

   ⭐ AND IT FAILS **OPEN**, which is `editRights.ts`'s standing rule and applies
   verbatim: hiding is invisible and permanent, refusing is loud and
   recoverable. An unlanded grant read, or a plant whose path this client cannot
   resolve, answers "offer it" and lets the server do the saying-no.
   --------------------------------------------------------------------------- */

/**
 * May this reader set the rule at the plant whose ltree path is `path`?
 * Mirrors `app_is_admin() or app_is_admin_for(node)`.
 *
 * @param path the PLANT's own ltree path, or `null` when the client cannot
 *             resolve it — which means "I cannot tell", never "no".
 */
export function canAdministerPlant(path: string | null, rights: EditRights): boolean {
  if (!rights.known) return true; // not asked, or the ask failed
  if (path === null) return true; // owner unresolvable -> cannot tell -> offer it
  if (isCompanyAdmin(rights.role)) return true; // app_is_admin()
  return coveredByAnyGrant(path, rights.adminPaths); // app_is_admin_on_path(n.path)
}

/* ===========================================================================
 * WHICH SCOPE THE SETTINGS TAB IS EDITING — R-333.
 *
 * ⭐⭐ THE TAB DOES NOT ASK ITS OWN QUESTION. `AdminPage` has carried a plant
 * control since §19.77 and every other admin panel reads it through
 * `usePlantFilter`; Settings grew a second answer instead — a column of
 * per-plant rows, one per plant, beneath the company's. The maintainer's
 * sentence is that the control at the top is the answer: choose a plant and the
 * tab edits THAT plant; choose All plants and it edits the company defaults.
 * ======================================================================== */

/** What the Settings tab is editing right now. */
export type SettingsScope =
  { kind: "company" } | { kind: "plant"; nodeId: string; name: string; path: string };

/**
 * The scope the tab edits, from the plant control's answer.
 *
 * ⚠️⚠️ THE HARD CASE IS "THE CONTROL IS NOT VISIBLE", and it has to be decided
 * rather than fallen into. `plantControlVisible` is false below two readable
 * roots (`plantFilter.ts` decision 2: a control that cannot change anything is
 * a control named after less than it does), and `resolvePlantChoice` then
 * collapses the stored choice to `null`. Following that mechanically would make
 * the tab always edit the company defaults for such a reader — which is right
 * for one of them and wrong for the other:
 *
 *   A COMPANY ADMIN OF A ONE-PLANT ORG must edit the COMPANY's values, and
 *   `canWriteCompany` is how this function is told so. Sending them to the
 *   plant instead would look identical on the board — every node is under that
 *   one root — and would leave `orgs.settings` untouched, so the ACTIVITY
 *   screen, which spans plants and therefore reads the company value, would go
 *   on showing the old date format. A setting that applies everywhere except
 *   one screen is worse than one that applies nowhere.
 *
 *   A SITE ADMIN GRANTED ONE PLANT cannot write `orgs.settings` at all —
 *   `set_org_date_format` and `set_org_eligibility_policy` are both
 *   `app_is_admin()`. Handing them the company scope hands them two disabled
 *   controls and nothing to do, and R-331's whole point was that this person
 *   can set their own plant's rule. So they get their plant.
 *
 * ⭐ THE TEST IS THE WRITE GATE, NOT THE ROLE AS SUCH. `canWriteCompany` is the
 * same predicate the company rows are disabled by, which is the same predicate
 * `app_is_admin()` names on the server — CLAUDE.md §4's rule that what a client
 * offers is decided by the test the server runs. It is deliberately NOT the
 * "never the role" rule `plantFilter.ts` states, which is about whether the
 * CONTROL is shown; this is about which of two scopes a reader can actually
 * change.
 */
export function settingsScope(
  choice: PlantChoice,
  plants: readonly PlantOption[],
  canWriteCompany: boolean,
): SettingsScope {
  const asPlant = (p: PlantOption): SettingsScope => ({
    kind: "plant",
    nodeId: p.id,
    name: p.name,
    path: p.path,
  });

  if (choice !== null) {
    const chosen = plants.find((p) => p.id === choice);
    // A choice naming a plant this reader can no longer see is already
    // collapsed to `null` by `resolvePlantChoice`; widening here too rather
    // than throwing keeps the tab on the safe, visible scope if it ever is not.
    return chosen === undefined ? { kind: "company" } : asPlant(chosen);
  }

  // "All plants" is a real answer when there was something to choose.
  if (plantControlVisible(plants)) return { kind: "company" };

  // No control. See the block above for why this is not simply "company".
  if (canWriteCompany) return { kind: "company" };
  return plants.length === 1 ? asPlant(plants[0]) : { kind: "company" };
}
