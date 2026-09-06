import { describe, expect, it } from "vitest";
import type { BoardOperator } from "@/lib/api";
import { outsideAreaOperatorIds, splitPeopleFor } from "@/features/board/lib/outsideArea";

/**
 * R-346 / S39 — WHO IS OFFERED WHERE, AND WHO IS MARKED.
 *
 * ⭐⭐ THE MAINTAINER'S RULE, 6 Sept, is the whole of this file: *"If a operator
 * is assigned to higher hierarchy they should automatically become available to
 * all lower hierarchy within that hierarchy ... That should be the default
 * behaviour. For other operators in the plant we need to give an option to the
 * supervisor to click through something so show remaining operators so they can
 * make that decision to assign someone outside of that area."*
 *
 * The board it is judged on is Ana's: a supervisor granted LINE 1, whose board
 * therefore starts at that line, in a plant whose people are homed ABOVE it.
 * That board is the one that was broken — an empty panel and a reason asked of
 * everybody — and it is the one every case here is written from.
 *
 * ---------------------------------------------------------------------------
 * ⚠️⚠️ THE FIXTURE IS SEVEN STRINGS AND NO BOARD, AND THAT IS THE POINT OF THE
 * CHANGE. The previous version of this file built a whole `BoardWindow` and ran
 * `buildBoardIndex` over it, because the decision was made by resolving each
 * person's owner through the board's node map. That map is the thing that was
 * wrong: `board_window` sends the nodes at or below the READER'S root, so a
 * missing node meant "another plant" for a plant admin and "above your grant"
 * for a supervisor, and no predicate reading that map could tell the two apart.
 * Migration 0058 sends each person's home as a PATH, so there is no map, no
 * index and no fixture left to get wrong — two strings and `isAtOrBelow`, the
 * same comparison `app_owner_covers_in_org` makes on the server.
 *
 * ⛔ THE "ANOTHER PLANT" CASE THAT THIS FILE USED TO EXIST FOR IS DELETED, and
 * not because it stopped mattering. R-345 moved it out of reach of the screen
 * entirely: migration 0058's table guard refuses a cross-plant placement
 * override or not, so no writer can make such a row, and `board_window` sends
 * only the plant's own people, so no picker is ever handed one. A unit case
 * here could only prove that a fixture nobody can build is handled — the rule
 * is the database's now, and `supabase/tests` is where it is proved. What this
 * file keeps is the half that is still a screen decision: which of the PLANT'S
 * people are a default offer, and which need the reason.
 */

/** Ana's board: she is granted Line 1, so this is the place the panel splits for. */
const LINE_1 = "plant_a.area_1.line_1";
/** A cell under it — what a pop-up opened on the board splits for. */
const CELL_1 = "plant_a.area_1.line_1.cell_1";
const CELL_2 = "plant_a.area_1.line_1.cell_2";
/** A plant admin's board. */
const PLANT = "plant_a";

function op(id: string, sitePath: string): BoardOperator {
  return {
    id,
    homeNodeId: null,
    displayName: id,
    employeeRef: null,
    active: true,
    siteNodeId: `n-${id}`,
    sitePath,
    skillIds: [],
    skillExpiries: [],
  };
}

/**
 * The demo plant, as `dev_demo.sql` builds it and 0058 sends it: one person
 * homed on Line 1 itself and the rest homed at the plant — plus, deliberately,
 * the two neighbours that decide the interesting cases.
 */
const AT_PLANT = op("at the plant", "plant_a");
const AT_AREA_1 = op("in Area 1", "plant_a.area_1");
const AT_LINE_1 = op("on Line 1", "plant_a.area_1.line_1");
const AT_CELL_1 = op("in Cell 1", "plant_a.area_1.line_1.cell_1");
const AT_AREA_2 = op("in Area 2", "plant_a.area_2");
/**
 * ⚠️ A SLUG THAT EXTENDS THIS LINE'S. `plant_a.area_1.line_1` is a prefix of the
 * STRING `plant_a.area_1.line_10` and is not an ancestor of that NODE. Ten lines
 * is not an exotic plant, and a `startsWith` here is right on every fixture
 * anybody would think to build except this one.
 */
const AT_LINE_10 = op("on Line 10", "plant_a.area_1.line_10");

const PLANT_PEOPLE = [AT_PLANT, AT_AREA_1, AT_LINE_1, AT_CELL_1, AT_AREA_2, AT_LINE_10];

function names(people: readonly BoardOperator[]): string[] {
  return people.map((o) => o.displayName);
}

/** The marked names, so a failure reads as people rather than as ids. */
function markedAt(cellPath: string | null): string[] {
  const ids = outsideAreaOperatorIds(PLANT_PEOPLE, cellPath);
  return names(PLANT_PEOPLE.filter((o) => ids.has(o.id)));
}

