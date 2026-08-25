/**
 * Pure session-update decision (design plan §19.8, brief P1-5c §4.2).
 *
 * Deliberately takes a user id, never a Session object -- keeps this module
 * import-free of @supabase/supabase-js so it stays a plain value in / value
 * out function.
 *
 * `identityChanged = lastUserId !== event.nextUserId`.
 *
 *  - kind === "initial": { resetCache: identityChanged, setLoading: true,
 *    reloadProfile: true }. setLoading is unconditionally true here even for
 *    a signed-out identity (null -> null), because `loading` starts true and
 *    something must clear it.
 *  - kind === "change": all three flags are `identityChanged`. A token
 *    refresh fires a change event with the same id; same person, same
 *    profile, same cache.
 *
 * One value, not three booleans recomputed at three call sites -- see the
 * brief's §4.2 note on why this is a single SessionStep and not inline logic
 * duplicated at each caller.
 */

export type AuthEventKind = "initial" | "change";

export interface AuthEvent {
  kind: AuthEventKind;
  nextUserId: string | null;
}

export interface SessionDecision {
  resetCache: boolean;
  setLoading: boolean;
  reloadProfile: boolean;
}

export interface SessionStep {
  decision: SessionDecision;
  nextLastUserId: string | null;
}

export function decideSessionUpdate(lastUserId: string | null, event: AuthEvent): SessionStep {
  const identityChanged = lastUserId !== event.nextUserId;

  const decision: SessionDecision =
    event.kind === "initial"
      ? { resetCache: identityChanged, setLoading: true, reloadProfile: true }
      : {
          resetCache: identityChanged,
          setLoading: identityChanged,
          reloadProfile: identityChanged,
        };

  return { decision, nextLastUserId: event.nextUserId };
}

/**
 * Whether a data query may run yet.
 *
 * Every read in this app is RLS-scoped to the caller, so a query fired before
 * the session resolves is not merely early — it is a request the server MUST
 * refuse. `useSession` starts with `loading: true` and no identity, while
 * `useQuery` fires the moment its component mounts, so on every page load the
 * hierarchy reads and `board_window` went out unauthenticated and came back
 * **401**, then re-ran once auth landed. Nothing broke; it cost a wasted round
 * trip per query on every load and filled the console with red that would hide
 * a real failure.
 *
 * Takes a user id rather than a `Session`, for the same reason
 * `decideSessionUpdate` does: this module stays import-free of
 * @supabase/supabase-js and is a plain value in, value out function.
 *
 * ONE implementation, not the same two-term condition open-coded at each
 * caller — which is exactly how §19.8's cache-reset and loading flags drifted
 * apart, and the reason `decideSessionUpdate` exists at all.
 */
export function canQueryAsUser(userId: string | null, loading: boolean): boolean {
  return !loading && userId !== null;
}
