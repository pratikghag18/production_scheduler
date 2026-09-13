#!/usr/bin/env node
// scripts/voice/serve/probe.mjs — S44-a: sends sentences through the
// contract in docs/agent-briefs/s44-a-serve-brief.md §2 to a running
// `npm run voice:serve` and prints what came back. Three modes:
//
//   npm run voice:probe -- "put Ana Silva on Housing A tomorrow"
//   npm run voice:probe -- --repeat 3 "..."
//   npm run voice:probe -- --heldout data/voice/heldout.jsonl --out <predictions.jsonl> [--limit N]
//
// `--url` (default http://127.0.0.1:8089) is the service itself -- this
// talks straight to the container, not through the Vite dev-server proxy
// the app uses (vite.config.ts's `/voice` rule strips a prefix this script
// has no reason to add).
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SYSTEM_PROMPT_PATH = fileURLToPath(new URL("../train/system_prompt.txt", import.meta.url));
const DEFAULT_URL = "http://127.0.0.1:8089";

function parseArgs(argv) {
  const out = {
    url: DEFAULT_URL,
    sentence: null,
    repeat: 1,
    heldout: null,
    out: null,
    limit: null,
    words: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--sentence") out.sentence = argv[++i];
    else if (a === "--repeat") out.repeat = Number(argv[++i]);
    else if (a === "--heldout") out.heldout = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else out.words.push(a);
  }
  if (!out.sentence && out.words.length > 0) out.sentence = out.words.join(" ");
  return out;
}

// Mirrors the contract's "the form is the first complete top-level `{...}`
// object in it (scan braces, honour strings)" -- same rule the Colab
// notebook's `_scan_braces` / `extract_first_json_object` cell uses on the
// Python side (scripts/voice/train/train_qwen3.ipynb), ported to JS here so
// this script has no Python dependency.
function firstJsonObject(text) {
  let depth = 0;
  let started = false;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (!started) start = i;
      depth++;
      started = true;
    } else if (ch === "}") {
      depth--;
      if (started && depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseForm(content) {
  const jsonText = firstJsonObject(content);
  if (jsonText === null) return null;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

async function callService(url, systemPrompt, sentence) {
  const body = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: sentence },
    ],
    temperature: 0,
    max_tokens: 256,
    cache_prompt: true,
    chat_template_kwargs: { enable_thinking: false },
  };
  const started = performance.now();
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const wallMs = performance.now() - started;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${url}/v1/chat/completions -> ${res.status} ${res.statusText}\n${text}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content ?? "";
  const form = parseForm(content);
  return { content, form, wallMs, timings: json?.timings ?? null };
}

async function runOnce(url, systemPrompt, sentence) {
  const { content, form, wallMs, timings } = await callService(url, systemPrompt, sentence);
  console.log(`\nsentence: ${sentence}`);
  console.log(`content: ${content}`);
  console.log(`form: ${form === null ? "null (not a form)" : JSON.stringify(form, null, 2)}`);
  console.log(`wall time: ${wallMs.toFixed(0)} ms`);
  if (timings) console.log(`server timings: ${JSON.stringify(timings)}`);
}

async function runRepeat(url, systemPrompt, sentence, repeat) {
  for (let i = 0; i < repeat; i++) {
    console.log(`\n--- call ${i + 1}/${repeat} ---`);
    await runOnce(url, systemPrompt, sentence);
  }
}

