import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { fetchAdminAnywhere } from "@/lib/api";
import { SessionContext, advanceSessionIdentity } from "./useSession";
import type { SessionProfile } from "./useSession";
import { RECOVERY_STORAGE_KEY, initialRecoveryFlag, nextRecoveryFlag } from "./session";
import type { AuthEventKind } from "./session";

/**
 * ⭐⭐ ONE SESSION FOR THE WHOLE APP (R-349).
 *
 * Mounted ONCE in `App.tsx`, inside `QueryClientProvider` (it needs
 * `useQueryClient` for the identity-change reset) and outside `RouterProvider`.
 * It owns everything the old `useSession` `useEffect` did — `getSession()` then
 * `applyStep(…, "initial")`, the `onAuthStateChange` listener with
 * `applyStep(…, "change")`, `decideSessionUpdate` (via `advanceSessionIdentity`)
 * as the single decision, `resetQueries()` on an identity change, and the
 * sequential profile-then-`adminAnywhere` read — unchanged in behaviour. The
 * code moved; the decisions did not.
 *
 * Before this provider each `useSession()` call site ran the whole effect for
 * itself, so ~thirty instances each made their own round trips and each held
 * their own `loading` and `profile`. Two could disagree about who you are for
 * as long as one round trip takes (F-094 / R-337). Now there is one round trip
 * per fact and one answer to read.
 */
/** The tab's memory of the recovery flag; `sessionStorage` can throw (a
 *  private window, blocked site data), and a flag that cannot be stored is
 *  simply not remembered past a reload. */
function readStoredRecovery(): string | null {
  try {
    return window.sessionStorage.getItem(RECOVERY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredRecovery(on: boolean): void {
  try {
    if (on) window.sessionStorage.setItem(RECOVERY_STORAGE_KEY, "1");
    else window.sessionStorage.removeItem(RECOVERY_STORAGE_KEY);
  } catch {
    // Not remembered; the event and the hash still gate the landing itself.
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [loading, setLoading] = useState(true);
  // F-106: a recovery-link session owes a password before it may use the app.
  // Seeded from the landing hash and the tab's memory, confirmed by the event;
  // see `initialRecoveryFlag` for the two holes that made both necessary.
  const [recovery, setRecovery] = useState(() =>
    initialRecoveryFlag(window.location.hash, readStoredRecovery()),
  );
  const queryClient = useQueryClient();

  // The tab's memory follows the flag, whichever way it moved: a seed from the
  // landing hash is written down at once (supabase-js clears the hash after
  // its round trip, and a reload must still find the flag), and USER_UPDATED
  // or SIGNED_OUT clears it.
  useEffect(() => {
    writeStoredRecovery(recovery);
  }, [recovery]);

  useEffect(() => {
    let cancelled = false;

    /**
     * Design plan §19.8 / brief P1-5c §4.2/§7.4: the decision of what to do
     * about a session update -- reset the cache, spin the loading state,
     * reload the profile -- is made in ONE place, `decideSessionUpdate`
     * (src/features/auth/session.ts), reached here through
     * `advanceSessionIdentity` so the app-wide `lastUserId` is read and
     * advanced in the same step. It used to be three independent statements at
     * two call sites, one of which (`setLoading(true)`) was written
     * unconditionally while its neighbour (`resetQueries()`) was correctly
     * guarded on the identity actually changing -- so the cache survived a
     * token refresh while the whole board still flashed through the
     * `sessionLoading` branch. Deriving all three flags from a single
     * `identityChanged` computation, once, is what stops the two from drifting
     * apart again.
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
      const decision = advanceSessionIdentity(kind, nextUserId);

      if (decision.resetCache) void queryClient.resetQueries();
      if (decision.setLoading) setLoading(true);
      if (decision.reloadProfile) {
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
        .select("id, org_id, user_id, role, default_create_mode, active")
        .eq("user_id", nextSession.user.id)
        .maybeSingle();
      if (cancelled) return;
      // A deactivated account (migration 0076, `active = false`) is locked out
      // org-wide by the server — every data read denies. Treat it here the same
      // as "no profile" so the app shows its coherent no-access state instead
      // of a shell whose every query fails. `active` defaults to true when a
      // pre-0076 server omits the column.
      if (error || !data || data.active === false) {
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

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (cancelled) return;

      // The token itself may have changed even when the user did not, so the
      // session object is always replaced.
      setSession(nextSession);
      // The recovery flag follows the EVENT, never the landing path or the
      // session shape -- a recovery session is indistinguishable from a
      // signed-in one by anything but the event that made it (F-106).
      setRecovery((current) => nextRecoveryFlag(current, event));

      // ⚠️ INITIAL_SESSION IS NOT A CHANGE. supabase-js fires it from its own
      // start-up, usually BEFORE `getSession()` above resolves, and the
      // "initial" step always reloads the profile; letting this event through
      // as a "change" (null -> user) loaded the profile a second time on
      // every hard reload. The reviewer counted two reads where R-349
      // promised one. The session object above is still replaced.
      if (event === "INITIAL_SESSION") return;

      // A TOKEN_REFRESH (supabase-js fires one roughly hourly) is the same
      // person with the same profile: `decideSessionUpdate`'s "change" kind
      // resolves all three flags to `identityChanged`, so a same-identity
      // event resets nothing, spins no loading state, and re-fetches
      // nothing -- `applyStep` becomes a no-op past updating `lastUserId`
      // (to the same value).
      applyStep(nextSession, "change");
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, [queryClient]);

  return (
    <SessionContext.Provider value={{ session, profile, loading, recovery }}>
      {children}
    </SessionContext.Provider>
  );
}
