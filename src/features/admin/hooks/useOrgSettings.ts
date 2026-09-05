/**
 * React Query over the org settings bag — one read, one mutation.
 *
 * `useDateFormat` is the client half of the calendar-date seam
 * (`src/lib/format/dates.ts`): it resolves the org-wide `date_format` token that
 * `formatCalendarDay` takes, defaulting through `coerceDateFormat` so a screen
 * renders correctly before the read lands and against a bag that has never had
 * the key set.
 *
 * ⚠️ `enabled` IS REQUIRED, never defaulted: `orgs_select` is RLS-scoped to the
 * caller's org, so firing before the session resolves can only be a 401. Callers
 * pass `canQueryAsUser(session?.user.id ?? null, sessionLoading)` (D91) — the
 * same contract `useShiftPatterns` keeps.
 *
 * AUTHOR-ONLY — imports React Query and, through `@/lib/api`, the Supabase
 * client; not runnable under `node --experimental-strip-types`. The logic worth
 * testing (the token mapping and the defensive fallback) is in
 * `src/lib/format/dates.ts`.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  clearPlantEligibilityPolicy,
  fetchHierarchyTree,
  fetchOrgSettings,
  fetchPlantEligibilityPolicies,
  setOrgDateFormat,
  setOrgEligibilityPolicy,
  setPlantEligibilityPolicy,
  type EligibilityPolicy,
  type Json,
  type PlantEligibilityPolicy,
  type SchedulerError,
} from "@/lib/api";
import { coerceDateFormat, DEFAULT_DATE_FORMAT, type DateFormat } from "@/lib/format/dates";
import { coveredByAnyGrant, isCompanyAdmin, type EditRights } from "../lib/editRights";
import { hierarchyKeys } from "./useHierarchyMutations";
import { useEditRights } from "./useEditRights";

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
 * The org-wide date-display format, resolved defensively. Returns the default
 * while the read is in flight or absent, and for any unrecognised stored value —
 * so a date is never shown raw because a setting was missing or malformed.
 */
export function useDateFormat(enabled: boolean): DateFormat {
  const { data } = useOrgSettings(enabled);
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return coerceDateFormat((data as Record<string, Json | undefined>).date_format);
  }
  return DEFAULT_DATE_FORMAT;
}

/**
 * Set the org-wide format. Refused server-side unless the caller is a system
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
 * The org-wide eligibility policy, resolved defensively. Returns the default
 * while the read is in flight or absent, and for any unrecognised stored value.
 */
export function useEligibilityPolicy(enabled: boolean): EligibilityPolicy {
  const { data } = useOrgSettings(enabled);
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return coerceEligibilityPolicy((data as Record<string, Json | undefined>).eligibility_policy);
  }
  return DEFAULT_ELIGIBILITY_POLICY;
}

/**
 * Set the org-wide eligibility policy. Refused server-side unless the caller is
 * a system admin; the Settings screen only offers it to one, but the RPC is the
 * authority. Invalidate-and-refetch, no optimistic update — a setting that
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
 * PER-PLANT SETTINGS — R-331, migration 0050.
 *
 * The maintainer, session 62: *"These settings I think cannot be applied plant
 * wise which defeats the purpose of both options. Lets make it possible to
 * assign settings individually for each plant."*
 *
 * ⛔⛔ THREE STATES, NOT TWO, AND EVERYTHING IN THIS SECTION EXISTS TO KEEP
 * THE FIRST ONE ALIVE. A plant is INHERITING (no `node_settings` row), SET TO
 * ALLOW, or SET TO REFUSE. "Inheriting, currently refuse" and "set to refuse"
 * are different states — the second survives the company changing its mind and
 * the first does not — and migration 0050 spent a whole TABLE rather than a
 * second jsonb bag precisely because `settings->>'k'` cannot tell an absent key
 * from a key holding a JSON null (F-088, measured). `override: null` is the
 * absence and it is load-bearing all the way to the screen.
 *
 * ⚠️ SO THE WRITE IS TWO VERBS AND NEVER ONE WITH A NULL. `PlantPolicyChoice`
 * carries `"inherit"` as a token this client understands and the server never
 * sees: `useSetPlantPolicy` turns it into `clear_node_setting`, and every other
 * value into `set_node_setting`. A binding that sent a null would silently
 * return a strict plant to the company's permissive default — the one direction
 * nobody goes and checks.
 * ======================================================================== */

/** What a reader can choose for one plant. `"inherit"` never reaches the server. */
export type PlantPolicyChoice = EligibilityPolicy | "inherit";

/** The option value that means "no row — follow the company". */
export const INHERIT_CHOICE = "inherit";

