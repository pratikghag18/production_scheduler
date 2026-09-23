/**
 * S71-f (R-453, R-434, brief docs/agent-briefs/s71-f-clip-capture-brief.md
 * §1.C) -- the dev server's own side of `trace.ts`'s `postClip`: writes the
 * exact WAV bytes the bar posted for one clip to disk and appends a
 * manifest line beside `traceServer.ts`'s own `bar.jsonl`, so
 * `scripts/voice/clips/score.mjs --from-trace` can re-score any clip the
 * bar ever actually sent to Whisper, joined on `at` against what the bar
 * heard for it.
 *
 * `vite.config.ts` routes `POST /__clip` here, the same shape
 * `voiceTracePlugin` already uses for `/__trace` -- the handler lives in
 * this ordinary module, not inline in the plugin, so `voiceClips.test.ts`
 * can call it directly with a fake request and response (no Vite, no real
 * HTTP), the same reason `traceServer.ts` is split from its own plugin.
 *
 * Node-only (`node:fs/promises`, `node:path`, `node:buffer`, `node:url`):
 * never imported by `CommandBar.tsx` or anything else that reaches the
 * client bundle.
 */
import { mkdir, appendFile, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";

/** Gitignored, alongside `traceServer.ts`'s own `bar.jsonl` (both live
 *  under the same already-ignored `data/voice/trace/` -- see the repo's
 *  `.gitignore`). */
export const CLIPS_DIR = "data/voice/trace/clips";
export const CLIPS_MANIFEST = `${CLIPS_DIR}/manifest.jsonl`;

/** Brief §1.C: "Cap the directory at the newest 500 clips (delete the
 *  oldest beyond that on each write) so it never grows without bound." */
export const MAX_CLIPS = 500;

/** The minimal shape this handler reads off a request -- satisfied
 *  structurally by Node's own `http.IncomingMessage` (what
 *  `configureServer`'s middleware actually hands it) and by a test's fake.
 *  `url` carries the query string (`?at=...`); Vite's middleware gives the
 *  path already stripped of the `/__clip` mount prefix, exactly as
 *  `voiceTracePlugin`'s own `/__trace` mount does. */
export interface ClipRequestLike {
  method?: string;
  url?: string;
  /** S71-h (R-453): Node's own `http.IncomingMessage` lower-cases header
   *  names and may hand back an array for a repeated header -- both read
   *  the same way a test's fake does. Optional so nothing before this
   *  change (a fake request with no `headers` at all) stops compiling. */
  headers?: Record<string, string | string[] | undefined>;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "end", listener: () => void): void;
}

/** Likewise, satisfied structurally by `http.ServerResponse`. */
export interface ClipResponseLike {
  statusCode: number;
  end(): void;
}

/** One line of `manifest.jsonl` -- `heard` is always written `null`: the
 *  bar's own POST fires before the clip's transcript is even known
 *  (`localRecognizer.ts`'s `onClip` fires before the fetch that answers
 *  it), and the scorer reads what was actually heard from `bar.jsonl`
 *  itself, joined on `at` (brief §1.D), never from here. */
export interface ClipManifestEntry {
  at: string;
  /** S71-k (F-209, R-453): the POST's own instant (`postClip`'s own
   *  `Date.now()` at post time, ISO) -- `file` is named from THIS, not from
   *  `at`, so an answer's clip (which shares its entry's `at` with the
   *  sentence that asked the question) never overwrites the sentence's own
   *  clip on disk. `at` still joins this line back to the entry in
   *  `bar.jsonl`; `postedAt` only ever tells two clips of the same entry
   *  apart. */
  postedAt: string;
  file: string;
  durationMs: number;
  recordedMs: number;
  endedBy: string;
  speechStarted: boolean;
  peakRms: number;
  meanRms: number;
  framesAboveFloor: number;
  heard: null;
  /** S71-h (R-453): the prompt the recogniser sent Whisper for this clip
   *  (`postClip`'s own `hint` argument, decoded from the `x-clip-hint`
   *  header), or `null` when none was sent (a typed sentence never reaches
   *  here at all; this is `null` only when the recogniser itself had no
   *  hint to send) OR when it was dropped -- see `hintDropped`.
   *  `score.mjs --from-trace` reads it back as the default prompt for a
   *  fair replay. */
  hint: string | null;
  /** S71-h review (R-453): "the hint must never cost the clip" -- an
   *  over-cap or undecodable `x-clip-hint` header no longer 400s the whole
   *  request (which would also refuse the WAV bytes that arrived fine); the
   *  clip is written exactly as normal, only the hint is lost, and this
   *  says so. `true` only on such a line; omitted (never an explicit
   *  `false`) on every ordinary one, the same convention `TraceEntry.clip`
   *  already follows for "nothing to say here". */
  hintDropped?: true;
}

