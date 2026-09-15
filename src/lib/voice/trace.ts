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
 * into the client bundle, so it holds no `node:fs` and makes no request --
 * only the shape, and how to render one line of it.
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