describe("R-346: a line supervisor's board — the default list, and the click", () => {
  const split = splitPeopleFor(PLANT_PEOPLE, LINE_1);

  /**
   * ⭐⭐ THE DEFECT, IN ONE ASSERTION. Ana saw an empty panel because the pool
   * kept only people whose owner node was on her board, and her board starts at
   * Line 1 while five of the six are homed at the plant. "If a operator is
   * assigned to higher hierarchy they should automatically become available to
   * all lower hierarchy within that hierarchy."
   */
  it("somebody homed at the PLANT is offered here by default", () => {
    expect(names(split.here)).toContain("at the plant");
    expect(names(split.elsewhere)).not.toContain("at the plant");
  });

  it("so is somebody homed at the AREA above this line, and on the line itself", () => {
    expect(names(split.here)).toEqual(
      expect.arrayContaining(["in Area 1", "on Line 1", "at the plant"]),
    );
  });

  /**
   * The other direction, and it is not symmetry for its own sake: a person
   * homed at a cell UNDER this line works on this line, so the line's panel has
   * to list them. Only a home that is neither above nor below is "elsewhere".
   */
  it("and somebody homed INSIDE it — at a cell under this line — is here too", () => {
    expect(names(split.here)).toContain("in Cell 1");
  });

  it("⭐ another AREA of the same plant is the click, not the default", () => {
    expect(names(split.elsewhere)).toContain("in Area 2");
    expect(names(split.here)).not.toContain("in Area 2");
  });

  it("⚠️ so is a sibling line whose slug merely extends this one's", () => {
    expect(names(split.elsewhere)).toContain("on Line 10");
  });

  it("the whole answer, so a new person cannot slip past the two lists above", () => {
    expect(names(split.here)).toEqual(["at the plant", "in Area 1", "on Line 1", "in Cell 1"]);
    expect(names(split.elsewhere)).toEqual(["in Area 2", "on Line 10"]);
  });
});

describe("R-346: the mark is a different question from the split", () => {
  /**
   * ⭐⭐ NOT THE COMPLEMENT OF `elsewhere`, AND CONFLATING THEM WOULD BE WRONG
   * IN BOTH DIRECTIONS. The split is about a PLACE and is generous downward;
   * the mark is about a CELL and is the server's write guard transcribed. The
   * person homed in Cell 1 is a default offer on Line 1's board AND is marked
   * on Cell 2, because `create_assignment` will ask them for the reason.
   */
  it("nobody whose home covers the cell is marked", () => {
    const marked = markedAt(CELL_1);
    expect(marked).not.toContain("at the plant");
    expect(marked).not.toContain("in Area 1");
    expect(marked).not.toContain("on Line 1");
    expect(marked).not.toContain("in Cell 1");
  });

  it("⭐ somebody homed in another area IS marked", () => {
    expect(markedAt(CELL_1)).toContain("in Area 2");
  });

  it("and a person homed in Cell 1 is marked on Cell 2, though the panel offers them", () => {
    expect(markedAt(CELL_2)).toContain("in Cell 1");
    expect(names(splitPeopleFor(PLANT_PEOPLE, LINE_1).here)).toContain("in Cell 1");
  });

  it("the whole marked list at Cell 1 — the person homed AT it is not on it", () => {
    // `@>` is reflexive: a home equal to the cell covers it. Marking that
    // person would be the screen refusing what the server takes.
    expect(markedAt(CELL_1).sort()).toEqual(["in Area 2", "on Line 10"]);
  });
});

describe("R-346: a plant admin's board", () => {
  it("⭐ everyone in the plant is a default offer, so there is nothing behind the click", () => {
    const split = splitPeopleFor(PLANT_PEOPLE, PLANT);
    expect(names(split.here)).toEqual(names(PLANT_PEOPLE));
    expect(split.elsewhere).toEqual([]);
  });

  it("⚠️ and the mark is unchanged by the wider board: Area 2 is still outside a cell in Area 1", () => {
    // The board the reader chose is a VIEW; the cell's own ancestry is not. A
    // plant admin scheduling Cell 1 is asked for the same reason Ana is.
    expect(markedAt(CELL_1)).toContain("in Area 2");
  });
});

describe("the one fail-open, and it is the PLACE", () => {
  it("an unresolvable place offers everyone rather than nobody", () => {
    // The board before it has loaded, and a pop-up whose node is not in this
    // window. There is nothing to compare anybody against, and hiding the list
    // is the invisible failure; the server is the backstop either way.
    expect(names(splitPeopleFor(PLANT_PEOPLE, null).here)).toEqual(names(PLANT_PEOPLE));
    expect(splitPeopleFor(PLANT_PEOPLE, "").elsewhere).toEqual([]);
  });

  it("and marks nobody", () => {
    expect(markedAt(null)).toEqual([]);
    expect(markedAt("")).toEqual([]);
  });

  /**
   * ⚠️ THE OPPOSITE FAIL-OPEN IS REFUSED. An empty HOME — D110's synthesised
   * departed person — covers nothing and is not waved through as belonging
   * everywhere, which is the mistake `offeredAt`'s fail-open would make if such
   * a row ever reached a picker.
   */
  it("a person with no home at all is marked and is not a default offer", () => {
    const ghost = op("departed", "");
    expect(outsideAreaOperatorIds([ghost], CELL_1).has(ghost.id)).toBe(true);
    expect(splitPeopleFor([ghost], LINE_1).here).toEqual([]);
  });
});
