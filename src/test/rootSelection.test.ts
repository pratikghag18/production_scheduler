import { describe, expect, it } from "vitest";
import {
  resolveRootPath,
  shouldOfferRootPicker,
  type BoardRoot,
} from "@/features/board/lib/rootSelection";

/**
 * The board opened on a hardcoded `"plant_1"` for every user since P1-4a.
 * These cases are the replacement rule. The one that matters most is W5:
 * the remembered choice outliving the identity that made it.
 */
const P1: BoardRoot = { id: "n1", name: "Plant 1", path: "plant_1" };
const P2: BoardRoot = { id: "n2", name: "Plant 2", path: "plant_2" };
const ASM: BoardRoot = { id: "n3", name: "Assembly", path: "plant_1.assembly" };

describe("resolveRootPath", () => {
  it("W1: nowhere to open is null, not a guess", () => {
    expect(resolveRootPath(null, [])).toBeNull();
    // ⚠️ and a remembered path does NOT resurrect a place they can no longer
    // see — this is the identity-switch case with the list emptied.
    expect(resolveRootPath("plant_1", [])).toBeNull();
  });

  it("W2: with no choice made, the first row wins", () => {
    expect(resolveRootPath(null, [P1, P2])).toBe("plant_1");
    // The server orders active-first then by path, so "the first row" is a
    // decision made in SQL (0027) and merely honoured here.
    expect(resolveRootPath(null, [P2, P1])).toBe("plant_2");
  });

  it("W3: a valid remembered choice is kept", () => {
    expect(resolveRootPath("plant_2", [P1, P2])).toBe("plant_2");
  });

  it("W4: a mid-tree top is a legitimate choice, not just a root", () => {
    // Ana's whole visible forest is one department. If this returned null or
    // reached for a root, her board would be empty — which is exactly what the
    // obvious server-side implementation would have done (0027, case V3).
    expect(resolveRootPath(null, [ASM])).toBe("plant_1.assembly");
    expect(resolveRootPath("plant_1.assembly", [ASM])).toBe("plant_1.assembly");
  });

  it("W5 ⭐: a remembered choice that is no longer visible is dropped", () => {
    // Dana → Quinn in the dev switcher, with no reload. React Query resets its
    // cache on an identity change; this store does not. Without this line the
    // board would keep asking for Plant 1 as Quinn — the original defect,
    // reproduced one layer up, and invisible because the server would answer
    // with an empty board rather than an error.
    expect(resolveRootPath("plant_1", [P2])).toBe("plant_2");
  });

  it("W6: matching is exact — a prefix is not a match", () => {
    // `plant_1` is an ltree ANCESTOR of `plant_1.assembly`, so a `startsWith`
    // or `<@`-flavoured comparison would call this a hit and load a subtree the
    // person may not be able to see the top of.
    expect(resolveRootPath("plant_1", [ASM])).toBe("plant_1.assembly");
    expect(resolveRootPath("plant_1.assembly", [P1])).toBe("plant_1");
  });
});

describe("shouldOfferRootPicker", () => {
  it("W7: one place is not a choice", () => {
    expect(shouldOfferRootPicker([])).toBe(false);
    expect(shouldOfferRootPicker([P1])).toBe(false);
    expect(shouldOfferRootPicker([P1, P2])).toBe(true);
  });
});
