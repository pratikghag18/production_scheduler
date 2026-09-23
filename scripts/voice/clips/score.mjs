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
//
// S71-h (brief docs/agent-briefs/s71-h-replay-uses-the-apps-hint-brief.md
// §1, R-453): a fair replay uses the SAME prompt the app actually sent --
// each manifest line's own `hint` (`clipServer.ts`, from `postClip`'s
// `x-clip-hint` header) -- so `--from-trace` needs neither `--prompt-file`
// nor `--no-prompt`; when given, either overrides the manifest's hint for
// EVERY clip in the run instead (so the same clips can be re-scored against
// a different prompt). The recorded-set mode below still requires one of
// the two, since it has no per-clip hint of its own to fall back on.
//
// S71-k (brief docs/agent-briefs/s71-k-clip-file-collision-and-gain-brief.md,
// F-209/F-210/R-453): `--from-trace` now GROUPS manifest lines by their
// entry's own `at` before printing -- an answer's clip (`clipServer.ts` now
// names its FILE from `postedAt`, its own POST instant, never from `at`, so
// it no longer overwrites the sentence's own clip on disk) still shares its
// entry's `at` with the sentence that asked the question, so one entry can
// now genuinely list two files. Each clip of an entry prints on its own
// row, newest entry first, oldest clip of an entry first within it: the
// sentence's own clip (unlabelled, `bar.jsonl`'s `heard` as its "then") and
// any clip after it (the answer) labelled `answer`, `bar.jsonl`'s own
// `answered` printed as ITS "then" instead -- `heard` is joined to the
// first clip only, never repeated on an answer's row.
//
// `--gain <factor|peak:<target>>` (F-210: the maintainer's own mic delivers
// peak RMS 0.037-0.065, a third to a tenth of whisper.cpp's own tuning
// sample) scales a clip's samples before it is posted -- either by a flat
// factor, or peak-normalised to `target` (0 to 1, default 0.5 when
// `peak:` is given bare) -- clipping at +-1, printing the gain actually
// used on each row. The sample maths live in `lib/wavGain.mjs` (pure, unit
// tested separately); nothing about the recogniser itself changes here.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { wordErrorRate, nameHits, isExact } from "./lib/score.mjs";
import { peakNormalizeGain, applyGain } from "./lib/wavGain.mjs";

const TRACE_CLIPS_DIR = "data/voice/trace/clips";
const TRACE_BAR_FILE = "data/voice/trace/bar.jsonl";
const FROM_TRACE_DEFAULT_N = 20;
const DEFAULT_PEAK_TARGET = 0.5;

function parseGainArg(raw) {
  if (raw === undefined) throw new Error("score.mjs: --gain requires a value");
  if (raw === "peak" || raw === "peak:") return { mode: "peak", target: DEFAULT_PEAK_TARGET };
  const peakMatch = raw.match(/^peak:(.+)$/);
  if (peakMatch) {
    const target = Number(peakMatch[1]);
    if (!Number.isFinite(target) || target <= 0 || target > 1) {
      throw new Error(
        `score.mjs: --gain peak:<target> must be a number in (0, 1], got "${peakMatch[1]}"`,
      );
    }
    return { mode: "peak", target };
  }
  const factor = Number(raw);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`score.mjs: --gain <factor> must be a positive number, got "${raw}"`);
  }
  return { mode: "factor", factor };
}

