/**
 * Acceptance suite for `src/features/admin/lib/trainings.ts` — the pure half of
 * the Trainings section (roadmap stage 22).
 *
 * A VITEST suite, because `npm run test` is what guards this permanently and
 * vitest collects every `src/test/*.test.ts`. One plain `it()` per case, never
 * `it.each`: a table-driven case that fails names the table, not the rule that
 * broke, and this file exists to name the rule.
 *
 * ⭐ WHAT IS UNDER TEST IS THE PURE MODULE, NOT THE PANEL. `TrainingsPanel.tsx`
 * renders what these functions return and decides nothing itself; what only the
 * rendered screen can answer — that the plant filter reaches the list and the
 * form, that a `"this-plant"` clash leaves Add live, that two same-named rows
 * are told apart — is `src/test/trainingsPanel.test.tsx`. The same split
 * `products.test.ts` / `productsPanel.test.tsx` already draws.
 *
 * THE FIXTURE — three trainings, and the second pair is the whole of 0031:
 *
 *   Forklift   Line A   live       <- two rows, one name, two owners.
 *   Forklift   Line B   live       <- LEGAL since `unique (org_id, site_node_id, name)`
 *   Welding    Line A   RETIRED    <- still held by whoever holds it
 */
import { describe, expect, it } from "vitest";
import type { SchedulerError } from "@/lib/api";
import {
  NAMES_SHOWN,
  NAME_MAX_LENGTH,
  NO_DOCUMENT_NUMBER,
  describeDocumentNumberRefusal,
  describeTrainingWriteRefusal,
  documentNumberLabel,
  hiddenByPlantNote,
  listStrandedHolders,
  matchesTrainingQuery,
  moveCosts,
  partitionTrainings,
  previewTrainingMove,
  retireActionLabel,
  retiredClashNote,
  skippedRowsNote,
  summariseTrainingMove,
  trainingHandle,
  validateTrainingDraft,
  type TrainingHolder,
  type TrainingPlace,
  type TrainingRow,
} from "../features/admin/lib/trainings.ts";
// ⭐⭐ THE **REAL** `isAtOrBelow`, NOT A STAND-IN. `previewTrainingMove` takes
// the predicate as a parameter precisely so `trainings.ts` keeps no runtime
// imports; a test that passed its own `startsWith` would pin the plumbing and
// miss the one thing that has actually bitten this codebase — `plant_1.line_1`
// is a string prefix of `plant_1.line_10` and is not an ancestor of that node.
// T29 is the case that fails if this import is swapped for a hand-rolled one.
import { isAtOrBelow } from "../features/admin/lib/scope.ts";

const LINE_A = "40000000-0000-0000-0000-00000000000a";
const LINE_B = "40000000-0000-0000-0000-00000000000b";

// ⭐ `externalId` IS PART OF THE ROW NOW (0032) — a document number distinct
// from the name. Forklift-A carries one; the other two record none (`null`),
// which is the ordinary answer and what `documentNumberLabel` shows a dash for.
const FORKLIFT_A: TrainingRow = {
  id: "s1",
  name: "Forklift",
  siteNodeId: LINE_A,
  active: true,
  externalId: "QP-14",
};
const FORKLIFT_B: TrainingRow = {
  id: "s2",
  name: "Forklift",
  siteNodeId: LINE_B,
  active: true,
  externalId: null,
};
const WELDING_A: TrainingRow = {
  id: "s3",
  name: "Welding",
  siteNodeId: LINE_A,
  active: false,
  externalId: null,
};
const ALL: readonly TrainingRow[] = [FORKLIFT_A, FORKLIFT_B, WELDING_A];

