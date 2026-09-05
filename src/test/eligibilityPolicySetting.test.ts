import { describe, expect, it, vi } from "vitest";

/**
 * THE DEFENSIVE READ OF `orgs.settings.eligibility_policy`.
 *
 * `useEligibilityPolicy` is the Settings screen's answer to "what is this plant
 * doing right now", and the screen prints that answer as a paragraph of
 * consequence — "a planner can still put someone on a job they are not
 * certified for…". So the fallback is not a cosmetic default the way a missing
 * date format is: a wrong one is a sentence on an admin screen telling somebody
 * the wrong thing about their own plant.
 *
 * ⛔ THE CASE THAT MATTERS IS "THE DEFAULT IS THE PERMISSIVE ONE". Every other
 * defensive fallback in this codebase leans safe, so `block` is the tempting
 * choice here and it is the WRONG one. `warn` is what migration 0001 writes
 * into a new org's bag, what `create_assignment` / `move_run` /
 * `apply_split_coverage` COALESCE to when the key is absent, and what
 * `readEligibilityPolicy` (`src/features/board/lib/boardIndex.ts`) returns.
 * Guessing `block` would make the Settings screen and the board disagree with
 * the server about what the plant currently does — and it would disagree in the
 * direction a reader is least likely to go and check, because the screen would
 * be claiming the STRICTER rule while the server quietly allowed overrides.
 *
 * ⚠️ `@/lib/api` IS MOCKED ONLY BECAUSE IT REACHES `@/lib/supabase`. Nothing
 * under test here talks to it: `coerceEligibilityPolicy` is pure, and the two
 * constants are literals. The mock exists so this file can import the module at
 * all, not to stand in for behaviour.
 */
vi.mock("@/lib/api", () => ({
  fetchOrgSettings: vi.fn(),
  setOrgDateFormat: vi.fn(),
  setOrgEligibilityPolicy: vi.fn(),
}));

const { coerceEligibilityPolicy, DEFAULT_ELIGIBILITY_POLICY, ELIGIBILITY_POLICIES } =
  await import("@/features/admin/hooks/useOrgSettings");

describe("R-014: reading the org's eligibility policy defensively", () => {
  it("offers exactly the two values migration 0001's CHECK allows", () => {
    expect(ELIGIBILITY_POLICIES).toEqual(["warn", "block"]);
  });

  it("defaults to warn — the server's COALESCE and 0001's seeded value", () => {
    expect(DEFAULT_ELIGIBILITY_POLICY).toBe("warn");
  });

  it("passes both stored values through unchanged", () => {
    expect(coerceEligibilityPolicy("warn")).toBe("warn");
    expect(coerceEligibilityPolicy("block")).toBe("block");
  });

  it("falls back rather than throwing on anything the bag should not contain", () => {
    // A key that was never set, a hand-edited jsonb, a value from a future
    // migration this build predates. None of these may take the screen down,
    // and none may be reported as `block` — see the header.
    for (const junk of [undefined, null, "", "Block", "BLOCK", "strict", 0, 1, true, [], {}]) {
      expect(coerceEligibilityPolicy(junk)).toBe("warn");
    }
  });
});
