#!/usr/bin/env node
// scripts/voice/generate.mjs — S42-a's generator CLI: a thin wrapper over
// `lib/rows.mjs` (brief §2) that handles argv, the filesystem, and turning
// an oracle mismatch into a non-zero exit.
//
// `--out <file> --n <rows> --seed <s> [--heldout]`
//
// Writes JSONL, one row per line: `{ id, intent, sentence, form, clean,
// source }`. Every CLEAN row is checked against the rule parser as it is
// built (`lib/rows.mjs`'s `buildClean`) and the process exits non-zero on
// the FIRST mismatch, naming the template id and the sentence (brief §2: a
// template the parser cannot read is a template bug, never a parser change
// made from here). Perturbed rows carry the clean sentence's form
// unchanged and are not re-checked.
//
// `--heldout` generates the reference set (nothing to collide with yet).
// Otherwise the generator loads the committed `data/voice/heldout.jsonl`,
// if present, and drops (retries) any training-side sentence that collides
// with it (brief §2: "disjoint... the generator checks and drops
// collisions from the training side").
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateHeldoutRows, generateTrainingRows, OracleMismatchError } from "./lib/rows.mjs";

const HELDOUT_PATH = fileURLToPath(new URL("../../data/voice/heldout.jsonl", import.meta.url));

function parseArgs(argv) {
  const out = { out: null, n: null, seed: null, heldout: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--n") out.n = Number(argv[++i]);
    else if (a === "--seed") out.seed = Number(argv[++i]);
    else if (a === "--heldout") out.heldout = true;
    else throw new Error(`generate.mjs: unknown argument "${a}"`);
  }
  if (!out.out) throw new Error("generate.mjs: --out <file> is required");
  if (!Number.isInteger(out.n) || out.n <= 0)
    throw new Error("generate.mjs: --n <rows> is required");
  if (!Number.isInteger(out.seed)) throw new Error("generate.mjs: --seed <s> is required");
  return out;
}

function loadHeldoutSentences() {
  if (!existsSync(HELDOUT_PATH)) return new Set();
  const text = readFileSync(HELDOUT_PATH, "utf8");
  const set = new Set();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    set.add(JSON.parse(trimmed).sentence);
  }
  return set;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let rows;
  try {
    rows = args.heldout
      ? generateHeldoutRows(args.seed)
      : generateTrainingRows(args.seed, args.n, loadHeldoutSentences());
  } catch (err) {
    if (err instanceof OracleMismatchError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(outPath, text, "utf8");

  const cleanCount = rows.filter((r) => r.clean).length;
  console.log(
    `wrote ${rows.length} rows to ${args.out} (${cleanCount} clean, ${rows.length - cleanCount} perturbed)`,
  );
}

main();