/* ---------------------------------------------------------------------------
   The move fixture (§6). ⚠️ PATHS, NOT IDS — `previewTrainingMove` compares the
   ltree the SERVER compares, and `plant_1.line_1` vs `plant_1.line_10` is the
   pair that makes a naive prefix test wrong.

     plant_1                 the plant
     plant_1.line_a          Line A
     plant_1.line_b          Line B
     plant_2                 a second plant entirely
--------------------------------------------------------------------------- */
const P1 = "plant_1";
const A_PATH = "plant_1.line_a";
const B_PATH = "plant_1.line_b";
const P2 = "plant_2";

const holder = (name: string, ownerPath: string | null): TrainingHolder => ({
  operatorId: `op-${name}`,
  name,
  ownerPath,
});
const place = (name: string, path: string | null): TrainingPlace => ({
  nodeId: `n-${name}`,
  name,
  path,
});

/** Every export that produces a sentence a reader can see. Used by T17. */
const EVERY_SENTENCE: readonly string[] = [
  retireActionLabel(true),
  retireActionLabel(false),
  trainingHandle("Forklift", "Line A"),
  hiddenByPlantNote(1, "Plant 1") ?? "",
  hiddenByPlantNote(4, "Plant 1") ?? "",
  skippedRowsNote(1) ?? "",
  skippedRowsNote(3) ?? "",
  retiredClashNote(false) ?? "",
  documentNumberLabel(null),
  documentNumberLabel("QP-14"),
  describeDocumentNumberRefusal({ kind: "DuplicateValue" }, "described"),
  describeDocumentNumberRefusal({ kind: "WriteRefused" }, "You don't have permission."),
  describeTrainingWriteRefusal({ kind: "DuplicateValue" }, "described"),
  describeTrainingWriteRefusal({ kind: "WriteRefused" }, "You don't have permission."),
  describeTrainingWriteRefusal(
    { kind: "OwnerChangeBlocked", what: "skill", id: "s1", newOwnerNodeId: LINE_B, stranded: 2 },
    "described",
  ),
  ...(() => {
    // Both faces of the move confirmation: the one that warns and the one that
    // refuses. Adding a sentence-producing export without adding it here is the
    // gap T17 cannot close by itself.
    const warns = summariseTrainingMove(
      { strandedHolders: [holder("Ana", "plant_2"), holder("Bo", "plant_2")], strandedPlaces: [] },
      "Line B",
    );
    const refuses = summariseTrainingMove(
      { strandedHolders: [], strandedPlaces: [place("Line A", "plant_1.line_a")] },
      "Line B",
    );
    return [
      warns.headline,
      ...warns.costs,
      warns.confirmLabel,
      refuses.headline,
      ...refuses.costs,
      refuses.confirmLabel,
      listStrandedHolders({
        strandedHolders: Array.from({ length: NAMES_SHOWN + 3 }, (_, i) => holder(`P${i}`, "x")),
        strandedPlaces: [],
      }).more ?? "",
    ];
  })(),
  ...(() => {
    const bad = validateTrainingDraft({ name: "", siteNodeId: "" });
    if (bad.ok) throw new Error("the fixture for T17 stopped being a refusal");
    return [bad.nameError ?? "", bad.ownerError ?? ""];
  })(),
  ...(() => {
    const long = validateTrainingDraft({ name: "x".repeat(NAME_MAX_LENGTH + 1), siteNodeId: "n" });
    if (long.ok) throw new Error("the fixture for T17 stopped being a refusal");
    return [long.nameError ?? ""];
  })(),
];

/* ===========================================================================
 * §1. The list.
 * ======================================================================== */

