import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
 * Group A — `adminAccess`, D97's single gate, WIDENED BY MIGRATION 0020
 * (design plan §19.38, then §19.46).
 *
 * Two call sites depend on this agreeing with itself: the nav link in
 * `AppShell` and the route guard in `RequireAdmin`. The database remains the
 * authority — every admin RPC re-asks the real question about the specific
 * node or structure — so nothing here protects data. It decides what gets
 * RENDERED.
 *
 * ⭐ A1–A11 GAINED A THIRD ARGUMENT AND KEPT THEIR MEANING. Each passes
 * `adminAnywhere = false`, which is the value that leaves the ROLE term as
 * the only thing that can decide — so every one of them still measures
 * exactly what it was written to measure. A12–A17 are the new behaviour.
 * ======================================================================== */

describe("session.ts: adminAccess", () => {
  // A1/A2 are the pair that matters. A predicate written as
  // `role === "admin" ? "granted" : loading ? "pending" : "denied"` passes A1
  // and FAILS A2 -- it would show the admin screen to a still-unresolved
  // session that merely happens to carry the right role already. Loading is
  // asked FIRST, and A2 is the case that pins the order.
  it("A1: an unresolved session with no profile yet is pending", () => {
    expect(adminAccess(null, false, true)).toBe("pending");
  });

  it("A2: still pending while loading EVEN IF the role is already admin", () => {
    expect(adminAccess("admin", false, true)).toBe("pending");
  });

  it("A3: a resolved admin is granted", () => {
    expect(adminAccess("admin", false, false)).toBe("granted");
  });

  it("A4: a resolved supervisor is denied", () => {
    expect(adminAccess("supervisor", false, false)).toBe("denied");
  });

  it("A5: a resolved viewer is denied", () => {
    expect(adminAccess("viewer", false, false)).toBe("denied");
  });

  it("A6: a resolved session with no profile at all is denied", () => {
    expect(adminAccess(null, false, false)).toBe("denied");
  });

  // `profile?.role` is `undefined` when there is no profile object, and `null`
  // when there is one with a null role. Both callers pass the optional-chained
  // form, so undefined is the shape that actually arrives.
  it("A7: an undefined role is denied", () => {
    expect(adminAccess(undefined, false, false)).toBe("denied");
  });

  // ⭐ A8 is the load-bearing one for the three-tier model (§19.38). When
  // `site_admin` lands, an OLD client must refuse it rather than guess that a
  // role with "admin" in the name is probably fine -- it has no idea how to
  // scope the screen. `adminAccess` is the one place to widen deliberately.
  it("A8: a role this build has never heard of is denied, not assumed", () => {
    expect(adminAccess("site_admin", false, false)).toBe("denied");
    expect(adminAccess("system_admin", false, false)).toBe("denied");
    expect(adminAccess("superuser", false, false)).toBe("denied");
  });

  // A9/A10: the comparison is exact. `user_profiles.role` is a CHECK-constrained
  // column, so a value differing by case or whitespace means something has gone
  // wrong upstream -- normalising it here would paper over that silently.
  it("A9: the match is case-sensitive", () => {
    expect(adminAccess("Admin", false, false)).toBe("denied");
    expect(adminAccess("ADMIN", false, false)).toBe("denied");
  });

  it("A10: the match does not trim", () => {
    expect(adminAccess(" admin", false, false)).toBe("denied");
    expect(adminAccess("admin ", false, false)).toBe("denied");
  });

  it("A11: the empty string is denied, not treated as absent", () => {
    expect(adminAccess("", false, false)).toBe("denied");
  });

  /* -------------------------------------------------------------------------
   * A12–A17 — migration 0020. A site admin carries the ORG-WIDE role `viewer`
   * and an `admin` GRANT on their site, so the D97 gate denied every one of
   * them and 0020's entire surface was unreachable through the product. A8
   * above says a role this build does not recognise is refused; these say the
   * answer now arrives as a separate fact instead, from the server.
   * ---------------------------------------------------------------------- */

  // A12 is the case the whole widening exists for.
  it("A12: a site admin -- org-wide viewer, admin somewhere -- is granted", () => {
    expect(adminAccess("viewer", true, false)).toBe("granted");
  });

  it("A13: a supervisor who is also an admin somewhere is granted", () => {
    expect(adminAccess("supervisor", true, false)).toBe("granted");
  });

  // The other half of A12, and without it a gate that granted EVERYONE would
  // pass every case above that was written before this argument existed.
  it("A14: a viewer who is an admin nowhere is still denied", () => {
    expect(adminAccess("viewer", false, false)).toBe("denied");
  });

  // Loading still wins over BOTH terms. A2 pins the order against the role;
  // this pins it against the new one.
  it("A15: still pending while loading EVEN IF admin somewhere", () => {
    expect(adminAccess("viewer", true, true)).toBe("pending");
  });

  // A16 -- THE FALLBACK IS DELIBERATE. `fetchAdminAnywhere` fails CLOSED, so a
  // company admin whose RPC call errored arrives here with null/undefined.
  // Their answer is in a profile they already hold, and this is the case that
  // says the role term is a fallback rather than dead weight the server
  // predicate subsumes.
  it("A16: a company admin is granted even when the probe could not answer", () => {
    expect(adminAccess("admin", null, false)).toBe("granted");
    expect(adminAccess("admin", undefined, false)).toBe("granted");
  });

  // A17 -- the comparison is `=== true`, not truthiness, and this is the ONLY
  // case that can tell the two apart. The value crosses a network boundary, so
  // a shape change could start returning a 1 or a non-empty string; truthy
  // would let either through. Measured in the design container: rewriting the
  // term as `Boolean(adminAnywhere)` passes A12-A16 and fails only here.
  it("A17: a truthy non-boolean from the server does not grant", () => {
    expect(adminAccess("viewer", 1 as unknown as boolean, false)).toBe("denied");
    expect(adminAccess("viewer", "yes" as unknown as boolean, false)).toBe("denied");
    expect(adminAccess("viewer", {} as unknown as boolean, false)).toBe("denied");
  });
});

