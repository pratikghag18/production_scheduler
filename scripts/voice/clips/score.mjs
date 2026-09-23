#!/usr/bin/env node
// scripts/voice/clips/score.mjs — S71-c (brief
// docs/agent-briefs/s71-c-clip-harness-brief.md §1.B, R-453): scores every
// recorded clip against a running whisper.cpp server, with or without a
// prompt file, so a decoding/model/prompt change is a number from this
// script, never a feeling from a walk. All I/O; the normaliser, WER and
// name-hit logic live in `lib/score.mjs` (pure, unit tested separately).
//
//   node scripts/voice/clips/score.mjs --whisper http://127.0.0.1:8090 \
//     [--prompt-file scripts/voice/clips/prompts/words-53.txt | --no-prompt] \
//     [--clips data/voice/clips] [--label base-en-beam-words-53]
//
// Sends exactly the fields the app sends (`file`, `response_format=json`,
// `temperature=0`, `language=en`, `prompt` only when a prompt file is
// given -- localRecognizer.ts's own request shape, ~434-450) to
// `<whisper>/inference`, scores the returned `text` against each clip's
// sentence, prints one row per clip and a summary line, and writes
// `<clips>/results/<label>.json` with everything.
//
// S71-f (brief docs/agent-briefs/s71-f-clip-capture-brief.md §1.D, R-453,
// R-434): `--from-trace [N]` scores the newest N clips the BAR itself
// captured live (`data/voice/trace/clips/manifest.jsonl`, via CommandBar's
// own `onClip` -- never the deliberately-recorded walk this file otherwise
// reads) against a running whisper.cpp server, printing what Whisper wrote
// THEN (`data/voice/trace/bar.jsonl`'s own `heard`, joined on `at`) next to
// what it writes NOW. There is no ground truth for a live sentence, so
// "then vs now" is the only comparison this mode makes; the maintainer
// reads the words.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { wordErrorRate, nameHits, isExact } from "./lib/score.mjs";

const TRACE_CLIPS_DIR = "data/voice/trace/clips";
const TRACE_BAR_FILE = "data/voice/trace/bar.jsonl";
const FROM_TRACE_DEFAULT_N = 20;

function parseArgs(argv) {
  const out = {
    whisper: null,
    promptFile: null,
    noPrompt: false,
    clipsDir: "data/voice/clips",
    label: null,
    // S71-f: `null` means "not this mode"; a number is the N requested.
    fromTrace: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--whisper") out.whisper = argv[++i];
    else if (a === "--prompt-file") out.promptFile = argv[++i];
    else if (a === "--no-prompt") out.noPrompt = true;
    else if (a === "--clips") out.clipsDir = argv[++i];
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--from-trace") {
      // The N is optional -- only consumed when the next argument is a bare
      // number, so `--from-trace` as the last flag (default N) never eats
      // the next unrelated argument.
      const next = argv[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) {
        out.fromTrace = Number(next);
        i++;
      } else {
        out.fromTrace = FROM_TRACE_DEFAULT_N;
      }
    } else throw new Error(`score.mjs: unknown argument "${a}"`);
  }
  if (!out.whisper) throw new Error("score.mjs: --whisper <url> is required");
  if (!out.noPrompt && !out.promptFile) {
    throw new Error("score.mjs: pass --prompt-file <path> or --no-prompt, not neither");
  }
  if (out.noPrompt && out.promptFile) {
    throw new Error("score.mjs: --no-prompt and --prompt-file are exclusive");
  }
  return out;
}

function defaultLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Posts one clip, exactly the multipart fields the app's own request uses
 *  (localRecognizer.ts). `promptText` is `""` for `--no-prompt` -- an empty
 *  string never appends a `prompt` field, matching the app's own
 *  "an absent hint, or one that returns '', sends no prompt field at all". */
async function scoreOne(whisperUrl, wavPath, promptText) {
  const bytes = readFileSync(wavPath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "clip.wav");
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("language", "en");
  if (promptText !== "") form.append("prompt", promptText);

  const start = Date.now();
  const res = await fetch(`${whisperUrl}/inference`, { method: "POST", body: form });
  const wallMs = Date.now() - start;
  if (!res.ok) {
    throw new Error(`score.mjs: ${whisperUrl}/inference -> ${res.status} ${res.statusText}`);
  }
  const payload = await res.json();
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  return { text, wallMs };
}

/** S71-f (brief §1.D): reads `data/voice/trace/bar.jsonl` (the bar's own
 *  trace of every sentence, `trace.ts`'s own shape) and returns a `Map` from
 *  `at` to the LAST `heard` recorded for it -- `trace.ts`'s own doc on
 *  `TraceEntry.revises`: "take the LAST line for each `at`" (a write that
 *  lands after the person has already said something else posts a SECOND
 *  line, same `at`, correcting the first). Missing entirely -- no sentence
 *  ever said before a clip was recorded -- is an empty `Map`, not an error. */
function readBarHeard(barPath) {
  const heardByAt = new Map();
  if (!existsSync(barPath)) return heardByAt;
  const lines = readFileSync(barPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // TS-5's own decision (traceServer.ts): a line can be
      // stored verbatim without validation; skip one this reader cannot use.
    }
    if (typeof entry?.at === "string") heardByAt.set(entry.at, entry.heard ?? "");
  }
  return heardByAt;
}

/** S71-f (brief §1.D): scores the newest `args.fromTrace` clips the bar
 *  itself posted to `/__clip` against a running whisper.cpp server, printing
 *  what it wrote THEN (the matching `bar.jsonl` entry's `heard`, joined on
 *  `at`) beside what it writes NOW, and their WER against each other. */
