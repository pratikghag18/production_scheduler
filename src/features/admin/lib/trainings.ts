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
  /**
   * The training's DOCUMENT NUMBER (`skills.external_id`, nullable) — and it is
   * a DISTINCT FACT from the name, not a second spelling of it.
   *
   * ⭐ THE MAINTAINER, 1 Sept: most trainings at a company carry a document
   * number, and it must NOT be folded into the name. The same split products
   * already draw between `sku` and `name`: the NAME is what a reader recognises
   * on the board, in the eligibility list and in the certifications import; the
   * NUMBER churns on revision and belongs in its own column. `null` = none
   * recorded, which is an ordinary answer and not a gap to nag about.
   */
  externalId: string | null;
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
 * ⚠️ WHICH LABEL IT IS REMAINS THE CALLER'S ANSWER, AND THE CALLER'S HAS
 * CHANGED. This used to record that the leaf name was passed, so two "Line 1"s
 * in different plants still collided here — filed as a known edge, which it was
 * not: `unique (org_id, parent_id, name)` (0001) makes SIBLING names unique and
 * says nothing across the tree, so two plants each naming their first line
 * "Line A" is ordinary rather than exotic. `TrainingsPanel` now hands in the
 * full PATH of names where the leaf is shared and the leaf alone where it is
 * not, because the objection recorded here was also right: a name three levels
 * deep read out on every button is a cure worse than the disease. Both halves
 * are the caller's to weigh, and this function still only joins two strings.
 */
export function trainingHandle(name: string, ownerLabel: string): string {
  return `${name} at ${ownerLabel}`;
}

/**
 * What a document-number cell shows when there is no number recorded.
 *
 * ⚠️ A DASH, NEVER THE EMPTY STRING. `null` is an ordinary answer — most rows
 * on a young company have no number yet — and an empty cell reads as a column
 * that failed to load rather than a fact nobody has entered. `hiddenByPlantNote`
 * makes the same choice for a different reason: the honest blank still occupies
 * its place.
 */
export const NO_DOCUMENT_NUMBER = "—";

/** The document number as the cell shows it: the number itself, or the dash. */
export function documentNumberLabel(externalId: string | null): string {
  return externalId === null || externalId === "" ? NO_DOCUMENT_NUMBER : externalId;
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
    case "OwnerChangeBlocked":
      // ⭐ THE SHARED SENTENCE COUNTS "scheduled items" AND NOTHING SCHEDULES A
      // TRAINING. `app_guard_skill_rehome` (0028 §5) counts
      // `node_skill_requirements` — PLACES that require it — so the shared
      // wording sends the reader to look at a board for rows that live on a
      // hierarchy screen. Same call the branch above makes: a shared
      // description that is right for several tables is wrong for this one.
      return "Somewhere outside the new place still requires this training. Take that requirement off first, then move it.";
    default:
      return described;
  }
}

/**
 * A DOCUMENT-NUMBER write refusal, in this screen's terms.
 *
 * ⭐⭐ ITS OWN HELPER, NOT `describeTrainingWriteRefusal`, AND THAT IS THE WHOLE
 * OF IT. `setSkillDocumentNumber` collides on `(org_id, site_node_id,
 * external_id)`, so a `DuplicateValue` from it means the NUMBER is taken — never
 * the name. Sending it through the name helper would tell the reader another
 * place already has a training "with that name" and point them at Rename, which
 * would send them to change a name that was never the trouble — D106's shape, in
 * an error. The number is unique per owner exactly as the name is (0031/0032), so
 * "in this place" is the right scope for both, but the noun has to be the number.
 *
 * ⚠️ ANYTHING ELSE PASSES THE SHARED DESCRIPTION STRAIGHT THROUGH — a permission
 * refusal on this write reads the same as on any other, and a second copy of that
 * sentence here is a second thing to keep in step.
 */
