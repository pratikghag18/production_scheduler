/**
 * S59-e (R-421, brief docs/agent-briefs/s59-e-trace-brief.md §1) -- the
 * bar's own trace of one sentence's life: what it heard, what the model
 * answered (or why it was not used), what it read, the question or readout
 * shown, the answer given, and what ran. `CommandBar.tsx` keeps one entry in
 * progress per mounted bar and posts it, as one line of JSON, to the dev
 * server's `/__trace` once the sentence's life ends (its own small module,
 * `traceServer.ts`, and the `vite.config.ts` plugin that wires it in own
 * that side).
 *
 * Pure and browser-safe on purpose: `CommandBar.tsx` imports this straight
 * into the client bundle, so it holds no `node:fs` -- only the shape, how to
 * render one line of it, and (S71-f, R-453/R-434, brief
 * docs/agent-briefs/s71-f-clip-capture-brief.md §1.B) `postClip`, the one
 * request this file does make: the exact bytes a clip's own `onClip` event
 * carried, fire-and-forget, in the same style `commandConversation.ts`'s own
 * `postTrace` uses for `/__trace` (kept here, not there, since only this
 * lane's files touch clip capture).
 */

export interface TraceEntry {
  /** ISO time the sentence's life started. */
  at: string;
  /** The sentence as typed, or the final transcript as heard. */
  heard: string;
  /** Which recogniser produced `heard`, or "typed". */
  by: "typed" | "browser" | "local";
  /** The model's raw answer, or the reason it was not used -- never both. */
  model: { raw: string } | { skipped: string };
  /** `formatCommand` of the command the bar read, or the parse failure's own
   *  `kind` when it could not read one at all. */
  read: string;
  /** The question or readout text shown while this entry was open, or
   *  `null` when none ever stood. */
  asked: string | null;
  /** The answer given -- a candidate button's label, or a confirm/cancel
   *  word -- or `null` when nothing answered a question. */
  answered: string | null;
  /** The readout of each command actually written, in order. */
  ran: string[];
  /**
   * F-164 (the maintainer's swap, 17 Sept): THE LAST WORD -- what actually
   * became of the write this sentence asked for, in the writer's own words,
   * or `null` when nothing was ever attempted (a question still standing, a
   * cancel, a sentence the bar could not read).
   *
   * `asked` already holds the question or the readout that STOOD; it cannot
   * also hold the answer that arrived after it, which is exactly what the
   * maintainer's trace was missing twice over:
   *   - a lot that stopped at step 4 finished its entry BEFORE `runLotNow`
   *     set the "Did 3 of 4; the next failed: ..." status, so nothing in the
   *     file said why the fourth stopped;
   *   - a single wrote its readout into `ran` the instant it called the
   *     writer, so a sentence whose write never landed (a pop-up left
   *     waiting, a server refusal) read in the file exactly like one that
   *     did.
   *
   * Written by `CommandBar.tsx` in the four words the writers answer in:
   * `"written"`, `"refused: <message>"`, `"popup: <what it waits for>"`, and
   * a lot's own finished sentence (`"Done: N commands."` / `"Did k of N; the
   * next failed: ..."`). `ran` now carries ONLY the readouts a writer
   * actually confirmed.
   */
  outcome: string | null;
  /**
   * S62-b reviewer fix (D): TRUE ON A CORRECTED LINE.
   *
   * A write can land after the person has already said something else — the
   * entry was posted when the new sentence flushed it, and only then did the
   * writer answer. The file is append-only (`traceServer.ts` appends one line
   * and never rewrites), so the correction is a SECOND line carrying the same
   * `at` and this flag.
   *
   * ⭐ HOW TO READ THE FILE: take the LAST line for each `at`. Every earlier
   * line with that `at` is a snapshot of the same sentence before its writer
   * answered. Omitted (undefined) on every ordinary line.
   */
  revises?: true;
  /**
   * S71-f (R-453, R-434): the numbers `ClipInfo` carried for this sentence's
   * clip -- `undefined` on a typed sentence, a bare confirm/cancel word, or
   * any turn no clip was ever posted for (a refused mic before a frame was
   * even captured, a genuine no-speech skip that never reached the
   * network). `wav`/`hint` are not repeated here: the bytes go to `/__clip`
   * via `postClip`, and `hint` is already implied by the reader's own
   * request the trace elsewhere never carries either.
   */
  clip?: {
    durationMs: number;
    recordedMs: number;
    endedBy: "stop" | "silence" | "cap" | "cap-window";
    speechStarted: boolean;
    peakRms: number;
    meanRms: number;
    framesAboveFloor: number;
  };
}

