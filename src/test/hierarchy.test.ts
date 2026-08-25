import { describe, expect, it } from "vitest";
import {
  buildHierarchyTree,
  canDropOn,
  pathDepth,
  prospectivePath,
  slugify,
  validateLevelDraft,
} from "@/features/admin/lib/hierarchy";
import type { LevelDraft, LevelRow, NodeRow } from "@/features/admin/lib/hierarchy";

/**
 * Permanent guard for the P1-5b pure hierarchy layer.
 *
 * The P1-5b brief specified a 76-assertion suite but its §3 file table never
 * listed a test file, so the build agent ran its suite in a scratch container
 * that no longer exists. This file is the design session's replacement: it
 * carries the brief's §6 corpus and §8 groups, plus the extra cases found by
 * the independent verification probe (design-plan §19.12).
 *
 * Every `slugify` expectation below -- the brief's 33 rows AND the Unicode
 * rows -- was produced by running the SQL `slugify()` from migration
 * 20260821000001 against PostgreSQL 16 with a UTF-8 database. They are
 * OBSERVATIONS, not predictions. If one fails, check which side moved.
 */

// ---------------------------------------------------------------------------
// slugify -- the corpus IS the contract (brief §6)
// ---------------------------------------------------------------------------

const SLUG_CASES: Array<[label: string, input: string, expected: string]> = [
  ["plain", "Cell 1", "cell_1"],
  ["dash", "Cell-1", "cell_1"],
  ["two words", "CNC Line", "cnc_line"],
  ["leading digit + symbol", "3 × 8h", "n_3_8h"],
  ["spaces only", "  ", "n_"],
  ["ordinal", "2nd Shift", "n_2nd_shift"],
  ["plant", "Plant 1", "plant_1"],
  ["single word", "Assembly", "assembly"],
  ["line", "Line 2", "line_2"],
  ["work cell", "Work Cell", "work_cell"],
  ["empty", "", "n_"],
  ["underscores only", "___", "n_"],
  ["upper single", "A", "a"],
  ["lower single", "a", "a"],
  // Postgres does NOT transliterate. `.normalize("NFD")` is the wrong instinct.
  ["accents are NOT transliterated", "ÀÉÎÕÜ", "n_"],
  ["accents mixed with ascii", "Ünïcödé Zoné", "n_c_d_zon"],
  ["double underscore collapses", "cell__1", "cell_1"],
  ["wrapped underscores", "_lead_", "lead"],
  ["padded", "  padded  ", "padded"],
  ["run of spaces", "Multi   Space", "multi_space"],
  ["run of dashes", "dash-dash--dash", "dash_dash_dash"],
  ["dot", "dot.dot", "dot_dot"],
  ["slash", "slash/slash", "slash_slash"],
  ["paren", "paren(1)", "paren_1"],
  ["percent", "100%", "n_100"],
  ["hash leading", "#4", "n_4"],
  ["hash trailing", "4#", "n_4"],
  ["bare digit", "9", "n_9"],
  ["leading zero", "0900 shift", "n_0900_shift"],
  ["greek omega", "Ω", "n_"],
  ["emoji", "emoji 🙂 here", "emoji_here"],
  ["tab", "tab\tsep", "tab_sep"],
  ["newline", "new\nline", "new_line"],
  // --- beyond the brief's corpus: Unicode case mapping, all re-run against PG ---
  ["kelvin sign U+212A lowercases to k", "K", "k"],
  ["turkish dotted I U+0130", "İ", "i"],
  ["fullwidth A stays non-ascii", "Ａ", "n_"],
  ["roman numeral I U+2160", "Ⅰ", "n_"],
  ["long input is not truncated", "a".repeat(300), "a".repeat(300)],
  ["digits wrapped in underscores", "__9__", "n_9"],
  ["digit after trimming", "_9", "n_9"],
  ["leading digit after collapse", "--7up", "n_7up"],
];

describe("slugify (parity with the SQL slugify() in migration 0001)", () => {
  for (const [label, input, expected] of SLUG_CASES) {
    it(`${label}: ${JSON.stringify(input).slice(0, 40)} -> ${expected.slice(0, 20)}`, () => {
      expect(slugify(input)).toBe(expected);
    });
  }

  it("is idempotent for an ordinary slug", () => {
    expect(slugify(slugify("Cell 1"))).toBe("cell_1");
  });

  // The empty-name sentinel is NOT a fixed point: slugify("n_") === "n". The SQL
  // does the same. Matters for P1-5d, which may re-slugify stored values.
  it("the n_ sentinel is NOT a fixed point (the SQL agrees)", () => {
    expect(slugify(slugify("###"))).toBe("n");
  });
});