function parseArgs(argv) {
  const out = {
    whisper: null,
    promptFile: null,
    noPrompt: false,
    clipsDir: "data/voice/clips",
    label: null,
    // S71-f: `null` means "not this mode"; a number is the N requested.
    fromTrace: null,
    // S71-k: `null` means "no --gain given, post the clip unchanged".
    gain: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--whisper") out.whisper = argv[++i];
    else if (a === "--prompt-file") out.promptFile = argv[++i];
    else if (a === "--no-prompt") out.noPrompt = true;
    else if (a === "--clips") out.clipsDir = argv[++i];
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--gain") out.gain = parseGainArg(argv[++i]);
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
  if (out.noPrompt && out.promptFile) {
    throw new Error("score.mjs: --no-prompt and --prompt-file are exclusive");
  }
  // S71-h: `--from-trace` has a default prompt of its own (each clip's own
  // manifest `hint`) -- neither flag is required there. The recorded-set
  // mode below has no such fallback, so it still requires one of the two.
  if (out.fromTrace === null && !out.noPrompt && !out.promptFile) {
    throw new Error("score.mjs: pass --prompt-file <path> or --no-prompt, not neither");
  }
  return out;
}

function defaultLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** S71-k: applies `gainSpec` (parsed by `parseGainArg`, or `null` for "no
 *  --gain given") to `rawBytes` before it is posted, returning the bytes to
 *  send and the factor actually used (`null` when no gain was requested, so
 *  callers can tell "unchanged" apart from "changed by exactly 1.0"). A
 *  peak-normalise's factor is computed fresh per clip, from THAT clip's own
 *  peak -- the whole point of `peak:<target>` is that different clips need
 *  different factors to land on the same target. */
function applyGainIfRequested(rawBytes, gainSpec) {
  if (!gainSpec) return { bytes: rawBytes, gainUsed: null };
  const factor =
    gainSpec.mode === "factor" ? gainSpec.factor : peakNormalizeGain(rawBytes, gainSpec.target);
  return { bytes: applyGain(rawBytes, factor), gainUsed: factor };
}

/** Posts one clip, exactly the multipart fields the app's own request uses
 *  (localRecognizer.ts). `promptText` is `""` for `--no-prompt` -- an empty
 *  string never appends a `prompt` field, matching the app's own
 *  "an absent hint, or one that returns '', sends no prompt field at all".
 *  S71-k: takes the bytes to post directly (never re-reads the file) so a
 *  `--gain`-scaled buffer can be sent without a second file on disk. */
async function scoreOne(whisperUrl, bytes, promptText) {
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
 *  `at` to the LAST `heard`/`answered` recorded for it -- `trace.ts`'s own
 *  doc on `TraceEntry.revises`: "take the LAST line for each `at`" (a write
 *  that lands after the person has already said something else posts a
 *  SECOND line, same `at`, correcting the first). Missing entirely -- no
 *  sentence ever said before a clip was recorded -- is an empty `Map`, not
 *  an error.
 *
 *  S71-k: also carries `answered` (the confirm/cancel word or candidate
 *  label that answered this entry's question, or `null`) -- `runFromTrace`
 *  prints it beside the answer's OWN clip instead of repeating `heard`. */
function readBarByAt(barPath) {
  const byAt = new Map();
  if (!existsSync(barPath)) return byAt;
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
    if (typeof entry?.at === "string") {
      byAt.set(entry.at, { heard: entry.heard ?? "", answered: entry.answered ?? null });
    }
  }
  return byAt;
}

/** S71-h (brief §1): the container's model name from `GET /health`, printed
 *  as a one-line header in `--from-trace` mode -- the brief's own note: the
 *  whisper.cpp server's `/health` does not actually report a model name, so
 *  in practice this always prints the "not reported" line; it is still a
 *  real fetch (not hard-coded) so a future server that does add one is
 *  picked up with no change here. Never fatal: a fetch failure prints its
 *  own one-line explanation instead of stopping the run. */
async function printModelHeader(whisperUrl) {
  try {
    const res = await fetch(`${whisperUrl}/health`);
    if (!res.ok) {
      console.log(`model: (unavailable -- /health -> ${res.status} ${res.statusText})`);
      return;
    }
    const payload = await res.json().catch(() => null);
    const model =
      payload && typeof payload === "object"
        ? (payload.model ?? payload.model_path ?? payload.whisper_model)
        : undefined;
    console.log(
      typeof model === "string" && model !== ""
        ? `model: ${model}`
        : `model: (not reported by /health)`,
    );
  } catch (err) {
    console.log(`model: (unavailable -- ${err instanceof Error ? err.message : String(err)})`);
  }
}

/** S71-f (brief §1.D): scores the newest `args.fromTrace` clips the bar
 *  itself posted to `/__clip` against a running whisper.cpp server, printing
 *  what it wrote THEN (the matching `bar.jsonl` entry's `heard`, joined on
 *  `at`) beside what it writes NOW, and their WER against each other.
 *
 *  S71-h (brief §1): `override` is `null` when neither `--prompt-file` nor
 *  `--no-prompt` was given -- each clip is then scored against ITS OWN
 *  manifest `hint` (the exact string the app sent Whisper live), printed as
 *  `prompt=hint` or `prompt=none` per row (S71-h review: `prompt=dropped`
 *  when `clipServer.ts` had to drop an over-cap or undecodable hint header
 *  rather than lose the clip over it -- scored with no prompt, same as
 *  `none`, but printed differently so the row says why). A non-null
 *  `override` (from either flag) is used for every clip instead, printed as
 *  `prompt=override`, so the same clips can be re-scored against a
 *  different prompt.
 *
 *  S71-k (F-209, R-453): the manifest's newest `args.fromTrace` LINES are
 *  selected exactly as before (so `--from-trace N` still means "N clips"),
 *  then GROUPED by their entry's own `at` -- one entry lists two lines only
 *  when a sentence's clip and the answer that continued it were both
 *  captured (`postClip`'s own doc). Each clip of an entry prints on its own
 *  row, oldest first within the entry (the sentence's own clip, then any
 *  answer), entries newest-first overall; `heard` is the sentence clip's
 *  "then", `answered` is the answer clip's -- never both on the same row. */
async function runFromTrace(args, override) {
  const clipsDir = resolve(TRACE_CLIPS_DIR);
  const manifestPath = join(clipsDir, "manifest.jsonl");
  // Reviewer fix: no clips yet is the ordinary state of a fresh checkout or
  // a dev server nobody has talked to yet, not an error -- it used to throw
  // and exit 1, which read like something was broken. One line, exit 0.
  if (!existsSync(manifestPath)) {
    console.log(
      `no clips yet -- say a sentence to the board first (the dev server must be running), then re-run this command`,
    );
    return;
  }
  const entries = readFileSync(manifestPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  if (entries.length === 0) {
    console.log(
      `no clips yet -- say a sentence to the board first (the dev server must be running), then re-run this command`,
    );
    return;
  }
  // The manifest is append-only, so the newest clips are the LAST lines.
  // `--from-trace N` still selects N raw lines (clips), same as before;
  // S71-k groups them by `at` below. Reviewer finding: manifest APPEND
  // order is not always POST order -- two clips of one entry can reach
  // `/__clip` (and so get appended) out of the order they were recorded in
  // (a slow request, a retried fetch), so labelling "first appended" as the
  // sentence could label the answer's clip as the sentence instead. Each
  // group is sorted by its own `postedAt` ascending below, right before
  // labelling, so the clip with the EARLIEST post instant is always
  // treated as the sentence's, regardless of append order.
  const selected = entries.slice(-args.fromTrace);
  const order = [];
  const groups = new Map();
  for (const clip of selected) {
    if (!groups.has(clip.at)) {
      groups.set(clip.at, []);
      order.push(clip.at);
    }
    groups.get(clip.at).push(clip);
  }
  for (const clipsForEntry of groups.values()) {
    clipsForEntry.sort((a, b) => (a.postedAt ?? "").localeCompare(b.postedAt ?? ""));
  }
  order.reverse(); // newest entry first

  const barByAt = readBarByAt(resolve(TRACE_BAR_FILE));

  console.log(
    `clips: ${clipsDir} (${selected.length} of ${entries.length} listed, ${order.length} ` +
      `entr${order.length === 1 ? "y" : "ies"}, newest first)\n`,
  );

  const rows = [];
  for (const at of order) {
    const clipsForEntry = groups.get(at);
    const bar = barByAt.get(at) ?? { heard: "", answered: null };
    for (let i = 0; i < clipsForEntry.length; i++) {
      const clip = clipsForEntry[i];
      const isAnswer = i > 0;
      const roleTag = isAnswer ? "answer  " : "";
      const wavPath = join(clipsDir, clip.file);
      if (!existsSync(wavPath)) {
        console.log(`${clip.at}  ${roleTag}MISSING  ${wavPath}`);
        continue;
      }
      // S71-h: `clip.hint` is `undefined` on a manifest line written before
      // that change and `null` on one written after it for a recogniser
      // that had no hint to send -- both mean "no prompt". S71-h review:
      // `clip.hintDropped` is a THIRD, distinct reason for no prompt.
      const promptText = override !== null ? override.text : (clip.hint ?? "");
      const promptLabel =
        override !== null ? "override" : clip.hintDropped ? "dropped" : clip.hint ? "hint" : "none";
      const rawBytes = readFileSync(wavPath);
      const { bytes, gainUsed } = applyGainIfRequested(rawBytes, args.gain);
      const { text: now } = await scoreOne(args.whisper, bytes, promptText);
      // S71-k: `heard` (the sentence's own transcript) joins the FIRST clip
      // only; an answer's row compares against `answered` instead -- never
      // both, and never `heard` repeated on the answer's own row.
      const reference = isAnswer ? (bar.answered ?? "") : bar.heard;
      const wer = wordErrorRate(reference, now);
      rows.push({
        at: clip.at,
        postedAt: clip.postedAt,
        role: isAnswer ? "answer" : "sentence",
        durationMs: clip.durationMs,
        endedBy: clip.endedBy,
        peakRms: clip.peakRms,
        prompt: promptLabel,
        gain: gainUsed,
        reference,
        now,
        wer,
      });
      const gainTag = gainUsed !== null ? `  gain=${gainUsed.toFixed(3)}` : "";
      console.log(
        `${clip.at}  ${roleTag}${Math.round(clip.durationMs)}ms  ${clip.endedBy}  ` +
          `peak=${clip.peakRms.toFixed(3)}  wer=${wer.toFixed(3)}  prompt=${promptLabel}${gainTag}`,
      );
      console.log(`    ${isAnswer ? "answered" : "then    "}: "${reference}"`);
      console.log(`    now     : "${now}"`);
    }
  }

  const n = rows.length;
  const meanWer = n ? rows.reduce((s, r) => s + r.wer, 0) / n : 0;
  console.log(
    `\n${n} clip(s) scored across ${order.length} entr${order.length === 1 ? "y" : "ies"}, ` +
      `mean then-vs-now WER ${meanWer.toFixed(3)}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.fromTrace !== null) {
    // S71-h: an override is present only when the caller gave one of the
    // two flags; otherwise `null` tells `runFromTrace` to use each clip's
    // own manifest hint.
    const override = args.noPrompt
      ? { text: "", label: "(none)" }
      : args.promptFile
        ? {
            text: readFileSync(resolve(args.promptFile), "utf8").trim(),
            label: resolve(args.promptFile),
          }
        : null;
    console.log(`whisper: ${args.whisper}`);
    await printModelHeader(args.whisper);
    console.log(
      override
        ? `prompt: ${override.label} (overrides every clip's own hint)`
        : `prompt: each clip's own hint from the manifest (the app's own prompt, replayed)`,
    );
    if (args.gain) {
      console.log(
        args.gain.mode === "factor"
          ? `gain: factor ${args.gain.factor}`
          : `gain: peak-normalise to ${args.gain.target}`,
      );
    }
    await runFromTrace(args, override);
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
  if (args.gain) {
    console.log(
      args.gain.mode === "factor"
        ? `gain: factor ${args.gain.factor}`
        : `gain: peak-normalise to ${args.gain.target}`,
    );
  }
  console.log(`clips: ${clipsDir} (${clips.length} listed)\n`);

  const rows = [];
  for (const clip of clips) {
    const wavPath = join(clipsDir, clip.file);
    if (!existsSync(wavPath)) {
      console.log(`${String(clip.n).padStart(2, "0")}  MISSING  ${wavPath}`);
      continue;
    }
    const rawBytes = readFileSync(wavPath);
    const { bytes, gainUsed } = applyGainIfRequested(rawBytes, args.gain);
    const { text, wallMs } = await scoreOne(args.whisper, bytes, promptText);
    const wer = wordErrorRate(clip.sentence, text);
    const names = nameHits(clip.sentence, text);
    const exact = isExact(clip.sentence, text);
    rows.push({
      n: clip.n,
      sentence: clip.sentence,
      heard: text,
      wer,
      names,
      exact,
      wallMs,
      gain: gainUsed,
    });

    const tail = exact ? "exact" : `heard="${text}"`;
    const gainTag = gainUsed !== null ? `  gain=${gainUsed.toFixed(3)}` : "";
    console.log(
      `${String(clip.n).padStart(2, "0")}  wer=${wer.toFixed(3)}  names=${names.hits}/${names.total}  ${tail}${gainTag}`,
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
    gain: args.gain,
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