describe("trainings.ts — the list", () => {
  it("T1: an empty search matches everything, rather than nothing", () => {
    // ⚠️ THE DIRECTION THAT MATTERS. A search that returns `[]` for `""` empties
    // the screen on first paint and reads as a company with no trainings.
    expect(ALL.filter((r) => matchesTrainingQuery(r, ""))).toEqual(ALL);
    expect(ALL.filter((r) => matchesTrainingQuery(r, "   "))).toEqual(ALL);
  });

  it("T2: the search is a substring match on the name, case- and space-insensitive", () => {
    expect(matchesTrainingQuery(FORKLIFT_A, "lift")).toBe(true);
    expect(matchesTrainingQuery(FORKLIFT_A, "  FORK ")).toBe(true);
    expect(matchesTrainingQuery(FORKLIFT_A, "weld")).toBe(false);
  });

  it("T3 ⚠️ the search never matches on the OWNER, only on the name", () => {
    // The owner is a COLUMN, never part of the text a reader searches — the
    // same rule that keeps the plant letter out of the name (`A-Welding`).
    // Folding it in here would make "Line A" a query that returns two rows and
    // no way to tell why.
    expect(matchesTrainingQuery(FORKLIFT_A, LINE_A)).toBe(false);
    expect(matchesTrainingQuery(FORKLIFT_A, "Line A")).toBe(false);
  });

  it("T4: the list splits into live and retired, and neither half loses a row", () => {
    const { live, retired } = partitionTrainings(ALL);
    expect(live).toEqual([FORKLIFT_A, FORKLIFT_B]);
    // ⭐ RETIRED IS A POPULATED SECTION, NOT A DROP. Retiring is the primary
    // action, so what has been retired has to be somewhere it can be found and
    // brought back. A partition that filtered it away would make the main
    // action a one-way door.
    expect(retired).toEqual([WELDING_A]);
    expect(live.length + retired.length).toBe(ALL.length);
  });

  it("T5: the server's order survives the split", () => {
    // Re-sorting here would be a second ordering that can disagree with
    // `order("name")` in the read.
    const rows: TrainingRow[] = [
      { id: "z", name: "Zebra", siteNodeId: LINE_A, active: true, externalId: null },
      { id: "a", name: "Aardvark", siteNodeId: LINE_A, active: true, externalId: null },
    ];
    expect(partitionTrainings(rows).live.map((r) => r.name)).toEqual(["Zebra", "Aardvark"]);
  });

  it("T6 ⭐ the primary action is RETIRE and its other face is BRING BACK", () => {
    // ⚠️ Not "Delete", and not "Remove". Retiring changes nothing anybody
    // holds; the other button cascades it off all of them.
    expect(retireActionLabel(true)).toBe("Retire");
    expect(retireActionLabel(false)).toBe("Bring back");
  });

  it("T7 ⭐⭐ a control's name carries the OWNER, because a name alone is ambiguous", () => {
    // 0031 made names unique per owner, so this list can hold two rows both
    // called "Forklift", each with its own Retire, Rename and cascading Delete.
    // Naming those controls by the training alone leaves a screen-reader user
    // choosing between six indistinguishable buttons.
    expect(trainingHandle(FORKLIFT_A.name, "Line A")).toBe("Forklift at Line A");
    expect(trainingHandle(FORKLIFT_B.name, "Line B")).toBe("Forklift at Line B");
    expect(trainingHandle(FORKLIFT_A.name, "Line A")).not.toBe(
      trainingHandle(FORKLIFT_B.name, "Line B"),
    );
  });
});

/* ===========================================================================
 * §2. The draft.
 * ======================================================================== */

