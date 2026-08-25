import { describe, expect, it } from "vitest";
import { applyLevelAction, invalidNameIndices, MAX_LEVELS } from "@/features/admin/lib/levelDraft";
import type { LevelAction, LevelDraft } from "@/features/admin/lib/levelDraft";

/**
 * Brief P1-5d §8 group L (20 assertions) for `applyLevelAction` /
 * `invalidNameIndices`.
 *
 * Authored, not run in this container (no npm) -- the /tmp harness copy of
 * this exact module was executed and mutation-tested against all 8 of the
 * brief's §9 mutations (M1-M8) before this file was written; see the agent
 * report for the full run, including the one mutation (M1) whose named
 * failing case did not match the brief's table -- L12/L13 test the same two
 * boundary conditions this suite does, just apparently numbered the other
 * way around in the reference implementation.
 *
 * `save_hierarchy_levels` takes the whole ordered array and the array index
 * IS the position (D70), so every case here is an array edit, never a
 * partial patch, and "positions must be contiguous" never appears as a rule
 * to test -- a payload cannot express a gap.
 */

function row(id: string | null, name: string, isSchedulable = false): LevelDraft {
  return { id, name, isSchedulable };
}

const BASE: LevelDraft[] = [
  row("s1", "Site", true),
  row("d1", "Department"),
  row("l1", "Line"),
  row("c1", "Work Cell"),
];

