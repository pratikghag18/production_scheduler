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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchOrgSettings,
  setOrgDateFormat,
  setOrgEligibilityPolicy,
  type EligibilityPolicy,
  type Json,
  type SchedulerError,
} from "@/lib/api";
import { coerceDateFormat, DEFAULT_DATE_FORMAT, type DateFormat } from "@/lib/format/dates";

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
