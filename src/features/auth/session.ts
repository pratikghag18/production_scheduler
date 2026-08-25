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