/** Long enough to read a form or a garbled answer back, short enough that
 *  one sentence's line never dwarfs the file. */
const RAW_MAX_CHARS = 600;

function trimRaw(raw: string): string {
  return raw.length > RAW_MAX_CHARS ? raw.slice(0, RAW_MAX_CHARS) : raw;
}

/** One line of JSON for `entry` -- the raw answer, if any, trimmed to
 *  `RAW_MAX_CHARS`. No trailing newline: the dev server's own handler
 *  (`traceServer.ts`) adds it when it appends. */
export function renderLine(entry: TraceEntry): string {
  const model = "raw" in entry.model ? { raw: trimRaw(entry.model.raw) } : entry.model;
  return JSON.stringify({ ...entry, model });
}

/** S71-f (brief §1.B): posts `wav` (exactly the bytes `ClipInfo.wav` held)
 *  to the dev server's `POST /__clip`, `at` and `clip`'s own numbers carried
 *  as query parameters (`clipServer.ts`'s own handler reads them back to
 *  write the manifest line -- there is no other channel for them on a raw
 *  binary POST). `at` is the SAME string the matching `TraceEntry.at`
 *  holds, so `score.mjs --from-trace` can join a clip to what the bar heard
 *  for it. Fire-and-forget, errors swallowed, a no-op outside dev -- the
 *  same three rules `commandConversation.ts`'s own `postTrace` follows for
 *  `/__trace` (R-421: "a build without it changes nothing in the bar").
 *
 *  S71-h (R-453, brief docs/agent-briefs/s71-h-replay-uses-the-apps-hint-
 *  brief.md §1): `hint` is the exact prompt the recogniser sent Whisper for
 *  this clip (`ClipInfo.hint`), carried as the `x-clip-hint` header,
 *  URL-encoded (headers are Latin-1; the hint is free text with names and
 *  punctuation). `null` omits the header entirely -- `clipServer.ts` then
 *  writes `hint: null` into the manifest line, exactly as an absent value
 *  reads today. A multipart body was the other option; a header keeps
 *  `clipServer.ts` dependency-free (no multipart parser in the repo) while
 *  the WAV stays the raw POST body, unchanged. */
export function postClip(
  at: string,
  wav: ArrayBuffer,
  clip: NonNullable<TraceEntry["clip"]>,
  hint: string | null,
): void {
  if (!import.meta.env.DEV) return;
  const params = new URLSearchParams({
    at,
    durationMs: String(Math.round(clip.durationMs)),
    recordedMs: String(Math.round(clip.recordedMs)),
    endedBy: clip.endedBy,
    speechStarted: String(clip.speechStarted),
    peakRms: String(clip.peakRms),
    meanRms: String(clip.meanRms),
    framesAboveFloor: String(clip.framesAboveFloor),
  });
  const headers: Record<string, string> = { "Content-Type": "audio/wav" };
  if (hint !== null) headers["x-clip-hint"] = encodeURIComponent(hint);
  try {
    fetch(`/__clip?${params.toString()}`, {
      method: "POST",
      headers,
      body: wav,
    }).catch(() => {});
  } catch {
    // Never throws -- see above.
  }
}