function loadJsonl(path) {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// Reads a predictions file written by `runHeldout` below, tolerating a
// truncated last line -- a run killed mid-`appendFileSync` leaves a partial
// JSON object on disk, and without this guard the next run's `JSON.parse`
// throws instead of resuming. Parses line by line; the first line that
// fails to parse, or that parses but has no string `id`, and every line
// after it, are dropped -- a truncated write is always the last thing on
// disk, never a line in the middle, so nothing past that point is trusted
// either. When anything was dropped, the file is rewritten with only the
// good lines (so the scorer downstream never sees a bad line) and one line
// is printed saying how many were dropped; the dropped rows are re-run
// because their ids are no longer in `doneIds`.
function loadResumablePredictions(path) {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const rows = [];
  let droppedFrom = -1;
  for (let i = 0; i < lines.length; i++) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      droppedFrom = i;
      break;
    }
    if (typeof row.id !== "string") {
      droppedFrom = i;
      break;
    }
    rows.push(row);
  }

  if (droppedFrom !== -1) {
    const droppedCount = lines.length - droppedFrom;
    const goodText = rows.length > 0 ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
    writeFileSync(path, goodText, "utf8");
    console.log(
      `${path}: dropped ${droppedCount} bad or truncated line(s) from row ${droppedFrom + 1} ` +
        `onward (most likely a killed run's partial last write); rewrote the file with the ` +
        `${rows.length} good row(s) -- the dropped ids will be re-run.`,
    );
  }

  return rows;
}

// Same resume rule as the Colab notebook's prediction cell
// (train_qwen3.ipynb): if `--out` already has rows for some ids, skip
// those and keep appending instead of starting over -- a long held-out run
// interrupted partway through does not have to redo the rows it already
// has.
async function runHeldout(url, systemPrompt, heldoutPath, outPath, limit) {
  const rows = loadJsonl(heldoutPath);
  const limited = limit ? rows.slice(0, limit) : rows;
  const total = limited.length;

  mkdirSync(dirname(outPath), { recursive: true });
  const doneIds = new Set();
  if (existsSync(outPath)) {
    for (const row of loadResumablePredictions(outPath)) doneIds.add(row.id);
  }
  if (doneIds.size > 0) {
    console.log(`resuming: ${doneIds.size} row(s) already predicted, skipping them`);
  }

  const toRun = limited.filter((r) => !doneIds.has(r.id));
  if (toRun.length === 0) {
    console.log(`all ${total} row(s) already predicted -- nothing to do`);
    return;
  }

  let nFailed = 0;
  const startTime = performance.now();
  for (let i = 0; i < toRun.length; i++) {
    const row = toRun[i];
    let form = null;
    try {
      const result = await callService(url, systemPrompt, row.sentence);
      form = result.form;
    } catch (err) {
      console.error(`row ${row.id} failed: ${err.message}`);
    }
    if (form === null) nFailed++;
    appendFileSync(outPath, `${JSON.stringify({ id: row.id, form })}\n`, "utf8");

    const doneThisRun = i + 1;
    if (doneThisRun % 25 === 0 || doneThisRun === toRun.length) {
      const elapsedS = (performance.now() - startTime) / 1000;
      const rate = elapsedS > 0 ? doneThisRun / elapsedS : 0;
      console.log(
        `${doneIds.size + doneThisRun}/${total} rows, ${elapsedS.toFixed(0)}s, ` +
          `${rate.toFixed(2)} rows/s, ${nFailed} failed to parse`,
      );
    }
  }
  console.log(
    `finished this run: ${toRun.length} row(s) predicted, ${nFailed} failed to parse total`,
  );
  console.log(`predictions written to ${outPath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf8");

  if (args.heldout) {
    if (!args.out) throw new Error("probe.mjs: --heldout requires --out <predictions.jsonl>");
    await runHeldout(args.url, systemPrompt, args.heldout, args.out, args.limit);
    return;
  }

  if (!args.sentence) {
    throw new Error(
      'probe.mjs: give a sentence as arguments, or --sentence "...", or use --heldout',
    );
  }

  if (args.repeat > 1) await runRepeat(args.url, systemPrompt, args.sentence, args.repeat);
  else await runOnce(args.url, systemPrompt, args.sentence);
}

// Guarded so this file can be imported (e.g. from a scratch test script)
// to exercise `loadResumablePredictions` without also running `main()`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.stack ?? String(err));
    process.exit(1);
  });
}

export { loadResumablePredictions };