async function runFromTrace(args, promptText) {
  const clipsDir = resolve(TRACE_CLIPS_DIR);
  const manifestPath = join(clipsDir, "manifest.jsonl");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `score.mjs: no manifest at ${manifestPath} -- say a sentence to the board first ` +
        `(the dev server must be running)`,
    );
  }
  const entries = readFileSync(manifestPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  if (entries.length === 0) {
    throw new Error(`score.mjs: ${manifestPath} lists no clips`);
  }
  // The manifest is append-only, so the newest clips are the LAST lines;
  // reversed so the most recently said sentence prints first.
  const newest = entries.slice(-args.fromTrace).reverse();
  const heardByAt = readBarHeard(resolve(TRACE_BAR_FILE));

  console.log(`clips: ${clipsDir} (${newest.length} of ${entries.length} listed, newest first)\n`);

  const rows = [];
  for (const clip of newest) {
    const then = heardByAt.get(clip.at) ?? "";
    const wavPath = join(clipsDir, clip.file);
    if (!existsSync(wavPath)) {
      console.log(`${clip.at}  MISSING  ${wavPath}`);
      continue;
    }
    const { text: now } = await scoreOne(args.whisper, wavPath, promptText);
    const wer = wordErrorRate(then, now);
    rows.push({
      at: clip.at,
      durationMs: clip.durationMs,
      endedBy: clip.endedBy,
      peakRms: clip.peakRms,
      then,
      now,
      wer,
    });
    console.log(
      `${clip.at}  ${Math.round(clip.durationMs)}ms  ${clip.endedBy}  peak=${clip.peakRms.toFixed(3)}  wer=${wer.toFixed(3)}`,
    );
    console.log(`    then: "${then}"`);
    console.log(`    now:  "${now}"`);
  }

  const n = rows.length;
  const meanWer = n ? rows.reduce((s, r) => s + r.wer, 0) / n : 0;
  console.log(`\n${n} clip(s) scored, mean then-vs-now WER ${meanWer.toFixed(3)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.fromTrace !== null) {
    const promptText = args.noPrompt ? "" : readFileSync(resolve(args.promptFile), "utf8").trim();
    console.log(`whisper: ${args.whisper}`);
    console.log(`prompt: ${args.noPrompt ? "(none)" : resolve(args.promptFile)}`);
    await runFromTrace(args, promptText);
    return;
  }

  const clipsDir = resolve(args.clipsDir);
  const manifestPath = join(clipsDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `score.mjs: no manifest at ${manifestPath} -- record clips first ` +
        `(npm run voice:clips:record)`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const clips = [...manifest.clips].sort((a, b) => a.n - b.n);
  if (clips.length === 0) {
    throw new Error(`score.mjs: ${manifestPath} lists no clips`);
  }

  const promptText = args.noPrompt ? "" : readFileSync(resolve(args.promptFile), "utf8").trim();

  console.log(`whisper: ${args.whisper}`);
  console.log(`prompt: ${args.noPrompt ? "(none)" : resolve(args.promptFile)}`);
  console.log(`clips: ${clipsDir} (${clips.length} listed)\n`);

  const rows = [];
  for (const clip of clips) {
    const wavPath = join(clipsDir, clip.file);
    if (!existsSync(wavPath)) {
      console.log(`${String(clip.n).padStart(2, "0")}  MISSING  ${wavPath}`);
      continue;
    }
    const { text, wallMs } = await scoreOne(args.whisper, wavPath, promptText);
    const wer = wordErrorRate(clip.sentence, text);
    const names = nameHits(clip.sentence, text);
    const exact = isExact(clip.sentence, text);
    rows.push({ n: clip.n, sentence: clip.sentence, heard: text, wer, names, exact, wallMs });

    const tail = exact ? "exact" : `heard="${text}"`;
    console.log(
      `${String(clip.n).padStart(2, "0")}  wer=${wer.toFixed(3)}  names=${names.hits}/${names.total}  ${tail}`,
    );
  }

  const n = rows.length;
  const meanWer = n ? rows.reduce((s, r) => s + r.wer, 0) / n : 0;
  const namesHitTotal = rows.reduce((s, r) => s + r.names.hits, 0);
  const namesTotal = rows.reduce((s, r) => s + r.names.total, 0);
  const exactCount = rows.filter((r) => r.exact).length;
  const meanWallMs = n ? rows.reduce((s, r) => s + r.wallMs, 0) / n : 0;

  console.log(
    `\nmean WER ${meanWer.toFixed(3)}  names ${namesHitTotal}/${namesTotal}  ` +
      `exact ${exactCount}/${n}  wall/clip ${meanWallMs.toFixed(0)}ms`,
  );

  const label = args.label ?? defaultLabel();
  const resultsDir = join(clipsDir, "results");
  mkdirSync(resultsDir, { recursive: true });
  const resultsPath = join(resultsDir, `${label}.json`);
  const results = {
    label,
    whisper: args.whisper,
    promptFile: args.noPrompt ? null : resolve(args.promptFile),
    clipsDir,
    rows,
    summary: { clips: n, meanWer, namesHitTotal, namesTotal, exactCount, meanWallMs },
  };
  writeFileSync(resultsPath, JSON.stringify(results, null, 2) + "\n");
  console.log(`wrote ${resultsPath}`);
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  // Not process.exit(1) -- scripts/voice/serve/fetch-whisper.mjs's own note:
  // an abrupt exit right after a fetch() call has crashed libuv on this
  // machine's Node build. exitCode lets the loop drain first.
  process.exitCode = 1;
});
