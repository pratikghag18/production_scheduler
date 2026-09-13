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
 * `BookCommand` do not share every field. `extraKeys` is `{ n, keys }`: `n`
 * is the number of rows whose prediction carried a key the expected form did
 * not, at any level; `keys` counts each such key name across every
 * occurrence (first-seen order). It is a diagnostic only -- it never changes
 * `correct`.
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

    const sameIntent = predicted != null && predicted.intent === row.intent;
    for (const field of Object.keys(row.form)) {
      const fieldBucket = (byField[field] ??= emptyBucket());
      fieldBucket.n++;
      if (sameIntent && JSON.stringify(predicted[field]) === JSON.stringify(row.form[field])) {
        fieldBucket.correct++;
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
