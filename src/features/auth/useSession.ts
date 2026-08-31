import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { fetchAdminAnywhere } from "@/lib/api";
import { decideSessionUpdate } from "./session";
import type { AuthEventKind } from "./session";

/**
 * The caller's `user_profiles` row (brief P1-3b §7), readable under RLS by
 * its own policy. Fetched directly here (not through src/lib/api/) since
 * auth/session is outside that layer's RPC-focused scope by the brief's
 * own file layout (§3 lists `useSession.ts` under src/features/auth/, not
 * src/lib/api/) — the one plain-table read below renames every column to
 * camelCase at the point of use (the destructure on the line after the
 * query) so no snake_case identifier is used anywhere past that line.
 */
export interface SessionProfile {
  id: string;
  orgId: string;
  userId: string;
  role: string;
  defaultCreateMode: string;
  /**
   * `app_is_admin_anywhere()` (migration 0019), carried on the profile rather
   * than fetched separately so that ONE `loading` covers both. A second
   * `useQuery` would add a second unresolved window for `adminAccess` to fold
   * into `pending`, and D91 is the standing reminder that `enabled: false`
   * leaves `isLoading` FALSE -- that fold is easy to get silently wrong.
   *
   * ⚠️ VISIBILITY ONLY. It decides whether the admin screen is worth showing.
   * It authorises nothing; every write re-asks the real question about the
   * specific node or structure. See `src/lib/api/access.ts`.
   */
  adminAnywhere: boolean;
}

export interface UseSessionResult {
  session: Session | null;
  profile: SessionProfile | null;
  loading: boolean;
}

/**
 * ⭐⭐ WHO IS SIGNED IN, HELD ONCE FOR THE WHOLE APP RATHER THAN PER HOOK
 * INSTANCE — AND THIS IS A FIX, NOT A TIDY-UP.
 *
 * It was a `useRef` inside the hook, initialised to `null`. `useSession` is
 * called in five components (`AppShell`, `AdminPage`, `BoardPage`,
 * `RequireAdmin`, `DevProfileSwitcher`) and now a sixth on every admin panel,
 * so **each one started life believing nobody was signed in**. Its first
 * `applyStep` then compared `null` against the real user id, concluded the
 * identity had changed, and fired `queryClient.resetQueries()` — emptying the
 * cache for everybody.
 *
 * ⚠⚠ THE VISIBLE SYMPTOM WAS ON THE ADMIN SCREEN AND IT TOOK A MEASUREMENT TO
 * FIND. Switching tabs mounts a panel, which mounts a `useSession`, which reset
 * the cache; `AdminPage`'s hierarchy read went briefly `undefined`, so
 * `readablePlants` saw no roots, so the plant filter row unmounted and came
 * back. Driven in a real browser and sampled per animation frame: the row's
 * height went **42 → 0 → 42 across one or two frames on every tab switch**, and
 * everything under it jumped up and back down.
 *
 * ⭐ IT ONLY SHOWED FOR SOMEBODY WITH MORE THAN ONE PLANT, which is why it read
 * as a quirk of the filter: a reader with one readable root has no row at all
 * (§19.79's decision 2), so there was nothing to flicker. The cache was being
 * thrown away for them too — silently, and paid for in refetches.
 *
 * ⚠️ THE RESET ITSELF IS RIGHT AND STAYS. Query keys deliberately carry no user
 * id, so a real identity change must drop the previous person's rows. What was
 * wrong was WHO gets to declare an identity change: mounting a component is not
 * one. At module scope the answer is shared, so a genuine sign-in still resets
 * exactly once — the first instance to see it moves the value, and the rest
 * compare equal and do nothing. That also settles the "resets fire five times"
 * half of P1-6b's recorded debt.
 *
 * ⚠️ Module scope is deliberate and NOT a step away from the `SessionProvider`
 * that debt asks for. It is the same value that provider would own, parked
 * where every instance can already see it; the provider is still worth doing
 * for the five duplicated `getSession()` round trips, which this does not
 * touch. `__resetSessionIdentityForTests` exists so a suite can put it back.
 */
let lastUserId: string | null = null;

/** Test-only: module state outlives a test file, and a stale identity would
 *  make the next suite's first mount skip a reset it genuinely needs. */
export function __resetSessionIdentityForTests(): void {
  lastUserId = null;
}

