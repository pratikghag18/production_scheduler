import type { BoardOperator } from "@/lib/api";
import { isAtOrBelow } from "@/features/admin/lib/scope";

/**
 * WHO IS OFFERED WHERE, ON THE BOARD. One module, two questions, no node map.
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ THE MAINTAINER'S RULE, 6 Sept, verbatim:
 *
 *   "If a operator is assigned to higher hierarchy they should automatically
 *    become available to all lower hierarchy within that hierarchy ... That
 *    should be the default behaviour. For other operators in the plant we need
 *    to give an option to the supervisor to click through something so show
 *    remaining operators so they can make that decision to assign someone
 *    outside of that area."
 *
 * So there are TWO lists for a place, not one filter: the people whose HOME
 * covers that place (the default), and the rest of the plant (one click away,
 * through the existing D113 reason). Never another plant's people: the table's
 * own guard refuses that placement now (R-345, migration 0058), and
 * `board_window` sends only the plant's people, so "the rest of the list" IS
 * "the rest of the plant" and nothing wider.
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ NO NODE LOOKUP, AND THAT ABSENCE IS THE FIX (R-346). Every previous
 * version of this file resolved a person's owner through the board's
 * `nodeById`, and that map starts at the reader's ROOT. A supervisor granted
 * Line 1 therefore had no node for the PLANT — which is where five of the
 * demo's six people are homed — so:
 *
 *   - the panel, which kept only people whose owner was IN the map, showed her
 *     an empty list ("Ana can't see any operators on the left panel. What am I
 *     missing? Something is definitely wrong.");
 *   - the mark, which read a missing owner as "not an ancestor", marked every
 *     one of them "not from this area" and asked for a reason the server does
 *     not want.
 *
 * Both were the same mistake: reading the absence of a node ABOVE the grant as
 * "somewhere else" when it means "above you". A client cannot tell those apart
 * from a truncated map, so it stopped being asked to — `board_window` sends
 * each person's home as a PATH (`sitePath`, migration 0058) and the comparison
 * happens on the two strings. `isAtOrBelow` is the ltree `@>` test the server's
 * own `app_owner_covers_in_org` runs, so the screen and the write guard cannot
 * drift.
 *
 * ⚠️ THE FAIL-OPEN THAT SURVIVES IS THE PLACE, and it is a different question.
 * With no place there is nothing to compare anybody against: `splitPeopleFor`
 * puts everyone in `here` and `outsideAreaOperatorIds` marks nobody. The
 * not-yet-loaded board and a pop-up whose node is not in this window both land
 * there, and in both the honest answer is to show the list and leave the server
 * to decide.
 */

/** The two lists a place has: the default, and the one behind the click. */
export interface PeopleSplit {
  /** Homed at or above the place, or somewhere inside it. Offered by default. */
  here: BoardOperator[];
  /** The rest of the plant. Offered behind "show other people in this plant". */
  elsewhere: BoardOperator[];
}

/**
 * Split the plant's people for ONE PLACE — a board root, or a cell.
 *
 * ⭐ "HERE" IS AT-OR-BELOW IN EITHER DIRECTION, and both halves are load-bearing.
 *
 *   home covers the place  — homed at the plant, on a line's board: the
 *                            maintainer's "available to all lower hierarchy".
 *   home inside the place  — homed at Cell 1, on Line 1's board: they work in
 *                            this line, so the line's panel must list them.
 *
 * A plant admin's board is the plant, so every person in the plant satisfies
 * the second half and `elsewhere` is empty — which is what "the rest of the
 * plant" means when the place IS the plant.
 *
 * @param placePath the place's ltree path. `null` or `""` -> everyone is
 *   `here`; see the file header on the one fail-open.
 */
export function splitPeopleFor(
  operators: readonly BoardOperator[],
  placePath: string | null,
): PeopleSplit {
  if (placePath === null || placePath === "") return { here: [...operators], elsewhere: [] };
  const here: BoardOperator[] = [];
  const elsewhere: BoardOperator[] = [];
  for (const o of operators) {
    const home = o.sitePath;
    const covers = home !== "" && isAtOrBelow(placePath, home);
    const inside = home !== "" && isAtOrBelow(home, placePath);
    (covers || inside ? here : elsewhere).push(o);
  }
  return { here, elsewhere };
}

/**
 * D113: the people who do NOT belong at a CELL — the set the pickers annotate
 * "not from this area (override)" and ask a reason for.
 *
 * ⚠️ THIS IS NOT `elsewhere` ABOVE, AND CONFLATING THEM WOULD BE WRONG IN BOTH
 * DIRECTIONS. The split is about a PLACE and is generous downward: a person
 * homed at Cell 1 is `here` on Line 1's board, because that is their line. The
 * mark is about a CELL and is the server's write guard transcribed: that same
 * person placed on Cell 2 is outside their area, and `create_assignment` will
 * ask for the reason. So the panel lists them and a pop-up on Cell 2 marks
 * them, and both are right.
 *
 * @param cellPath the cell's ltree path, or `null` when it cannot be resolved
 *   — in which case nobody is marked (the file header says why).
 */
export function outsideAreaOperatorIds(
  operators: readonly BoardOperator[],
  cellPath: string | null,
): Set<string> {
  const out = new Set<string>();
  if (cellPath === null || cellPath === "") return out;
  for (const o of operators) {
    // An empty home is a synthesised row (D110) and cannot cover anything.
    if (o.sitePath === "" || !isAtOrBelow(cellPath, o.sitePath)) out.add(o.id);
  }
  return out;
}
