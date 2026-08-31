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
  NAME_MAX_LENGTH,
  describeTrainingWriteRefusal,
  hiddenByPlantNote,
  matchesTrainingQuery,
  partitionTrainings,
  retireActionLabel,
  retiredClashNote,
  skippedRowsNote,
  trainingHandle,
  validateTrainingDraft,
  type TrainingRow,
} from "../features/admin/lib/trainings.ts";

const LINE_A = "40000000-0000-0000-0000-00000000000a";
const LINE_B = "40000000-0000-0000-0000-00000000000b";

const FORKLIFT_A: TrainingRow = { id: "s1", name: "Forklift", siteNodeId: LINE_A, active: true };
const FORKLIFT_B: TrainingRow = { id: "s2", name: "Forklift", siteNodeId: LINE_B, active: true };
const WELDING_A: TrainingRow = { id: "s3", name: "Welding", siteNodeId: LINE_A, active: false };
const ALL: readonly TrainingRow[] = [FORKLIFT_A, FORKLIFT_B, WELDING_A];

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
  describeTrainingWriteRefusal({ kind: "DuplicateValue" }, "described"),
  describeTrainingWriteRefusal({ kind: "WriteRefused" }, "You don't have permission."),
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
      { id: "z", name: "Zebra", siteNodeId: LINE_A, active: true },
      { id: "a", name: "Aardvark", siteNodeId: LINE_A, active: true },
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
});
