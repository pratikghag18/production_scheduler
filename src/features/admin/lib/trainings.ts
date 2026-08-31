/**
 * trainings.ts — the pure half of the Trainings section (roadmap stage 22).
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ THE WORD IS "TRAINING", AND CHANGING IT IS HALF OF WHY THIS FILE EXISTS.
 *
 * THE MAINTAINER, 31 August:
 *   "I thought we were going to create a trainings tab like operator/shifts/
 *    products. These should be editable and we're still calling them tickets."
 *
 * Three names for one thing had accumulated, one per layer: the DATABASE calls
 * the table `skills`, the SCREEN called them "Ticket types", and the person who
 * runs the plant calls them trainings. The database name is not this file's to
 * change and the maintainer's is the one the reader sees — so every identifier
 * that touches the api layer stays `skill`, and **not one string this module
 * returns may say "ticket" or "skill"**. Case T17 in `src/test/trainings.test.ts`
 * enumerates every sentence-producing export and asserts exactly that, because
 * a vocabulary rule kept only by care is a vocabulary rule that drifts back.
 *
 * ⚠️ THE OTHER HALF IS THAT TRAININGS GOT A SECTION AT ALL. They lived INSIDE
 * the Operators tab behind a "Ticket types" toggle, reachable only after
 * picking a person — so "rename the forklift course" required choosing somebody
 * who happened to hold it, and a training nobody held was unreachable.
 *
 * ---------------------------------------------------------------------------
 * DEPENDENCY-FREE. `import type` only: no React, no CSS, no `supabase`, no
 * runtime import of any kind — not even of `../lib/scope`, which is why owner
 * NAMES are passed in as strings (see `trainingHandle`) rather than resolved
 * here. It runs under `node --experimental-strip-types` with nothing to
 * resolve, which is what makes it the thing `src/test/trainings.test.ts`
 * actually tests. `TrainingsPanel.tsx` renders what these functions return and
 * decides nothing itself — the same split `products.ts` draws against
 * `ProductsPanel.tsx`, and `operators.ts` against `OperatorsPanel.tsx`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AUTHORITATIVE. The DATABASE is. `skills_owner_name_unique` from
 * migration 0031 (`unique (org_id, site_node_id, name)`) decides duplicates,
 * 0026's `app_can_read_owned(site_node_id)` decides who sees a row, and 0029's
 * `ON DELETE CASCADE` on `operator_skills → skills` decides what a delete
 * takes with it. This module computes PREVIEWS — what to offer, what to say
 * instead — so the screen stops offering what the server will refuse.
 *
 * The invariant is one-way and it is `products.ts`'s: **anything the client
 * hides, the server must also refuse; never the converse.** Which is exactly
 * why `findExistingSkillByName`'s `"this-plant"` answer does NOT block a create
 * anywhere in this feature — 0031's constraint is per owner, so blocking it
 * would be a client enforcing a rule the database does not have.
 *
 * ---------------------------------------------------------------------------
 * WHITESPACE PARITY, same as `products.ts`. `skills.name` has no server-side
 * `app_trim_ws` trigger (0011 touches the hierarchy RPCs only), so what
 * `validateTrainingDraft` sends is what the table stores — and the unique index
 * is whitespace-sensitive, so `"Forklift"` and `"Forklift "` would coexist
 * forever under one owner. Trimming here is the only trim there is.
 */
import type { SchedulerError } from "@/lib/api";

/* ===========================================================================
 * §1. The row.
 * ======================================================================== */

/**
 * One training as this screen needs it. `SkillRecord` from `@/lib/api`
 * satisfies it structurally, and the functions below are generic over it so a
 * caller keeps its own row type rather than widening to this one.
 *
 * ⭐ `active` IS THE FIELD THE WHOLE SECTION TURNS ON, and it shipped in 0029
 * with deliberately no UI. `false` = retired: still held by everyone who holds
 * it, still on every record it has ever been part of, and no longer offered for
 * new work. ⚠️ RETIRING IS NOT DELETING and the two must never be described in
 * the same words — deleting cascades the training off everyone holding it,
 * which 0029 made possible on purpose.
 *
 * ⚠️ `siteNodeId` IS NOT DECORATION HERE. Since 0031 two trainings may share a
 * name, so the owner is the only thing that tells them apart — see
 * `trainingHandle`.
 */
export interface TrainingRow {
  id: string;
  name: string;
  siteNodeId: string;
  active: boolean;
}

/* ===========================================================================
 * §2. The list.
 * ======================================================================== */

