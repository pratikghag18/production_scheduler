import { createContext, useContext } from "react";
import type { Session } from "@supabase/supabase-js";
import { decideSessionUpdate } from "./session";
import type { AuthEventKind, SessionDecision } from "./session";

/**
 * The caller's `user_profiles` row (brief P1-3b §7), readable under RLS by
 * its own policy. Fetched directly in `SessionProvider` (not through
 * src/lib/api/) since auth/session is outside that layer's RPC-focused scope
 * by the brief's own file layout (§3 lists `useSession.ts` under
 * src/features/auth/, not src/lib/api/) — the one plain-table read there
 * renames every column to camelCase at the point of use (the destructure on
 * the line after the query) so no snake_case identifier is used anywhere past
 * that line.
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
  /**
   * True from the moment a reset-email link is consumed (`PASSWORD_RECOVERY`)
   * until the password is set (`USER_UPDATED`) or the person signs out. The
   * route gate sends a recovery session to `/reset-password` wherever GoTrue
   * dropped it (F-106); see `nextRecoveryFlag` in session.ts.
   */
  recovery: boolean;
}

/**
 * ⭐⭐ WHO IS SIGNED IN, RESOLVED ONCE AT THE ROOT (R-349).
 *
 * `useSession` used to be a hook that ran its own `useEffect` — its own
 * `getSession()` round trip, its own `user_profiles` read, its own
 * `fetchAdminAnywhere()` RPC and its own `onAuthStateChange` listener — and it
 * is called at ~thirty call sites. Each instance therefore held its own
 * `loading` and its own `profile`, and two of them could disagree about who
 * you are for as long as one round trip takes: `RequireAdmin`'s copy could
 * resolve, admit you and mount `AdminPage` while `AdminPage`'s copy was still
 * `loading` with a null profile, which drew every company admin a supervisor's
 * three-tab rail for a beat (F-094 / R-337).
 *
 * The cure is one `SessionProvider` at the root (`SessionProvider.tsx`, mounted
 * once in `App.tsx`): one round trip per fact, one `loading`, one `profile`,
 * one listener. `useSession()` now just reads that single object from context,
 * so every reader shares the same answer and there is nothing left to disagree.
 * Its signature and return type are unchanged, so every existing call site and
 * every suite that `vi.mock`s this module keeps working untouched.
 */
export const SessionContext = createContext<UseSessionResult | null>(null);

/**
 * ⭐⭐ THE SIGNED-IN IDENTITY, HELD ONCE FOR THE WHOLE APP.
 *
 * This value was a `useRef` inside the old hook, initialised to `null`, so
 * **each of the many instances started life believing nobody was signed in**.
 * Its first `applyStep` then compared `null` against the real user id,
 * concluded the identity had changed, and fired `queryClient.resetQueries()` —
 * emptying the cache for everybody.
 *
 * ⚠️ THE RESET ITSELF IS RIGHT AND STAYS. Query keys deliberately carry no user
 * id, so a real identity change must drop the previous person's rows. What was
 * wrong was WHO gets to declare an identity change: mounting a component is not
 * one. At module scope the answer is shared, so a genuine sign-in still resets
 * exactly once — the first caller to see it moves the value, and the rest
 * compare equal and do nothing.
 *
 * ⚠️ It stays module-scoped HERE even though the effect that reads it now lives
 * in `SessionProvider`: an ES-module `let` cannot be reassigned from an
 * importing module, so `advanceSessionIdentity` below owns the read-and-write
 * and the provider calls it. With a single provider there is now exactly one
 * caller in production anyway; module scope keeps the test hook working and the
 * behaviour identical. `__resetSessionIdentityForTests` exists so a suite can
 * put it back.
 */
let lastUserId: string | null = null;

/** Test-only: module state outlives a test file, and a stale identity would
 *  make the next suite's first mount skip a reset it genuinely needs. */
export function __resetSessionIdentityForTests(): void {
  lastUserId = null;
}

/**
 * Read the app-wide identity, decide what a session update means, and advance
 * the identity in one step. The provider's `applyStep` used to inline these
 * three lines; they live here because `lastUserId` lives here.
 *
 * `decideSessionUpdate` (src/features/auth/session.ts) is the single, pure
 * decision — reset the cache, spin the loading state, reload the profile — so
 * the three flags cannot drift apart across call sites the way §19.8's
 * cache-reset and loading flags once did.
 */
export function advanceSessionIdentity(
  kind: AuthEventKind,
  nextUserId: string | null,
): SessionDecision {
  const step = decideSessionUpdate(lastUserId, { kind, nextUserId });
  lastUserId = step.nextLastUserId;
  return step.decision;
}

/**
 * WHO IS SIGNED IN — the same `{ session, profile, loading }` every reader
 * shares, read from `SessionContext`.
 *
 * Calling it outside `SessionProvider` throws immediately and by name, so a
 * component or test that forgot to wrap says so at once rather than silently
 * reading a null session.
 */
export function useSession(): UseSessionResult {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error("useSession() must be used within a <SessionProvider>.");
  }
  return value;
}