/** One plant, as the Settings screen renders it. */
export interface PlantPolicyRow extends PlantEligibilityPolicy {
  /**
   * May this reader change THIS plant's answer? A PREVIEW of the server's
   * decision, never a permission — `canAdministerPlant` below carries the
   * argument for what it mirrors and why it fails open.
   */
  editable: boolean;
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

/**
 * Join the plants the server described to the paths this client can see, and
 * decide which of them to offer a control for.
 *
 * Pure and exported so `src/test/plantSettings.test.ts` can drive it without a
 * network — the same split `editRights.ts`/`useEditRights.ts` keeps.
 *
 * ⚠️ THE ORDER AND THE MEMBERSHIP OF `plants` ARE PASSED THROUGH UNTOUCHED.
 * The list is already the roots the reader may READ, ordered by name, decided by
 * `nodes_select` and by `fetchPlantEligibilityPolicies`. Dropping a plant here
 * because it is read-only would be silent hiding; the screen lists it and says
 * why instead.
 */
export function buildPlantPolicyRows(
  plants: readonly PlantEligibilityPolicy[],
  pathByNodeId: ReadonlyMap<string, string>,
  rights: EditRights,
): PlantPolicyRow[] {
  return plants.map((p) => ({
    ...p,
    editable: canAdministerPlant(pathByNodeId.get(p.nodeId) ?? null, rights),
  }));
}

export const plantSettingsKeys = {
  all: ["plant-settings"] as const,
};

/** What `usePlantPolicies` hands the screen. */
export interface PlantPolicies {
  rows: PlantPolicyRow[];
  isLoading: boolean;
  isError: boolean;
  error: SchedulerError | null;
}

/**
 * Every plant this reader can see, with its own answer, the answer in force
 * there, and whether they may change it.
 *
 * ⚠️ `orgPolicy` IS IN THE QUERY KEY, not merely in the closure. It is what
 * `fetchPlantEligibilityPolicies` resolves an INHERITING plant's `effective`
 * from, so a cached list keyed without it would keep showing the old company
 * answer against every inheriting plant after the company setting moved —
 * a screen quietly disagreeing with the server about what a plant is doing.
 *
 * ⚠️ THE PATHS COME FROM THE ADMIN TREE READ, under the SAME key `AdminPage`,
 * `ProductsPanel` and `CycleTimesPanel` use, so this costs one shared request
 * and one cache entry rather than a fourth round trip. They are needed because
 * `fetchPlantEligibilityPolicies` deliberately does not select `nodes.path` —
 * it is an ltree, typed `unknown`, and a list of plants that wanted a name and
 * an id should not buy a runtime guard for a column it does not render. The
 * PERMISSION does need it, and a plant missing from the tree read resolves to
 * `null`, which fails open.
 */
export function usePlantPolicies(
  enabled: boolean,
  orgPolicy: EligibilityPolicy,
  role: string | null,
): PlantPolicies {
  const plants = useQuery<PlantEligibilityPolicy[], SchedulerError>({
    queryKey: [...plantSettingsKeys.all, orgPolicy],
    queryFn: () => fetchPlantEligibilityPolicies(orgPolicy),
    enabled,
  });
  const tree = useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
    enabled,
  });
  const { rights } = useEditRights(enabled, role);

  const pathByNodeId = useMemo(
    () => new Map((tree.data?.nodes ?? []).map((n) => [n.id, n.path])),
    [tree.data],
  );

  const rows = useMemo(
    () => buildPlantPolicyRows(plants.data ?? [], pathByNodeId, rights),
    [plants.data, pathByNodeId, rights],
  );

  return {
    // ⚠️ ONLY THE PLANT LIST DECIDES "loading" AND "error". The tree read and
    // the grant read are the permission PREVIEW: both fail open on their own
    // terms, so letting either blank this card would trade a loud refusal for
    // an empty screen — the trade `editRights.ts` argues against.
    rows,
    isLoading: plants.isLoading,
    isError: plants.isError,
    error: plants.error ?? null,
  };
}

/**
 * Set or clear ONE plant's eligibility policy.
 *
 * ⭐ ONE MUTATION FOR EVERY ROW, and the screen tells them apart by
 * `variables.nodeId` — React Query hands the in-flight variables back. One
 * mutation per row would mean a hook inside a loop, which React forbids; a
 * single `isPending` painted across every plant would say three plants were
 * saving when one was.
 *
 * ⛔ `"inherit"` IS DISPATCHED TO `clear_node_setting`, THE SEPARATE VERB. There
 * is no "set to null to clear" on the server and there must not be one here:
 * the whole of migration 0050 is about a row existing or not.
 *
 * Invalidate-and-refetch, no optimistic update — the same reasoning as the
 * org-wide writer above, and it matters more per plant: a setting that decides
 * whether an untrained person can be scheduled AT THIS SITE must never be
 * painted as changed before the server has said it is.
 */
export function useSetPlantPolicy() {
  const queryClient = useQueryClient();
  return useMutation<void, SchedulerError, { nodeId: string; choice: PlantPolicyChoice }>({
    mutationFn: ({ nodeId, choice }) =>
      choice === INHERIT_CHOICE
        ? clearPlantEligibilityPolicy(nodeId)
        : setPlantEligibilityPolicy(nodeId, choice),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: plantSettingsKeys.all });
    },
  });
}