describe("trainings.ts — validateTrainingDraft", () => {
  it("T8: a good draft comes back trimmed, with the owner untouched", () => {
    const r = validateTrainingDraft({ name: "  Forklift  ", siteNodeId: LINE_A });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // ⚠️ `skills.name` has no `app_trim_ws` trigger, so this is the only trim
    // there is — and the unique index is whitespace-sensitive, so an untrimmed
    // "Forklift " would sit beside "Forklift" under one owner forever.
    expect(r.value).toEqual({ name: "Forklift", siteNodeId: LINE_A });
  });

  it("T9: a blank name is refused, and whitespace is blank", () => {
    const r = validateTrainingDraft({ name: "   ", siteNodeId: LINE_A });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.nameError).toBe("A name is required.");
    expect(r.ownerError).toBeNull();
  });

  it("T10: a name longer than the bound is refused, and the bound itself is legal", () => {
    const atLimit = validateTrainingDraft({
      name: "x".repeat(NAME_MAX_LENGTH),
      siteNodeId: LINE_A,
    });
    expect(atLimit.ok).toBe(true);
    const over = validateTrainingDraft({
      name: "x".repeat(NAME_MAX_LENGTH + 1),
      siteNodeId: LINE_A,
    });
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.nameError).toBe(`A name can be at most ${NAME_MAX_LENGTH} characters.`);
  });

  it("T11 ⭐ a missing owner gets its OWN error, not the name's", () => {
    // Since 0031 the owner is half of the unique key, so it decides whether the
    // name is legal. Reporting it on the name field sends the reader to retype
    // a name that was never the trouble — D106's shape, in a form.
    const r = validateTrainingDraft({ name: "Forklift", siteNodeId: "" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.nameError).toBeNull();
    expect(r.ownerError).toBe("Choose where this training belongs.");
  });

  it("T12: both problems are reported at once, not one at a time", () => {
    const r = validateTrainingDraft({ name: "", siteNodeId: "" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.nameError).not.toBeNull();
    expect(r.ownerError).not.toBeNull();
  });

  it("T13 ⚠️ case is NOT folded — two spellings are two storable rows", () => {
    // `skills_owner_name_unique` is a plain `text` unique, not `citext`. Folding
    // here would silently rewrite what somebody typed AND still not prevent the
    // pair; the honest place to notice it is the finder's loose answer.
    const r = validateTrainingDraft({ name: "FORKLIFT", siteNodeId: LINE_A });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("FORKLIFT");
  });
});

/* ===========================================================================
 * §3. Sentences.
 * ======================================================================== */

