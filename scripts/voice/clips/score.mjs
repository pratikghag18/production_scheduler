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
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { wordErrorRate, nameHits, isExact } from "./lib/score.mjs";

function parseArgs(argv) {
  const out = {
    whisper: null,
    promptFile: null,
    noPrompt: false,
    clipsDir: "data/voice/clips",
    label: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--whisper") out.whisper = argv[++i];
    else if (a === "--prompt-file") out.promptFile = argv[++i];
    else if (a === "--no-prompt") out.noPrompt = true;
    else if (a === "--clips") out.clipsDir = argv[++i];
    else if (a === "--label") out.label = argv[++i];
    else throw new Error(`score.mjs: unknown argument "${a}"`);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
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
