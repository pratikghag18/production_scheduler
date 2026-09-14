// scripts/voice/train/lib/prepare.mjs — pure pieces behind
// `scripts/voice/train/prepare.mjs` (S43-a brief §3): building one
// chat-format row, checking train/held-out disjointness, and assembling the
// manifest the notebook reads instead of retyping the system prompt or the
// rule parser's baseline (brief §2's "asserts its own serialisation against
// a sample in the manifest"; §4 step 9's "from manifest.json").
//
// Nothing here touches the filesystem; `../prepare.mjs` reads/writes files
// and turns argv into calls on these functions (S42-a's own split between
// `lib/rows.mjs` and `generate.mjs`).
import { canonical } from "../../lib/form.mjs";
import { score, rate } from "../../lib/score.mjs";
import { parseCommand } from "../../../../src/lib/command/parse.ts";

/** Parses JSONL text into an array of row objects — the same shape
 *  `generate.mjs` writes and `score.mjs`'s own loader reads. */
export function parseJsonl(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** The one chat-format row for a training row (brief §3): the system
 *  prompt, the sentence, and the model's target — `canonical(row.form)`
 *  byte for byte, never re-derived by the notebook. */
export function buildChatRow(systemPrompt, row) {
  return {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: row.sentence },
      { role: "assistant", content: canonical(row.form) },
    ],
  };
}

export function buildChatRows(systemPrompt, trainRows) {
  return trainRows.map((row) => buildChatRow(systemPrompt, row));
}

/** Throws, naming every colliding row, if a training sentence also appears
 *  in held-out (brief §3: "asserts train/held-out disjointness"). This is a
 *  defensive re-check — `generate.mjs` already drops collisions against a
 *  committed `heldout.jsonl` as it builds the training set — so this should
 *  never fire on the files `npm run voice:generate` produces; it exists for
 *  a training file built some other way. */
export function assertDisjoint(trainRows, heldoutRows) {
  const heldoutSentences = new Set(heldoutRows.map((r) => r.sentence));
  const collisions = trainRows.filter((r) => heldoutSentences.has(r.sentence));
  if (collisions.length > 0) {
    const first = collisions[0];
    throw new Error(
      `prepare: ${collisions.length} training row(s) collide with held-out sentences, ` +
        `e.g. ${first.id}: "${first.sentence}"`,
    );
  }
}

/** The rule parser's own score on held-out — the number every trained model
 *  must beat. Computed here (never retyped from the brief's example
 *  numbers) so `manifest.json` always carries the CURRENT baseline, even if
 *  the grammar or the held-out set ever changes. */
export function ruleParserBaseline(heldoutRows) {
  const predict = (row) => {
    const result = parseCommand(row.sentence);
    return result.ok ? result.command : null;
  };
  const result = score(heldoutRows, predict);
  return { clean: rate(result.clean), perturbed: rate(result.perturbed) };
}

/**
 * `manifest.json`'s content: row counts, the fixed generation seeds, the
 * git sha, the system prompt (so the notebook can read it at inference time
 * instead of retyping it — only three files travel to Drive, brief §5 step
 * 1, and the system prompt is not one of them), the rule parser's current
 * baseline, and one sample's `canonical` form so the notebook can assert its
 * own chat-template round trip against it. The sample is held-out's first
 * row — deterministic, since held-out is committed and never regenerated.
 */
export function buildManifest({
  trainRows,
  heldoutRows,
  systemPrompt,
  gitSha,
  trainSeed,
  heldoutSeed,
  generatedAt,
}) {
  const sample = heldoutRows[0];
  return {
    gitSha,
    generatedAt,
    trainRows: trainRows.length,
    heldoutRows: heldoutRows.length,
    seeds: { train: trainSeed, heldout: heldoutSeed },
    systemPrompt,
    ruleParserBaseline: ruleParserBaseline(heldoutRows),
    sample: {
      id: sample.id,
      sentence: sample.sentence,
      canonicalForm: canonical(sample.form),
    },
  };
}