describe("trainings.ts — what the screen says", () => {
  it("T14 ⭐⭐ a duplicate-name refusal names the RETIRED rows, and offers the right way out", () => {
    // The constraint does not care whether the row it collides with is retired,
    // but the reader was looking at the "In use" list when they typed — so the
    // row that refused them is one they cannot see from where they stand.
    const msg = describeTrainingWriteRefusal({ kind: "DuplicateValue" }, "generic");
    expect(msg).toContain("retired");
    // ⚠️ AND IT MUST NOT SAY "DELETE". Deleting cascades the training off
    // everyone who holds it; offering that as the way past a name clash would
    // be catastrophic advice attached to a typo.
    expect(msg.toLowerCase()).not.toContain("delete");
    expect(msg).toContain("Bring that one back");
  });

  it("T15: any other refusal passes the shared description straight through", () => {
    // ⚠️ NOT REWRITTEN. §19.63's contract already produces the sentence for
    // `WriteRefused`; a second copy here is a second thing to keep in step.
    const err: SchedulerError = { kind: "WriteRefused" };
    expect(describeTrainingWriteRefusal(err, "You don't have permission to change this.")).toBe(
      "You don't have permission to change this.",
    );
  });

  it("T16 ⭐ a retired clash says 'bring it back', and a live one says nothing extra", () => {
    // `describeSkillNameClash` ends "use that one", which is advice a reader
    // cannot follow for a retired training. This is the half that knows.
    expect(retiredClashNote(true)).toBeNull();
    expect(retiredClashNote(false)).toBe(
      "That one is retired. Bring it back rather than creating a second.",
    );
  });

  it("T17 ⭐⭐ not one sentence this module produces says 'ticket' or 'skill'", () => {
    // THE MAINTAINER: *"we're still calling them tickets."* A vocabulary rule
    // kept only by care is a vocabulary rule that drifts back, so it is
    // enumerated. `EVERY_SENTENCE` is built from every sentence-producing
    // export at the top of this file; adding one without adding it there is the
    // gap this case cannot close, and the panel suite's own T14 covers the
    // rendered screen.
    for (const s of EVERY_SENTENCE) {
      expect(s.toLowerCase()).not.toContain("ticket");
      expect(s.toLowerCase()).not.toContain("skill");
    }
    // ⚠️ AND THE LIST IS NOT EMPTY. A vacuous loop passes forever.
    expect(EVERY_SENTENCE.filter((s) => s !== "").length).toBeGreaterThan(8);
  });

  it("T18 ⭐ the plant filter's footnote is counted, pluralised, and names the way out", () => {
    // `scope.ts`'s rule: hiding is invisible and permanent, so a list that
    // shrank has to say by how much AND how to undo it.
    expect(hiddenByPlantNote(0, "Plant 1")).toBeNull();
    expect(hiddenByPlantNote(-2, "Plant 1")).toBeNull();
    expect(hiddenByPlantNote(1, "Plant 1")).toContain("1 training outside Plant 1 isn't listed.");
    expect(hiddenByPlantNote(4, "Plant 1")).toContain("4 trainings outside Plant 1 aren't listed.");
    expect(hiddenByPlantNote(1, "Plant 1")).toContain("All plants");
  });

  it("T19 ⚠️ the footnote is named by the LABEL, never by the word 'plant'", () => {
    // The hierarchy is user-defined and the top level is whatever this company
    // calls it — the same care §19.77 takes with `ownRootName`.
    const note = hiddenByPlantNote(2, "Bristol Works");
    expect(note).toContain("Bristol Works");
    expect(note).not.toContain("outside plant");
  });

  it("T20a ⭐ a move refusal is told in PLACES, not in 'scheduled items'", () => {
    // `app_guard_skill_rehome` (0028 §5) counts `node_skill_requirements`, and
    // nothing schedules a training — so the SHARED `OwnerChangeBlocked`
    // sentence ("already used outside the site... N scheduled items") sends the
    // reader to look at a board for rows that live on a hierarchy screen.
    const said = describeTrainingWriteRefusal(
      { kind: "OwnerChangeBlocked", what: "skill", id: "s1", newOwnerNodeId: LINE_B, stranded: 2 },
      "This is already used outside the site you're moving it to (2 scheduled items).",
    );
    expect(said).toContain("requires this training");
    expect(said).not.toContain("scheduled");
  });

  it("T20 ⚠️ the skipped footnote says 'rows', not 'trainings'", () => {
    // `fetchOperatorsAdmin` runs six reads and returns ONE `skipped` count
    // across all of them, so a number here may be about people or requirements
    // just as easily. Naming it "trainings" would be this screen claiming to
    // know something the read did not tell it.
    expect(skippedRowsNote(0)).toBeNull();
    expect(skippedRowsNote(1)).toBe("1 row couldn't be read and isn't shown.");
    expect(skippedRowsNote(2)).toBe("2 rows couldn't be read and aren't shown.");
    expect(skippedRowsNote(2)).not.toContain("training");
  });

  it("T32 ⭐ a document number shows as typed, and a blank one shows a dash, never empty text", () => {
    // The number is a distinct fact from the name (the maintainer, 1 Sept), and
    // most rows on a young company have none — so `null` is an ordinary answer.
    expect(documentNumberLabel("QP-14")).toBe("QP-14");
    expect(documentNumberLabel(null)).toBe(NO_DOCUMENT_NUMBER);
    // ⚠️ `""` reads the same as `null`: an empty string is not a document number,
    // and `createSkill`/`setSkillDocumentNumber` normalise it to `null` anyway.
    expect(documentNumberLabel("")).toBe(NO_DOCUMENT_NUMBER);
    // ⚠️ A DASH, NOT EMPTY TEXT — an empty cell reads as a column that failed to
    // load rather than a fact nobody has recorded.
    expect(NO_DOCUMENT_NUMBER).not.toBe("");
  });

  it("T33 ⭐⭐ a duplicate DOCUMENT NUMBER is named as the number, never as the name", () => {
    // A `DuplicateValue` from `setSkillDocumentNumber` is the NUMBER clashing on
    // `(org_id, site_node_id, external_id)`, not the name. Reusing
    // `describeTrainingWriteRefusal` here would send the reader to rename a
    // training whose name was never the trouble — D106's shape, in an error.
    const msg = describeDocumentNumberRefusal({ kind: "DuplicateValue" }, "generic");
    expect(msg.toLowerCase()).toContain("document number");
    expect(msg.toLowerCase()).not.toContain("name");
    // ⚠️ AND IT MUST NOT BE THE NAME SENTENCE. The two helpers are separate for
    // exactly this: the same error kind means different nouns on the two writes.
    expect(msg).not.toBe(describeTrainingWriteRefusal({ kind: "DuplicateValue" }, "generic"));
    // Anything else passes the shared description straight through, unrewritten.
    expect(
      describeDocumentNumberRefusal({ kind: "WriteRefused" }, "You don't have permission."),
    ).toBe("You don't have permission.");
  });
});

