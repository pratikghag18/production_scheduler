import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

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
     * Drop every cached query when the signed-in identity changes.
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
     *
     * Guarded on the id actually changing, because onAuthStateChange also
     * fires on token refresh, and clearing the board on a routine refresh
     * would blank the screen every hour for no reason.
     */
    function clearCacheOnIdentityChange(nextSession: Session | null) {
      const nextUserId = nextSession?.user.id ?? null;
      if (lastUserId.current !== nextUserId) {
        lastUserId.current = nextUserId;
        void queryClient.resetQueries();
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

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      clearCacheOnIdentityChange(data.session);
      setSession(data.session);
      void loadProfile(data.session).finally(() => {
        if (!cancelled) setLoading(false);
      });
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (cancelled) return;
      clearCacheOnIdentityChange(nextSession);
      setSession(nextSession);
      setLoading(true);
      void loadProfile(nextSession).finally(() => {
        if (!cancelled) setLoading(false);
      });
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, [queryClient]);

  return { session, profile, loading };
}