function readBody(req: ClipRequestLike): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Review fix (path traversal): `at` used to reach `join(dir, file)` with
 * only its colons replaced -- `at=../../evil` (or `at=<iso>/../../evil2`)
 * survived `safeStem` untouched and `join` happily walked it OUT of
 * `dir`, writing (and answering 204 for) a file anywhere on disk the
 * process can reach. `at` is validated against this exact shape -- the one
 * `postClip`/`startTrace` ever actually produce (`new Date().toISOString()`)
 * -- before anything is built from it at all; digits, `-`, `T`, `:`, `.`,
 * `Z` at fixed positions are the only characters a match can ever contain,
 * so no `/`, `..`, or anything else a path could walk on ever reaches
 * `safeStem` or `join` in the first place. A request whose `at` does not
 * match this exactly (missing, malformed, oversized, or a traversal
 * attempt) is refused with 400 before any write is attempted.
 *
 * S71-k (F-209, R-453): `postedAt` (`postClip`'s own `Date.now()` at POST
 * time, the same `new Date().toISOString()` shape) is checked against this
 * exact same regexp before it becomes the FILE name (`safeStem(postedAt)`)
 * -- the traversal risk and the fix are identical to `at`'s; a request whose
 * `postedAt` does not match is refused with 400, same as a bad `at`.
 */
