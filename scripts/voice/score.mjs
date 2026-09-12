#!/usr/bin/env node
// scripts/voice/score.mjs — S42-a's scorer CLI.
//
// `--heldout data/voice/heldout.jsonl [--predictions <file> | --rule-parser] --bar 0.95`
//
// Prints the score table and exits 1 when the CLEAN rate falls below `--bar`
// (brief §7: "a score below the bar fails the build the way a lost test file
// fails `npm run test` today"). The perturbed rate is reported, never
// gated -- brief §2: "that gap is the whole reason for a model."
import { readFileSync } from "node:fs";
import { parseCommand } from "../../src/lib/command/parse.ts";
import { score, rate } from "./lib/score.mjs";

function parseArgs(argv) {
  const out = { heldout: null, predictions: null, ruleParser: false, bar: 0.95 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--heldout") out.heldout = argv[++i];
    else if (a === "--predictions") out.predictions = argv[++i];
    else if (a === "--rule-parser") out.ruleParser = true;
    else if (a === "--bar") out.bar = Number(argv[++i]);
    else throw new Error(`score.mjs: unknown argument "${a}"`);
  }
  if (!out.heldout) throw new Error("score.mjs: --heldout <file> is required");
  if (!out.ruleParser && !out.predictions) {
    throw new Error("score.mjs: one of --rule-parser or --predictions <file> is required");
  }
  return out;
}

function loadJsonl(path) {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function ruleParserPredict(row) {
  const result = parseCommand(row.sentence);
  return result.ok ? result.command : null;
}

function predictionsPredict(path) {
  const rows = loadJsonl(path);
  const byId = new Map(rows.map((r) => [r.id, r.form]));
  return (row) => byId.get(row.id) ?? null;
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function printTable(result) {
  console.log("\nOverall:");
  console.log(
    `  clean:     ${result.clean.correct}/${result.clean.n}  (${pct(rate(result.clean))})`,
  );
  console.log(
    `  perturbed: ${result.perturbed.correct}/${result.perturbed.n}  (${pct(rate(result.perturbed))})`,
  );

  console.log("\nBy intent:");
  for (const [intent, bucket] of Object.entries(result.byIntent)) {
    console.log(
      `  ${intent.padEnd(10)} clean ${String(bucket.clean.correct).padStart(3)}/${String(bucket.clean.n).padEnd(3)} (${pct(rate(bucket.clean))})` +
        `   perturbed ${String(bucket.perturbed.correct).padStart(3)}/${String(bucket.perturbed.n).padEnd(3)} (${pct(rate(bucket.perturbed))})`,
    );
  }

  console.log("\nBy field:");
  for (const [field, bucket] of Object.entries(result.byField)) {
    console.log(`  ${field.padEnd(12)} ${bucket.correct}/${bucket.n}  (${pct(rate(bucket))})`);
  }
  console.log("");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = loadJsonl(args.heldout);
  const predict = args.ruleParser ? ruleParserPredict : predictionsPredict(args.predictions);

  const result = score(rows, predict);
  printTable(result);

  const cleanRate = rate(result.clean);
  console.log(`clean rate ${pct(cleanRate)} vs bar ${pct(args.bar)}`);
  if (cleanRate < args.bar) {
    console.error(`FAIL: clean rate ${pct(cleanRate)} is below the bar ${pct(args.bar)}`);
    process.exit(1);
  }
  console.log("PASS");
}

main();
