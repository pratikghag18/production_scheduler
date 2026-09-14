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
import { parseJsonl, buildChatRows, assertDisjoint, buildManifest } from "./lib/prepare.mjs";

const SYSTEM_PROMPT_PATH = fileURLToPath(new URL("./system_prompt.txt", import.meta.url));

// The fixed seeds `package.json`'s own scripts use to generate these files
// (`voice:generate` for training; S42-a's held-out generation, run once, for
// held-out) — recorded here, not re-derived from the files themselves (a
// generated row carries no seed), so the manifest can name them (brief §3:
// "manifest.json (row counts, seeds, the git sha, ...)").
const TRAIN_SEED = 1;
const HELDOUT_SEED = 20260911;

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
  writeFileSync(
    resolve(outDir, "train.chat.jsonl"),
    chatRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  writeFileSync(resolve(outDir, "heldout.jsonl"), heldoutText, "utf8");

  const manifest = buildManifest({
    trainRows,
    heldoutRows,
    systemPrompt,
    gitSha: gitSha(),
    trainSeed: TRAIN_SEED,
    heldoutSeed: HELDOUT_SEED,
    generatedAt: new Date().toISOString(),
  });
  writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(
    `wrote ${chatRows.length} chat rows and ${heldoutRows.length} held-out rows to ${outDir}`,
  );
  console.log(JSON.stringify(manifest, null, 2));
}

main();
