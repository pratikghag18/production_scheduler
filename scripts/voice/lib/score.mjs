// scripts/voice/lib/score.mjs — scores a set of rows against a predictor
// (S42-a §3). `predict(row)` returns a `Command`-shaped object or
// `null`/`undefined` for "could not parse"; nothing here knows or cares
// whether the predictor is the rule parser or a trained model -- that is the
// whole point (brief §1: "every reader ... is scored against it").
import { canonical } from "./form.mjs";

function emptyBucket() {
  return { n: 0, correct: 0 };
}

/**
 * `{ clean: {n, correct}, perturbed: {n, correct}, byIntent, byField }`.
 * `byIntent[intent]` is `{ clean, perturbed }` in the same `{n, correct}`
 * shape. `byField[field]` counts, over every row that carries that field
 * (any intent), whether the predictor got exactly that field right --
 * comparable across intents even though `AssignCommand` and `BookCommand`
 * do not share every field.
 */
export function score(rows, predict) {
  const clean = emptyBucket();
  const perturbed = emptyBucket();
  const byIntent = {};
  const byField = {};

  for (const row of rows) {
    const overall = row.clean ? clean : perturbed;
    overall.n++;

    const predicted = predict(row);
    const isCorrect = predicted != null && canonical(predicted) === canonical(row.form);
    if (isCorrect) overall.correct++;

    const intentBucket = (byIntent[row.intent] ??= {
      clean: emptyBucket(),
      perturbed: emptyBucket(),
    });
    const intentSide = row.clean ? intentBucket.clean : intentBucket.perturbed;
    intentSide.n++;
    if (isCorrect) intentSide.correct++;

    const sameIntent = predicted != null && predicted.intent === row.intent;
    for (const field of Object.keys(row.form)) {
      const fieldBucket = (byField[field] ??= emptyBucket());
      fieldBucket.n++;
      if (sameIntent && JSON.stringify(predicted[field]) === JSON.stringify(row.form[field])) {
        fieldBucket.correct++;
      }
    }
  }

  return { clean, perturbed, byIntent, byField };
}

/** `correct/n`, or `1` for an empty bucket (nothing to get wrong). */
export function rate(bucket) {
  return bucket.n === 0 ? 1 : bucket.correct / bucket.n;
}
