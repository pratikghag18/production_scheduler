import { describe, expect, it } from "vitest";
import { adminAccess, canQueryAsUser, decideSessionUpdate } from "@/features/auth/session";
import type { AuthEvent } from "@/features/auth/session";

/**
 * Brief P1-5c §8 group S (9 assertions) for `decideSessionUpdate` (design
 * plan §19.8). §19.8's bug was already fixed by hand in useSession.ts
 * before this brief: `clearCacheOnIdentityChange` correctly guarded the
 * cache reset, and only `setLoading(true)` next to it was left
 * unconditional, blanking the board on every routine token refresh. This
 * suite is the missing regression test for that fix, now expressed as one
 * pure decision instead of logic scattered across two call sites.
 *
 * Authored, not run in this container (no npm) -- the /tmp harness copy of
 * this exact module was executed and mutation-tested against all of the
 * brief's §9 mutations (M9-M11, plus the confirmed-inert `!==`→`!=`
 * substitution) before this file was written. See the agent report.
 */

describe("session.ts: decideSessionUpdate", () => {
  it("S1: initial signed-in", () => {
    const step = decideSessionUpdate(null, { kind: "initial", nextUserId: "u1" });
    expect(step.decision).toEqual({ resetCache: true, setLoading: true, reloadProfile: true });
    expect(step.nextLastUserId).toBe("u1");
  });

  it("S2: initial signed-out still clears loading", () => {
    const step = decideSessionUpdate(null, { kind: "initial", nextUserId: null });
    expect(step.decision).toEqual({ resetCache: false, setLoading: true, reloadProfile: true });
  });

  it("S3: TOKEN REFRESH — all three flags false", () => {
    // Same user id on a "change" event, exactly what supabase-js fires
    // roughly hourly. This is the §19.8 case: nothing should reset, spin,
    // or re-fetch.
    const step = decideSessionUpdate("u1", { kind: "change", nextUserId: "u1" });
    expect(step.decision).toEqual({ resetCache: false, setLoading: false, reloadProfile: false });
  });

  it("S4: sign-in from signed-out", () => {
    const step = decideSessionUpdate(null, { kind: "change", nextUserId: "u1" });
    expect(step.decision).toEqual({ resetCache: true, setLoading: true, reloadProfile: true });
  });

  it("S5: switch identity", () => {
    const step = decideSessionUpdate("u1", { kind: "change", nextUserId: "u2" });
    expect(step.decision).toEqual({ resetCache: true, setLoading: true, reloadProfile: true });
  });

  it("S6: sign out", () => {
    const step = decideSessionUpdate("u1", { kind: "change", nextUserId: null });
    expect(step.decision).toEqual({ resetCache: true, setLoading: true, reloadProfile: true });
  });

  it("S7: repeated signed-out change events stay inert", () => {
    const step1 = decideSessionUpdate(null, { kind: "change", nextUserId: null });
    const step2 = decideSessionUpdate(step1.nextLastUserId, { kind: "change", nextUserId: null });
    expect(step1.decision).toEqual({ resetCache: false, setLoading: false, reloadProfile: false });
    expect(step2.decision).toEqual({ resetCache: false, setLoading: false, reloadProfile: false });
  });

  it("S8: nextLastUserId always advances to event.nextUserId", () => {
    const cases: Array<[string | null, AuthEvent]> = [
      [null, { kind: "initial", nextUserId: "u1" }],
      ["u1", { kind: "change", nextUserId: "u1" }],
      ["u1", { kind: "change", nextUserId: "u2" }],
      ["u2", { kind: "change", nextUserId: null }],
    ];
    for (const [last, event] of cases) {
      expect(decideSessionUpdate(last, event).nextLastUserId).toBe(event.nextUserId);
    }
  });

  it("S9: PROPERTY — on a change event the three flags never disagree", () => {
    const ids: Array<string | null> = [null, "u1", "u2", "u3"];
    for (const last of ids) {
      for (const next of ids) {
        const { decision } = decideSessionUpdate(last, { kind: "change", nextUserId: next });
        expect(decision.resetCache).toBe(decision.setLoading);
        expect(decision.setLoading).toBe(decision.reloadProfile);
      }
    }
  });
});

/**
 * D91 — `canQueryAsUser`, the gate that stops an RLS-scoped read firing as
 * nobody. Every read in this app is scoped to the caller, so a query sent
 * before the session resolves is a request the server MUST refuse: on every
 * page load the hierarchy reads and `board_window` went out unauthenticated,
 * came back 401, and re-ran once auth landed.
 *
 * Two terms, one implementation — because §19.8's cache-reset and loading
 * flags drifted apart precisely by being open-coded at more than one caller,
 * and this condition now has two (BoardPage, AdminPage).
 */
