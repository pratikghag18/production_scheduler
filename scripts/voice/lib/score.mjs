// scripts/voice/lib/score.mjs — scores a set of rows against a predictor
// (S42-a §3). `predict(row)` returns a `Command`-shaped object or
// `null`/`undefined` for "could not parse"; nothing here knows or cares
// whether the predictor is the rule parser or a trained model -- that is the
// whole point (brief §1: "every reader ... is scored against it").
//
// A model may invent a field the training data never had (a fine-tuned
// model's first real run added `"type":"assign"` to an otherwise-perfect
// AssignCommand). The resolver only ever reads the fields it knows, so that
// extra key changes nothing a person sees -- but a bare `canonical(predicted)
// === canonical(row.form)` would still call the row wrong. Before comparing,
// the predicted form is normalised down to the keys the EXPECTED form has,
// recursively (so an extra key nested inside `start`/`end`/`span` is ignored
// the same way); a key the expected form has but the prediction lacks is
// still missing, never "extra" -- that keeps a genuinely wrong/incomplete
// prediction wrong. Every row that carried an extra key anywhere is counted
// in `extraKeys`, visible in the table, without moving the verdict.
import { canonical } from "./form.mjs";

function emptyBucket() {
  return { n: 0, correct: 0 };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keeps only the keys `expected` has, recursively wherever both sides are
 *  plain objects at the same spot (covers `start`/`end`/`span` and any other
 *  nested field without naming them). A key `expected` lacks a value for
 *  (missing on `predicted`) is simply not copied -- "missing" stays missing,
 *  never confused with "extra". */
function normalizeToKnownKeys(predicted, expected) {
  if (!isPlainObject(predicted) || !isPlainObject(expected)) return predicted;
  const out = {};
  for (const key of Object.keys(expected)) {
    if (key in predicted) out[key] = normalizeToKnownKeys(predicted[key], expected[key]);
  }
  return out;
}

/** Collects every key `predicted` carries that `expected` does not, at any
 *  depth where both sides are plain objects, into `into` (one entry per
 *  occurrence). */
function collectExtraKeys(predicted, expected, into) {
  if (!isPlainObject(predicted) || !isPlainObject(expected)) return;
  for (const key of Object.keys(predicted)) {
    if (!(key in expected)) into.push(key);
    else collectExtraKeys(predicted[key], expected[key], into);
  }
}

/**
 * `{ clean: {n, correct}, perturbed: {n, correct}, byIntent, byField,
 * extraKeys }`. `byIntent[intent]` is `{ clean, perturbed }` in the same
 * `{n, correct}` shape. `byField[field]` counts, over every row that carries
 * that field (any intent), whether the predictor got exactly that field
 * right -- comparable across intents even though `AssignCommand` and
 * `BookCommand` do not share every field. A field is judged the same
 * key-order-blind way the row verdict is -- `canonical()` on both sides,
 * against the normalised prediction (the same value the row verdict
 * compares), so a model that writes keys in a different order, or an extra
 * key inside a nested object the normalisation strips, does not count as
 * wrong. `extraKeys` is `{ n, keys }`: `n` is the number of rows whose
 * prediction carried a key the expected form did not, at any level; `keys`
 * counts each such key name across every occurrence (first-seen order). It
 * is a diagnostic only -- it never changes `correct`.
 *
 * S50 (R-398): a `several` row's OWN top-level keys are just `commands` and
 * `intent` -- `place`/`span`/`operator`/... never show up in `byField` for
 * it unless we look INSIDE `commands`. When the prediction is ALSO a
 * `several` with the SAME number of inner commands as the row's own, each
 * inner command's fields are tallied into the SAME `byField` buckets a
 * plain assign/book/unassign/move row would use (merged by field name, not
 * kept separate per intent) -- that is what keeps `place` and `span`
 * meaningful for a several row too, exactly the way brief §2 item 6 asks.
 * A different inner count is already wrong for the ROW (the whole-form
 * `canonical` compare never matches when the array lengths differ) and
 * tallies NOTHING inner here either -- never a guess at which of a
 * differently-sized pair of lists might correspond to which.
 */
export function score(rows, predict) {
  const clean = emptyBucket();
  const perturbed = emptyBucket();
  const byIntent = {};
  const byField = {};
  const extraKeys = { n: 0, keys: {} };

  for (const row of rows) {
    const overall = row.clean ? clean : perturbed;
    overall.n++;

    const predicted = predict(row);

    if (predicted != null) {
      const extra = [];
      collectExtraKeys(predicted, row.form, extra);
      if (extra.length > 0) {
        extraKeys.n++;
        for (const key of extra) extraKeys.keys[key] = (extraKeys.keys[key] ?? 0) + 1;
      }
    }

    const normalizedPredicted =
      predicted == null ? predicted : normalizeToKnownKeys(predicted, row.form);
    const isCorrect =
      normalizedPredicted != null && canonical(normalizedPredicted) === canonical(row.form);
    if (isCorrect) overall.correct++;

    const intentBucket = (byIntent[row.intent] ??= {
      clean: emptyBucket(),
      perturbed: emptyBucket(),
    });
    const intentSide = row.clean ? intentBucket.clean : intentBucket.perturbed;
    intentSide.n++;
    if (isCorrect) intentSide.correct++;

    const sameIntent = normalizedPredicted != null && normalizedPredicted.intent === row.intent;
    for (const field of Object.keys(row.form)) {
      const fieldBucket = (byField[field] ??= emptyBucket());
      fieldBucket.n++;
      if (sameIntent && canonical(normalizedPredicted[field]) === canonical(row.form[field])) {
        fieldBucket.correct++;
      }
    }

    // S50: a several's own inner commands' fields, tallied into the same
    // `byField` buckets (see the doc comment above `score` for why). A
    // different inner count (or no several prediction at all) tallies
    // NOTHING here -- the whole loop is skipped, never run with a null
    // `predictedInner` on every iteration (that would still count `n` for
    // fields no other row in the set carries at all).
    if (row.intent === "several" && Array.isArray(row.form.commands)) {
      const expectedCommands = row.form.commands;
      const predictedCommands =
        sameIntent &&
        Array.isArray(normalizedPredicted.commands) &&
        normalizedPredicted.commands.length === expectedCommands.length
          ? normalizedPredicted.commands
          : null;
      if (predictedCommands != null) {
        for (let i = 0; i < expectedCommands.length; i++) {
          const expectedInner = expectedCommands[i];
          const predictedInner = normalizeToKnownKeys(predictedCommands[i], expectedInner);
          const sameInnerIntent = predictedInner.intent === expectedInner.intent;
          for (const field of Object.keys(expectedInner)) {
            const fieldBucket = (byField[field] ??= emptyBucket());
            fieldBucket.n++;
            if (
              sameInnerIntent &&
              canonical(predictedInner[field]) === canonical(expectedInner[field])
            ) {
              fieldBucket.correct++;
            }
          }
        }
      }
    }
  }

  return { clean, perturbed, byIntent, byField, extraKeys };
}

/** `correct/n`, or `1` for an empty bucket (nothing to get wrong). */
export function rate(bucket) {
  return bucket.n === 0 ? 1 : bucket.correct / bucket.n;
}

/** "extra keys ignored: N rows (type: 12, foo: 1)" -- the one line both
 *  `score.mjs` and `score_port.py` print so the diagnostic is visible
 *  without moving the verdict. Exported so both CLI printers stay in sync. */
export function formatExtraKeysLine(extraKeys) {
  const parts = Object.entries(extraKeys.keys).map(([key, count]) => `${key}: ${count}`);
  const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `extra keys ignored: ${extraKeys.n} rows${suffix}`;
}
