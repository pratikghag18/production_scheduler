/**
 * Acceptance suite for `src/features/admin/lib/deletion.ts` and the shape guard
 * in `src/lib/api/deletion.ts` — migration 0029, D110.
 *
 * ⭐⭐ THE VOCABULARY IS SHARED WITH THE DATABASE, so half of what matters here
 * is that it AGREES with `56_delete_keeps_the_past_test.sql`. Every `what` key
 * the fixtures below use is a key `deletion_preview` actually emits (D5, D9,
 * D10, D11 pin the emitted set), so a `what` renamed on one side turns two
 * files red instead of one screen silent.
 *
 * ⚠️ AND THE UNTRANSLATED-KEY CASE IS THE POINT OF K5. The tempting
 * implementation drops a `what` it has no phrase for, which turns "and 40 other
 * rows go too" into a blank line in a confirmation dialog. That is the worst
 * thing this module could do and it is invisible until the day it matters.
 */
import { describe, expect, it } from "vitest";
import {
  confirmLabel,
  describeCount,
  describeCounts,
  describeDeletionResult,
  kindLabel,
  summariseDeletion,
} from "@/features/admin/lib/deletion";
import { parseDeletionPreview } from "@/lib/api";

const NOTHING = {
  kind: "product",
  name: "Never Scheduled",
  code: "DP4",
  removes: [
    { what: "runs", count: 0 },
    { what: "assignments", count: 0 },
  ],
  keeps: [
    { what: "runs", count: 0 },
    { what: "assignments", count: 0 },
  ],
};

const HISTORY_ONLY = {
  kind: "product",
  name: "Retired Part",
  code: "RP1",
  removes: [
    { what: "runs", count: 0 },
    { what: "assignments", count: 0 },
  ],
  keeps: [
    { what: "runs", count: 12 },
    { what: "assignments", count: 30 },
  ],
};

const DESTRUCTIVE = {
  kind: "product",
  name: "Plant-wide Part",
  code: "DP2",
  removes: [
    { what: "runs", count: 1 },
    { what: "assignments", count: 2 },
  ],
  keeps: [
    { what: "runs", count: 2 },
    { what: "assignments", count: 2 },
  ],
};

describe("phrasing one count", () => {
  it("K1: singular and plural are different words, not an appended s", () => {
    expect(describeCount({ what: "runs", count: 1 })).toBe("1 job on the schedule");
    expect(describeCount({ what: "runs", count: 3 })).toBe("3 jobs on the schedule");
    expect(describeCount({ what: "assignments", count: 1 })).toBe("1 shift for a person");
    expect(describeCount({ what: "assignments", count: 4 })).toBe("4 shifts for people");
  });

  it("K2: every key deletion_preview emits has a phrase", () => {
    // The list is exactly what 56_'s D5/D9/D10/D11 assert the RPC returns.
    const emitted = [
      "runs",
      "assignments",
      "operator_skills",
      "node_skill_requirements",
      "shifts",
      "shift_breaks",
      "node_shift_templates",
    ];
    for (const what of emitted) {
      expect(describeCount({ what, count: 2 })).not.toContain("×");
    }
  });

  it("K3: zero-count lines are dropped from the list", () => {
    expect(describeCounts(NOTHING.removes)).toEqual([]);
    expect(describeCounts(DESTRUCTIVE.removes)).toEqual([
      "1 job on the schedule",
      "2 shifts for people",
    ]);
  });

  it("K4: order is the database's, not re-sorted here", () => {
    expect(
      describeCounts([
        { what: "assignments", count: 2 },
        { what: "runs", count: 1 },
      ]),
    ).toEqual(["2 shifts for people", "1 job on the schedule"]);
  });

  it("K5 ⭐: a key with no phrase is RENDERED, never dropped", () => {
    expect(describeCount({ what: "future_widgets", count: 40 })).toBe("40 × future_widgets");
    expect(describeCounts([{ what: "future_widgets", count: 40 }])).toHaveLength(1);
  });

  it("K6: an unknown kind falls back to its raw key rather than to 'item'", () => {
    expect(kindLabel("product").article).toBe("this part");
    expect(kindLabel("shift_template").singular).toBe("shift pattern");
    expect(kindLabel("widget").article).toBe("this widget");
  });
});

