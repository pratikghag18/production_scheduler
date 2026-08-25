import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
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
}

export interface UseSessionResult {
  session: Session | null;
  profile: SessionProfile | null;
  loading: boolean;
}

export function useSession(): UseSessionResult {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();
  // Last identity we saw. Every cached query was fetched AS that user and is
  // meaningless -- worse, misleading -- for anyone else, because RLS scopes
  // every result to the caller. Tracked in a ref so a re-render never resets it.
  const lastUserId = useRef<string | null>(null);

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
      const step = decideSessionUpdate(lastUserId.current, { kind, nextUserId });
      lastUserId.current = step.nextLastUserId;

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
      const {
        id,
        org_id: orgId,
        user_id: userId,
        role,
        default_create_mode: defaultCreateMode,
      } = data;
      setProfile({ id, orgId, userId, role, defaultCreateMode });
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
