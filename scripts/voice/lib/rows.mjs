// scripts/voice/lib/rows.mjs — the row-building logic behind
// `generate.mjs`, kept here (rather than in the CLI file) so it is testable
// without a subprocess (brief §2: "generate.mjs and score.mjs are thin CLIs
// over [the lib]"). Nothing here touches the filesystem; `generate.mjs`
// reads/writes files and turns a thrown oracle mismatch into a process exit.
import { mulberry32, randInt, pick, chance } from "./rng.mjs";
import { TEMPLATES } from "./templates.mjs";
import { perturbAll, perturbedRowForm } from "./perturb.mjs";
import { equalForms } from "./form.mjs";
import { parseCommand } from "../../../src/lib/command/parse.ts";

export const INTENTS = ["assign", "book", "unassign", "move"];

export function templatesFor(intent) {
  return TEMPLATES.filter((t) => t.intent === intent);
}

/** An error naming the template id and sentence that broke the oracle
 *  (brief §2's "exits non-zero on the first mismatch" -- the CLI is what
 *  turns this into that exit; a test can catch it instead). */
export class OracleMismatchError extends Error {
  constructor(templateId, sentence, expected, actual) {
    super(
      `ORACLE MISMATCH -- template "${templateId}"\n  sentence: ${sentence}\n  expected: ${JSON.stringify(expected)}\n  parsed:   ${JSON.stringify(actual)}`,
    );
    this.name = "OracleMismatchError";
    this.templateId = templateId;
    this.sentence = sentence;
  }
}

/** Builds one clean (sentence, form) pair from `template` and asserts the
 *  rule-parser oracle immediately -- the one check the whole generator
 *  exists to run (brief §2). Throws `OracleMismatchError` on the first
 *  mismatch; never touches `parse.ts`. */
export function buildClean(template, rng) {
  const slots = template.genSlots(rng);
  const sentence = template.sentence(slots);
  const form = template.form(slots);
  const result = parseCommand(sentence);
  if (!result.ok || !equalForms(result.command, form)) {
    throw new OracleMismatchError(
      template.id,
      sentence,
      form,
      result.ok ? result.command : result.failure,
    );
  }
  return { sentence, form };
}

/** One row, retrying (dropping a colliding attempt and trying again) while
 *  the chosen sentence collides with `forbidden` or with a sentence already
 *  emitted in this run (`seen`). */
export function makeRow(template, rng, wantClean, forbidden, seen, idPrefix, index) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { sentence: cleanSentence, form: cleanForm } = buildClean(template, rng);
    let sentence = cleanSentence;
    let source = template.id;
    let form = cleanForm;
    if (!wantClean) {
      const n = randInt(rng, 1, 3);
      const perturbedResult = perturbAll(cleanSentence, rng, n);
      sentence = perturbedResult.sentence;
      source =
        perturbedResult.ids.length > 0
          ? `${template.id}+${perturbedResult.ids.join("+")}`
          : template.id;
      // The one place a perturbed row's form is decided -- always the clean
      // sentence's own form, whatever ids were applied (brief §2). See
      // `perturbedRowForm`'s own comment: this is the line V3 exercises and
      // X2 mutates.
      form = perturbedRowForm(cleanForm, perturbedResult.ids);
    }
    if (forbidden.has(sentence) || seen.has(sentence)) continue;
    seen.add(sentence);
    return {
      id: `${idPrefix}-${String(index).padStart(5, "0")}`,
      intent: template.intent,
      sentence,
      form,
      clean: wantClean,
      source,
    };
  }
  throw new Error(`makeRow: could not find a non-colliding sentence for template "${template.id}"`);
}

/** The held-out set: 100 rows per intent, 50 clean and 50 perturbed within
 *  each, templates cycled evenly. Nothing is forbidden -- this IS the
 *  reference set. */
export function generateHeldoutRows(seed) {
  const rng = mulberry32(seed);
  const rows = [];
  const seen = new Set();
  const forbidden = new Set();
  let index = 0;
  for (const intent of INTENTS) {
    const templates = templatesFor(intent);
    for (let i = 0; i < 50; i++) {
      const t = templates[i % templates.length];
      rows.push(makeRow(t, rng, true, forbidden, seen, "ho", index++));
    }
    for (let i = 0; i < 50; i++) {
      const t = templates[i % templates.length];
      rows.push(makeRow(t, rng, false, forbidden, seen, "ho", index++));
    }
  }
  return rows;
}

/** The training set: `n` rows, template and clean/perturbed chosen at
 *  random each time, dropping (retrying) any sentence in `forbiddenSet`
 *  (the held-out set's own sentences) -- brief §2's disjointness rule. */
export function generateTrainingRows(seed, n, forbiddenSet = new Set()) {
  const rng = mulberry32(seed);
  const seen = new Set();
  const rows = [];
  for (let i = 0; i < n; i++) {
    const template = pick(rng, TEMPLATES);
    const wantClean = chance(rng, 0.5);
    rows.push(makeRow(template, rng, wantClean, forbiddenSet, seen, "tr", i));
  }
  return rows;
}
