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
import { fetchOrgSettings, setOrgDateFormat, type Json, type SchedulerError } from "@/lib/api";
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