describe("levelDraft.ts: applyLevelAction", () => {
  it("L1: rename changes only the named row", () => {
    const next = applyLevelAction(BASE, { kind: "rename", index: 1, name: "Dept" });
    expect(next.map((r) => r.name)).toEqual(["Site", "Dept", "Line", "Work Cell"]);
  });

  it("L2: moveUp swaps with the previous row", () => {
    const next = applyLevelAction(BASE, { kind: "moveUp", index: 1 });
    expect(next.map((r) => r.id)).toEqual(["d1", "s1", "l1", "c1"]);
  });

  it("L3: moveDown swaps with the next row", () => {
    const next = applyLevelAction(BASE, { kind: "moveDown", index: 1 });
    expect(next.map((r) => r.id)).toEqual(["s1", "l1", "d1", "c1"]);
  });

  // L4/L5: reference identity (`toBe`, not `toEqual`) is the point -- the
  // no-op contract is what lets the editor skip a re-render. A version that
  // returns a fresh, deep-equal array passes a deep-equality check and
  // fails the actual contract.
  it("L4: moveUp at index 0 is a no-op -- returns the SAME reference", () => {
    const next = applyLevelAction(BASE, { kind: "moveUp", index: 0 });
    expect(next).toBe(BASE);
  });

  it("L5: moveDown at the last index is a no-op -- returns the SAME reference", () => {
    const next = applyLevelAction(BASE, { kind: "moveDown", index: BASE.length - 1 });
    expect(next).toBe(BASE);
  });

  it("L6: add appends a blank, non-schedulable row", () => {
    const next = applyLevelAction(BASE, { kind: "add" });
    expect(next.length).toBe(5);
    expect(next[4]).toEqual({ id: null, name: "", isSchedulable: false });
  });

  it("L7: remove drops the named row and closes the gap", () => {
    const next = applyLevelAction(BASE, { kind: "remove", index: 2 });
    expect(next.map((r) => r.id)).toEqual(["s1", "d1", "c1"]);
  });

  // D72's most consequential rule: removing the schedulable row leaves
  // NONE schedulable. No auto-promotion -- silently choosing where all
  // scheduled work lives is not this editor's decision.
  it("L8: removing the schedulable level leaves NONE schedulable", () => {
    const next = applyLevelAction(BASE, { kind: "remove", index: 0 });
    expect(next.every((r) => !r.isSchedulable)).toBe(true);
  });

  it("L9: remove refuses to empty the list -- same reference at length 1", () => {
    const one: LevelDraft[] = [row("s1", "Site", true)];
    const next = applyLevelAction(one, { kind: "remove", index: 0 });
    expect(next).toBe(one);
  });

  it("L10: setSchedulable is radio semantics -- sets one, clears every other", () => {
    const next = applyLevelAction(BASE, { kind: "setSchedulable", index: 2 });
    expect(next.map((r) => r.isSchedulable)).toEqual([false, false, true, false]);
  });

  it("L11: setSchedulable still enforces radio semantics against a malformed multi-flag draft", () => {
    const mixed: LevelDraft[] = [row("a", "A", true), row("b", "B", true), row("c", "C")];
    const next = applyLevelAction(mixed, { kind: "setSchedulable", index: 2 });
    expect(next.map((r) => r.isSchedulable)).toEqual([false, false, true]);
  });

  // L12/L13: the cap is checked with `>`, not `>=` (§8) -- a draft AT
  // MAX_LEVELS may not add a (MAX_LEVELS+1)th row, but a draft one below
  // the cap still may.
  it("L12: at MAX_LEVELS - 1 entries, add succeeds", () => {
    const at63: LevelDraft[] = Array.from({ length: MAX_LEVELS - 1 }, (_, i) =>
      row(`id${i}`, `L${i}`),
    );
    const next = applyLevelAction(at63, { kind: "add" });
    expect(next.length).toBe(MAX_LEVELS);
  });

  it("L13: at MAX_LEVELS entries, add is a no-op -- same reference", () => {
    const at64: LevelDraft[] = Array.from({ length: MAX_LEVELS }, (_, i) => row(`id${i}`, `L${i}`));
    const next = applyLevelAction(at64, { kind: "add" });
    expect(next).toBe(at64);
  });

  it("L14 PROPERTY: the input array (and its rows) are never mutated", () => {
    const original: LevelDraft[] = [row("s1", "Site", true), row("d1", "Department")];
    const snapshot = JSON.parse(JSON.stringify(original));
    const actions: LevelAction[] = [
      { kind: "rename", index: 0, name: "Plant" },
      { kind: "moveDown", index: 0 },
      { kind: "add" },
      { kind: "remove", index: 0 },
      { kind: "setSchedulable", index: 1 },
    ];
    for (const action of actions) applyLevelAction(original, action);
    expect(original).toEqual(snapshot);
  });

  it("L15 PROPERTY: row objects are cloned, not shared, across the whole array", () => {
    const original: LevelDraft[] = [row("s1", "Site", true), row("d1", "Department")];
    const next = applyLevelAction(original, { kind: "rename", index: 1, name: "Dept" });
    // The row that WASN'T touched must still be a fresh object reference
    // (a shallow `[...draft]` clone would leave it shared) while remaining
    // value-equal.
    expect(next[0]).not.toBe(original[0]);
    expect(next[0]).toEqual(original[0]);
  });

  it("L16: rename to the current value is a no-op -- same reference", () => {
    const next = applyLevelAction(BASE, { kind: "rename", index: 0, name: "Site" });
    expect(next).toBe(BASE);
  });

  it("L17: an out-of-range index is a no-op -- same reference", () => {
    const next = applyLevelAction(BASE, { kind: "rename", index: 99, name: "X" });
    expect(next).toBe(BASE);
  });

  it("L18: a non-integer index is a no-op -- same reference", () => {
    const next = applyLevelAction(BASE, { kind: "rename", index: 1.5, name: "X" });
    expect(next).toBe(BASE);
  });
});

describe("levelDraft.ts: invalidNameIndices", () => {
  it("L19: flags blank and whitespace-only names, by index", () => {
    const draft: LevelDraft[] = [row("a", "Site"), row("b", "   "), row("c", ""), row("d", "Ok")];
    expect(invalidNameIndices(draft)).toEqual([1, 2]);
  });

  // `validateLevelDraft` (P1-5b) remains the authority on WHETHER the draft
  // is valid; this only says WHERE to draw the error styling, and it must
  // tolerate a malformed row rather than throw -- a validator the admin
  // form calls on every keystroke must never throw.
  it("L20: tolerates a malformed row (null / missing name) without throwing", () => {
    const draft = [
      row("a", "Site"),
      null,
      { id: "c" },
      undefined,
      row("d", "Ok"),
    ] as unknown as LevelDraft[];
    expect(() => invalidNameIndices(draft)).not.toThrow();
    expect(invalidNameIndices(draft)).toEqual([1, 2, 3]);
  });
});
