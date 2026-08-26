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

/* ===========================================================================
 * D97 — who may open the admin screen (design plan §19.38).
 * ======================================================================== */

/**
 * THREE STATES, NOT A BOOLEAN, AND THAT IS THE WHOLE POINT.
 *
 * `useSession` resolves the profile asynchronously — `loading` starts true
 * with no profile at all. A boolean predicate has to answer *something*
 * during that window, and both answers are wrong: `false` bounces a real
 * admin who navigated straight to `/admin`, and `true` shows the screen to
 * whoever turns out not to be one. **This is exactly D91 one component
 * over** — there, gating a query without widening the render condition would
 * have swapped seven console errors for a blank card, because `enabled:
 * false` leaves `isLoading` FALSE. The fix there was to make the unresolved
 * state explicit rather than let it collapse into one of the two answers, and
 * it is the fix here.
 *
 * ONE implementation, because there are TWO call sites — the nav link and the
 * route itself — and a nav link that disagrees with its own route is how a
 * user ends up staring at a link that refuses them.
 *
 * FAILS CLOSED ON A ROLE IT DOES NOT RECOGNISE. `user_profiles.role` already
 * allows `admin | supervisor | viewer`, and the three-tier model (§19.38) will
 * add more. A client that has not been taught a new role must not decide it is
 * probably fine — **this function is the single place to widen when that lands.**
 */
export type AdminAccess = "pending" | "granted" | "denied";

/**
 * ⭐ WIDENED BY MIGRATION 0020 (design plan §19.46). D97's original form asked
 * only `role === "admin"` -- the ORG-WIDE flag -- and that was correct while
 * org-wide admin was the only kind there was. It stopped being correct the
 * moment a role became a property of a (person, PLACE) pair: a site admin
 * carries the org-wide role `viewer` and an `admin` GRANT on their site, so
 * the old gate denied every one of them and 0020's whole surface was
 * unreachable through the product.
 *
 * `adminAnywhere` is `app_is_admin_anywhere()`, fetched with the profile so
 * it shares one loading state -- see `useSession`. Deliberately NOT a second
 * `useQuery`: a separate query would introduce a second unresolved window to
 * fold into `pending`, and D91 is the standing reminder that `enabled: false`
 * leaves `isLoading` FALSE, so that fold is easy to get silently wrong.
 *
 * THE ROLE TERM IS KEPT EVEN THOUGH THE SERVER PREDICATE SUBSUMES IT.
 * `app_is_admin_anywhere()` already returns true for a company admin, so this
 * function could be one line. It is two because the wrapper fails CLOSED on a
 * PostgREST error, and a company admin who cannot reach that RPC should still
 * see their own admin screen -- their answer is in a profile they already
 * have. The redundancy is the fallback, not an oversight.
 *
 * `adminAnywhere === true`, NOT a truthiness test, and the distinction is
 * load-bearing: the value crosses a network boundary, so "truthy" would admit
 * a `1` or a non-empty string that a shape change could start returning.
 * Case A9 is the only thing that catches that.
 *
 * STILL FAILS CLOSED ON A ROLE IT DOES NOT RECOGNISE, and still THREE STATES
 * rather than a boolean, for D97's original reasons: `loading` starts true
 * with no profile, and both boolean answers are wrong in that window -- one
 * bounces a real admin who navigated straight to `/admin`, the other shows
 * the screen to whoever turns out not to be one.
 *
 * ONE implementation, TWO call sites -- the nav link and the route -- because
 * a nav link that disagrees with its own route is how a user ends up staring
 * at a link that refuses them.
 */
export function adminAccess(
  role: string | null | undefined,
  adminAnywhere: boolean | null | undefined,
  loading: boolean,
): AdminAccess {
  if (loading) return "pending";
  if (role === "admin") return "granted";
  return adminAnywhere === true ? "granted" : "denied";
}