describe("the three stakes", () => {
  it("K7: nothing scheduled, nothing finished — deleting changes nothing else", () => {
    const s = summariseDeletion(NOTHING);
    expect(s.stakes).toBe("nothing");
    expect(s.preferDeactivate).toBe(false);
    expect(s.removed).toEqual([]);
    expect(s.kept).toEqual([]);
  });

  it("K8 ⭐⭐: finished work only — safe for the schedule, so it must NOT push Deactivate", () => {
    // This is the case that decides whether the dialog cries wolf. Everything
    // this product touches has already happened; the delete removes nothing
    // and the history keeps its name. A warning here is a warning people learn
    // to click through, and the next one they click through is K9.
    const s = summariseDeletion(HISTORY_ONLY);
    expect(s.stakes).toBe("history-only");
    expect(s.preferDeactivate).toBe(false);
    expect(s.removed).toEqual([]);
    expect(s.kept).toEqual(["12 jobs on the schedule", "30 shifts for people"]);
  });

  it("K9: something on the schedule goes — Deactivate becomes the primary action", () => {
    const s = summariseDeletion(DESTRUCTIVE);
    expect(s.stakes).toBe("destructive");
    expect(s.preferDeactivate).toBe(true);
  });

  it("K10: a training keeps nothing, and an empty keeps list is not an error", () => {
    const s = summariseDeletion({
      kind: "skill",
      name: "Line Training D",
      code: null,
      removes: [
        { what: "operator_skills", count: 1 },
        { what: "node_skill_requirements", count: 1 },
      ],
      keeps: [],
    });
    expect(s.stakes).toBe("destructive");
    expect(s.removed).toEqual(["1 person qualified on it", "1 cell that requires it"]);
    expect(s.kept).toEqual([]);
  });

  it("K11: the headline names the code only when there is one", () => {
    expect(summariseDeletion(HISTORY_ONLY).headline).toContain("code and name");
    expect(summariseDeletion({ ...HISTORY_ONLY, code: null }).headline).not.toContain(
      "code and name",
    );
  });
});

describe("the confirm button", () => {
  it("K12 ⭐: D106 — the button names what it destroys, not just 'Delete'", () => {
    expect(confirmLabel(summariseDeletion(DESTRUCTIVE))).toBe(
      "Delete, and remove 1 job on the schedule and 2 shifts for people",
    );
  });

  it("K13: with nothing at stake it stays plain, because there is nothing to name", () => {
    expect(confirmLabel(summariseDeletion(NOTHING))).toBe("Delete");
    expect(confirmLabel(summariseDeletion(HISTORY_ONLY))).toBe("Delete");
  });
});

describe("what the screen says afterwards", () => {
  it("K14: the sentence is built from what happened, and says what survived", () => {
    expect(
      describeDeletionResult({
        kind: "product",
        name: "Plant-wide Part",
        removes: DESTRUCTIVE.removes,
        keeps: DESTRUCTIVE.keeps,
      }),
    ).toBe(
      "Deleted Plant-wide Part. Removed 1 job on the schedule and 2 shifts for people. " +
        "2 jobs on the schedule and 2 shifts for people kept their record of it.",
    );
  });

  it("K15: nothing removed and nothing kept is one short sentence, not two empty ones", () => {
    expect(
      describeDeletionResult({
        kind: "product",
        name: "Never Scheduled",
        removes: NOTHING.removes,
        keeps: NOTHING.keeps,
      }),
    ).toBe("Deleted Never Scheduled.");
  });
});

describe("the shape guard", () => {
  const GOOD = {
    kind: "product",
    id: "p-1",
    name: "Plant-wide Part",
    code: "DP2",
    active: true,
    removes: [{ what: "runs", count: 1 }],
    keeps: [{ what: "runs", count: 2 }],
    deleted: true,
  };

  it("K16: a well-formed payload parses, by key", () => {
    const parsed = parseDeletionPreview(GOOD);
    expect(parsed).not.toBeNull();
    expect(parsed?.removes[0]).toEqual({ what: "runs", count: 1 });
    expect(parsed?.deleted).toBe(true);
  });

  it("K17: `deleted` absent means false, not undefined", () => {
    const { deleted: _drop, ...preview } = GOOD;
    expect(parseDeletionPreview(preview)?.deleted).toBe(false);
  });

  it("K18: a null code is legal — trainings and patterns have none", () => {
    expect(parseDeletionPreview({ ...GOOD, kind: "skill", code: null })).not.toBeNull();
  });

  it("K19 ⭐⭐: a count that is not a number REJECTS THE WHOLE PAYLOAD", () => {
    // Not coerced and not skipped. `Number("3 runs")` is NaN and `?? 0` is
    // zero, and zero is the number that makes somebody press Delete.
    expect(parseDeletionPreview({ ...GOOD, removes: [{ what: "runs", count: "1" }] })).toBeNull();
    expect(parseDeletionPreview({ ...GOOD, removes: [{ what: "runs", count: 1.5 }] })).toBeNull();
    expect(parseDeletionPreview({ ...GOOD, removes: [{ count: 1 }] })).toBeNull();
  });

  it("K20: an unrecognised kind is rejected — this client does not know what it would be deleting", () => {
    expect(parseDeletionPreview({ ...GOOD, kind: "orgs" })).toBeNull();
  });

  it("K21: the negative controls — a short payload, a null, a list", () => {
    expect(parseDeletionPreview(null)).toBeNull();
    expect(parseDeletionPreview([GOOD])).toBeNull();
    expect(parseDeletionPreview({ kind: "product", id: "p-1" })).toBeNull();
    expect(parseDeletionPreview({ ...GOOD, removes: "none" })).toBeNull();
  });
});