/** Substring match on the name, both sides trimmed and case-folded. */
export function matchesTrainingQuery(row: Pick<TrainingRow, "name">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return row.name.toLowerCase().includes(q);
}

/**
 * The list split the way the screen shows it.
 *
 * ⭐ RETIRING IS THE PRIMARY ACTION, so "retired" is a populated, ordinary part
 * of this screen rather than an edge case — the same call `partitionProducts`
 * records. A retired training is still held by everyone who holds it, and
 * bringing it back is one click.
 *
 * ⚠️ ORDER IS PRESERVED WITHIN EACH HALF. The server sorts (`order("name")`),
 * and re-sorting here would be a second ordering that can disagree with it.
 */
export function partitionTrainings<T extends Pick<TrainingRow, "active">>(
  rows: readonly T[],
): { live: readonly T[]; retired: readonly T[] } {
  return {
    live: rows.filter((r) => r.active),
    retired: rows.filter((r) => !r.active),
  };
}

/**
 * What the retire/bring-back control says.
 *
 * ⭐ "RETIRE", NOT "DEACTIVATE", AND NOT "REMOVE". `ProductsPanel` says
 * Deactivate/Reactivate about a part, which is the vocabulary of a catalogue;
 * a training is a course a company either still runs or does not, and "we don't
 * run that course any more" is the sentence this button exists for. "Remove"
 * is the word it must never use — that is the other button, and it cascades.
 */
export function retireActionLabel(active: boolean): string {
  return active ? "Retire" : "Bring back";
}

/**
 * How a row is named to somebody who cannot see the screen: `"Forklift at
 * Line A"`.
 *
 * ⭐⭐ THIS IS THE ACCESSIBILITY HALF OF 0031. Names are unique per OWNER now,
 * so one list can legitimately hold two rows both called "Forklift", each with
 * its own Retire, Rename and cascading Delete. Naming those controls
 * `"Retire"` alone leaves a screen-reader user choosing between six
 * indistinguishable buttons — which is `OperatorsPanel`'s real "Belongs to"
 * defect arriving in a list where the ambiguity is guaranteed rather than
 * accidental. The visible label stays the plain verb, so the accessible name
 * still CONTAINS it (WCAG 2.5.3).
 *
 * ⚠️ THE OWNER LABEL IS PASSED IN, NEVER RESOLVED HERE. This module holds node
 * IDs and not node names — `scope.ts`'s `scopeLabel` stays the one place an id
 * becomes a name, exactly as `describeSkillNameClash` requires of its caller.
 *
 * ⚠️ AND IT IS THE LEAF NAME, so two "Line 1"s in different plants still
 * collide here. The full path is the row's tooltip (`scopePathLabel`); an
 * accessible name three levels deep would be read out in full on every button.
 */
export function trainingHandle(name: string, ownerLabel: string): string {
  return `${name} at ${ownerLabel}`;
}

/* ===========================================================================
 * §3. The draft.
 * ======================================================================== */

export interface TrainingDraft {
  name: string;
  siteNodeId: string;
}

export type TrainingDraftResult =
  | { ok: true; value: { name: string; siteNodeId: string } }
  | { ok: false; nameError: string | null; ownerError: string | null };

/**
 * `skills.name` is plain `text NOT NULL` with no length limit and no CHECK —
 * the database will accept a 40 000-character name and a name made entirely of
 * spaces. This bound is therefore the CLIENT's, and it matches
 * `products.ts`'s `NAME_MAX_LENGTH` deliberately: two limits on the same kind
 * of field, differing for no reason, is a rule nobody can remember.
 */
export const NAME_MAX_LENGTH = 120;

/**
 * Trim, refuse blanks, refuse an owner that was never chosen.
 *
 * ⭐ THE OWNER GETS ITS OWN ERROR, BESIDE ITS OWN CONTROL. Since 0031 the owner
 * is half of the unique key, so it decides whether the NAME is legal — a
 * missing owner reported as a name problem would send the reader to retype a
 * name that was never the trouble.
 *
 * ⚠️ CASE IS NOT NORMALISED. `skills_owner_name_unique` is a plain `text`
 * unique, not `citext` and not over `lower(name)`, so under one owner
 * "forklift" and "Forklift" are two storable rows. Folding case here would
 * silently rewrite what somebody typed AND still not prevent the pair; the
 * honest place to notice it is `findExistingSkillByName`'s loose answer, which
 * warns and leaves the create available.
 *
 * Returns EVERY problem at once, not the first: a form that reveals its second
 * complaint only after you fix the first is what this shape avoids.
 */