// ---------------------------------------------------------------------------
// pathDepth / prospectivePath
// ---------------------------------------------------------------------------

describe("pathDepth", () => {
  const CASES: Array<[string, number]> = [
    ["", 0],
    ["a", 1],
    ["a.b.c", 3],
    [".", 2],
    ["a..b", 3],
  ];
  for (const [path, want] of CASES) {
    it(`${JSON.stringify(path)} -> ${want}`, () => expect(pathDepth(path)).toBe(want));
  }
});

describe("prospectivePath", () => {
  const CASES: Array<[string | null, string, string]> = [
    ["p1.a1", "Cell 1", "p1.a1.cell_1"],
    [null, "Plant 1", "plant_1"],
    // A root parent arrives as "" from some callers and null from others.
    ["", "Plant 1", "plant_1"],
    ["p1", "Cell-1", "p1.cell_1"],
    ["a", "###", "a.n_"],
  ];
  for (const [parent, name, want] of CASES) {
    it(`${JSON.stringify(parent)} + ${JSON.stringify(name)} -> ${want}`, () =>
      expect(prospectivePath(parent, name)).toBe(want));
  }
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * D86: every level belongs to a template. `templateId` defaults to a single
 * shape so all the pre-D86 cases below keep testing exactly what they tested
 * before — an org with one hierarchy shape, which is still the common case.
 * The cross-template cases pass a second one explicitly.
 */
export const TEMPLATE_A = "tpl-a";
export const TEMPLATE_B = "tpl-b";

const L = (
  id: string,
  position: number,
  isSchedulable = false,
  templateId: string = TEMPLATE_A,
): LevelRow => ({
  id,
  templateId,
  position,
  name: id,
  isSchedulable,
});

const N = (
  id: string,
  path: string,
  levelId: string,
  parentId: string | null = null,
  sortOrder = 0,
  name?: string,
): NodeRow => ({
  id,
  name: name ?? path.split(".").slice(-1)[0],
  path,
  parentId,
  levelId,
  sortOrder,
  active: true,
});

const LEVELS = [L("l0", 0), L("l1", 1), L("l2", 2, true)];

/**
 * Paths here are SLUG-CONSISTENT with names, exactly as the database derives
 * them. That matters: a no-op drop re-derives the node's own path, so a
 * collision check that forgets to exclude the dragged node reports a false
 * path_collision. With `c1` at a hand-written path like "p1.a1.c1", nothing
 * ever holds the prospective path and that bug is invisible.
 */
const TREE: NodeRow[] = [
  N("p1", "plant_1", "l0", null, 0, "Plant 1"),
  N("a1", "plant_1.area_1", "l1", "p1", 0, "Area 1"),
  N("a2", "plant_1.area_2", "l1", "p1", 1, "Area 2"),
  N("c1", "plant_1.area_1.cell_1", "l2", "a1", 0, "Cell 1"),
  N("c2", "plant_1.area_1.cell_2", "l2", "a1", 1, "Cell 2"),
];

// ---------------------------------------------------------------------------
// buildHierarchyTree
// ---------------------------------------------------------------------------

describe("buildHierarchyTree", () => {
  it("produces one root at depth 0 with the whole tree beneath it", () => {
    const t = buildHierarchyTree(TREE, LEVELS);
    expect(t.length).toBe(1);
    expect(t[0].depth).toBe(0);
    expect(t[0].children.length).toBe(2);
    expect(t[0].children[0].children.length).toBe(2);
  });

  it("gives each node depth = pathDepth - 1", () => {
    const t = buildHierarchyTree(TREE, LEVELS);
    expect(t[0].children[0].depth).toBe(1);
    expect(t[0].children[0].children[0].depth).toBe(2);
  });

  it("returns [] for empty input", () => {
    expect(buildHierarchyTree([], LEVELS)).toEqual([]);
  });

  // A mid-tree slice roots at its shallowest node, and that root keeps its
  // ABSOLUTE depth -- it does not renumber to 0.
  it("roots a mid-tree slice at its shallowest node, keeping absolute depth", () => {
    const slice = [N("a1", "p1.a1", "l1"), N("c1", "p1.a1.c1", "l2")];
    const t = buildHierarchyTree(slice, LEVELS);
    expect(t.length).toBe(1);
    expect(t[0].node.id).toBe("a1");
    expect(t[0].depth).toBe(1);
    expect(t[0].children[0].depth).toBe(2);
  });

  // M6: linkage must come from `path`, never `parentId`. The fixture makes the
  // two DISAGREE -- a seed-shaped fixture, where they agree, cannot see this.
  it("links by path even when parentId disagrees", () => {
    const nodes = [
      N("p1", "p1", "l0"),
      N("a1", "p1.a1", "l1", "p1"),
      N("a2", "p1.a2", "l1", "p1"),
      N("c1", "p1.a1.c1", "l2", "a2"), // claims a2, but its PATH is under a1
    ];
    const t = buildHierarchyTree(nodes, LEVELS);
    const a1 = t[0].children.find((c) => c.node.id === "a1");
    const a2 = t[0].children.find((c) => c.node.id === "a2");
    expect(a1?.children.map((c) => c.node.id)).toEqual(["c1"]);
    expect(a2?.children.length).toBe(0);
  });

  it("treats a node whose path-parent is absent as a root, even with a parentId", () => {
    const nodes = [N("c1", "p1.a1.c1", "l2", "a1")];
    expect(buildHierarchyTree(nodes, LEVELS).length).toBe(1);
  });

  // M7: sortOrder must win over name. Fixture makes them DISAGREE.
  it("sorts siblings by sortOrder before name", () => {
    const nodes = [
      N("p1", "p1", "l0"),
      N("z", "p1.z", "l1", "p1", 0, "Zulu"),
      N("a", "p1.a", "l1", "p1", 1, "Alpha"),
    ];
    const t = buildHierarchyTree(nodes, LEVELS);
    expect(t[0].children.map((c) => c.node.name)).toEqual(["Zulu", "Alpha"]);
  });

  it("falls back to name when sortOrder ties", () => {
    const nodes = [
      N("p1", "p1", "l0"),
      N("z", "p1.z", "l1", "p1", 0, "Zulu"),
      N("a", "p1.a", "l1", "p1", 0, "Alpha"),
    ];
    const t = buildHierarchyTree(nodes, LEVELS);
    expect(t[0].children.map((c) => c.node.name)).toEqual(["Alpha", "Zulu"]);
  });

  // The order must be TOTAL, or equal keys reshuffle between renders.
  it("falls back to id when sortOrder AND name tie", () => {
    const nodes = [
      N("p1", "p1", "l0"),
      N("id_b", "p1.b", "l1", "p1", 0, "Same"),
      N("id_a", "p1.a", "l1", "p1", 0, "Same"),
    ];
    const t = buildHierarchyTree(nodes, LEVELS);
    expect(t[0].children.map((c) => c.node.id)).toEqual(["id_a", "id_b"]);
  });

  // Deep children must be sorted too, not just the roots.
  it("sorts grandchildren, not only the top level", () => {
    const nodes = [
      N("p1", "p1", "l0"),
      N("a1", "p1.a1", "l1", "p1", 0),
      N("z", "p1.a1.z", "l2", "a1", 0, "Zulu"),
      N("a", "p1.a1.a", "l2", "a1", 1, "Alpha"),
    ];
    const t = buildHierarchyTree(nodes, LEVELS);
    expect(t[0].children[0].children.map((c) => c.node.name)).toEqual(["Zulu", "Alpha"]);
  });

  it("does not mutate its inputs", () => {
    const nodes = [
      N("p1", "p1", "l0"),
      N("z", "p1.z", "l1", "p1", 5),
      N("a", "p1.a", "l1", "p1", 1),
    ];
    const levels = [L("l1", 1), L("l0", 0)];
    const nodesBefore = JSON.stringify(nodes);
    const levelsBefore = JSON.stringify(levels);
    buildHierarchyTree(nodes, levels);
    expect(JSON.stringify(nodes)).toBe(nodesBefore);
    expect(JSON.stringify(levels)).toBe(levelsBefore);
  });

  it("returns independent structures on repeated calls", () => {
    const first = buildHierarchyTree(TREE, LEVELS);
    const second = buildHierarchyTree(TREE, LEVELS);
    first[0].children.length = 0;
    expect(second[0].children.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// canDropOn -- mirrors move_node's check ORDER (migration 0010)
// ---------------------------------------------------------------------------

type Drop = { ok: true; noop: boolean } | { ok: false; reason: string };

describe("canDropOn", () => {
  const CASES: Array<{
    label: string;
    dragged: string;
    target: string | null;
    nodes?: NodeRow[];
    levels?: LevelRow[];
    want: Drop;
  }> = [
    {
      label: "legal move to a sibling parent",
      dragged: "c1",
      target: "a2",
      want: { ok: true, noop: false },
    },
    {
      label: "onto its current parent is a NO-OP, not a rejection",
      dragged: "c1",
      target: "a1",
      want: { ok: true, noop: true },
    },
    {
      label: "onto itself is a cycle",
      dragged: "a1",
      target: "a1",
      want: { ok: false, reason: "node_cycle" },
    },
    {
      label: "beneath its own descendant is a cycle",
      dragged: "a1",
      target: "c1",
      want: { ok: false, reason: "node_cycle" },
    },
    {
      label: "skipping a level",
      dragged: "c1",
      target: "p1",
      want: { ok: false, reason: "level_mismatch" },
    },
    {
      label: "unknown dragged node",
      dragged: "nope",
      target: "a1",
      want: { ok: false, reason: "invalid_argument" },
    },
    {
      label: "unknown target",
      dragged: "c1",
      target: "nope",
      want: { ok: false, reason: "invalid_argument" },
    },
    {
      label: "non-root to a null parent",
      dragged: "c1",
      target: null,
      want: { ok: false, reason: "level_mismatch" },
    },
    {
      label: "root to a null parent is a no-op",
      dragged: "p1",
      target: null,
      want: { ok: true, noop: true },
    },
    {
      label: "dragged node's level id is absent from levels",
      dragged: "c1",
      target: "a2",
      levels: [L("l0", 0), L("l1", 1)],
      want: { ok: false, reason: "invalid_argument" },
    },
    {
      label: "destination already holds the slug",
      dragged: "c1",
      target: "a2",
      nodes: [...TREE, N("x", "plant_1.area_2.cell_1", "l2", "a2", 0, "Cell 1")],
      want: { ok: false, reason: "path_collision" },
    },
  ];

  for (const c of CASES) {
    it(c.label, () => {
      expect(canDropOn(c.dragged, c.target, c.nodes ?? TREE, c.levels ?? LEVELS)).toEqual(c.want);
    });
  }

  // The cycle check MUST precede the level check. Every move beneath one's own
  // descendant also skips a level, so with the order reversed a genuine cycle
  // is misreported as level_mismatch.
  it("reports node_cycle for a drop that is BOTH a cycle and a level skip", () => {
    const deep = [
      N("p1", "p1", "l0"),
      N("a1", "p1.a1", "l1", "p1"),
      N("c1", "p1.a1.c1", "l2", "a1"),
    ];
    expect(canDropOn("p1", "c1", deep, LEVELS)).toEqual({ ok: false, reason: "node_cycle" });
  });

  // A sibling's path can be a string PREFIX of another's without being an
  // ancestor: line_10 is not beneath line_1. The ancestry test needs the dot.
  it("does not treat line_10 as a descendant of line_1", () => {
    const nodes = [
      N("p1", "p1", "l0"),
      N("a1", "p1.a1", "l1", "p1"),
      N("l1n", "p1.a1.line_1", "l2", "a1", 0, "Line 1"),
      N("l10", "p1.a1.line_10", "l2", "a1", 1, "Line 10"),
    ];
    // Both sit at the same level, so the honest answer is level_mismatch. A
    // descendant test missing the separator answers node_cycle instead.
    expect(canDropOn("l1n", "l10", nodes, LEVELS)).toEqual({
      ok: false,
      reason: "level_mismatch",
    });
  });

  it("excludes the dragged node itself from the collision check", () => {
    // Without the exclusion, a no-op drop onto the current parent reports
    // path_collision against the node's own existing path.
    expect(canDropOn("c1", "a1", TREE, LEVELS)).toEqual({ ok: true, noop: true });
  });

  it("still checks collision on a root move", () => {
    const roots = [
      N("r1", "plant_1", "l0", null, 0, "Plant 1"),
      N("r2", "plant_2", "l0", null, 1, "Plant 1"),
    ];
    expect(canDropOn("r2", null, roots, LEVELS)).toEqual({ ok: false, reason: "path_collision" });
  });

  it("does not mutate its inputs", () => {
    const before = JSON.stringify(TREE);
    canDropOn("c1", "a2", TREE, LEVELS);
    expect(JSON.stringify(TREE)).toBe(before);
  });

  /**
   * KNOWN GAP, recorded deliberately (design-plan §19.12). The brief's §4 step 1
   * covers an unknown DRAGGED level but never says what an unknown TARGET level
   * does; it falls through to step 6 as `level_mismatch`. Either way, passing a
   * PARTIAL levels array makes the client reject a move the server would accept
   * -- the direction §5 forbids. P1-5c MUST pass the complete level list.
   */
  it("reports level_mismatch when the TARGET's level is missing from levels", () => {
    expect(canDropOn("c1", "a2", TREE, [L("l0", 0), L("l2", 2)])).toEqual({
      ok: false,
      reason: "level_mismatch",
    });
  });
});

// ---------------------------------------------------------------------------
// validateLevelDraft -- mirrors save_hierarchy_levels' order
// ---------------------------------------------------------------------------

const D = (name: string, isSchedulable = false): LevelDraft => ({ id: null, name, isSchedulable });
const fill = (n: number) => Array.from({ length: n }, (_, i) => D(`level ${i}`));

describe("validateLevelDraft", () => {
  const CASES: Array<[label: string, draft: LevelDraft[], want: unknown]> = [
    ["a valid draft", [D("Plant"), D("Area"), D("Cell", true)], { ok: true }],
    ["empty array", [], { ok: false, reason: "empty" }],
    ["zero schedulable", [D("Plant"), D("Area")], { ok: false, reason: "schedulable_count" }],
    [
      "two schedulable",
      [D("Plant", true), D("Area", true)],
      { ok: false, reason: "schedulable_count" },
    ],
    ["a blank name", [D("Plant", true), D("   ")], { ok: false, reason: "blank_name" }],
    ["exactly 64 is fine", [D("s", true), ...fill(63)], { ok: true }],
    ["65 is too many", [D("s", true), ...fill(64)], { ok: false, reason: "too_many" }],
    // too_many must precede schedulable_count...
    [
      "65 with zero schedulable still reports too_many",
      fill(65),
      { ok: false, reason: "too_many" },
    ],
    // ...and schedulable_count must precede blank_name.
    [
      "zero schedulable AND a blank name reports schedulable_count",
      [D("Plant"), D("  ")],
      { ok: false, reason: "schedulable_count" },
    ],
    // Not an array -- checked first.
    ["null", null as unknown as LevelDraft[], { ok: false, reason: "not_an_array" }],
    ["undefined", undefined as unknown as LevelDraft[], { ok: false, reason: "not_an_array" }],
    ["a string", "abc" as unknown as LevelDraft[], { ok: false, reason: "not_an_array" }],
    [
      "an array-like object",
      { length: 1 } as unknown as LevelDraft[],
      { ok: false, reason: "not_an_array" },
    ],
  ];

  for (const [label, draft, want] of CASES) {
    it(label, () => expect(validateLevelDraft(draft)).toEqual(want));
  }

  /**
   * Malformed entries must return a typed reason, never throw. The server
   * treats a missing/null name as blank (`trim(coalesce(e->>'name',''))=''`)
   * and a null array element as non-schedulable; these three assert parity.
   * All three THREW before the design-session fix (design-plan §19.12).
   */
  describe("malformed entries return a reason instead of throwing", () => {
    it("a null name reads as blank", () => {
      expect(
        validateLevelDraft([{ id: null, name: null as unknown as string, isSchedulable: true }]),
      ).toEqual({ ok: false, reason: "blank_name" });
    });

    it("a missing name key reads as blank", () => {
      expect(
        validateLevelDraft([{ id: null, isSchedulable: true } as unknown as LevelDraft]),
      ).toEqual({ ok: false, reason: "blank_name" });
    });

    it("a null array element reads as blank and non-schedulable", () => {
      expect(validateLevelDraft([null as unknown as LevelDraft, D("ok", true)])).toEqual({
        ok: false,
        reason: "blank_name",
      });
    });

    it("a numeric name is not blank (the server stringifies it too)", () => {
      expect(
        validateLevelDraft([{ id: null, name: 42 as unknown as string, isSchedulable: true }]),
      ).toEqual({ ok: true });
    });
  });

  /**
   * KNOWN DIVERGENCE, recorded deliberately (design-plan §19.12). Postgres
   * `trim()` with no explicit character set strips SPACES ONLY, so the server
   * ACCEPTS a tab/newline-only level name while JS `.trim()` makes the client
   * reject it -- the direction brief §5 forbids. The fix belongs in the SERVER
   * (btrim over whitespace) and is owed before P1-5d pipes CSV into this.
   * This test pins the CURRENT client behaviour so the divergence cannot be
   * closed accidentally without someone reading this comment.
   */
  it("rejects a tab-only name, which the SERVER currently accepts", () => {
    expect(validateLevelDraft([D("Plant", true), D("\t\n ")])).toEqual({
      ok: false,
      reason: "blank_name",
    });
  });

  it("accepts duplicate ids -- the server owns that rule", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(
      validateLevelDraft([
        { id, name: "a", isSchedulable: true },
        { id, name: "b", isSchedulable: false },
      ]),
    ).toEqual({ ok: true });
  });
});

/**
 * D86 (migration 0014) — a node may only sit under a parent from the SAME
 * hierarchy template.
 *
 * Once an org holds two shapes, level POSITION stops being enough to identify
 * a legal parent: a Line at position 2 of shape A and a Department at position
 * 1 of shape B satisfy `2 === 1 + 1` and have nothing to do with each other.
 * D2 is the case that matters, and its fixture is built so the ARITHMETIC
 * PASSES — otherwise it would be a duplicate of the level-mismatch cases above
 * and would go on passing with the template check deleted.
 *
 * Mutation-verified: replacing the template comparison with `false` breaks D2
 * and ONLY D2.
 *
 * Check order mirrors the server (`nodes_check_level_adjacency`): POSITION
 * first, TEMPLATE second. Both report `level_mismatch`, so D3 cannot tell them
 * apart by reason code — it exists to prove the cross-template path does not
 * accidentally start reporting something else.
 */
describe("canDropOn — hierarchy templates (D86)", () => {
  const TL = [
    L("a0", 0, false, TEMPLATE_A),
    L("a1", 1, false, TEMPLATE_A),
    L("a2", 2, true, TEMPLATE_A),
    L("b0", 0, false, TEMPLATE_B),
    L("b1", 1, false, TEMPLATE_B),
    L("b2", 2, true, TEMPLATE_B),
  ];
  const TN = [
    N("pa", "plant_a", "a0", null, 0, "Plant A"),
    N("da", "plant_a.dept", "a1", "pa", 0, "Dept"),
    N("la", "plant_a.dept.line_1", "a2", "da", 0, "Line 1"),
    N("pb", "plant_b", "b0", null, 0, "Plant B"),
    N("zb", "plant_b.zone", "b1", "pb", 0, "Zone"),
    N("bb", "plant_b.zone.bay_1", "b2", "zb", 0, "Bay 1"),
  ];

  it("D1: a same-template move is still legal", () => {
    expect(canDropOn("la", "da", TN, TL)).toEqual({ ok: true, noop: true });
  });

  it("D2: a cross-template parent is refused even when the positions line up", () => {
    // Line(shape A, position 2) onto Zone(shape B, position 1): 2 === 1 + 1.
    expect(canDropOn("la", "zb", TN, TL)).toEqual({ ok: false, reason: "level_mismatch" });
  });

  it("D3: cross-template AND wrong position is still level_mismatch", () => {
    expect(canDropOn("la", "pb", TN, TL)).toEqual({ ok: false, reason: "level_mismatch" });
  });

  it("D4: a root move is position-only and untouched by templates", () => {
    expect(canDropOn("pa", null, TN, TL)).toEqual({ ok: true, noop: true });
  });

  it("D5: the second shape works internally, exactly like the first", () => {
    expect(canDropOn("bb", "zb", TN, TL)).toEqual({ ok: true, noop: true });
  });
});
