import { createContext, useContext } from "react";

/**
 * S47 / R-395 -- "the outline and the spoken yes": what the command bar
 * tells the board is IN QUESTION while a remove/move/retime question
 * stands. `kind` picks the colour (`CommandBar.tsx`'s `withBlockHighlight`
 * is the one place that builds one): `"remove"` is the danger colour
 * (`remove_which`, S41-b), `"move"` and `"retime"` are both the board's
 * accent (`move_which`, S41-c, and `block_exists`, R-385's own "change it or
 * make a separate block" question -- a re-time is not a removal, so it gets
 * the same colour a move does, never red).
 */
export type Highlight = {
  kind: "remove" | "move" | "retime";
  assignmentIds: string[];
};

/**
 * A React Context rather than a prop threaded through `BoardGrid`/`TrackRow`
 * (brief §2: "Files you own" names `BoardPage.tsx` and "the block component",
 * never the two layers between them) -- `BoardPage` is the one place that
 * knows what the bar is asking, and `DirectBlock`/`AssignmentChip` are the
 * only ones that need the answer, for exactly one assignment id each. Adding
 * a prop to every row/grid layer in between just to relay one value neither
 * of them reads would be new plumbing for its own sake.
 */
const HighlightContext = createContext<Highlight | null>(null);

export const HighlightProvider = HighlightContext.Provider;

/** `null` when nothing is highlighted, or `assignmentId` is not in the
 *  current highlight's set; otherwise the colour to draw. */
export function useHighlightKind(assignmentId: string): Highlight["kind"] | null {
  const highlight = useContext(HighlightContext);
  if (highlight && highlight.assignmentIds.includes(assignmentId)) return highlight.kind;
  return null;
}
