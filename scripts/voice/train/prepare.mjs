#!/usr/bin/env node
// scripts/voice/train/prepare.mjs — S43-a §3's CLI: turns the committed
// held-out set and a generated training set into the three files Colab
// needs (brief §5 step 1). Never touches the notebook or the model.
//
// `--train data/voice/train.jsonl --heldout data/voice/heldout.jsonl --out data/voice/colab/`
//
// Writes `train.chat.jsonl` (one chat row per training row), copies
// `heldout.jsonl` verbatim, and writes `manifest.json`. `data/voice/colab/`
// is gitignored — this is a local build step, run again whenever the
// training set is regenerated.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseJsonl,
  buildChatRows,
  assertDisjoint,
  buildManifest,
  buildExpectedFilesLines,
  replaceCellSourceInRawText,
} from "./lib/prepare.mjs";

const SYSTEM_PROMPT_PATH = fileURLToPath(new URL("./system_prompt.txt", import.meta.url));
const SOURCE_NOTEBOOK_PATH = fileURLToPath(new URL("./train_qwen3.ipynb", import.meta.url));

// The exact line the notebook checked into the repo carries in its
// Settings cell (F-148 design note) -- this run's fingerprints replace it
// in the COPY written to `data/voice/colab/`; the source notebook itself
// is never touched by this script.
const EXPECTED_FILES_PLACEHOLDER_LINE = "EXPECTED_FILES = None\n";

// The fixed seeds `package.json`'s own scripts use to generate these files
// (`voice:generate` for training; S42-a's held-out generation, run once, for
// held-out) — recorded here, not re-derived from the files themselves (a
// generated row carries no seed), so the manifest can name them (brief §3:
// "manifest.json (row counts, seeds, the git sha, ...)").
const TRAIN_SEED = 1;
// S56-b review flag: this used to read 20260911, a stale value from before
// S56's first regeneration -- `data/voice/heldout.jsonl` has not carried
// that seed's own rows since (`data/voice/README.md`'s own held-out
// generation command is the source of truth: `--seed 20260915`). The
// generator stamps no seed into the file itself (checked: `generate.mjs`
// writes only `{ id, intent, sentence, form, clean, source }`), so this
// constant is kept in sync with the README's own documented command by
// hand, the same way `TRAIN_SEED` above already is -- `src/test/voiceData.test.ts`'s
// own pin on `manifest.json`'s `heldoutSeed` is what catches the next drift.
const HELDOUT_SEED = 20260915;

function parseArgs(argv) {
  const out = { train: null, heldout: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--train") out.train = argv[++i];
    else if (a === "--heldout") out.heldout = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else throw new Error(`prepare.mjs: unknown argument "${a}"`);
  }
  if (!out.train) throw new Error("prepare.mjs: --train <file> is required");
  if (!out.heldout) throw new Error("prepare.mjs: --heldout <file> is required");
  if (!out.out) throw new Error("prepare.mjs: --out <dir> is required");
  return out;
}

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf8").trim();
  const trainText = readFileSync(resolve(args.train), "utf8");
  const heldoutText = readFileSync(resolve(args.heldout), "utf8");
  const trainRows = parseJsonl(trainText);
  const heldoutRows = parseJsonl(heldoutText);

  assertDisjoint(trainRows, heldoutRows);

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  const chatRows = buildChatRows(systemPrompt, trainRows);
  const trainChatText = chatRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(resolve(outDir, "train.chat.jsonl"), trainChatText, "utf8");
  writeFileSync(resolve(outDir, "heldout.jsonl"), heldoutText, "utf8");

  const sha = gitSha();
  const manifest = buildManifest({
    trainRows,
    heldoutRows,
    systemPrompt,
    gitSha: sha,
    trainSeed: TRAIN_SEED,
    heldoutSeed: HELDOUT_SEED,
    generatedAt: new Date().toISOString(),
    trainChatText,
    heldoutText,
  });
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(resolve(outDir, "manifest.json"), manifestText, "utf8");

  // F-148 design note: an old same-named file can be left on Drive instead
  // of the one this run actually prepared (how is not always known), so
  // even `manifest.json` on Drive can be a stale copy sitting under the
  // expected name. A COPY of the notebook, with this run's own fingerprints
  // baked into its Settings cell, is what actually gets uploaded to Colab
  // -- the notebook's own data-load cell checks Drive's files against
  // THIS, not against whatever manifest.json happens to be sitting on
  // Drive.
  const sourceNotebookText = readFileSync(SOURCE_NOTEBOOK_PATH, "utf8");
  const notebookCells = JSON.parse(sourceNotebookText).cells;
  const settingsCellIndex = notebookCells.findIndex(
    (cell) => cell.cell_type === "code" && cell.source.join("").includes("# Settings -- every"),
  );
  if (settingsCellIndex === -1) {
    throw new Error("prepare.mjs: Settings cell not found in train_qwen3.ipynb");
  }
  const settingsSource = notebookCells[settingsCellIndex].source;
  const placeholderIdx = settingsSource.indexOf(EXPECTED_FILES_PLACEHOLDER_LINE);
  if (placeholderIdx === -1) {
    throw new Error(
      "prepare.mjs: EXPECTED_FILES placeholder not found in train_qwen3.ipynb's Settings " +
        "cell -- has the placeholder line changed?",
    );
  }
  const expectedFilesLines = buildExpectedFilesLines({ gitSha: sha, manifest, manifestText });
  const newSettingsSource = [
    ...settingsSource.slice(0, placeholderIdx),
    ...expectedFilesLines,
    ...settingsSource.slice(placeholderIdx + 1),
  ];
  const notebookCopyText = replaceCellSourceInRawText(
    sourceNotebookText,
    settingsCellIndex,
    newSettingsSource,
  );
  writeFileSync(resolve(outDir, "train_qwen3.ipynb"), notebookCopyText, "utf8");

  console.log(
    `wrote ${chatRows.length} chat rows and ${heldoutRows.length} held-out rows to ${outDir}`,
  );
  console.log(`wrote a stamped notebook copy to ${resolve(outDir, "train_qwen3.ipynb")}`);
  console.log(JSON.stringify(manifest, null, 2));
}

main();