/* ===========================================================================
 * WHO GETS TO DECLARE AN IDENTITY CHANGE.
 *
 * ⭐⭐ `decideSessionUpdate` is pure and every case above passes whatever
 * `lastUserId` is threaded into it — which is exactly why none of them noticed
 * that the value lived in a `useRef`, one copy per hook instance, each starting
 * at `null`. `useSession` is called in six components now, so **every newly
 * mounted one compared `null` against the real user, concluded the person had
 * just signed in, and called `queryClient.resetQueries()`**, emptying the cache
 * for everybody.
 *
 * ⚠⚠ IT WAS FOUND IN A BROWSER, NOT HERE, and only because it became visible:
 * switching admin tabs mounts a panel, the reset blanked the hierarchy read,
 * and the plant filter row unmounted and came back. Sampled per animation
 * frame, its height went **42 → 0 → 42 on every tab switch**. Anybody with one
 * readable plant has no row at all (§19.79), so for them the cache was thrown
 * away silently and paid for in refetches.
 *
 * ⚠️ SO THIS IS A SOURCE-LEVEL GUARD, in `scaleAudit`'s idiom, and it is here
 * because a behavioural one would need an auth mock this project does not have.
 * It pins the one thing that regressed: WHERE the identity is kept. If that
 * matters more later, the honest upgrade is the `SessionProvider` P1-6b already
 * records as debt — not a bigger regex.
 * =========================================================================== */

describe("useSession.ts: the signed-in identity is app-wide, not per hook instance", () => {
  const src = readFileSync(`${process.cwd()}/src/features/auth/useSession.ts`, "utf8");

  it("S13 ⭐⭐: `lastUserId` is declared at module scope", () => {
    // `let lastUserId: string | null = null;` with no leading indentation —
    // module scope is exactly what "no indentation" means in this file.
    expect(/^let lastUserId: string \| null = null;$/m.test(src)).toBe(true);
  });

  it("S14: and it is NOT a ref inside the hook, which is what it used to be", () => {
    expect(src).not.toMatch(/lastUserId\s*=\s*useRef/);
    expect(src).not.toMatch(/lastUserId\.current/);
  });

  it("S15: the guard can fail — it is matching this file and not passing vacuously", () => {
    // ⚠️ Rule 3: a matcher that only ever reads a clean repo says nothing about
    // whether it can fail. Both patterns are run against the shape they exist
    // to reject, so a typo that made them match nothing would surface here.
    const asRef = src.replace(
      /^let lastUserId: string \| null = null;$/m,
      "  const lastUserId = useRef<string | null>(null);",
    );
    expect(asRef).not.toBe(src);
    expect(/^let lastUserId: string \| null = null;$/m.test(asRef)).toBe(false);
    expect(asRef).toMatch(/lastUserId\s*=\s*useRef/);
  });
});