export function validateTrainingDraft(draft: TrainingDraft): TrainingDraftResult {
  const name = draft.name.trim();

  let nameError: string | null = null;
  if (name === "") {
    nameError = "A name is required.";
  } else if (name.length > NAME_MAX_LENGTH) {
    nameError = `A name can be at most ${NAME_MAX_LENGTH} characters.`;
  }

  let ownerError: string | null = null;
  if (draft.siteNodeId === "") {
    ownerError = "Choose where this training belongs.";
  }

  if (nameError !== null || ownerError !== null) {
    return { ok: false, nameError, ownerError };
  }
  return { ok: true, value: { name, siteNodeId: draft.siteNodeId } };
}

/* ===========================================================================
 * §4. Saying what is in the way.
 * ======================================================================== */

/**
 * A write refusal, in this screen's terms.
 *
 * ⭐⭐ THE `DuplicateValue` BRANCH NAMES THE RETIRED ONES, AND THAT IS THE
 * WHOLE OF IT. `skills_owner_name_unique` does not care whether the row it
 * collides with is retired — a retired "Forklift" holds the name just as
 * firmly as a live one. But the reader was looking at the "In use" list when
 * they typed, so the row that refused them is one they cannot see from where
 * they are standing, and the shared sentence (*"Something here already uses
 * that name or code."*) sends them hunting through a list it is not in.
 *
 * ⚠️ It says "bring it back", not "delete it": deleting cascades the training
 * off everyone who holds it, and offering that as the way past a name clash
 * would be catastrophic advice attached to a typo.
 */
export function describeTrainingWriteRefusal(err: SchedulerError, described: string): string {
  switch (err.kind) {
    case "DuplicateValue":
      return "This place already has a training with that name — including one that has been retired. Bring that one back, or choose another name.";
    default:
      return described;
  }
}

/**
 * The extra sentence a name clash needs when the row it found is RETIRED.
 *
 * ⭐ `describeSkillNameClash` ends *"— use that one"*, and for a retired row
 * that is advice the reader cannot follow: it is not offered for new work, so
 * "using it" means bringing it back first. The finder is in `operators.ts`,
 * which is shared with the Operators screen and does not know about `active`;
 * this is the half that does, and it is a SEPARATE sentence rather than an edit
 * to that one so neither screen inherits the other's vocabulary.
 *
 * `null` when the row is live — there is nothing extra to say.
 */
export function retiredClashNote(existingIsActive: boolean): string | null {
  if (existingIsActive) return null;
  return "That one is retired. Bring it back rather than creating a second.";
}

/* ===========================================================================
 * §5. Counting what is not shown.
 *
 * ⭐ `scope.ts`'s rule, and the reason the plant filter may persist at all:
 * hiding is invisible and permanent, and a list that quietly shrank looks
 * exactly like a list of things nobody created.
 * ======================================================================== */

/**
 * The footnote for what the plant filter trimmed, or `null` when it trimmed
 * nothing.
 *
 * ⚠️ NAMED BY `plantLabel`, NEVER BY THE WORD "plant". The hierarchy is
 * user-defined and the top level is whatever this company calls it — the same
 * care §19.77 takes with `ownRootName`. The label is passed in for the same
 * reason `trainingHandle`'s is.
 *
 * ⚠️ A count of ZERO RETURNS `null` RATHER THAN AN EMPTY STRING, so the caller
 * renders nothing at all instead of an empty paragraph that still takes space
 * and is still announced.
 */
export function hiddenByPlantNote(count: number, plantLabel: string): string | null {
  if (count <= 0) return null;
  const head =
    count === 1
      ? `1 training outside ${plantLabel} isn't listed.`
      : `${count} trainings outside ${plantLabel} aren't listed.`;
  return `${head} Switch to “All plants” above to see everything.`;
}

/**
 * The footnote for rows the client could not read.
 *
 * ⚠️ "ROWS", NOT "TRAININGS", AND THAT IS ACCURACY RATHER THAN CAUTION.
 * `fetchOperatorsAdmin` runs six reads and returns ONE `skipped` count across
 * all of them, so a number here may be about people or requirements just as
 * easily as about trainings. Naming it "trainings" would be this screen
 * claiming to know something the read did not tell it.
 */
export function skippedRowsNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 row couldn't be read and isn't shown."
    : `${count} rows couldn't be read and aren't shown.`;
}
