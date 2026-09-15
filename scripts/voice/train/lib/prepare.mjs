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
import { createHash } from "node:crypto";
import { canonical } from "../../lib/form.mjs";
import { score, rate } from "../../lib/score.mjs";
import { parseCommand } from "../../../../src/lib/command/parse.ts";

/** sha256 of the exact bytes a string would be written as (utf8) -- one
 *  algorithm, used for `manifest.json`'s own `files` block (F-148 §1) and
 *  for `EXPECTED_FILES` in the notebook copy `prepare.mjs` writes (F-148
 *  design note). Not "streamed" here -- the text is already fully in
 *  memory (this module touches no filesystem), and a single `update()`
 *  call produces the identical digest a chunked, streamed hash of the same
 *  bytes would (the notebook streams because it reads multi-MB files off
 *  disk; there is nothing to stream from a string already in memory). */
export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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
 * baseline, one sample's `canonical` form so the notebook can assert its
 * own chat-template round trip against it, and (F-148 §1) a `files` block
 * naming the sha256 and row count of `train.chat.jsonl` and `heldout.jsonl`
 * exactly as `prepare.mjs` is about to write them, so the notebook can tell
 * a stale Drive copy from the one this manifest was actually prepared with.
 * The sample is held-out's first row — deterministic, since held-out is
 * committed and never regenerated.
 *
 * `trainChatText` and `heldoutText` must be the EXACT bytes `prepare.mjs`
 * writes to `train.chat.jsonl` and `heldout.jsonl` — this function hashes
 * them, it does not re-derive them, so a caller that passes anything else
 * produces a manifest that does not describe the files on disk.
 */
export function buildManifest({
  trainRows,
  heldoutRows,
  systemPrompt,
  gitSha,
  trainSeed,
  heldoutSeed,
  generatedAt,
  trainChatText,
  heldoutText,
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
    files: {
      "train.chat.jsonl": { sha256: sha256Hex(trainChatText), rows: trainRows.length },
      "heldout.jsonl": { sha256: sha256Hex(heldoutText), rows: heldoutRows.length },
    },
  };
}

/**
 * The six source lines (F-148 design note) that replace the
 * `EXPECTED_FILES = None` placeholder in the notebook copy's Settings
 * cell: the git sha and, for each of the three files that travel to
 * Drive, the sha256 `buildManifest` already computed (`manifest.json`
 * itself is hashed here, once it has been serialized, since its own bytes
 * are not known until after `buildManifest` returns). Each line carries
 * its own trailing "\n", matching the notebook's own source-array
 * convention (every line, the last included) so a caller can splice this
 * straight into a cell's `source` array with
 * `replaceCellSourceInRawText`.
 */
export function buildExpectedFilesLines({ gitSha, manifest, manifestText }) {
  const trainChat = manifest.files["train.chat.jsonl"];
  const heldout = manifest.files["heldout.jsonl"];
  return [
    "EXPECTED_FILES = {\n",
    `    "gitSha": ${JSON.stringify(gitSha)},\n`,
    `    "train.chat.jsonl": {"sha256": ${JSON.stringify(trainChat.sha256)}, "rows": ${trainChat.rows}},\n`,
    `    "heldout.jsonl": {"sha256": ${JSON.stringify(heldout.sha256)}, "rows": ${heldout.rows}},\n`,
    `    "manifest.json": {"sha256": ${JSON.stringify(sha256Hex(manifestText))}},\n`,
    "}\n",
  ];
}

/**
 * Splices `newLines` in as cell `cellIndex`'s ENTIRE `source` array, by
 * locating that cell's `"source": [ ... ]` block directly in the raw
 * `.ipynb` text (its (cellIndex+1)'th occurrence — every cell has exactly
 * one `source` key) and rewriting only that span, in the file's own
 * formatting (one element per source line, 4-space indent, `,\r\n`
 * between elements, no trailing comma). Every other byte of the notebook
 * — including cells this repo does not own — is untouched, because
 * nothing here goes through `JSON.stringify` on the whole document (F-148
 * task instructions: "Edit the notebook only through a node script that
 * parses the JSON and writes it back with the same formatting; every
 * other cell byte-identical").
 */
export function replaceCellSourceInRawText(rawText, cellIndex, newLines) {
  const marker = '"source": [';
  let searchStart = 0;
  let startIdx = -1;
  for (let i = 0; i <= cellIndex; i++) {
    startIdx = rawText.indexOf(marker, searchStart);
    if (startIdx === -1) {
      throw new Error(`replaceCellSourceInRawText: source block ${i} not found`);
    }
    searchStart = startIdx + 1;
  }
  const arrayStart = startIdx + marker.length;
  const closeMarker = "\r\n   ]";
  const closeIdx = rawText.indexOf(closeMarker, arrayStart);
  if (closeIdx === -1) {
    throw new Error("replaceCellSourceInRawText: closing bracket not found");
  }
  const body = newLines.map((line) => "    " + JSON.stringify(line)).join(",\r\n");
  const replacement = marker + "\r\n" + body + closeMarker;
  return rawText.slice(0, startIdx) + replacement + rawText.slice(closeIdx + closeMarker.length);
}