describe("session.ts: canQueryAsUser", () => {
  it("Q1: resolved AND signed in -> may query", () => {
    expect(canQueryAsUser("user-1", false)).toBe(true);
  });

  it("Q2: still loading -> must NOT query, even with a user id", () => {
    // The dangerous case: an id is present before `loading` clears on the
    // very first pass, and querying then is exactly the 401.
    expect(canQueryAsUser("user-1", true)).toBe(false);
  });

  it("Q3: resolved but signed out -> must not query", () => {
    expect(canQueryAsUser(null, false)).toBe(false);
  });

  it("Q4: loading and signed out -> must not query", () => {
    expect(canQueryAsUser(null, true)).toBe(false);
  });

  it("Q5: BOTH terms are load-bearing — exactly one input combination is true", () => {
    // A guard that ignored either argument would let a second combination
    // through, and a `return true` would let all four.
    const combos: Array<[string | null, boolean]> = [
      ["user-1", false],
      ["user-1", true],
      [null, false],
      [null, true],
    ];
    expect(combos.filter(([id, loading]) => canQueryAsUser(id, loading)).length).toBe(1);
  });

  it("Q6: an empty-string id is still an identity, not a signed-out state", () => {
    // Guarding on truthiness rather than `!== null` would silently treat "" as
    // signed out. The session layer's contract is `string | null`, and only
    // `null` means nobody.
    expect(canQueryAsUser("", false)).toBe(true);
  });
});

/* ===========================================================================
 * Group A — `adminAccess`, D97's single gate (design plan §19.38).
 *
 * Two call sites depend on this agreeing with itself: the nav link in
 * `AppShell` and the route guard in `RequireAdmin`. The database remains the
 * authority — every admin RPC opens with `app_is_admin()` — so nothing here
 * protects data. It decides what gets RENDERED.
 * ======================================================================== */

describe("session.ts: adminAccess", () => {
  // A1/A2 are the pair that matters. A predicate written as
  // `role === "admin" ? "granted" : loading ? "pending" : "denied"` passes A1
  // and FAILS A2 -- it would show the admin screen to a still-unresolved
  // session that merely happens to carry the right role already. Loading is
  // asked FIRST, and A2 is the case that pins the order.
  it("A1: an unresolved session with no profile yet is pending", () => {
    expect(adminAccess(null, true)).toBe("pending");
  });

  it("A2: still pending while loading EVEN IF the role is already admin", () => {
    expect(adminAccess("admin", true)).toBe("pending");
  });

  it("A3: a resolved admin is granted", () => {
    expect(adminAccess("admin", false)).toBe("granted");
  });

  it("A4: a resolved supervisor is denied", () => {
    expect(adminAccess("supervisor", false)).toBe("denied");
  });

  it("A5: a resolved viewer is denied", () => {
    expect(adminAccess("viewer", false)).toBe("denied");
  });

  it("A6: a resolved session with no profile at all is denied", () => {
    expect(adminAccess(null, false)).toBe("denied");
  });

  // `profile?.role` is `undefined` when there is no profile object, and `null`
  // when there is one with a null role. Both callers pass the optional-chained
  // form, so undefined is the shape that actually arrives.
  it("A7: an undefined role is denied", () => {
    expect(adminAccess(undefined, false)).toBe("denied");
  });

  // ⭐ A8 is the load-bearing one for the three-tier model (§19.38). When
  // `site_admin` lands, an OLD client must refuse it rather than guess that a
  // role with "admin" in the name is probably fine -- it has no idea how to
  // scope the screen. `adminAccess` is the one place to widen deliberately.
  it("A8: a role this build has never heard of is denied, not assumed", () => {
    expect(adminAccess("site_admin", false)).toBe("denied");
    expect(adminAccess("system_admin", false)).toBe("denied");
    expect(adminAccess("superuser", false)).toBe("denied");
  });

  // A9/A10: the comparison is exact. `user_profiles.role` is a CHECK-constrained
  // column, so a value differing by case or whitespace means something has gone
  // wrong upstream -- normalising it here would paper over that silently.
  it("A9: the match is case-sensitive", () => {
    expect(adminAccess("Admin", false)).toBe("denied");
    expect(adminAccess("ADMIN", false)).toBe("denied");
  });

  it("A10: the match does not trim", () => {
    expect(adminAccess(" admin", false)).toBe("denied");
    expect(adminAccess("admin ", false)).toBe("denied");
  });

  it("A11: the empty string is denied, not treated as absent", () => {
    expect(adminAccess("", false)).toBe("denied");
  });
});