export function describeDocumentNumberRefusal(err: SchedulerError, described: string): string {
  switch (err.kind) {
    case "DuplicateValue":
      return "Another training in this place already uses that document number. Choose a different one.";
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

/* ===========================================================================
 * §6. Moving a training, and what it costs the people who hold it.
 *
 * ⭐⭐ MEASURED BEFORE IT WAS DESIGNED, on the local stack, 31 August. Every
 * claim below is an observation of a running database, not a reading of the
 * migration:
 *
 *   1. `app_guard_operator_skill_scope` (0028 §4) requires a training's owner
 *      and a HOLDER's owner to be COMPARABLE — either an ancestor of the
 *      other. It is a trigger on `operator_skills`, fired `BEFORE INSERT OR
 *      UPDATE OF operator_id, skill_id`. **Nothing re-checks it when `skills`
 *      moves out from under those rows.**
 *   2. So a move that strands holders is ALLOWED, and silent. The rows survive.
 *   3. They still count: `check_eligibility` reads `operator_skills` with no
 *      scope test, so a stranded holder is still answered `eligible`. Nothing
 *      is destroyed and nobody is un-qualified — this is not a delete, and
 *      saying it were would be the fear that makes people ignore warnings.
 *   4. But the pair is left in a state the guard would refuse to CREATE: a
 *      re-grant of exactly that person and that training raises
 *      `not_offered_here`. Revoke it once and it cannot be given back.
 *   5. `app_guard_skill_rehome` (0028 §5) DOES guard this column — and counts
 *      `node_skill_requirements` only. A stranded REQUIREMENT raises
 *      `owner_change_blocked`; a stranded HOLDER raises nothing at all.
 *
 * ⭐ WHICH IS WHY THIS IS A WARNING AND NOT A BLOCK. The database permits the
 * move, so a client that refused it would be enforcing a rule the server does
 * not have — §19.74's stale-refusal defect, the quiet kind that never fails and
 * just stops people working. What is owed is that nobody finds out afterwards:
 * the count, before the press, in the reader's words. The stranded REQUIREMENT
 * is the other shape — the server really will refuse it — so that one blocks,
 * exactly as `clashBlocks` does on the add form.
 * ======================================================================== */

/**
 * `isAtOrBelow` from `../lib/scope`, PASSED IN rather than imported.
 *
 * ⚠️ THIS MODULE HAS NO RUNTIME IMPORTS (see the header) and this is the one
 * thing that has ever wanted one. The alternative was a second label-aware
 * ltree prefix test living here, and `plantFilter.ts`'s header is the standing
 * ruling on that: *"this file must not become a second implementation of
 * ancestry that can disagree with the first."* An injected predicate keeps one
 * implementation and keeps this file runnable under
 * `node --experimental-strip-types` with nothing to resolve.
 */
export type AtOrBelow = (targetPath: string, ancestorPath: string) => boolean;

/** Somebody who holds the training, as the preview needs them. */
export interface TrainingHolder {
  operatorId: string;
  name: string;
  /** The ltree path of the node that owns this PERSON. `null` = unresolvable. */
  ownerPath: string | null;
}

/** A place that requires the training. */
export interface TrainingPlace {
  nodeId: string;
  name: string;
  /** The place's own ltree path. `null` = unresolvable. */
  path: string | null;
}

export interface TrainingMovePreview {
  /** Holders the move would leave on a branch the training no longer reaches. */
  strandedHolders: readonly TrainingHolder[];
  /** Places whose requirement the move would strand. The server REFUSES these. */
  strandedPlaces: readonly TrainingPlace[];
}

/**
 * What moving a training to `newOwnerPath` would cost.
 *
 * ⭐⭐ THE TWO HALVES FAIL IN OPPOSITE DIRECTIONS, AND THAT IS THE DESIGN
 * RATHER THAN AN INCONSISTENCY.
 *
 *   A HOLDER WHOSE OWNER CANNOT BE PLACED IS COUNTED AS STRANDED. This is the
 *   one thing in this feature that fails CLOSED, and the reason is which way
 *   the harm runs. `editRights.ts` fails open because hiding a control stops
 *   somebody doing their job — loudly, recoverably, with something on screen to
 *   argue with. This output blocks nothing; it is a sentence. So one name too
 *   many costs a sentence, and one name too few hides a consequence that has
 *   already happened by the time anybody notices.
 *
 *   A PLACE WHOSE PATH CANNOT BE RESOLVED IS NOT COUNTED. That half DOES block,
 *   because the server refuses it — so it is back under `scope.ts`'s rule:
 *   *"I cannot tell"* must never become a refusal. If the client is wrong there,
 *   the server says so in its own words through `describeTrainingWriteRefusal`.
 *
 * ⚠️ THE HOLDER TEST IS COMPARABILITY, NOT CONTAINMENT, and it is the only
 * both-ways test in this feature. 0028 §4's own comment says why: a plant-wide
 * person holding a Line 1 training is ordinary — they are qualified for Line 1
 * work — while a Plant 2 person holding a Plant 1 training is not. A
 * one-directional test would warn about half the company on every move.
 *
 * ⚠️ THE PLACE TEST IS CONTAINMENT, one direction only, because that is what
 * `app_owner_covers_in_org` asks: a requirement must sit AT OR BELOW the
 * training's owner. Comparability here would predict "allowed" for moves the
 * server refuses, which is the one prediction this must never make.
 */
export function previewTrainingMove(
  move: {
    newOwnerPath: string;
    holders: readonly TrainingHolder[];
    requiredAt: readonly TrainingPlace[];
  },
  atOrBelow: AtOrBelow,
): TrainingMovePreview {
  const strandedHolders = move.holders.filter((h) => {
    if (h.ownerPath === null) return true; // cannot tell -> say so
    return !(
      atOrBelow(h.ownerPath, move.newOwnerPath) || atOrBelow(move.newOwnerPath, h.ownerPath)
    );
  });
  const strandedPlaces = move.requiredAt.filter(
    (p) => p.path !== null && !atOrBelow(p.path, move.newOwnerPath),
  );
  return { strandedHolders, strandedPlaces };
}

/**
 * Is there anything to warn about at all?
 *
 * ⭐ A MOVE THAT COSTS NOTHING GETS NO CONFIRMATION, and that is
 * `DeleteDialog`'s second decision rather than a shortcut: *"pushing it every
 * time — including for a part nothing has ever been scheduled against — is how
 * a warning becomes something people learn to click past, and then the one that
 * matters gets clicked past too."*
 */
export function moveCosts(preview: TrainingMovePreview): boolean {
  return preview.strandedHolders.length > 0 || preview.strandedPlaces.length > 0;
}

export interface TrainingMoveSummary {
  headline: string;
  /** One line per consequence. */
  costs: readonly string[];
  /** What the button that goes ahead is called. It NAMES what it costs (D106). */
  confirmLabel: string;
  /** The database itself will refuse this move, so the confirm is not offered. */
  refused: boolean;
}

/**
 * The confirmation, in the reader's words. `summariseDeletion`'s shape,
 * deliberately — this screen already shows one of those, and two confirmations
 * on one panel built to different plans is how the second ends up saying less
 * than the first.
 *
 * ⭐ THE CONFIRM BUTTON NAMES THE COUNT. `DeleteDialog`'s third decision:
 * *"the screen this replaces said 'Delete for good?' whether the answer was
 * 'nothing happens' or 'eleven jobs disappear'."* A button that just said "Move
 * it" would be that mistake again — what this does is move it AND leave three
 * people holding it from somewhere it no longer reaches, so that is what it
 * says.
 *
 * ⚠️ "YOU CAN SEE" IS ACCURACY, NOT MODESTY. Reads are scoped (0026), so this
 * count is over the holders THIS CLIENT was handed. A reader granted one line
 * may hold a shorter list than the company admin looking at the same training,
 * and a bare number would be the screen claiming to know something the read did
 * not tell it — the same care `skippedRowsNote` takes with the word "rows".
 *
 * ⚠️ AND IT SAYS THEY STAY QUALIFIED, BECAUSE THEY DO (observation 3 above).
 * Overstating this as "they lose it" would be the easier sentence and a false
 * one, and a warning people learn is exaggerated is a warning they stop
 * reading.
 */
export function summariseTrainingMove(
  preview: TrainingMovePreview,
  newOwnerLabel: string,
): TrainingMoveSummary {
  const places = preview.strandedPlaces.length;
  const holders = preview.strandedHolders.length;

  if (places > 0) {
    const one = places === 1;
    return {
      headline: `This training can’t move to ${newOwnerLabel} yet.`,
      costs: [
        `${one ? "1 place" : `${places} places`} outside ${newOwnerLabel} still ${
          one ? "requires" : "require"
        } it. Take the requirement off ${one ? "that place" : "those places"} first.`,
      ],
      confirmLabel: `Move it to ${newOwnerLabel}`,
      refused: true,
    };
  }

  const one = holders === 1;
  const who = one ? "1 person" : `${holders} people`;
  const lead = `${who} you can see ${one ? "holds" : "hold"} it from outside ${newOwnerLabel}.`;
  // ⚠️ ONE SENTENCE FOR BOTH COUNTS, and singular "they" throughout rather than
  // a second string that differs only in a verb. Two near-identical sentences
  // are two places for the honest half — *they stay qualified* — to be edited
  // out of only one.
  const tail =
    "They stay qualified and keep what they’ve earned, but it will no longer belong where they work — and once it’s taken off them, it can’t be given back there.";
  return {
    headline: `Moving this training to ${newOwnerLabel} affects the people who hold it.`,
    costs: [`${lead} ${tail}`],
    confirmLabel: `Move it and leave ${who} holding it`,
    refused: false,
  };
}

/**
 * The names behind the count, for the confirmation to list.
 *
 * ⭐ A COUNT ALONE IS NOT SOMETHING TO ACT ON. `DeleteDialog` lists what goes
 * rather than only counting it, for this reason: "3 people" is a number to
 * accept, and three names are three people to go and ask.
 *
 * ⚠️ CAPPED, AND THE REMAINDER SAID OUT LOUD rather than trailing off. A
 * training half the plant holds would otherwise put two hundred names in a
 * confirmation and bury the button under them.
 */
export const NAMES_SHOWN = 5;

export function listStrandedHolders(preview: TrainingMovePreview): {
  names: readonly string[];
  more: string | null;
} {
  const all = preview.strandedHolders.map((h) => h.name);
  if (all.length <= NAMES_SHOWN) return { names: all, more: null };
  const rest = all.length - NAMES_SHOWN;
  return {
    names: all.slice(0, NAMES_SHOWN),
    more: rest === 1 ? "and 1 more" : `and ${rest} more`,
  };
}
