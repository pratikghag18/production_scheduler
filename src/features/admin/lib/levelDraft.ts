/**
 * Pure level-draft reducer (brief P1-5d §4.1).
 *
 * `save_hierarchy_levels` takes the whole ordered array and the array index
 * IS the position (D70), so "positions must be contiguous" is not a rule
 * this editor enforces -- a payload cannot express a gap. Every action here
 * is an array edit, never a partial patch.
 *
 * Never mutates the input (clones row OBJECTS too, not just the array --
 * §9's M5). An inapplicable action returns the SAME array reference so a
 * caller can detect a no-op cheaply and React bails out via Object.is.
 */

export interface LevelDraft {
  id: string | null;
  name: string;
  isSchedulable: boolean;
}

export type LevelAction =
  | { kind: "rename"; index: number; name: string }
  | { kind: "moveUp"; index: number }
  | { kind: "moveDown"; index: number }
  | { kind: "add" }
  | { kind: "remove"; index: number }
  | { kind: "setSchedulable"; index: number };

export const MAX_LEVELS = 64;

/** Integer, in range for `draft`. Non-integer indices are always no-ops (L18). */
function inRange(draft: readonly LevelDraft[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < draft.length;
}

/** Shallow-clone every row object, not just the array (§9's M5 / L15). */
function cloneRows(draft: readonly LevelDraft[]): LevelDraft[] {
  return draft.map((row) => ({ ...row }));
}

export function applyLevelAction(
  draft: readonly LevelDraft[],
  action: LevelAction,
): readonly LevelDraft[] {
  switch (action.kind) {
    case "rename": {
      if (!inRange(draft, action.index)) return draft;
      if (draft[action.index].name === action.name) return draft;
      const next = cloneRows(draft);
      next[action.index] = { ...next[action.index], name: action.name };
      return next;
    }

    case "moveUp": {
      if (!inRange(draft, action.index) || action.index === 0) return draft;
      const next = cloneRows(draft);
      const i = action.index;
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      return next;
    }

    case "moveDown": {
      if (!inRange(draft, action.index) || action.index === draft.length - 1) return draft;
      const next = cloneRows(draft);
      const i = action.index;
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
      return next;
    }

    case "add": {
      // The cap is checked with `>`, not `>=` (L12/L13/M1): a draft at
      // length 63 (63 + 1 = 64, not > 64) may still add a 64th row; a draft
      // at length 64 (64 + 1 = 65 > 64) may not add a 65th.
      if (draft.length + 1 > MAX_LEVELS) return draft;
      const next = cloneRows(draft);
      next.push({ id: null, name: "", isSchedulable: false });
      return next;
    }

    case "remove": {
      if (!inRange(draft, action.index)) return draft;
      // remove refuses to empty the list (L9/M2): save_hierarchy_levels
      // rejects an empty array, so an editor that let you empty it could
      // only offer a Save that always fails.
      if (draft.length <= 1) return draft;
      const next = cloneRows(draft);
      next.splice(action.index, 1);
      // Removing the schedulable level leaves NONE, deliberately (L8/M3).
      // Do NOT auto-promote another row -- silently choosing where all
      // scheduled work lives is not this editor's decision to make.
      return next;
    }

    case "setSchedulable": {
      if (!inRange(draft, action.index)) return draft;
      const already = draft[action.index].isSchedulable;
      const onlyOneSchedulable = already && draft.filter((r) => r.isSchedulable).length === 1;
      // setSchedulable on the row that is already the only schedulable one
      // is a no-op.
      if (onlyOneSchedulable) return draft;
      const next = cloneRows(draft);
      for (let i = 0; i < next.length; i++) {
        next[i] = { ...next[i], isSchedulable: i === action.index };
      }
      return next;
    }

    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/**
 * Where to put error styling. `validateLevelDraft` (P1-5b) remains the
 * authority on WHETHER the draft is valid; this must tolerate a malformed
 * row rather than throw (L20).
 */
export function invalidNameIndices(draft: readonly LevelDraft[]): number[] {
  if (!Array.isArray(draft)) return [];
  const out: number[] = [];
  for (let i = 0; i < draft.length; i++) {
    const row = draft[i];
    const name =
      row === null || row === undefined ? "" : String((row as { name?: unknown }).name ?? "");
    if (name.trim() === "") out.push(i);
  }
  return out;
}