export function useSession(): UseSessionResult {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();
  // Last identity we saw. Every cached query was fetched AS that user and is
  // meaningless -- worse, misleading -- for anyone else, because RLS scopes
  // every result to the caller. Tracked in a ref so a re-render never resets it.
  // ⚠️ `lastUserId` USED TO LIVE HERE AS A `useRef`. See `lastUserId` at module
  // scope above — the identity is a fact about the APP, and a per-instance copy
  // made every newly mounted component believe the user had just signed in.

  useEffect(() => {
    let cancelled = false;

    /**
     * Design plan §19.8 / brief P1-5c §4.2/§7.4: the decision of what to do
     * about a session update -- reset the cache, spin the loading state,
     * reload the profile -- is now made in ONE place,
     * `decideSessionUpdate` (src/features/auth/session.ts), a pure function
     * this hook only calls and applies. It used to be three independent
     * statements at two call sites, one of which (`setLoading(true)`) was
     * written unconditionally while its neighbour (`resetQueries()`) was
     * correctly guarded on the identity actually changing -- so the cache
     * survived a token refresh while the whole board still flashed through
     * the `sessionLoading` branch. Deriving all three flags from a single
     * `identityChanged` computation, once, is what stops the two from
     * drifting apart again: there is one answer now, not two call sites
     * that each have to remember to ask the same question.
     *
     * Query keys deliberately do NOT carry the user id: adding one would give
     * each identity its own cache entry, but the previous user's rows would
     * still be sitting in memory. Resetting is the stronger guarantee -- the
     * data is dropped AND every mounted query refetches as the new user.
     *
     * resetQueries, not clear(): clear() empties the cache but leaves mounted
     * observers pending with nothing to fetch them again, so the board sticks
     * on "Loading..." until a manual refresh. resetQueries returns queries to
     * their initial state and re-runs the active ones.
     */
    function applyStep(nextSession: Session | null, kind: AuthEventKind) {
      const nextUserId = nextSession?.user.id ?? null;
      const step = decideSessionUpdate(lastUserId, { kind, nextUserId });
      lastUserId = step.nextLastUserId;

      if (step.decision.resetCache) void queryClient.resetQueries();
      if (step.decision.setLoading) setLoading(true);
      if (step.decision.reloadProfile) {
        void loadProfile(nextSession).finally(() => {
          if (!cancelled) setLoading(false);
        });
      }
    }

    async function loadProfile(nextSession: Session | null) {
      if (!nextSession) {
        if (!cancelled) setProfile(null);
        return;
      }
      const { data, error } = await supabase
        .from("user_profiles")
        .select("id, org_id, user_id, role, default_create_mode")
        .eq("user_id", nextSession.user.id)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setProfile(null);
        return;
      }
      // Sequential, not concurrent, and on purpose: the RPC is only ever
      // consulted for someone who HAS a profile, and the early return above
      // means a failed profile read never fires it at all. One round trip is
      // the cost of the admin nav link resolving in the same tick as the rest
      // of the session, which is what keeps `adminAccess` a two-state
      // question instead of a three-state one.
      const adminAnywhere = await fetchAdminAnywhere();
      if (cancelled) return;
      const {
        id,
        org_id: orgId,
        user_id: userId,
        role,
        default_create_mode: defaultCreateMode,
      } = data;
      setProfile({ id, orgId, userId, role, defaultCreateMode, adminAnywhere });
    }

    // First mount must always load: `decideSessionUpdate`'s "initial" kind
    // always resolves `setLoading`/`reloadProfile` to true regardless of
    // identity (even signed-out, since `loading` starts true and something
    // must clear it) -- this path's behaviour is unchanged from before the
    // refactor.
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      applyStep(data.session, "initial");
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (cancelled) return;

      // The token itself may have changed even when the user did not, so the
      // session object is always replaced.
      setSession(nextSession);

      // A TOKEN_REFRESH (supabase-js fires one roughly hourly) is the same
      // person with the same profile: `decideSessionUpdate`'s "change" kind
      // resolves all three flags to `identityChanged`, so a same-identity
      // event resets nothing, spins no loading state, and re-fetches
      // nothing -- `applyStep` becomes a no-op past updating `lastUserId`
      // (to the same value) below.
      applyStep(nextSession, "change");
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, [queryClient]);

  return { session, profile, loading };
}
