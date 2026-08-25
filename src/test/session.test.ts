import { describe, expect, it } from "vitest";
import { decideSessionUpdate } from "@/features/auth/session";
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