const ISO_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** ISO `at` -> a filesystem-safe stem. Colons are the real blocker on
 *  Windows filenames (this repo's own machine, per `CLAUDE.local.md`) --
 *  `at` has already been checked against `ISO_AT_RE` by the time this is
 *  called, so no other character survives to be a concern. */
function safeStem(at: string): string {
  return at.replace(/:/g, "-");
}

/** Reviewer finding (S71-k): two POSTs can carry the SAME `postedAt` (a fast
 *  answer landing in the same millisecond as its sentence's own clip, or two
 *  truly concurrent posts) -- `postedAt` alone moved the collision from
 *  `at`, it did not remove it. If `<stem>.wav` already exists, this tries
 *  `<stem>-2.wav`, `<stem>-3.wav`, ... until it finds a name nothing has
 *  claimed, so a same-millisecond collision gets a second file instead of
 *  overwriting the first. The check and the write below it run with no
 *  `await` between them, so two requests already inside this function
 *  cannot both observe the same candidate as free. */
function uniqueFileName(dir: string, stem: string): string {
  let candidate = `${stem}.wav`;
  let n = 2;
  while (existsSync(join(dir, candidate))) {
    candidate = `${stem}-${n}.wav`;
    n++;
  }
  return candidate;
}

function num(params: URLSearchParams, key: string): number {
  const raw = params.get(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * S71-h review (R-453): the app's own cap on the hint is 200 WORDS
 * (`recognizerHint.ts`'s `MAX_WORDS`), not characters -- a plant whose cell
 * codes have no internal space (`LINE-3-CELL-07-STATION`, entirely ordinary
 * manufacturing naming) counts each code as ONE word no matter how long, so
 * 200 of them can legitimately encode past several KB with nothing
 * adversarial about it (`review-1` below, reproduced through the real
 * `buildRecognizerHint`). 4096 chars 400'd a real clip from a real board.
 * 16384 is headroom over that realistic worst case; a header past even this
 * is the pathological case the rule below drops rather than refuses. */
const MAX_HINT_HEADER_CHARS = 16384;

/** Reads a single-valued header off `req.headers`, lower-cased name, the
 *  first entry when Node handed back an array (a header this handler never
 *  sends twice, but the type allows it). `undefined` when absent. */
function getHeader(req: ClipRequestLike, name: string): string | undefined {
  const raw = req.headers?.[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * POST writes `data/voice/trace/clips/<postedAt-with-colons-replaced>.wav`
 * (the raw request body -- `postClip`'s own `wav` bytes, untouched) and
 * appends one manifest line, then evicts the oldest clip(s) beyond
 * `MAX_CLIPS`. S71-k (F-209): the file is named from `postedAt` -- THIS
 * POST's own instant -- not from `at`, so an answer's clip (posted under the
 * same entry `at` as the sentence that asked its question) never overwrites
 * the sentence's own clip; `at` is still kept as its own manifest field, so
 * `score.mjs --from-trace` can still join every clip of one entry back to
 * what the bar heard for it. Anything but POST answers 405; a request with
 * no `at`/`postedAt`, or either one not matching `ISO_AT_RE`, answers 400 --
 * both write nothing. Review fix:
 * a genuine failure writing the clip or the manifest line now answers 500
 * (never a false 204 for a write that did not happen) -- eviction, which
 * runs only after a successful write and touches clips already safely on
 * disk, stays best-effort and never fails the request that triggered it,
 * the same courtesy `traceServer.ts`'s own handler gives its own write.
 *
 * S71-h review (R-453): an `x-clip-hint` header past `MAX_HINT_HEADER_CHARS`
 * or one that fails to decode does NOT join `at` in refusing the request --
 * the hint is never worth losing the clip over. It is dropped instead
 * (`hint: null`, `hintDropped: true`) and the write proceeds exactly as if
 * no hint had ever been sent.
 */
export async function handleClipRequest(
  req: ClipRequestLike,
  res: ClipResponseLike,
  dir: string = CLIPS_DIR,
  manifestPath: string = CLIPS_MANIFEST,
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end();
    return;
  }
  const params = new URL(req.url ?? "", "http://localhost").searchParams;
  const at = params.get("at");
  const postedAt = params.get("postedAt");
  if (!at || !ISO_AT_RE.test(at) || !postedAt || !ISO_AT_RE.test(postedAt)) {
    res.statusCode = 400;
    res.end();
    return;
  }
  // S71-h review (R-453): the hint travels as a header (the body is the raw
  // WAV), URL-encoded since headers are Latin-1. Unlike `at`, a bad hint
  // header never refuses the request -- the clip and its trace are worth
  // keeping even when the hint is not; it is simply dropped (`hintDropped`)
  // and the clip is written exactly as if no hint had been sent at all.
  const hintHeader = getHeader(req, "x-clip-hint");
  let hint: string | null = null;
  let hintDropped = false;
  if (hintHeader !== undefined) {
    if (hintHeader.length > MAX_HINT_HEADER_CHARS) {
      hintDropped = true;
    } else {
      try {
        hint = decodeURIComponent(hintHeader);
      } catch {
        hintDropped = true;
      }
    }
  }
  try {
    const body = await readBody(req);
    await mkdir(dir, { recursive: true });
    // S71-k (F-209): named from `postedAt` -- THIS POST's own instant --
    // not from `at`, so two clips sharing one entry's `at` (a sentence and
    // the answer that continued it) never collide on the same file.
    // Reviewer finding: `postedAt` itself can still collide (same
    // millisecond) -- `uniqueFileName` disambiguates with a `-2`, `-3`, ...
    // suffix rather than overwrite.
    const file = uniqueFileName(dir, safeStem(postedAt));
    await writeFile(join(dir, file), body);

    const entry: ClipManifestEntry = {
      at,
      postedAt,
      file,
      durationMs: num(params, "durationMs"),
      recordedMs: num(params, "recordedMs"),
      endedBy: params.get("endedBy") ?? "",
      speechStarted: params.get("speechStarted") === "true",
      peakRms: num(params, "peakRms"),
      meanRms: num(params, "meanRms"),
      framesAboveFloor: num(params, "framesAboveFloor"),
      heard: null,
      hint,
      ...(hintDropped ? { hintDropped: true as const } : {}),
    };
    await mkdir(dirname(manifestPath), { recursive: true });
    await appendFile(manifestPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    res.statusCode = 500;
    res.end();
    return;
  }
  try {
    await evictOldest(dir, manifestPath);
  } catch {
    // Best-effort -- see the doc above. The clip and its manifest line are
    // already safely written; a later cap-eviction failure is not this
    // request's failure.
  }
  res.statusCode = 204;
  res.end();
}

/** Trims `manifestPath` to its newest `MAX_CLIPS` lines and deletes the
 *  `.wav` file each dropped line named, so the manifest and the directory
 *  never disagree about which clips still exist. Best-effort: a file
 *  already missing (a hand-deleted clip) is not an error. */
async function evictOldest(dir: string, manifestPath: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length <= MAX_CLIPS) return;
  const drop = lines.slice(0, lines.length - MAX_CLIPS);
  const keep = lines.slice(lines.length - MAX_CLIPS);
  await writeFile(manifestPath, `${keep.join("\n")}\n`, "utf8");
  for (const line of drop) {
    try {
      const dropped = JSON.parse(line) as { file?: string };
      if (dropped.file) await unlink(join(dir, dropped.file));
    } catch {
      // Best effort -- a malformed line or an already-missing file is not
      // a reason to stop evicting the rest.
    }
  }
}