/* ===========================================================================
 * §6 — moving a training, and what it costs the people who hold it.
 *
 * ⭐⭐ EVERY EXPECTATION HERE IS A MEASUREMENT, taken on the local Supabase
 * stack on 31 August rather than read off the migration:
 *
 *   M2  moving a training away from its holders is ALLOWED — `UPDATE skills SET
 *       site_node_id = <other plant>` returns without raising.
 *   M3  the `operator_skills` rows SURVIVE, and their owner is then
 *       incomparable with the training's: exactly what
 *       `app_guard_operator_skill_scope` refuses on INSERT.
 *   M4  a re-grant of that same pair raises PT409 `not_offered_here`. What was
 *       silently allowed cannot be silently undone.
 *   M5  the same move WITH a requirement outside the destination is REFUSED,
 *       PT409 `owner_change_blocked` — `app_guard_skill_rehome` counts
 *       `node_skill_requirements` and nothing else.
 *   M6  `check_eligibility` still answers `eligible: true` for a stranded
 *       holder: `held` reads `operator_skills` with no scope test.
 *
 * So the database refuses one of the two hazards and is silent about the
 * other, and these cases pin the client to that exact split: the requirement
 * BLOCKS, the holder WARNS.
 * ======================================================================== */
describe("trainings.ts — moving a training (D105)", () => {
  it("T21 ⭐⭐ M3: a holder on another branch is stranded, and the move is not refused", () => {
    const p = previewTrainingMove(
      {
        newOwnerPath: P2,
        holders: [holder("Ana", A_PATH)],
        requiredAt: [],
      },
      isAtOrBelow,
    );
    expect(p.strandedHolders.map((h) => h.name)).toEqual(["Ana"]);
    expect(p.strandedPlaces).toEqual([]);
    // The SERVER allows this (M2). The client must warn, never refuse — a
    // client enforcing a rule the database does not have is §19.74's defect.
    expect(summariseTrainingMove(p, "Plant 2").refused).toBe(false);
  });

  it("T22 ⭐⭐ the holder test is COMPARABILITY — both directions, unlike every other scope test", () => {
    // 0028 §4's own comment: a plant-wide person holding a Line 1 training is
    // ORDINARY (they are qualified for Line 1 work); a Plant 2 person holding a
    // Plant 1 training is not. A one-directional test would warn about half the
    // company on every move.
    const downward = previewTrainingMove(
      { newOwnerPath: A_PATH, holders: [holder("Ana", P1)], requiredAt: [] },
      isAtOrBelow,
    );
    expect(downward.strandedHolders).toEqual([]); // owner ABOVE the destination

    const upward = previewTrainingMove(
      { newOwnerPath: P1, holders: [holder("Bo", A_PATH)], requiredAt: [] },
      isAtOrBelow,
    );
    expect(upward.strandedHolders).toEqual([]); // owner BELOW the destination

    const sideways = previewTrainingMove(
      { newOwnerPath: B_PATH, holders: [holder("Cy", A_PATH)], requiredAt: [] },
      isAtOrBelow,
    );
    // ⭐ SIBLINGS ARE THE WHOLE HAZARD, and this is the move an ORDINARY plant
    // admin can make entirely inside their own grant: measured as allowed, and
    // silent.
    expect(sideways.strandedHolders.map((h) => h.name)).toEqual(["Cy"]);
  });

  it("T23 ⭐⭐ M5: a requirement outside the destination BLOCKS, because the server refuses it", () => {
    const p = previewTrainingMove(
      {
        newOwnerPath: B_PATH,
        holders: [],
        requiredAt: [place("Line A", A_PATH)],
      },
      isAtOrBelow,
    );
    expect(p.strandedPlaces.map((q) => q.name)).toEqual(["Line A"]);
    const summary = summariseTrainingMove(p, "Line B");
    expect(summary.refused).toBe(true);
    expect(summary.costs.join(" ")).toContain("1 place");
  });

  it("T24 ⚠️ the PLACE test is containment only — a requirement ABOVE the destination is stranded too", () => {
    // `app_owner_covers_in_org` asks whether the requirement sits AT OR BELOW
    // the training's owner. Reusing the holder's comparability test here would
    // predict "allowed" for a move the server refuses, which is the one
    // prediction this may never make.
    const p = previewTrainingMove(
      { newOwnerPath: A_PATH, holders: [], requiredAt: [place("The plant", P1)] },
      isAtOrBelow,
    );
    expect(p.strandedPlaces.map((q) => q.name)).toEqual(["The plant"]);
    // A requirement BELOW the destination is fine — requirements inherit down.
    const below = previewTrainingMove(
      { newOwnerPath: P1, holders: [], requiredAt: [place("Line A", A_PATH)] },
      isAtOrBelow,
    );
    expect(below.strandedPlaces).toEqual([]);
  });

  it("T25 ⭐⭐ the two halves fail in OPPOSITE directions, on purpose", () => {
    // A HOLDER we cannot place is COUNTED: the output is a sentence and blocks
    // nothing, so one name too many costs a sentence and one too few hides a
    // consequence nobody will connect to this press.
    const p = previewTrainingMove(
      {
        newOwnerPath: P2,
        holders: [holder("Ghost", null)],
        requiredAt: [place("Nowhere", null)],
      },
      isAtOrBelow,
    );
    expect(p.strandedHolders.map((h) => h.name)).toEqual(["Ghost"]);
    // A PLACE we cannot resolve is NOT counted: that half BLOCKS, so it is back
    // under `scope.ts`'s rule — "I cannot tell" must never become a refusal.
    expect(p.strandedPlaces).toEqual([]);
    expect(summariseTrainingMove(p, "Plant 2").refused).toBe(false);
  });

  it("T26 ⭐ a move that costs nothing gets NO confirmation", () => {
    // `DeleteDialog`'s second decision: a warning shown every time is how
    // people learn to click past the one that matters.
    const free = previewTrainingMove(
      { newOwnerPath: P1, holders: [holder("Ana", A_PATH)], requiredAt: [place("Line A", A_PATH)] },
      isAtOrBelow,
    );
    expect(moveCosts(free)).toBe(false);
    const costly = previewTrainingMove(
      { newOwnerPath: P2, holders: [holder("Ana", A_PATH)], requiredAt: [] },
      isAtOrBelow,
    );
    expect(moveCosts(costly)).toBe(true);
  });

  it("T27 ⭐⭐ the confirm button NAMES the count (D106), and the number is right", () => {
    // `DeleteDialog`'s third decision: *"the screen this replaces said 'Delete
    // for good?' whether the answer was 'nothing happens' or 'eleven jobs
    // disappear'."* "Move it" alone would be that mistake again.
    const one = summariseTrainingMove(
      { strandedHolders: [holder("Ana", P2)], strandedPlaces: [] },
      "Line B",
    );
    expect(one.confirmLabel).toBe("Move it and leave 1 person holding it");
    expect(one.costs.join(" ")).toContain("1 person you can see holds it");

    const many = summariseTrainingMove(
      {
        strandedHolders: [holder("Ana", P2), holder("Bo", P2), holder("Cy", P2)],
        strandedPlaces: [],
      },
      "Line B",
    );
    expect(many.confirmLabel).toBe("Move it and leave 3 people holding it");
    expect(many.costs.join(" ")).toContain("3 people you can see hold it");
  });

  it("T28 ⚠️⚠️ M6: the sentence says they STAY QUALIFIED, because they do", () => {
    // `check_eligibility` reads `operator_skills` with no scope test, so a
    // stranded holder is still answered `eligible: true`. Nothing is destroyed
    // and nobody is un-qualified — and a warning people learn is exaggerated is
    // a warning they stop reading. What it must NOT do is call this a loss.
    const said = summariseTrainingMove(
      { strandedHolders: [holder("Ana", P2)], strandedPlaces: [] },
      "Line B",
    ).costs.join(" ");
    expect(said).toContain("stay qualified");
    expect(said.toLowerCase()).not.toContain("lose");
    expect(said.toLowerCase()).not.toContain("removed");
    // ⭐ M4 is the half that IS permanent, and it has to be in there: a re-grant
    // of the same pair raises `not_offered_here`.
    expect(said).toContain("be given back there");
  });

  it("T29 ⚠️⚠️ ancestry is compared LABEL BY LABEL, not by string prefix", () => {
    // `plant_1.line_1` IS a string prefix of `plant_1.line_10` and is NOT an
    // ancestor of that node. Six trainings across ten lines is enough for this
    // to bite, and the failure is silent: a confirmation that says nobody is
    // stranded while somebody is.
    const p = previewTrainingMove(
      {
        newOwnerPath: "plant_1.line_1",
        holders: [holder("Ana", "plant_1.line_10")],
        requiredAt: [place("Line 10", "plant_1.line_10")],
      },
      isAtOrBelow,
    );
    expect(p.strandedHolders.map((h) => h.name)).toEqual(["Ana"]);
    expect(p.strandedPlaces.map((q) => q.name)).toEqual(["Line 10"]);
  });

  it("T30 ⭐ the names are listed, and a long list says how many it did not show", () => {
    // "3 people" is a number to accept; three names are three people to ask.
    const few = listStrandedHolders({
      strandedHolders: [holder("Ana", P2), holder("Bo", P2)],
      strandedPlaces: [],
    });
    expect(few.names).toEqual(["Ana", "Bo"]);
    expect(few.more).toBeNull();

    const many = listStrandedHolders({
      strandedHolders: Array.from({ length: NAMES_SHOWN + 2 }, (_, i) => holder(`P${i}`, P2)),
      strandedPlaces: [],
    });
    // ⚠️ THE REMAINDER IS SAID OUT LOUD rather than trailing off — a
    // confirmation that silently shows five of two hundred is a confirmation
    // about a smaller move than the one being made.
    expect(many.names).toHaveLength(NAMES_SHOWN);
    expect(many.more).toBe("and 2 more");
  });

  it("T31 ⭐ nothing the move confirmation says calls a training a 'skill' or a 'ticket'", () => {
    // T17's rule, restated over §6 because `EVERY_SENTENCE` is hand-maintained
    // and this section added six sentences at once.
    const said = [
      ...summariseTrainingMove(
        { strandedHolders: [holder("Ana", P2)], strandedPlaces: [] },
        "Line B",
      ).costs,
      summariseTrainingMove({ strandedHolders: [holder("Ana", P2)], strandedPlaces: [] }, "Line B")
        .headline,
      summariseTrainingMove(
        { strandedHolders: [], strandedPlaces: [place("Line A", A_PATH)] },
        "Line B",
      ).headline,
    ];
    for (const line of said) {
      expect(line.toLowerCase()).not.toContain("ticket");
      expect(line.toLowerCase()).not.toContain("skill");
    }
  });
});
