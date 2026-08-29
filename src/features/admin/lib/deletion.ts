/**
 * Deletion — turning `deletion_preview`'s counts into the sentences the dialog
 * shows, and deciding which of the two buttons is the primary one (D110).
 *
 * PURE. Imports nothing at runtime, so `src/test/deletion.test.ts` can reach
 * every branch without a network — the same split `features/admin/lib/products.ts`
 * draws against `lib/api/products.ts`.
 *
 * ⭐⭐ THE ONE DECISION IN THIS FILE. The maintainer asked for a dialog that "names the
 * counts and offers Deactivate first". Offering Deactivate first UNCONDITIONALLY
 * would be nagging: deleting a part nobody has ever scheduled destroys nothing,
 * and a warning that fires when there is nothing to warn about is a warning
 * people learn to click through — after which the one that matters is clicked
 * through too. So `deletionStakes()` answers "is anything actually at risk",
 * and Deactivate is the primary action exactly when the answer is yes.
 */

/** Kept in step with `DeletableKind` in `lib/api/deletion.ts`. */
export type DeletionKindLabel = { singular: string; article: string };

const KIND_LABELS: Record<string, DeletionKindLabel> = {
  product: { singular: "part", article: "this part" },
  operator: { singular: "person", article: "this person" },
  skill: { singular: "training", article: "this training" },
  shift_template: { singular: "shift pattern", article: "this shift pattern" },
};

/**
 * What to call the thing being deleted, in the words the rest of the admin
 * screens use. An unrecognised kind falls back to the raw key rather than to
 * "item": a dialog that says "this item" about something the client does not
 * understand is a dialog that has stopped telling the truth, and the raw key
 * at least tells whoever sees it what to go and look at.
 */
export function kindLabel(kind: string): DeletionKindLabel {
  return KIND_LABELS[kind] ?? { singular: kind, article: `this ${kind}` };
}

interface CountPhrase {
  /** e.g. "job" / "jobs" — the noun a person on the shop floor would use. */
  one: string;
  many: string;
}

/**
 * TABLE NAME → the words on screen. This is the only place the two vocabularies
 * meet, and the table names arrive from the database rather than being invented
 * here, so a new `what` shows up as an untranslated key and not as a missing
 * line (see `describeCount`).
 */
const COUNT_PHRASES: Record<string, CountPhrase> = {
  runs: { one: "job on the schedule", many: "jobs on the schedule" },
  assignments: { one: "shift for a person", many: "shifts for people" },
  operator_skills: { one: "person qualified on it", many: "people qualified on it" },
  node_skill_requirements: { one: "cell that requires it", many: "cells that require it" },
  shifts: { one: "shift in the pattern", many: "shifts in the pattern" },
  shift_breaks: { one: "break", many: "breaks" },
  node_shift_templates: { one: "cell that runs it", many: "cells that run it" },
};

/**
 * One line of the dialog: `{ what: "runs", count: 3 }` → `"3 jobs on the schedule"`.
 *
 * ⚠️ AN UNKNOWN KEY IS RENDERED, NOT DROPPED. The temptation is to skip a
 * `what` this client has no phrase for, which turns "and 40 other rows go too"
 * into silence — the single most dangerous thing this dialog could do. An
 * unknown key renders with its raw table name, which is ugly and honest.
 */
export function describeCount(count: { what: string; count: number }): string {
  const phrase = COUNT_PHRASES[count.what];
  if (phrase === undefined) return `${count.count} × ${count.what}`;
  return `${count.count} ${count.count === 1 ? phrase.one : phrase.many}`;
}

/** Every non-zero line, in the order the database gave them. Zeroes are noise. */
export function describeCounts(counts: readonly { what: string; count: number }[]): string[] {
  return counts.filter((c) => c.count > 0).map(describeCount);
}

export type DeletionStakes = "nothing" | "history-only" | "destructive";

export interface DeletionSummary {
  /** Lines for "this would be removed", already phrased. Empty if nothing is. */
  removed: string[];
  /** Lines for "this stays, under the name it has now". Empty if nothing does. */
  kept: string[];
  stakes: DeletionStakes;
  /** True exactly when Deactivate should be the primary action. */
  preferDeactivate: boolean;
  /** The one sentence at the top of the dialog. */
  headline: string;
}

/**
 * ⭐ THREE STAKES, NOT TWO.
 *
 *   "nothing"       — nothing is removed and nothing is kept. Deleting is
 *                     tidying up, and there is nothing to be careful about.
 *   "history-only"  — nothing is removed, but finished work names it. Deleting
 *                     is safe for the schedule and still changes what the board
 *                     says about last week, so the dialog says so without
 *                     pushing Deactivate.
 *   "destructive"   — something on the schedule goes. This is the only case the
 *                     maintainer's "encourage them to deactivate instead" is about.
 *
 * Collapsing the middle case into "destructive" is what would make this dialog
 * cry wolf; collapsing it into "nothing" is what would make it hide the one
 * consequence of a delete that cannot be undone.
 */
export function summariseDeletion(preview: {
  kind: string;
  name: string;
  code: string | null;
  removes: readonly { what: string; count: number }[];
  keeps: readonly { what: string; count: number }[];
}): DeletionSummary {
  const removed = describeCounts(preview.removes);
  const kept = describeCounts(preview.keeps);
  const label = kindLabel(preview.kind);
  const stakes: DeletionStakes =
    removed.length > 0 ? "destructive" : kept.length > 0 ? "history-only" : "nothing";

  let headline: string;
  if (stakes === "destructive") {
    headline = `Deleting ${label.article} removes work that has not started yet.`;
  } else if (stakes === "history-only") {
    headline = `Nothing on the schedule changes. Finished work keeps ${
      preview.code === null ? "the name" : "the code and name"
    } it has now.`;
  } else {
    headline = `Nothing uses ${label.article}. Deleting it changes nothing else.`;
  }

  return { removed, kept, stakes, preferDeactivate: stakes === "destructive", headline };
}

/**
 * The label on the confirm button.
 *
 * ⭐ D106: A CONTROL MAY NOT BE NAMED AFTER LESS THAN IT DOES. "Delete" is
 * accurate for a part nothing has scheduled and a lie for one with a week of
 * work booked against it — and the version of this screen that shipped before
 * 0029 said "Delete for good?" for both. The count goes IN the button, so the
 * thing you are about to destroy is named on the control that destroys it and
 * not only in a paragraph above it.
 */
export function confirmLabel(summary: DeletionSummary): string {
  if (summary.stakes !== "destructive") return "Delete";
  return `Delete, and remove ${summary.removed.join(" and ")}`;
}

/**
 * What to say after it happened — built from the ACTUAL counts, never from the
 * preview. See `deleteOwnedRow`'s header for why those can differ.
 */
export function describeDeletionResult(result: {
  kind: string;
  name: string;
  removes: readonly { what: string; count: number }[];
  keeps: readonly { what: string; count: number }[];
}): string {
  const removed = describeCounts(result.removes);
  const kept = describeCounts(result.keeps);
  const parts: string[] = [`Deleted ${result.name}.`];
  if (removed.length > 0) parts.push(`Removed ${removed.join(" and ")}.`);
  if (kept.length > 0) parts.push(`${kept.join(" and ")} kept their record of it.`);
  return parts.join(" ");
}
