import { useEffect, useRef, useState } from "react";
import type { DateFormat } from "@/lib/format/dates";
import { formatDayLabel } from "../lib/time";
import fieldStyles from "@/components/Field.module.css";
import styles from "./CommandBar.module.css";
import type { Reader, Reading } from "@/lib/voice/readSentence";
import type { Recognizer, RecognizerHandle } from "@/lib/voice/recognizer";
import { renderLine, type TraceEntry } from "@/lib/voice/trace";
import { parseCommand, formatCommand, expectedShape } from "@/lib/command/parse";
import type {
  AssignCommand,
  BookCommand,
  UnassignCommand,
  MoveCommand,
  HeadcountCommand,
  SingleCommand,
  Command,
  Attach,
  Existing,
  ParseFailure,
} from "@/lib/command/parse";
import { resolveCommand, describeQuestion, expandCommand } from "@/lib/command/resolve";
import type {
  ResolveContext,
  ResolvedCommand,
  ResolvedBook,
  ResolvedUnassign,
  ResolvedMove,
  ResolvedHeadcount,
  Question,
  Candidate,
} from "@/lib/command/resolve";
import type { Highlight } from "../lib/highlight";
import { Microphone } from "@/components/icons";

export type { Highlight };

/**
 * S51 (R-400, design §19.98/D127): a several's inner commands are always one
 * of the resolver's four SINGLE resolved shapes -- `SeveralCommand.commands`
 * is typed on `SingleCommand` (`parse.ts`'s own invariant: a several is
 * never itself nested inside another), so `resolveCommand` on each of them
 * can only ever return one of these four, never a fifth "several" shape.
 */
export type ResolvedAny = ResolvedCommand | ResolvedBook | ResolvedUnassign | ResolvedMove;

/** S51: `onRunLot`'s own answer -- `done` is how many of the lot's commands
 *  were written before either everything succeeded or the first one failed;
 *  `error` is that failure's sentence (the same wording a toast would show),
 *  or `null` on a clean sweep. */
export interface LotResult {
  done: number;
  error: string | null;
}

/**
 * P1-7a — "Tell the board": the typed command bar (brief
 * docs/agent-briefs/p1-7a-typed-command-bar-brief.md, §6).
 *
 * ⛔ NO SECOND DOOR (brief §2). This component imports NOTHING from
 * `src/lib/api/` — not `createAssignment`, not `useCreateAssignment`, not
 * `supabase`. Its whole job ends at one of two callbacks: `onOpen(resolved,
 * anchor)`, from which instant the caller opens the SAME `CreatePopover` a
 * drag opens, pre-filled, and everything after Create — the probe, the split,
 * the overrides, the server — is that one existing path; or, for R-385,
 * `onRetime(resolved, anchor)`, from which the caller re-times the person's
 * own block through the drag's own commit function. `src/test/commandPurity.test.ts`
 * fails the build on a runtime import of any of those here.
 *
 * S41-a (docs/agent-briefs/s41-a-book-a-job-brief.md) adds the "book a job"
 * intent, and two more callbacks: `onBook(resolved, anchor)` for a brand-new
 * job (the caller opens `CreatePopover` in run mode, preset), and
 * `onRetimeRun(resolved, anchor)` for R-387's "change that job's hours?"
 * answer (the caller re-times the job through the drag's own re-time
 * function). Same rule, same audit: nothing here writes anything.
 *
 * S41-b (docs/agent-briefs/s41-b-unassign-brief.md) adds the "unassign"
 * intent and one more callback, `onUnassign(resolved, anchor)`: the caller
 * removes the named block through the SAME `dragApi.removeAssignment` the
 * block's own Delete button calls. No second door here either.
 *
 * S44-b (docs/agent-briefs/s44-b-read-by-model-brief.md) adds the optional
 * `reader` prop: when set, Enter reads the sentence through the model
 * service (`src/lib/voice/readSentence.ts`) first and falls back to the same
 * `parseCommand` rules on anything but a clean answer, saying so in the
 * readout. `reader` null (the default) is BYTE FOR BYTE the pre-S44-b
 * behaviour -- every earlier test in this file passes untouched.
 *
 * S48-a (docs/agent-briefs/s48-a-launcher-brief.md, R-396) adds the optional
 * `onEscapeIdle` prop and swaps the microphone button's emoji for the drawn
 * `<Microphone>` glyph (`@/components/icons`) -- nothing else here changes.
 * `onEscapeIdle` is called from the Escape branch below ONLY when Escape
 * found nothing left to do (not listening, no status, empty input) -- the
 * launcher's own signal to close the panel around this bar, since the bar
 * itself owns no notion of that panel.
 *
 * S46-a (docs/agent-briefs/s46-a-microphone-brief.md) adds the optional
 * `recognizer` prop: `null` (the default) renders no microphone button and
 * is otherwise byte for byte the pre-S46-a behaviour. Set, a button appears
 * after the input; pressing it starts a `Recognizer` session
 * (`src/lib/voice/recognizer.ts`) that writes interim text into the input as
 * it is heard and, on a final result, submits it exactly as Enter would
 * (`submitText`, extracted from `handleKeyDown`'s Enter branch for this).
 * One capability folded into the existing control, not a parallel widget
 * (CLAUDE.md §4).
 *
 * S47-a (docs/agent-briefs/s47-a-outline-and-yes-brief.md, R-395) adds three
 * optional props, none of which changes anything for a caller that omits
 * them. `onHighlight` is called with a `Highlight` (`../lib/highlight.ts`)
 * whenever a `remove_which`/`move_which`/`block_exists` question is the
 * current status (the ids to outline and which colour), and with `null`
 * whenever that status is replaced, cleared or this component unmounts --
 * done in one `useEffect` keyed on `status` (see below) rather than at every
 * `setStatus` call site, so the many existing ones stay untouched. When such
 * a question has exactly one candidate, its message gains a yes/no suffix
 * and `submitText` recognises the confirmation words below it BEFORE
 * parsing: a confirm word runs that one candidate's `onClick` (several
 * candidates: a bare confirm asks "Which one?" instead, buttons unchanged);
 * a cancel word clears the question, the outline and the input. `onOpen`ed
 * pop-ups are the OTHER half (R-384's "Enter creates when clean" widened to
 * a spoken yes): when NO such question stands, a confirm/cancel word is
 * offered first to `onConfirmWord`/`onCancelWord` (only ever true when a
 * create pop-up a SENTENCE opened is showing); either returning `false`
 * means "not for me" and the word falls through to the ordinary parse path
 * (the rules refuse it with the usual shape hint, same as any other
 * unparseable sentence) -- so both props are safe to omit or to return
 * false unconditionally.
 *
 * The bar holds no rule of its own: parsing is `parseCommand`/`formatCommand`
 * (`src/lib/command/parse.ts`), resolving is `resolveCommand`/`describeQuestion`
 * (`src/lib/command/resolve.ts`) against the `ctx` the caller (`BoardPage`)
 * built from the board's own scope functions. This file only turns their
 * answers into a text box, a status line and some buttons.
 *
 * The Enter/candidate/run-question handlers below call one another (a
 * candidate button re-resolves, which can produce another question, whose
 * buttons call back in) — plain function declarations, not `useCallback`, on
 * purpose: they are not passed anywhere that needs referential stability, and
 * a `useCallback` ring here would just be three hooks feeding each other's
 * dependency arrays for no benefit.
 *
 * S60-b (docs/agent-briefs/s60-b-which-part-brief.md, R-422): the RULES
 * grammar (`parse.ts`) can now leave `product: ""` on a part-less sentence,
 * and this file's own `questionToStatus` renders that as "Which part? <cell>
 * makes: " with the cell's own menu as buttons (see the `kind === "unknown"`
 * branch below). The MODEL path (`reader`, S44-b) was never trained on a
 * part-less sentence at all -- every row in its training set names a part --
 * so a model reading of one is expected to GUESS a part rather than answer
 * with an empty string. That is fine, on purpose: the guess is never run
 * unseen. `applyReading`'s own success path hands the model's `command`
 * (guessed part included) to `runCommand`, whose readout is what actually
 * shows on screen, suffixed " · read by the model" -- the person sees the
 * GUESSED part named in that readout, exactly the same as any other model
 * reading, before anything is written (`onOpen`/`onBook`/etc. still wait on
 * the pop-up or a further confirm). A future training pass that teaches the
 * model this shape (S56's successor) only ever needs to start emitting
 * `product: ""` itself -- this file needs no change either way, since it
 * already renders whatever `resolveCommand` answers.
 */

type Status =
  | { kind: "shape"; message: string }
  | {
      kind: "question";
      message: string;
      candidates: CandidateButton[];
      /** S47: set only for remove_which/move_which/block_exists -- the ids
       *  to outline on the board (`onHighlight`) while this status stands.
       *  S51: the LOT's own finished status sets this to a LIST -- one
       *  outline per block a removal or a move in it would touch. */
      blockHighlight?: Highlight | Highlight[];
      /** S51: set ONLY on the lot's own "N commands ready" status -- the
       *  marker `submitText` needs since `blockHighlight` no longer
       *  identifies a single kind once it can be a list (brief §2 item 2:
       *  "the lot's status needs a marker ... since blockHighlight.kind no
       *  longer identifies it"). Never set on a per-command question. */
      lot?: boolean;
    }
  | { kind: "readout"; message: string }
  /** S44-b: shown while `reader(text, signal)` is pending. */
  | { kind: "reading"; message: string };

/** S47: appended to a block question's message when it has exactly one
 *  candidate (brief §2 item 3) -- the ONLY place this string is written. */
const YES_SUFFIX = " — say or type yes to do it, no to leave it.";

/** S47: recognised by `submitText` before parsing (case-insensitive,
 *  trimmed, every punctuation character stripped -- see `normalizeWord`).
 *  These confirm ANY block question, or a pop-up, regardless of kind.
 *  "remove it" and "move it" are NOT here -- review fix: they used to be,
 *  which meant saying "remove it" to a standing MOVE question ran the move
 *  (the word was never checked against what was actually being asked). They
 *  are matched against the standing question's own kind instead, in
 *  `confirmsQuestion` below.
 *
 *  S59 (F-150, design §19.104/D133 item 2): "the confirm words were the
 *  developer's, not the floor's" -- the maintainer said "yeah" to a standing
 *  question and nothing happened. Yeah/yep/yup/sure/okay/go ahead/go on/
 *  correct/yes yes join the confirm set; nope/nah/never mind/forget it
 *  join the cancel set -- the floor's own words, not a developer's guess at
 *  them.
 *
 *  S60-b (the S59 reviewer, 15 Sept): "right" is WITHDRAWN -- it is a floor
 *  filler word ("right, so..."), not a confirm, and would confirm a standing
 *  REMOVAL question the person never meant to say yes to. Every other word
 *  above stays. */
const UNIVERSAL_CONFIRM_WORDS = new Set([
  "yes",
  "yes please",
  "confirm",
  "do it",
  "ok",
  "yeah",
  "yep",
  "yup",
  "sure",
  "okay",
  "go ahead",
  "go on",
  "correct",
  "yes yes",
]);
const CANCEL_WORDS = new Set([
  "no",
  "cancel",
  "leave it",
  "stop",
  "nope",
  "nah",
  "never mind",
  "forget it",
]);

/**
 * S47 review fix: true when `word` confirms a block question of `kind` --
 * one of the five universal words always does; "remove it" only confirms a
 * `remove_which` question (`kind === "remove"`); "move it" only confirms a
 * `move_which` OR a `block_exists` re-time question (`kind === "move"` or
 * `"retime"` -- a re-time is not a removal, so "move it" reaches it too).
 * Used against the OTHER kind, "remove it"/"move it" are ordinary text, same
 * as any word this function returns false for.
 */
function confirmsQuestion(word: string, kind: Highlight["kind"]): boolean {
  if (UNIVERSAL_CONFIRM_WORDS.has(word)) return true;
  if (word === "remove it") return kind === "remove";
  if (word === "move it") return kind === "move" || kind === "retime";
  return false;
}

/**
 * True for any word `confirmsQuestion` or a cancel could ever act on, for
 * SOME kind -- used by `handleChange` below to tell "the person is typing a
 * word that might confirm or cancel the standing question" apart from "the
 * person is editing the sentence itself" without knowing yet which kind is
 * standing (that check is `confirmsQuestion`'s, run again at Enter).
 */
function isConfirmOrCancelWord(word: string): boolean {
  return (
    UNIVERSAL_CONFIRM_WORDS.has(word) ||
    CANCEL_WORDS.has(word) ||
    word === "remove it" ||
    word === "move it"
  );
}

/** S59 (F-150): strips EVERY punctuation character, not only a trailing one
 *  -- a recogniser's "Yes." must match the same as a typed "yes", and so must
 *  "yeah," or "Okay!". The trailing `.trim()` cleans up any whitespace a
 *  removed character leaves behind (a stray leading/trailing space); the
 *  words themselves never carry the punctuation this strips. */
function normalizeWord(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+/g, "")
    .trim();
}

interface CandidateButton {
  key: string;
  label: string;
  onClick: () => void;
}

export interface CommandBarProps {
  ctx: ResolveContext;
  dateFormat: DateFormat;
  /** `index.zone` — D88a: the plant's own zone, never optional in spirit. */
  zone: string;
  onOpen: (resolved: ResolvedCommand, anchor: { x: number; y: number }) => void;
  /** R-385: the resolved target is `retime` — the caller re-times the block
   *  through the drag's own path; nothing is created. */
  onRetime: (resolved: ResolvedCommand, anchor: { x: number; y: number }) => void;
  /** S41-a: a "book a job" sentence resolved to a brand-new job — the caller
   *  opens `CreatePopover` in run mode, preset, through `submitCreateRun`. */
  onBook: (resolved: ResolvedBook, anchor: { x: number; y: number }) => void;
  /** S41-a / R-387: the resolved target is `retime_run` — the caller
   *  re-times the job through the drag's own re-time path; nothing is
   *  created. */
  onRetimeRun: (resolved: ResolvedBook, anchor: { x: number; y: number }) => void;
  /** S41-b / R-388: an "unassign" sentence resolved to the one block it
   *  names — the caller removes it through the SAME `dragApi.removeAssignment`
   *  the block's own Delete button calls. Nothing is created or re-timed. */
  onUnassign: (resolved: ResolvedUnassign, anchor: { x: number; y: number }) => void;
  /** S41-c / R-389: a "move" sentence resolved to the one block it names --
   *  called for BOTH targets (`retime` and `move_cell`); the caller
   *  dispatches on `resolved.target.kind`. Nothing is created here either:
   *  a `retime` re-times through the drag's own path, a `move_cell` opens
   *  the create pop-up preset under `presetMove`. */
  onMove: (resolved: ResolvedMove, anchor: { x: number; y: number }) => void;
  /**
   * S58 / R-415 (D132 item 4): a "job's headcount" sentence resolved to one
   * existing run and one existing write -- the caller commits it through the
   * SAME field-edit mutation the job panel's own headcount field uses (no
   * second door), then the bar shows the readout `resolveHeadcountCommand`
   * already wrote. Never part of a lot (`ResolvedHeadcount` is not a member
   * of `ResolvedAny` below -- a headcount can never reach `onRunLot`).
   */
  onSetHeadcount: (resolved: ResolvedHeadcount, anchor: { x: number; y: number }) => void;
  /**
   * S51 / R-400 (design §19.98/D127): a sentence that reads as SEVERAL
   * commands resolves them one at a time (below) and, on the lot's single
   * "yes", calls this once with every resolved command IN ORDER -- the
   * caller writes them in order through the same doors `onOpen`/`onRetime`/
   * `onBook`/`onRetimeRun`/`onUnassign`/`onMove` above already write
   * through, stopping at the first failure. Never called for a single
   * (non-several) sentence -- see CB-lot-9's regression pin.
   */
  onRunLot: (resolved: ResolvedAny[]) => Promise<LotResult>;
  /** S44-b: when set, Enter reads the sentence through the model service
   *  first and falls back to the rules on anything but a clean answer.
   *  `null` (the default) is the pre-S44-b behaviour, unchanged. */
  reader?: Reader | null;
  /** S46-a: when set, a microphone button appears after the input. `null`
   *  (the default) renders no button -- byte for byte the pre-S46-a
   *  behaviour. */
  recognizer?: Recognizer | null;
  /**
   * S59-e (R-421, brief docs/agent-briefs/s59-e-trace-brief.md §3): which
   * recogniser `recognizer` actually is -- `BoardPage`'s own choice between
   * the local (whisper.cpp) one and the browser's, mirrored here since this
   * file never imports either concretely (no second door on that either).
   * Used only as the trace entry's `by` for a spoken sentence; omitted (or
   * `recognizer` unset) falls back to `"browser"`, the pre-S59-e default.
   *
   * S60-b (the S59 reviewer, 15 Sept): widened from a plain value to a
   * GETTER -- which engine actually ran is a per-clip fact once
   * `localRecognizer.ts`'s `withFallback` can fall back mid-session
   * (LREC-17/18's own `onEngine`), never a static configuration fact fixed
   * at render (the bug this fixes: a clip that fell back to the browser was
   * traced as "local" regardless, since the OLD plain-value prop was read
   * once, before any clip had run). Read here at the moment the trace
   * entry's `by` is actually set (`onFinal`, below), never at render --
   * CB-t-8 pins that a render between sessions does not change what an
   * IN-FLIGHT clip is traced as.
   */
  recognizerName?: () => "browser" | "local";
  /** S47 / R-395: told what is in question -- the ids to outline and which
   *  colour -- whenever a remove/move/retime question stands, and `null`
   *  whenever it is answered, cleared or this component unmounts. S51: a
   *  several's finished lot status widens this to a LIST -- one outline per
   *  block a removal or a move in it would touch, each its own kind. */
  onHighlight?: (highlight: Highlight | Highlight[] | null) => void;
  /**
   * S59 / R-419 (design §19.104/D133 item 3): called when the "Show that
   * day" button on a `day_off_board` question is pressed, with the target
   * VERBATIM as the question names it (`question.text` -- "yesterday",
   * "tomorrow", a lowercase weekday name, an ISO date, or a week word). The
   * bar itself does no date arithmetic (CLAUDE.md §4/commandPurity.test.ts:
   * `resolve.ts` never reads a clock, and this file holds no copy of the
   * board's own day axis beyond `ctx.days`) -- `BoardPage` (the caller) owns
   * turning that word into a window move through the store's own
   * `setWindowStartDate`/`setWindowDayCount`/`shiftWindowByDays`. Once the
   * window actually moves, the NEW `ctx` this component receives as a prop
   * re-runs the same command that asked the question -- see the effect keyed
   * on `ctx` below. Omit to render the button inert (a caller that has not
   * wired window control at all).
   */
  onShowDay?: (target: string) => void;
  /**
   * S47 / R-385/R-384: called when a confirm word (`yes`, `confirm`, ...)
   * arrives and no block question stands. Three outcomes, review fix
   * (a bare boolean could not say WHY nothing happened):
   *   - `"created"`: a create pop-up a sentence opened was showing, read
   *     clean (R-384, unweakened), and has now been submitted through that
   *     same path -- the bar clears the input.
   *   - `"needs-decision"`: that pop-up was showing but was NOT clean (it
   *     would show something to decide) -- nothing is sent; the bar says so
   *     verbatim and leaves the input as it was.
   *   - `"none"`: no such pop-up is showing (or `autoCreate` was never set)
   *     -- the bar treats the word as ordinary text, same as any other
   *     unparseable sentence (the rules' shape hint).
   * Omit to leave every confirm word here as ordinary text.
   */
  onConfirmWord?: () => ConfirmWordResult;
  /** S47: the cancel-word twin of `onConfirmWord` -- true when a create
   *  pop-up a sentence opened was showing and this closed it; false
   *  otherwise (then the bar treats the word as ordinary text, refused with
   *  the usual shape hint like any other unparseable sentence). */
  onCancelWord?: () => boolean;
  /** S48-a / R-396: called from the Escape branch below ONLY when Escape
   *  found nothing left to do -- not listening, no status standing, and the
   *  input already empty. The launcher wraps this bar in a panel and uses
   *  this as its own "nothing left to clear, so close the panel" signal;
   *  omit to leave Escape exactly as it was before S48-a. */
  onEscapeIdle?: () => void;
}

/** S47 review fix: see `onConfirmWord`'s own doc above for what each value
 *  means. `PopoverConfirmHandle.submitIfClean()` (`CreatePopover.tsx`)
 *  returns the same three strings -- structurally, not by a shared import,
 *  since the bar imports nothing from the popover (brief §2: "no second
 *  door"). */
export type ConfirmWordResult = "created" | "needs-decision" | "none";

const PLACEHOLDER = "Assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2";

/** The readout's day is an ISO token (`resolve.ts` cannot import the date
 *  seam); this is the one place it is rendered through it (brief §3). */
const ISO_DAY = /\d{4}-\d{2}-\d{2}/;
const FULL_ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** S60-b (the S59 reviewer, 15 Sept): `resolve.ts`'s own `WEEKDAY_FULL_NAMES`
 *  (0 = Sunday), mirrored -- not imported (this file imports no VALUE from
 *  `resolve.ts`, only types; `BoardPage.tsx`'s own `SHOW_DAY_WEEKDAY_NAMES`
 *  already mirrors the same list for the same reason). Used only to tell
 *  whether a `day_off_board` question's own weekday-name `text` is now on
 *  the board (`isTargetOnBoard`, below) -- never to compute a day, only to
 *  read one `ctx.days` already carries (`BoardDay.weekday`). */
const SHOW_DAY_WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** S60-b: true for either half of a `CopyCommand` naming a WEEK (D130 item
 *  4's own three kinds) -- the one shape `day_off_board`'s `text` ever names
 *  by its FIRST missing day alone (`resolve.ts`'s own `resolveWeekDays`)
 *  rather than the whole week; `isTargetOnBoard` widens the check to all
 *  seven when this is true. No other command ever carries one of these three
 *  kinds (`DayWord`'s own doc: legal only on a copy's `from`/`to`). */
function commandNamesAWeek(command: Command): boolean {
  if (command.intent !== "copy") return false;
  const isWeekKind = (d: { kind: string }): boolean =>
    d.kind === "this_week" || d.kind === "next_week" || d.kind === "last_week";
  return isWeekKind(command.from) || isWeekKind(command.to);
}

/** S60-b: the seven ISOs of the calendar week `iso` falls in, MONDAY first
 *  -- `resolve.ts`'s own `resolveWeekDays` is explicitly "seven, Monday
 *  first" (its own comment), never Sunday first (`SHOW_DAY_WEEKDAY_NAMES`'s
 *  own 0=Sunday convention is for a single weekday NAME, a different axis --
 *  mixing the two up here would silently check the wrong seven days). Built
 *  with the same UTC-noon-safe `Date` arithmetic `renderReadout` below
 *  already uses to turn an ISO token into a label, the one place this file
 *  touches a `Date` at all; never `ctx`'s own day axis
 *  (`wallToOffset`/`wallOf`), which stays untouched. */
function isoWeekOf(iso: string): string[] {
  const start = new Date(`${iso}T00:00:00Z`);
  const daysFromMonday = (start.getUTCDay() + 6) % 7; // Sun(0)->6 .. Sat(6)->5, Mon(1)->0
  start.setUTCDate(start.getUTCDate() - daysFromMonday);
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * S60-b (the S59 reviewer, 15 Sept): is `pending.target` -- the exact word
 * `question.text` named when "Show that day" was pressed -- actually on the
 * board in `ctx` now? Fixes a real bug: the rerun effect used to fire on
 * ANY `ctx` change at all (a density click, a background refetch) and
 * consume the one-shot `pendingRerunRef` against whichever `ctx` happened to
 * be current, re-asking the SAME `day_off_board` question when the window
 * had not actually moved yet -- and, worse, the LATER `ctx` that really did
 * include the target then had nothing left pending to run. This is the
 * precheck that lets the effect below leave `pendingRerunRef` alone until a
 * `ctx` that actually contains the target arrives.
 *
 * "today"/"tomorrow"/"yesterday" are read off `ctx.todayIndex` (the same
 * index arithmetic `resolve.ts`'s own `resolveDay` already does, never a
 * calendar computation -- `ctx.todayIndex + 1`/`- 1` is a WINDOW position,
 * not a date); an ISO token (a `date` kind, or a week's own first missing
 * day) is compared directly, widened to the whole week
 * (`commandNamesAWeek`/`isoWeekOf`) when the original command named one; a
 * weekday name is read off `BoardDay.weekday`, never computed.
 */
function isTargetOnBoard(
  pending: { command: Command; target: string },
  ctx: ResolveContext,
): boolean {
  const { command, target } = pending;
  if (target === "today") return ctx.todayIndex !== null;
  if (target === "tomorrow") {
    return ctx.todayIndex !== null && ctx.days.some((d) => d.index === ctx.todayIndex! + 1);
  }
  if (target === "yesterday") {
    return ctx.todayIndex !== null && ctx.days.some((d) => d.index === ctx.todayIndex! - 1);
  }
  if (FULL_ISO_DAY.test(target)) {
    const need = commandNamesAWeek(command) ? isoWeekOf(target) : [target];
    const have = new Set(ctx.days.map((d) => d.iso));
    return need.every((iso) => have.has(iso));
  }
  const weekdayIndex = SHOW_DAY_WEEKDAY_NAMES.indexOf(target);
  if (weekdayIndex >= 0) return ctx.days.some((d) => d.weekday === weekdayIndex);
  return false;
}

/** The one sentence shown when the bar cannot read the line (brief §6);
 *  `bad_time`/`bad_day` get the offending text named first. */
function failureToStatus(failure: ParseFailure): Status {
  const shape = expectedShape();
  // F-133: two day words that disagree (one before the hours, one after) --
  // never a pick (CLAUDE.md §4). This is the one line outside `parse.ts`
  // this piece touches (brief §3).
  if (failure.kind === "two_days") {
    return {
      kind: "shape",
      message: `I read two days, "${failure.first}" and "${failure.second}". Say one.`,
    };
  }
  if (
    failure.kind === "bad_time" ||
    failure.kind === "bad_day" ||
    failure.kind === "bad_headcount"
  ) {
    return { kind: "shape", message: `I could not read "${failure.text}". ${shape}` };
  }
  // S58 (R-412/R-413/R-415, D132): the grammar's own three group-2 failures
  // -- never the offending text (brief §3): `which_job` (S58-a's "make it 4
  // people" -- the bar keeps no memory of "it") has no text at all to name,
  // and `bad_adjust`/`no_split_time`'s own `text` is not what a person needs
  // to hear back; a plain "say it this way" is plainer.
  if (failure.kind === "which_job") {
    return {
      kind: "shape",
      message: `Say which job — "make the Housing A job on Cell 1 4 people".`,
    };
  }
  if (failure.kind === "bad_adjust") {
    return { kind: "shape", message: `Say how much — "by an hour", or "at 3".` };
  }
  if (failure.kind === "no_split_time") {
    return { kind: "shape", message: `Say where to split — "at noon".` };
  }
  return { kind: "shape", message: shape };
}

export function CommandBar({
  ctx,
  dateFormat,
  zone,
  onOpen,
  onRetime,
  onBook,
  onRetimeRun,
  onUnassign,
  onMove,
  onSetHeadcount,
  onRunLot,
  reader = null,
  recognizer = null,
  recognizerName,
  onHighlight,
  onShowDay,
  onConfirmWord,
  onCancelWord,
  onEscapeIdle,
}: CommandBarProps) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [listening, setListening] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The last parsed command, kept so a candidate button can substitute one
  // field and so a run/job-question button can set `attach`/`existing`
  // without retyping the sentence (brief §6). Any edit to the input
  // invalidates it. S41-a widens this from `AssignCommand` to `Command`
  // (the union also holding `BookCommand`) since the bar now parses both.
  const heldRef = useRef<Command | null>(null);
  // S51 (R-400/D127): the lot a `several` sentence is being walked through --
  // `commands` in the sentence's order, `index` the one being resolved right
  // now, `done` the resolutions gathered so far. `null` whenever no several
  // is standing (every pre-S51 path, and the ordinary end of a lot: a typed
  // edit, a cancel word, or Escape drops it back to `null`, same as a single
  // question). A ref, not state, for the same reason `heldRef` is one: it is
  // read and written from event handlers, never rendered directly -- what IS
  // rendered is always the derived `Status` those handlers build from it.
  const lotRef = useRef<{ commands: SingleCommand[]; index: number; done: ResolvedAny[] } | null>(
    null,
  );
  // S51 review fix (small 2): true while `onRunLot` is in flight for the
  // CURRENT lot -- `runLotNow`'s own early-return guard, so a second "yes"
  // can never start a second run over the same lot. Also read by
  // `submitText`/`handleChange`/Escape below: a lot writing in the
  // background cannot be cancelled or typed out from under itself, so all
  // three leave the "Working…" status exactly as it is while this is true.
  const runningLotRef = useRef(false);
  // S51 review fix: bumped by every `runLotNow` call, compared on resolve --
  // the same shape as `readingSeqRef`/`recognitionSeqRef` below, so a run
  // that somehow settles after a newer one has started (never possible
  // today, since `runningLotRef` above already refuses a second run to
  // START -- kept anyway, belt and braces, exactly as those two refs are)
  // is discarded rather than clobbering whatever the bar is doing by then.
  const lotRunSeqRef = useRef(0);
  // S59 (R-419): the command a "Show that day" press is waiting to re-run,
  // once the NEW window's `ctx` arrives as a prop (the effect keyed on `ctx`
  // below) -- `null` whenever no such press is outstanding. A ref, not
  // state, same reason as `heldRef`/`lotRef`: read and written from event
  // handlers and one effect, never rendered directly. Cleared on a typed
  // edit, a cancel word or Escape (the same three the brief names) -- a
  // stale rerun must never fire against a window the person has since moved
  // away from by hand, or under a sentence they have since abandoned.
  //
  // S60-b (the S59 reviewer, 15 Sept): widened to carry `target` (the exact
  // word `question.text` named) alongside `command` -- the effect below
  // needs it to check `isTargetOnBoard` before consuming this, so a `ctx`
  // change that does not yet include the target leaves it standing instead
  // of firing (and re-asking the same question) against a `ctx` that was
  // never going to answer differently.
  const pendingRerunRef = useRef<{ command: Command; target: string } | null>(null);
  // S44-b: the in-flight reading's own abort controller (null when nothing
  // is pending) and a sequence number bumped by every Enter, Escape and edit
  // so a reading that settles after a newer one has started is discarded
  // rather than clobbering whatever the bar is doing by then.
  const readingAbortRef = useRef<AbortController | null>(null);
  const readingSeqRef = useRef(0);
  // S46-a: the in-flight recognition session's handle (null when idle) and a
  // sequence number bumped every time a session ends -- by `stopListening`,
  // by unmount, or by the session's own `onError`/`onEnd` -- so a callback
  // from a session that is no longer the current one (a late `onFinal` after
  // Escape/stop, or a synchronous `onError` fired from inside the
  // `Recognizer` call itself, before this file has assigned the ref) is a
  // no-op rather than clobbering whatever the bar is doing by then (review
  // findings 1-3).
  const recognitionRef = useRef<RecognizerHandle | null>(null);
  const recognitionSeqRef = useRef(0);
  // S59-e (R-421, brief §3): one trace entry in progress for the CURRENT
  // sentence, `null` whenever none is open. A ref, not state, same reason as
  // `heldRef`/`lotRef` above: read and written from event handlers and one
  // `.then()`, never rendered.
  const traceRef = useRef<TraceEntry | null>(null);

  /** S59-e: posts `entry` to the dev server's `/__trace`, fire-and-forget,
   *  errors swallowed (both a synchronous throw -- an invalid URL under a
   *  test's fetch, say -- and a rejected promise), only when
   *  `import.meta.env.DEV` (brief §3: "a build without it changes nothing in
   *  the bar"). */
  function postTrace(entry: TraceEntry): void {
    if (!import.meta.env.DEV) return;
    try {
      fetch("/__trace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: renderLine(entry),
      }).catch(() => {});
    } catch {
      // Never throws -- see above.
    }
  }

  /** S59-e: the sentence's life ends here (brief §3: "a readout written, a
   *  cancel, a new sentence") -- posts whatever the entry holds and clears
   *  it. A no-op when nothing is open (every call site below is safe to
   *  call unconditionally). */
  function finishTrace(): void {
    const entry = traceRef.current;
    if (!entry) return;
    traceRef.current = null;
    postTrace(entry);
  }

  /** S59-e: starts a fresh entry for `heard`/`by` -- flushes (posts) any
   *  entry still open first, since starting one IS "a new sentence" ending
   *  the previous one's life (brief §3). `model` defaults to "no reader",
   *  overwritten by `applyReading` the moment a real reader answers. */
  function startTrace(heard: string, by: "typed" | "browser" | "local"): void {
    finishTrace();
    traceRef.current = {
      at: new Date().toISOString(),
      heard,
      by,
      model: { skipped: "no reader" },
      read: "",
      asked: null,
      answered: null,
      ran: [],
    };
  }

  // S46-a: stop a listening session on unmount rather than leak it, and
  // retire its generation so a callback that fires after teardown is a
  // no-op.
  useEffect(() => {
    return () => {
      // `recognitionRef`/`recognitionSeqRef` are plain mutable refs (a
      // session handle and a counter), not DOM nodes -- reading their LIVE
      // value at unmount (not a stale snapshot captured when the effect
      // ran) is exactly what stopping whatever session is current requires,
      // so the rule's usual "copy it to a variable first" fix does not
      // apply here.
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      recognitionSeqRef.current++;
    };
  }, []);

  // S47: kept in a ref, not the effect's own dependency array, below -- a
  // caller that passes a fresh inline function every render (BoardPage does)
  // must not re-fire the effect on every unrelated render, only when
  // `status` itself actually changes.
  const onHighlightRef = useRef(onHighlight);
  onHighlightRef.current = onHighlight;

  // S47 / R-395: reports the outline `status` implies -- a block question's
  // `blockHighlight` when that is the current status, `null` otherwise --
  // and, via the cleanup function every effect gets, `null` again the moment
  // `status` changes away from it OR this component unmounts (brief §2 item
  // 1: "call it with null whenever that status is replaced, cleared ... or
  // the bar unmounts"). One `useEffect` here instead of touching every
  // `setStatus` call site above and below.
  useEffect(() => {
    onHighlightRef.current?.(
      status?.kind === "question" && status.blockHighlight ? status.blockHighlight : null,
    );
    return () => onHighlightRef.current?.(null);
  }, [status]);

  // S59 (R-419): re-runs a "Show that day" press's held command once the
  // window has actually moved -- `ctx` is the SAME object from one render to
  // the next until `BoardPage`'s own `commandCtx` memo recomputes, which only
  // happens once the store's window state changes AND the board's data for
  // the new window has landed, so this effect fires exactly when "the new
  // window's ctx arrives" (brief §3), never against the ctx that produced the
  // `day_off_board` question in the first place. `pendingRerunRef` is `null`
  // on every OTHER render (the ordinary case), so this is a no-op then.
  //
  // S60-b (the S59 reviewer, 15 Sept): this effect used to fire (and consume
  // the one-shot ref) on ANY `ctx` change at all -- a density click, a
  // background refetch -- not only the window actually moving; a `ctx` that
  // still did not include the target just re-asked the SAME `day_off_board`
  // question and threw the pending rerun away, so the LATER `ctx` that
  // really did move never got a turn. `isTargetOnBoard` gates the consume:
  // a `ctx` without the target leaves `pendingRerunRef` standing (this
  // effect simply runs again, a no-op, on the next change) instead.
  useEffect(() => {
    if (pendingRerunRef.current && isTargetOnBoard(pendingRerunRef.current, ctx)) {
      const command = pendingRerunRef.current.command;
      pendingRerunRef.current = null;
      runCommand(command);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  function renderReadout(readout: string): string {
    return readout.replace(ISO_DAY, (iso) =>
      formatDayLabel(new Date(`${iso}T00:00:00Z`), dateFormat, zone),
    );
  }

  function anchorOfInput(): { x: number; y: number } {
    const rect = inputRef.current?.getBoundingClientRect();
    return { x: rect?.left ?? 0, y: rect?.bottom ?? 0 };
  }

  /**
   * S44-b: `suffix`, when given, is appended to the readout text ONLY --
   * never to a question's message (brief §3.3: "when that produces a
   * readout status, append ... to the readout text"). Every existing call
   * site omits it, which is byte-for-byte the pre-S44-b behaviour.
   */
  /** S59-e (brief §3): records what `status` means for the trace entry
   *  currently open, if any -- a resolver/expand-phase "question" sets
   *  `asked`; a "readout" (an ordinary one, or `questionToStatus`'s own
   *  `nothing_to_do` case) ends the entry's life the same as any other
   *  readout. Never touches `status` itself -- called right after the
   *  `setStatus` that already shows it. */
  function traceQuestionStatus(status: Status): void {
    if (!traceRef.current) return;
    if (status.kind === "question") {
      traceRef.current.asked = status.message;
    } else if (status.kind === "readout") {
      finishTrace();
    }
  }

  function runCommand(command: Command, suffix?: string): void {
    // S59-e (brief §3): what the bar read, regardless of how this resolves
    // (a write, a question, or a several) -- `command` here, not whatever
    // `expandCommand` turns it into below, since a lot's own numbered steps
    // resolve their OWN commands through `resolveLotStep`, never this one.
    if (traceRef.current) traceRef.current.read = formatCommand(command);
    // S55 (R-406 to R-410, D130/brief §2): `expandCommand` runs FIRST, before
    // the S51 several intercept below -- a board-answered sentence
    // (`replace`/`swap`/`copy`, `everyone` on a removal/move, an absence's
    // `until`) turns into an ordinary `several`/single here, and THIS is the
    // one place both the rules path and the model path land
    // (`fallbackToRules`/`applyReading` both call `runCommand`), so both
    // expand the same way. `expandCommand` returns the SAME object for every
    // ordinary form (an already-single command, or an already-several one),
    // so the branch below is byte for byte the pre-S55 several intercept for
    // every sentence that never needed expanding.
    const expanded = expandCommand(command, ctx);
    if (!expanded.ok) {
      // `command` here, never `expanded.command` (there is none) -- the
      // ORIGINAL sentence's command is what a candidate button must
      // substitute a field into and re-run (see `pickCandidate`'s own S55
      // comment below).
      const next = questionToStatus(expanded.question, command);
      setStatus(next);
      traceQuestionStatus(next);
      return;
    }
    const resolvedCommand = expanded.command;
    if (resolvedCommand.intent === "several") {
      startLot(resolvedCommand.commands);
      return;
    }
    // `heldRef` keeps the ORIGINAL sentence's command (brief §2: "the one a
    // re-parse after a button press must start from"), never the expanded
    // form -- for an ordinary sentence the two are the SAME object
    // (`expandCommand`'s own contract), so this is unchanged from before S55
    // for every sentence that does not expand.
    heldRef.current = command;
    const resolution = resolveCommand(resolvedCommand, ctx);
    if (resolution.ok) {
      const resolved = resolution.resolved;
      if (resolved.intent === "book") {
        if (resolved.target.kind === "retime_run") {
          onRetimeRun(resolved, anchorOfInput());
        } else {
          onBook(resolved, anchorOfInput());
        }
      } else if (resolved.intent === "unassign") {
        onUnassign(resolved, anchorOfInput());
      } else if (resolved.intent === "move") {
        // S41-c: BOTH targets go through onMove -- the caller narrows on
        // `resolved.target.kind` (keep the types honest: never build a
        // ResolvedCommand-shaped call to reach onRetime from here).
        onMove(resolved, anchorOfInput());
      } else if (resolved.intent === "headcount") {
        // S58 (R-415, D132 item 4): one existing write, never a create or a
        // re-time -- see `onSetHeadcount`'s own doc above.
        onSetHeadcount(resolved, anchorOfInput());
      } else {
        if (resolved.target.kind === "retime") {
          onRetime(resolved, anchorOfInput());
        } else {
          onOpen(resolved, anchorOfInput());
        }
      }
      setStatus({ kind: "readout", message: renderReadout(resolved.readout) + (suffix ?? "") });
      // S59-e (brief §3): a readout written ends the sentence's life --
      // `resolved.readout` is the ONE command this run actually wrote
      // (never the `+ suffix` UI annotation, which says WHY it was read,
      // not what ran).
      if (traceRef.current) traceRef.current.ran.push(resolved.readout);
      finishTrace();
      return;
    }
    // `resolvedCommand`, not `command`: when `expandCommand` collapsed a
    // board-answered sentence down to the ONE ordinary command it produced
    // (brief §2: "a single: the existing path"), that is what was actually
    // handed to `resolveCommand` and so what a candidate button must
    // substitute a field into -- for an ordinary sentence the two are the
    // same object, so this is unchanged from before S55 there.
    const next = questionToStatus(resolution.question, resolvedCommand);
    setStatus(next);
    traceQuestionStatus(next);
  }

  /** S51: starts a fresh lot from a several's inner commands and resolves
   *  the first one (brief §2 item 1). */
  function startLot(commands: SingleCommand[]): void {
    lotRef.current = { commands, index: 0, done: [] };
    resolveLotStep();
  }

  /**
   * S51: resolves `lotRef.current`'s CURRENT command with the same
   * `resolveCommand` a single sentence uses; an `ok` result is kept and the
   * lot advances to the next command (recursing, exactly as a chain of
   * always-resolved single sentences would); a question is shown numbered
   * "i of N: ..." with that question's own buttons and outline
   * (`questionToStatus`, unchanged); once every command has resolved, the
   * lot status is shown instead (brief §2 items 1-2).
   */
  function resolveLotStep(): void {
    const lot = lotRef.current;
    if (!lot) return;
    if (lot.index >= lot.commands.length) {
      showLotStatus();
      return;
    }
    const command = lot.commands[lot.index];
    const resolution = resolveCommand(command, ctx);
    if (resolution.ok) {
      // S58: `resolveCommand`'s per-shape overloads do not cover the
      // `SingleCommand` union directly (TypeScript overload resolution does
      // not distribute over a union argument unless one signature's
      // parameter equals it exactly), so this call falls through to the
      // generic `Command` overload and its return type now includes
      // `ResolvedHeadcount` -- a shape `SingleCommand` can never actually
      // produce THROUGH THE RULES (`HeadcountCommand` is not a member of
      // that union; `expandCommand` always hands a headcount back
      // UNCHANGED, never wrapped in a `several`, so it never reaches a
      // lot's own commands array by that path). The MODEL path has no such
      // guarantee (brief §3, reviewer scenario 6): `decode.ts` owns keeping
      // a `headcount` form out of a decoded several's own commands, but a
      // garbled answer that slips one in anyway must not leave the bar
      // silently stuck on whatever status was showing before this ran (a
      // bare `return` here used to do exactly that -- "Reading…" frozen on
      // screen forever, indistinguishable from a hang). Reviewer fix
      // (S58-d lane review, 14 Sept): drop the lot and say so in plain
      // words, the same shape `several_unsupported` already reports for a
      // several the resolver refuses outright.
      if (resolution.resolved.intent === "headcount") {
        lotRef.current = null;
        setStatus({
          kind: "shape",
          message: "I could not read that as several commands. Say them one at a time.",
        });
        return;
      }
      lotRef.current = {
        ...lot,
        done: [...lot.done, resolution.resolved],
        index: lot.index + 1,
      };
      resolveLotStep();
      return;
    }
    const base = questionToStatus(resolution.question, command);
    if (base.kind !== "question") {
      // Every SingleCommand's own Resolution question is always a
      // "question" status through questionToStatus -- this branch exists
      // only so TypeScript sees the numbering below is safe, never because
      // a several's inner command can reach a different Status kind.
      setStatus(base);
      return;
    }
    const next = {
      ...base,
      message: `${lot.index + 1} of ${lot.commands.length}: ${base.message}`,
    };
    setStatus(next);
    // S59-e (brief §3): a lot's own per-step question, numbered exactly as
    // shown -- the entry's single `asked` is the CURRENT question, same as
    // a single sentence's.
    if (traceRef.current) traceRef.current.asked = next.message;
  }

  /**
   * S51 (brief §2 item 1): a candidate button or a confirm word answering
   * the lot's CURRENT command substitutes into `lotRef.current.commands[index]`
   * (never into `heldRef`, which is not in play while a lot stands) and
   * re-resolves from that same index -- called by `pickCandidate`/
   * `pickAttach`/`pickExisting` below INSTEAD of `runCommand` whenever a lot
   * is standing.
   */
  function updateLotCommand(next: SingleCommand): void {
    const lot = lotRef.current;
    if (!lot) return;
    const commands = lot.commands.slice();
    commands[lot.index] = next;
    lotRef.current = { ...lot, commands };
    resolveLotStep();
  }

  /**
   * S51 (brief §2 item 2): one `Highlight` per removal (`remove`), per
   * re-time (`retime` -- an assign's own-block change, or a move-in-time)
   * and per move to another cell (`move`), in the lot's own order; a create
   * or a booking adds nothing (neither ever names an assignment id to
   * outline).
   */
  function buildLotHighlights(done: readonly ResolvedAny[]): Highlight[] {
    const highlights: Highlight[] = [];
    for (const r of done) {
      if (r.intent === "unassign") {
        highlights.push({ kind: "remove", assignmentIds: [r.assignmentId] });
      } else if (r.intent === "move") {
        highlights.push({
          kind: r.target.kind === "retime" ? "retime" : "move",
          assignmentIds: [r.assignmentId],
        });
      } else if (r.intent === "assign" && r.target.kind === "retime") {
        highlights.push({ kind: "retime", assignmentIds: [r.target.assignmentId] });
      }
      // "assign" with a direct/run target, and every "book": nothing to
      // outline -- a create or a booking names no existing block.
    }
    return highlights;
  }

  /** S51 review fix (small 1): the one assignment id a resolved command
   *  actually NAMES -- a removal, a move (either target), or an assign's
   *  own-block retime; `null` for a create/booking, which names no
   *  existing block at all and so can never collide with anything. */
  function namedAssignmentId(r: ResolvedAny): string | null {
    if (r.intent === "unassign") return r.assignmentId;
    if (r.intent === "move") return r.assignmentId;
    if (r.intent === "assign" && r.target.kind === "retime") return r.target.assignmentId;
    return null;
  }

  /**
   * S51 review fix (small 1): the first two commands (1-based, sentence
   * order) that name the SAME block -- a removal or a re-time of it twice
   * over, which the resolver has no way to catch on its own (each inner
   * command resolves against the board, never against its SIBLINGS in the
   * lot). `null` when every named id in the lot is distinct.
   */
  function findDuplicateBlockPair(done: readonly ResolvedAny[]): [number, number] | null {
    const seenAt = new Map<string, number>();
    for (let i = 0; i < done.length; i++) {
      const id = namedAssignmentId(done[i]);
      if (id === null) continue;
      const firstIndex = seenAt.get(id);
      if (firstIndex !== undefined) return [firstIndex, i + 1];
      seenAt.set(id, i + 1);
    }
    return null;
  }

  /**
   * S51 (brief §2 item 2): every command has resolved -- show every readout
   * numbered, outline everything a removal or a move in the lot would
   * touch, and ask once. Only the universal confirm words confirm it
   * (`submitText`'s own `status.lot` branch); a typed edit, "no" or Escape
   * drop it exactly as they drop a single question.
   *
   * S51 review fix (small 1): two commands naming the SAME block (a removal
   * or a re-time of it twice) never reach that lot status at all -- there is
   * no sane "one outline, one write" answer for a block asked about twice,
   * so this drops the lot outright and says which two commands collided,
   * in plain sentence positions.
   */
  function showLotStatus(): void {
    const lot = lotRef.current;
    if (!lot) return;
    const dup = findDuplicateBlockPair(lot.done);
    if (dup) {
      lotRef.current = null;
      setStatus({
        kind: "shape",
        message: `Commands ${dup[0]} and ${dup[1]} name the same block; say them one at a time.`,
      });
      return;
    }
    const n = lot.done.length;
    // S55 (brief §4): unchanged for a lot of up to 6 (every existing CB-lot
    // case pins this small format); above it, the first 5 numbered readouts
    // followed by a count of the rest -- `expandCommand` can hand back many
    // more than a person would ever read one by one, and the "N commands
    // ready" question and the outline (`buildLotHighlights`, below) already
    // say what the whole lot touches.
    const shown = n > 6 ? lot.done.slice(0, 5) : lot.done;
    const readouts = shown.map((r, i) => `${i + 1}. ${renderReadout(r.readout)}`).join("; ");
    const readoutText = n > 6 ? `${readouts}; … and ${n - 5} more` : readouts;
    const message = `${n} commands ready: ${readoutText} — say or type yes to do them, no to leave them.`;
    setStatus({
      kind: "question",
      message,
      candidates: [{ key: "__do_all__", label: `Do all ${n}`, onClick: () => runLotNow() }],
      blockHighlight: buildLotHighlights(lot.done),
      lot: true,
    });
    // S59-e (brief §3): the lot's own single question, same as a per-step
    // one above.
    if (traceRef.current) traceRef.current.asked = message;
  }

  /**
   * S51 (brief §2 item 3): the lot's single "yes" -- a busy status while
   * `onRunLot` is in flight, then either "Done: N commands." (input
   * cleared) or "Did k of N; the next failed: <error>" (input kept). The
   * lot is dropped either way: a half-answered lot never lingers once its
   * one question has been answered.
   *
   * S51 review fix (small 2): `runningLotRef` is an explicit early-return
   * guard, checked first -- a second "yes" (a stray double click on "Do all
   * N" before React has re-rendered it away, or any other path that might
   * someday reach here again while the first run is still in flight) must
   * never start a SECOND `onRunLot` call over the same lot.
   *
   * S51 review fix: `mySeq` is this run's own generation, checked again on
   * resolve (`lotRunSeqRef.current !== mySeq`) before touching `status` or
   * `lotRef` -- a stale finish can never overwrite a newer status. Escape, a
   * typed edit and the cancel words all leave "Working…" standing while
   * `runningLotRef` is true (`handleKeyDown`/`handleChange`/`submitText`
   * below), so nothing today actually produces a second generation before
   * this one settles -- the check is kept anyway, the same belt-and-braces
   * shape `readingSeqRef`/`recognitionSeqRef` already use elsewhere here.
   */
  function runLotNow(): void {
    if (runningLotRef.current) return;
    const lot = lotRef.current;
    if (!lot) return;
    runningLotRef.current = true;
    const mySeq = ++lotRunSeqRef.current;
    const n = lot.done.length;
    const resolved = lot.done;
    setStatus({ kind: "reading", message: "Working…" });
    onRunLot(resolved).then((result) => {
      // A stale finish touches NOTHING -- not the flag, not the lot, not
      // the status -- exactly as if it had never arrived.
      if (lotRunSeqRef.current !== mySeq) return;
      runningLotRef.current = false;
      lotRef.current = null;
      // S59-e (brief §3): every command the lot actually wrote, in order --
      // `result.done` of `resolved` on a partial failure, all of them on a
      // clean sweep -- and the lot's run always ends the entry's life
      // either way (a busy "Working…" never itself opens a NEW entry, so
      // this is the same one the lot's own question set `asked` on).
      if (traceRef.current) {
        traceRef.current.ran.push(
          ...resolved.slice(0, result.error === null ? n : result.done).map((r) => r.readout),
        );
      }
      finishTrace();
      if (result.error === null) {
        setStatus({ kind: "readout", message: `Done: ${n} commands.` });
        setText("");
      } else {
        setStatus({
          kind: "shape",
          message: `Did ${result.done} of ${n}; the next failed: ${result.error}`,
        });
      }
    });
  }

  /** S44-b: the three "why the rules read this instead" phrases, shared by
   *  the readout suffix and the failure-message prefix below. */
  function whyForReason(reason: "unavailable" | "timeout" | "garbled"): string {
    if (reason === "unavailable") return "the model service is off";
    if (reason === "timeout") return "the model took too long";
    return "the model's answer was not a form";
  }

  /** S44-b: `"the model service is off"` -> `"The model service is off, so
   *  the rules read this: "` -- the same phrase, capitalised, as a prefix. */
  function failurePrefixForReason(reason: "unavailable" | "timeout" | "garbled"): string {
    const why = whyForReason(reason);
    return `${why.charAt(0).toUpperCase()}${why.slice(1)}, so the rules read this: `;
  }

  /**
   * S44-b: the fallback path once the model reader has answered anything but
   * `ok` — re-parses `sentence` through the rules exactly as a null-reader
   * Enter would, then either runs it as-is (`reason` null, the `no-service`
   * case) or annotates the result with why the rules read it instead.
   */
  function fallbackToRules(
    sentence: string,
    reason: "unavailable" | "timeout" | "garbled" | null,
  ): void {
    const parsed = parseCommand(sentence);
    if (!parsed.ok) {
      heldRef.current = null;
      // S59-e (brief §3): "the failure kind" -- `read` when the bar could
      // not read a command at all. The entry's life does NOT end here
      // (brief §3's own three triggers -- a readout, a cancel, a new
      // sentence -- and a bare shape hint is none of them): it stays open,
      // posted once one of those actually happens.
      if (traceRef.current) traceRef.current.read = parsed.failure.kind;
      const base = failureToStatus(parsed.failure);
      setStatus(
        reason === null
          ? base
          : { ...base, message: `${failurePrefixForReason(reason)}${base.message}` },
      );
      return;
    }
    runCommand(
      parsed.command,
      reason === null ? undefined : ` · read by the rules (${whyForReason(reason)})`,
    );
  }

  /** S59-e (brief §2/§3): the trace entry's own `model` field for `result`
   *  -- the raw answer when the reader got far enough to have one (a form,
   *  or a garbled answer past "no message content"), the plain reason
   *  otherwise. `readSentence.ts`'s own `reason`s map onto the brief's own
   *  words ("no service", "timeout", "network") rather than the readout's
   *  phrasing (`whyForReason`), which is written for a person, not a log. */
  function traceModelField(result: Reading): TraceEntry["model"] {
    if (result.ok) return { raw: result.raw ?? "" };
    if (result.reason === "garbled" && result.raw !== undefined) return { raw: result.raw };
    if (result.reason === "no-service") return { skipped: "no service" };
    if (result.reason === "timeout") return { skipped: "timeout" };
    if (result.reason === "unavailable") return { skipped: "network" };
    return { skipped: "garbled" };
  }

  /** S44-b: settles a reading that is still current (brief §3.3). */
  function applyReading(sentence: string, result: Reading): void {
    if (traceRef.current) traceRef.current.model = traceModelField(result);
    if (result.ok) {
      runCommand(result.command, " · read by the model");
      return;
    }
    fallbackToRules(sentence, result.reason === "no-service" ? null : result.reason);
  }

  /** S44-b: starts (or restarts) a reading through `activeReader` -- a
   *  second Enter aborts whatever is in flight first (brief §3.3). */
  function startReading(sentence: string, activeReader: Reader): void {
    readingAbortRef.current?.abort();
    const controller = new AbortController();
    readingAbortRef.current = controller;
    const mySeq = ++readingSeqRef.current;
    setStatus({ kind: "reading", message: "Reading…" });
    activeReader(sentence, controller.signal).then((result) => {
      // A newer Enter, Escape or edit has happened since -- discard.
      if (readingSeqRef.current !== mySeq) return;
      readingAbortRef.current = null;
      applyReading(sentence, result);
    });
  }

  function pickCandidate(
    command: Command,
    field: "operator" | "product" | "place" | "shift",
    candidate: Candidate,
    // S55 (D130 item 1): the exact word `question.text` was asked about --
    // needed ONLY to tell a `replace`/`swap`'s TWO person fields apart (see
    // below); every other caller of this function leaves it unset.
    text?: string,
  ): void {
    let next: Command;
    if (
      field === "operator" &&
      (command.intent === "replace" || command.intent === "swap") &&
      text !== undefined
    ) {
      // S55: both people a `replace`/`swap` names resolve through the SAME
      // `resolvePersonStep`, so `resolve.ts` can only ever say `field:
      // "operator"` for either one -- `question.text` is that call's own
      // input verbatim (`command.operator` for the first person, `with`/
      // `other` for the second), so comparing it against `command.operator`
      // tells the two apart without a field name `resolve.ts`'s `Question`
      // type does not have (this module owns no shape there -- CLAUDE.md
      // §4: never a copy of the resolver's own rule).
      next =
        command.intent === "replace"
          ? text === command.operator
            ? { ...command, operator: candidate.word }
            : { ...command, with: candidate.word }
          : text === command.operator
            ? { ...command, operator: candidate.word }
            : { ...command, other: candidate.word };
    } else if (
      field === "place" &&
      (command.intent === "replace" || command.intent === "swap" || command.intent === "copy")
    ) {
      next = { ...command, place: [candidate.word] };
    } else {
      // "operator" only ever comes from an AssignCommand's ambiguous question
      // (a `BookCommand` has no operator field, and an `UnassignCommand`'s
      // ambiguous-operator question re-resolves through its own `operator`
      // field below rather than this cast). "product" only ever comes from
      // AssignCommand or BookCommand (S41-b: unassign names no part at all).
      // "place" comes from any of the four -- never from a SeveralCommand
      // (S50: a several never reaches an ambiguous/place question; its only
      // answer is `several_unsupported`, with no candidates at all) -- so the
      // cast here mirrors that invariant the same way the other two branches
      // already do, rather than widening `SingleCommand` to prove it. "shift"
      // (S52-b, R-402) comes from any of the four too -- every single command
      // carries `shift`.
      next =
        field === "operator"
          ? command.intent === "unassign"
            ? { ...command, operator: candidate.word }
            : { ...(command as AssignCommand), operator: candidate.word }
          : field === "product"
            ? { ...(command as AssignCommand | BookCommand), product: candidate.word }
            : field === "shift"
              ? {
                  ...(command as AssignCommand | BookCommand | UnassignCommand | MoveCommand),
                  shift: candidate.word,
                }
              : {
                  ...(command as AssignCommand | BookCommand | UnassignCommand | MoveCommand),
                  place: [candidate.word],
                };
    }
    // S51 (brief §2 item 1): while a lot stands, a candidate substitutes
    // into THAT command (`lotRef.current.commands[index]`), never into the
    // input text or the lone `heldRef` -- the input keeps showing the whole
    // several sentence throughout, and `resolveLotStep` re-resolves from the
    // same index.
    if (lotRef.current) {
      updateLotCommand(next as SingleCommand);
      return;
    }
    const rendered = formatCommand(next);
    setText(rendered);
    const parsed = parseCommand(rendered);
    if (!parsed.ok) {
      heldRef.current = null;
      // S59-e (brief §3): same as `submitText`'s own identical comment.
      if (traceRef.current) traceRef.current.read = parsed.failure.kind;
      setStatus(failureToStatus(parsed.failure));
      return;
    }
    runCommand(parsed.command);
  }

  /**
   * Reviewer fix (S60-b review, R-422): the one caller for the `unknown`/
   * `place` question's own `asPart` flag (`questionToStatus`, below) -- a
   * single-segment word `resolve.ts` recognised as a PART, not a place
   * ("Housing A" in "assign Sam to Housing A 8 to 4"). Picking a track-cell
   * button here has to set TWO fields at once: `place` to the picked cell,
   * `product` to the word itself (already matched or near-matched by
   * `resolveCellStep`, never re-guessed here). A plain `pickCandidate(command,
   * "place", c, text)` would leave `product` at its original empty string,
   * and the re-run would only ask "Which part?" again for a part the person
   * already named -- this is the one picker that fills two fields from one
   * button.
   */
  function pickPartAsPlace(
    command: AssignCommand | BookCommand | HeadcountCommand,
    product: string,
    candidate: Candidate,
  ): void {
    const next = { ...command, place: [candidate.word], product };
    if (lotRef.current) {
      updateLotCommand(next as SingleCommand);
      return;
    }
    const rendered = formatCommand(next);
    setText(rendered);
    const parsed = parseCommand(rendered);
    if (!parsed.ok) {
      heldRef.current = null;
      if (traceRef.current) traceRef.current.read = parsed.failure.kind;
      setStatus(failureToStatus(parsed.failure));
      return;
    }
    runCommand(parsed.command);
  }

  function pickAttach(command: AssignCommand, attach: Attach): void {
    // R-383: the sentence stays as it is -- only the held command's `attach`
    // changes -- so this re-resolves directly rather than going back through
    // `parseCommand` (which always returns `attach: null`).
    const next = { ...command, attach };
    if (lotRef.current) {
      updateLotCommand(next);
      return;
    }
    runCommand(next);
  }

  /**
   * R-385's setter, WIDENED for S41-a rather than duplicated (brief §3:
   * "`pickExisting` is reused for the run answer"): the assign path's
   * `Existing` (`retime`/`separate`, keyed by `assignmentId`) and the book
   * path's own inline shape (`retime`/`null`, keyed by `runId`) are
   * different types, so this is declared as two overloads over one body —
   * the sentence stays as it is; only the held command's `existing` changes,
   * re-resolved directly rather than through `parseCommand` (which always
   * returns `existing: null`).
   */
  function pickExisting(command: AssignCommand, existing: Existing): void;
  function pickExisting(command: BookCommand, existing: BookCommand["existing"]): void;
  function pickExisting(command: UnassignCommand, existing: UnassignCommand["existing"]): void;
  function pickExisting(command: MoveCommand, existing: MoveCommand["existing"]): void;
  function pickExisting(
    command: Command,
    existing:
      Existing | BookCommand["existing"] | UnassignCommand["existing"] | MoveCommand["existing"],
  ): void {
    const next = { ...command, existing } as Command;
    // S51 (brief §2 item 1): same lot substitution as `pickCandidate` above.
    if (lotRef.current) {
      updateLotCommand(next as SingleCommand);
      return;
    }
    runCommand(next);
  }

  /**
   * S47: the one place a `Status` gains a `blockHighlight` -- called only
   * for `remove_which`/`move_which`/`block_exists` (brief §2 items 1 and 3).
   * With exactly one candidate the message also gets `YES_SUFFIX`; with
   * several, the outline still covers every one of `assignmentIds` but the
   * message is left as `describeQuestion` wrote it (a bare yes would be
   * ambiguous -- `submitText` below asks "Which one?" instead).
   */
  function withBlockHighlight(
    status: Status,
    kind: Highlight["kind"],
    assignmentIds: string[],
  ): Status {
    if (status.kind !== "question") return status;
    const withSuffix =
      status.candidates.length === 1 ? { ...status, message: status.message + YES_SUFFIX } : status;
    return { ...withSuffix, blockHighlight: { kind, assignmentIds } };
  }

  function questionToStatus(question: Question, command: Command): Status {
    // S55 (R-406 to R-410, D130/brief §3): the bar's own words for the seven
    // new `expandCommand` questions -- plainer, or with fields
    // `describeQuestion`'s generic sentence does not carry, than the
    // resolver's own wording (which still backs every OTHER kind below,
    // unchanged). No candidates on any of these (brief §3): a cancel word or
    // fresh typing clears them exactly as any other question does.
    // `nothing_to_do` is a plain READOUT, not a question at all -- the text
    // as the resolver wrote it (brief §3, D130 item 1).
    if (question.kind === "nothing_to_do") {
      return { kind: "readout", message: renderReadout(question.text) };
    }
    if (question.kind === "lot_too_big") {
      return {
        kind: "question",
        message: `That would be ${question.count} changes; say a smaller span — one cell, or one day.`,
        candidates: [],
      };
    }
    if (question.kind === "split_needed") {
      return {
        kind: "question",
        message: `${question.person}'s ${question.block} block on ${question.cell} runs across both sides of ${question.span}; say a span that reaches one end of it.`,
        candidates: [],
      };
    }
    if (question.kind === "swap_which") {
      return {
        kind: "question",
        message: `${question.person} has more than one block ${question.when}: ${question.blocks.join(", ")}. Say the hours.`,
        candidates: [],
      };
    }
    if (question.kind === "day_order") {
      return {
        kind: "question",
        message: `${question.second} is before ${question.first}; say the days the other way round.`,
        candidates: [],
      };
    }
    if (question.kind === "no_start") {
      return {
        kind: "question",
        message: `Say when it starts — "from 10", say.`,
        candidates: [],
      };
    }
    if (question.kind === "no_shift_at") {
      return {
        kind: "question",
        message: `No shift on ${question.cell} covers ${question.time}.`,
        candidates: [],
      };
    }
    // S58 (R-412 to R-415, D132/brief §3): the bar's own words for the five
    // new group-2 `expandCommand`/resolver questions -- plainer, or with
    // fields `describeQuestion`'s generic sentence does not carry, than the
    // resolver's own wording (which still backs the resolver-defensive
    // `bad_adjust`/`bad_repeat_day` kinds below, unchanged). No candidates on
    // any of these: a cancel word or fresh typing clears them exactly as any
    // other question does.
    if (question.kind === "adjust_inverts") {
      return {
        kind: "question",
        message: `${question.person}'s ${question.block} block would end before it starts; say a smaller change.`,
        candidates: [],
      };
    }
    if (question.kind === "adjust_off_day") {
      return {
        kind: "question",
        message: `${question.person}'s ${question.block} block would leave the day; say a time inside it.`,
        candidates: [],
      };
    }
    if (question.kind === "split_outside") {
      return {
        kind: "question",
        message: `${question.at} is outside ${question.person}'s block${question.blocks.length > 1 ? "s" : ""} (${question.blocks.join(", ")}); say a time inside one.`,
        candidates: [],
      };
    }
    if (question.kind === "no_job") {
      return {
        kind: "question",
        message: `There is no ${question.product} job on ${question.cell} ${question.when}; book it first, or say the hours.`,
        candidates: [],
      };
    }
    if (question.kind === "which_job") {
      return {
        kind: "question",
        message: `${question.product} runs more than once on ${question.cell}: ${question.runs.join(", ")}. Say the hours.`,
        candidates: [],
      };
    }
    // `expand_first` (brief §3: "should never show") and every existing kind
    // keep `describeQuestion`'s own wording, unchanged.
    // CU4 (S41-b brief §5): a question's message can carry an ISO day too
    // (`remove_which`/`no_block`'s whole-day `when`) -- the same
    // `renderReadout` substitution the successful-open readout gets.
    const message = renderReadout(describeQuestion(question));
    if (question.kind === "ambiguous") {
      const field = question.field;
      const text = question.text;
      return {
        kind: "question",
        message,
        candidates: question.candidates.map((c) => ({
          key: c.id,
          label: c.label,
          onClick: () => pickCandidate(command, field, c, text),
        })),
      };
    }
    // S59 / R-419 (design §19.104/D133 item 3): "Show that day" -- moves the
    // window through `onShowDay` (the caller's job, see that prop's own doc)
    // and holds `command` (the exact command this question came from -- the
    // ordinary sentence, or a lot's own current step, whichever
    // `questionToStatus` was called with) until the effect above sees a new
    // `ctx` and re-runs it. No candidate answers the question directly (a
    // window move is asynchronous), so this is the button's whole job.
    if (question.kind === "day_off_board") {
      const day = question.text;
      return {
        kind: "question",
        message,
        candidates: [
          {
            key: "__show_that_day__",
            label: "Show that day",
            onClick: () => {
              pendingRerunRef.current = { command, target: day };
              onShowDay?.(day);
            },
          },
        ],
      };
    }
    // S59 / R-418's message (design §19.104/D133 item 1): a word that
    // matches no part, person or place, WITH nearest-name suggestions from
    // the resolver, offers them as buttons -- the same shape `ambiguous`
    // already renders, a pick substituting the real name and re-running. Lane
    // A (resolver) is concurrently adding `suggestions?: Candidate[]` to this
    // question -- read through a local cast so this compiles either side of
    // that landing; `suggestions` undefined or empty (today, and any
    // `unknown` the resolver still answers with none) keeps the plain
    // `describeQuestion` wording and no buttons, unchanged from before S59.
    if (question.kind === "unknown") {
      const suggestions = (question as { suggestions?: Candidate[] }).suggestions;
      // S60-b (R-422): `more` flags a cell whose own menu is bigger than the
      // eight `resolve.ts`'s own `offeredSuggestions` ever shows at once --
      // never a silent drop of the rest.
      const more = (question as { more?: true }).more === true;
      const moreTail = more ? " … and more — say the part." : "";
      // Reviewer fix (S60-b review, R-422): `asPart` (set only by
      // `resolveCellStep`'s own check, resolve.ts) flags a single-segment
      // word that named no place but DOES name a part -- "assign Sam to
      // Housing A 8 to 4" with no separator reads "Housing A" as the place
      // (parse.ts's own R-422 branch) since there is no syntactic way to
      // tell the two apart; the resolver catches it once no cell matches.
      // Rendered BEFORE the ordinary place-suggestion wording below so a
      // person who named a part is told the part was heard, never sent place
      // suggestions for a word they never meant as a place. `suggestions`
      // carries every track cell (`ctx.cells`, capped at eight) when there
      // are few enough to list; past eight, `resolve.ts` omits the field
      // entirely and this falls to the plain "say the cell" wording, never a
      // silent partial list (unlike the product menu's own `more` flag,
      // there is no natural "first eight" order for every cell on the
      // board).
      if (question.field === "place" && (question as { asPart?: true }).asPart === true) {
        const text = question.text;
        const asPlaceCommand = command as AssignCommand | BookCommand | HeadcountCommand;
        if (suggestions && suggestions.length > 0) {
          return {
            kind: "question",
            message: `${text} is a part; which cell?`,
            candidates: suggestions.map((c) => ({
              key: c.id,
              label: c.label,
              onClick: () => pickPartAsPlace(asPlaceCommand, text, c),
            })),
          };
        }
        return {
          kind: "question",
          message: `${text} is a part; which cell? Say the cell.`,
          candidates: [],
        };
      }
      if (suggestions && suggestions.length > 0) {
        const field = question.field;
        const text = question.text;
        // S60-b: no part was said at all (`resolvePartStep`'s own empty-
        // product branch) -- `question.text` carries the resolved CELL's
        // own name for exactly this shape (there is no misheard word to
        // report), and the message names it directly rather than the
        // generic "No part called ..." wording, which would read oddly for
        // an empty string. `command.product` is read off the SAME command
        // `resolveCommand` was just given (assign/book/headcount, the only
        // three intents `resolvePartStep` ever runs for -- `resolve.ts`'s
        // own comment above it), so this never fires for a genuine
        // near-miss word (non-empty `product`), which keeps the ordinary
        // "Did you mean one of these?" wording below, unchanged.
        if (field === "product" && (command as { product?: string }).product === "") {
          const whichPartBase = `Which part? ${text} makes:`;
          return {
            kind: "question",
            message: more ? `${whichPartBase} … and more — say the part.` : `${whichPartBase} `,
            candidates: suggestions.map((c) => ({
              key: c.id,
              label: c.label,
              onClick: () => pickCandidate(command, field, c, text),
            })),
          };
        }
        const fieldNoun = field === "operator" ? "person" : field === "product" ? "part" : "place";
        return {
          kind: "question",
          message: `No ${fieldNoun} called "${text}" on this board. Did you mean one of these?${moreTail}`,
          candidates: suggestions.map((c) => ({
            key: c.id,
            label: c.label,
            onClick: () => pickCandidate(command, field, c, text),
          })),
        };
      }
      return { kind: "question", message, candidates: [] };
    }
    if (question.kind === "run_exists") {
      // Only ever asked from the assign path (brief §5/§9).
      const assignCommand = command as AssignCommand;
      return {
        kind: "question",
        message,
        candidates: [
          ...question.runs.map((r) => ({
            key: r.id,
            label: r.label,
            onClick: () => pickAttach(assignCommand, { kind: "run", runId: r.id }),
          })),
          {
            key: "__separate_block__",
            label: "Separate block",
            onClick: () => pickAttach(assignCommand, { kind: "direct" }),
          },
        ],
      };
    }
    if (question.kind === "block_exists") {
      const assignCommand = command as AssignCommand;
      const separate = {
        key: "__separate_block__",
        label: "Separate block",
        onClick: () => pickExisting(assignCommand, { kind: "separate" }),
      };
      const ids = question.blocks.map((b) => b.id);
      if (question.same) {
        return withBlockHighlight(
          { kind: "question", message, candidates: [separate] },
          "retime",
          ids,
        );
      }
      return withBlockHighlight(
        {
          kind: "question",
          message,
          candidates: [
            ...question.blocks.map((b) => ({
              key: b.id,
              label: `Change ${b.label}`,
              onClick: () => pickExisting(assignCommand, { kind: "retime", assignmentId: b.id }),
            })),
            separate,
          ],
        },
        "retime",
        ids,
      );
    }
    if (question.kind === "block_gone") {
      const assignCommand = command as AssignCommand;
      return {
        kind: "question",
        message,
        candidates: [
          {
            key: "__new_block__",
            label: "New block",
            onClick: () => pickExisting(assignCommand, { kind: "separate" }),
          },
        ],
      };
    }
    if (question.kind === "job_exists") {
      // Only ever asked from the book path (S41-a).
      const bookCommand = command as BookCommand;
      if (question.same) {
        return { kind: "question", message, candidates: [] };
      }
      const run = question.run;
      return {
        kind: "question",
        message,
        candidates: [
          {
            key: run.id,
            label: `Change ${run.label}`,
            onClick: () => pickExisting(bookCommand, { kind: "retime", runId: run.id }),
          },
        ],
      };
    }
    if (question.kind === "job_in_the_way") {
      return { kind: "question", message, candidates: [] };
    }
    if (question.kind === "job_gone") {
      const bookCommand = command as BookCommand;
      return {
        kind: "question",
        message,
        candidates: [
          {
            key: "__book_it__",
            label: "Book it",
            onClick: () => pickExisting(bookCommand, null),
          },
        ],
      };
    }
    if (question.kind === "remove_which") {
      // Only ever asked from the unassign path (S41-b).
      const unassignCommand = command as UnassignCommand;
      const ids = question.blocks.map((b) => b.id);
      if (question.blocks.length === 1) {
        const only = question.blocks[0];
        return withBlockHighlight(
          {
            kind: "question",
            message,
            candidates: [
              {
                key: only.id,
                label: "Remove it",
                onClick: () =>
                  pickExisting(unassignCommand, { kind: "remove", assignmentId: only.id }),
              },
            ],
          },
          "remove",
          ids,
        );
      }
      return withBlockHighlight(
        {
          kind: "question",
          message,
          candidates: question.blocks.map((b) => ({
            key: b.id,
            label: `Remove ${b.label}`,
            onClick: () => pickExisting(unassignCommand, { kind: "remove", assignmentId: b.id }),
          })),
        },
        "remove",
        ids,
      );
    }
    if (question.kind === "move_which") {
      // Only ever asked from the move path (S41-c). A move on the right
      // cell never asks for exactly one block (it is just taken); S49's
      // elsewhere case does ask for one (the sentence's cell was wrong), so
      // that one candidate reads "Move it", same as remove_which's own
      // one-block label -- `withBlockHighlight` already adds the yes suffix
      // for exactly one candidate.
      const moveCommand = command as MoveCommand;
      return withBlockHighlight(
        {
          kind: "question",
          message,
          candidates: question.blocks.map((b) => ({
            key: b.id,
            label: question.blocks.length === 1 ? "Move it" : `Move ${b.label}`,
            onClick: () => pickExisting(moveCommand, { kind: "move", assignmentId: b.id }),
          })),
        },
        "move",
        question.blocks.map((b) => b.id),
      );
    }
    if (question.kind === "no_block" || question.kind === "block_gone_remove") {
      return { kind: "question", message, candidates: [] };
    }
    return { kind: "question", message, candidates: [] };
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>): void {
    // S51 review fix: a lot writing in the background cannot be typed out
    // from under itself -- while `runningLotRef` is true this is a no-op,
    // and since the input is CONTROLLED (`value={text}` below), React
    // simply redraws the keystroke away rather than committing it, so the
    // input reads unchanged through to the result. `status`/`lotRef` are
    // untouched either way -- "Working…" stands until `runLotNow`'s own
    // `.then()` replaces it.
    if (runningLotRef.current) return;
    setText(e.target.value);
    // Brief §6: "Any edit to the input clears the held command and its
    // attach (a new sentence is a new question)." Clearing the held command
    // clears its `existing` (R-385) the same way it clears `attach`.
    heldRef.current = null;
    // S59 (R-419): a typed edit drops a "Show that day" press's pending
    // rerun too -- the sentence it would have re-run is gone.
    pendingRerunRef.current = null;
    // S44-b: any edit aborts an in-flight reading (brief §3.3) -- the bump
    // discards a response that settles after this point even if abort()
    // itself has no effect on an already-settled fetch. Review finding 1:
    // clear the "Reading…" status too, or it sits on screen (looking like a
    // stuck spinner) until the next Enter or Escape -- a readout/question
    // status is left exactly as it was (the pre-S44-b behaviour).
    if (readingAbortRef.current) {
      readingAbortRef.current.abort();
      readingAbortRef.current = null;
      readingSeqRef.current++;
    }
    // S47 review must-fix: a TYPED edit also clears a standing block
    // question (remove_which/move_which/block_exists) -- its buttons are
    // bound to the OLD command, so leaving them up under unrelated text
    // would keep a stale "Remove it" clickable. This goes through the
    // ordinary `status` state, so the highlight effect clears the outline
    // the same way Escape does.
    //
    // EXCEPT when the new text is itself a confirm/cancel candidate
    // (`isConfirmOrCancelWord` -- the same words `submitText` reads at
    // Enter): typing "yes" is a normal way to answer a standing question
    // (CB-yes-2), so that keystroke must not erase the very question it is
    // about to answer. Which KIND it actually confirms is re-checked at
    // Enter (`confirmsQuestion`) -- this only decides whether to keep the
    // question standing long enough to ask.
    //
    // This handler is the DOM input's own `onChange` -- `onInterim` (S46-a)
    // calls `setText` directly and never reaches here, so a speech result
    // that is still interim (the person may be about to say "yes") leaves a
    // standing question alone regardless, on purpose.
    //
    // S51 (brief §2 item 1): a typed edit drops a standing LOT entirely,
    // same as it drops a single block question -- computed off `status`
    // (this render's own closed-over value, not React's updater `prev`) so
    // clearing the ref never sits inside the `setStatus` updater itself.
    if (
      status?.kind === "question" &&
      status.blockHighlight &&
      !isConfirmOrCancelWord(normalizeWord(e.target.value))
    ) {
      lotRef.current = null;
    }
    setStatus((prev) => {
      if (prev?.kind === "reading") return null;
      if (prev?.kind === "question" && prev.blockHighlight) {
        return isConfirmOrCancelWord(normalizeWord(e.target.value)) ? prev : null;
      }
      return prev;
    });
  }

  /**
   * S46-a: extracted from the Enter branch below (brief §2.2) so a final
   * recognition result submits exactly as Enter does. Behaviour is
   * unchanged from the pre-S46-a Enter path.
   */
  function submitText(
    value: string,
    // S59-e (R-421, brief §3): "typed" for Enter (every pre-S59-e caller),
    // the recogniser's own name for a final transcript (`startListening`'s
    // `onFinal`, below) -- the trace entry's `by`.
    by: "typed" | "browser" | "local" = "typed",
  ): void {
    // S51 review fix: a lot writing in the background cannot be cancelled
    // or re-confirmed out from under itself -- Enter on ANY word (a cancel
    // word, a stray "yes", an ordinary sentence) is a no-op while
    // `runningLotRef` is true, so "Working…" stands until `runLotNow`'s own
    // `.then()` replaces it with the result.
    if (runningLotRef.current) return;
    // S47 / R-395 (brief §2 item 3): a confirm/cancel word is read BEFORE
    // parsing -- ahead of even the model reader below, since "yes" is never
    // a sentence to send there. Two contexts, checked in order:
    //   1. A block question stands (`status.blockHighlight` -- remove_which/
    //      move_which/block_exists): the word acts on IT (its one candidate,
    //      or "Which one?" with several; a cancel clears it) and nothing
    //      else runs -- PROVIDED it actually confirms THIS question's kind
    //      (`confirmsQuestion`, review fix: "remove it" no longer confirms a
    //      move, nor "move it" a removal). A kind-mismatched confirm
    //      CANDIDATE (S50 fix, CB-yes-12: "remove it"/"move it" against the
    //      other kind) is answered IN PLACE -- the question, its buttons and
    //      the outline stand, only the message changes to say which word
    //      this question wants -- and NEVER falls through to be parsed as a
    //      sentence: it is never a sentence, and the old fallthrough only
    //      "worked" as a no-op because the pre-S50 grammar happened to
    //      refuse "remove it"/"move it" outright (no_place); S50 widened the
    //      grammar enough that "remove it" became a valid place-less removal
    //      of an operator literally named "it", which must never run.
    //   2. No question stands at all: a candidate word is offered to
    //      `onConfirmWord`/`onCancelWord` (R-384's pop-up, S47 item 4) --
    //      "none" (or `onCancelWord`'s false) falls through to the ordinary
    //      path below, same as any other word that means nothing here.
    // A word that fits neither -- e.g. a question of some OTHER kind
    // (`ambiguous`, `run_exists`, ...) stands -- also falls through.
    const normalized = normalizeWord(value);
    const isCancel = CANCEL_WORDS.has(normalized);
    // S59 (R-419): a cancel word drops a "Show that day" press's pending
    // rerun, whichever context below actually claims the word (or none does
    // -- the sentence it would have re-run is gone either way).
    if (isCancel) pendingRerunRef.current = null;
    // "remove it"/"move it" are only ever confirm CANDIDATES -- whether they
    // actually confirm depends on the standing question's kind, decided
    // below by `confirmsQuestion`; the five universal words always are.
    const isConfirmCandidate =
      UNIVERSAL_CONFIRM_WORDS.has(normalized) ||
      normalized === "remove it" ||
      normalized === "move it";
    if (isConfirmCandidate || isCancel) {
      // S51 (brief §2 item 2): the LOT's own finished status, checked BEFORE
      // the generic block-question branch below (its `blockHighlight` is a
      // LIST, not one kind -- this is the marker the brief calls for). Only
      // the universal confirm words confirm it; "remove it"/"move it" name
      // one thing, and a lot may hold several of each kind, so they are
      // answered in place instead, same shape as a kind-mismatched single
      // question; a cancel drops the lot exactly as it drops a single one.
      if (status?.kind === "question" && status.lot) {
        if (isCancel) {
          // S59-e (brief §3): a cancel ends the sentence's life -- nothing
          // ran.
          if (traceRef.current) traceRef.current.answered = value;
          finishTrace();
          setStatus(null);
          setText("");
          lotRef.current = null;
          return;
        }
        if (UNIVERSAL_CONFIRM_WORDS.has(normalized)) {
          if (traceRef.current) traceRef.current.answered = value;
          runLotNow();
          return;
        }
        const n = lotRef.current?.done.length ?? status.candidates.length;
        setStatus({
          ...status,
          message: `That is a lot of ${n} commands; say yes to do them all, or no.`,
        });
        return;
      }
      if (
        status?.kind === "question" &&
        status.blockHighlight &&
        !Array.isArray(status.blockHighlight)
      ) {
        if (isConfirmCandidate && confirmsQuestion(normalized, status.blockHighlight.kind)) {
          if (status.candidates.length === 1) {
            // S59-e (brief §3): a spoken/typed confirm word IS the answer --
            // the same field a candidate BUTTON's click sets (see the
            // candidates' own `onClick` wrapper below), set here since this
            // calls the candidate's `onClick` directly rather than through
            // that wrapper.
            if (traceRef.current) traceRef.current.answered = value;
            status.candidates[0].onClick();
          } else {
            // Several candidates: a bare confirm is ambiguous (brief §2
            // item 3) -- ask which one, buttons unchanged, nothing written.
            setStatus({
              ...status,
              message: `Which one? ${status.candidates.map((c) => c.label).join(", ")}`,
            });
          }
          return;
        }
        if (isCancel) {
          if (traceRef.current) traceRef.current.answered = value;
          finishTrace();
          setStatus(null);
          setText("");
          return;
        }
        // S50 fix (CB-yes-12): a confirm CANDIDATE that does NOT match THIS
        // question's kind is answered in place -- the question, its buttons
        // and the outline stand (the status object keeps the same
        // `candidates`/`blockHighlight`; only `message` changes), and it
        // never falls through to be parsed as a sentence (it is never a
        // sentence -- see the comment block above).
        const kind = status.blockHighlight.kind;
        const message =
          kind === "remove"
            ? 'That question is about a removal; say "remove it", yes, or no.'
            : 'That question is about a move; say "move it", yes, or no.';
        setStatus({ ...status, message });
        return;
      } else if (status?.kind !== "question") {
        if (isConfirmCandidate && onConfirmWord) {
          const result = onConfirmWord();
          if (result === "created") {
            setText("");
            return;
          }
          if (result === "needs-decision") {
            setStatus({ kind: "shape", message: "The pop-up needs a decision first." });
            return;
          }
          // "none" -- falls through to the ordinary path below.
        } else if (isCancel && onCancelWord) {
          if (onCancelWord()) {
            setStatus(null);
            setText("");
            return;
          }
        }
      }
      // Neither context claimed it -- ordinary text, falls through below.
    }
    // S59-e (brief §3): a sentence submitted -- starts a fresh trace entry,
    // flushing (posting) whatever was still open from before ("a new
    // sentence" is one of the three life-end triggers). Placed after every
    // confirm/cancel branch above that returns without reaching here: none
    // of those is a NEW sentence, only an answer to (or a cancel of) the
    // one already open.
    startTrace(value, by);
    // Review finding 2: empty/whitespace-only text takes exactly the
    // null-reader path -- no network round trip (and no 20s wait) for a
    // sentence that can only ever fail to parse, and no misleading "not a
    // form" prefix on top of it.
    if (reader && value.trim() !== "") {
      startReading(value, reader);
      return;
    }
    const parsed = parseCommand(value);
    if (!parsed.ok) {
      heldRef.current = null;
      // S59-e (brief §3): "the failure kind" -- see `fallbackToRules`'s own
      // identical comment; the entry stays open, posted once one of the
      // three triggers actually happens.
      if (traceRef.current) traceRef.current.read = parsed.failure.kind;
      setStatus(failureToStatus(parsed.failure));
      return;
    }
    runCommand(parsed.command);
  }

  /** S46-a: ends the current session's generation -- shared by a stopped
   *  session (`stopListening`) and by the session's own `onError`/`onEnd`
   *  -- so any callback still to arrive from THIS session (a late
   *  `onFinal`, or `onEnd` after `onError` already ran) is a no-op (review
   *  findings 1 and 3): `recognitionRef`/`listening` only ever describe a
   *  session whose generation is still current. */
  function endSession(): void {
    recognitionRef.current = null;
    recognitionSeqRef.current++;
    setListening(false);
  }

  /** S46-a: stops the in-flight recognition session, if any -- shared by a
   *  second press of the mic button and by Escape while listening. Text is
   *  kept and the status line is left untouched (brief §2.2). */
  function stopListening(): void {
    recognitionRef.current?.stop();
    endSession();
  }

  /** S46-a: starts a recognition session through `activeRecognizer`.
   *
   * `mySeq` is captured BEFORE `activeRecognizer(...)` is called and every
   * callback below checks it against `recognitionSeqRef.current` before
   * doing anything: `recognizer.ts` can call `onError` synchronously, from
   * inside `start()`'s own try/catch, before this function's call to
   * `activeRecognizer` has even returned a handle (review finding 2) -- that
   * `onError` already bumps the generation via `endSession`, so the
   * unconditional-looking assignment after the call is guarded by the same
   * `isCurrent()` check and never resurrects a session that ended inline. */
  function startListening(activeRecognizer: Recognizer): void {
    // Press when idle aborts any in-flight reading (the S44 path), same as
    // an edit (brief §2.2).
    if (readingAbortRef.current) {
      readingAbortRef.current.abort();
      readingAbortRef.current = null;
      readingSeqRef.current++;
    }
    // S47 / R-395: a standing block question (remove/move/retime) survives a
    // fresh mic press -- the browser's own recogniser ends a session after
    // one final result (`recognizer.ts`'s `continuous = false`), so saying
    // the confirming "yes" out loud takes a SECOND press; that press must
    // not erase the very question the word is about to answer. Anything
    // else (a readout, a shape hint, an ordinary question) still clears, as
    // before S47.
    setStatus((prev) => (prev?.kind === "question" && prev.blockHighlight ? prev : null));
    const mySeq = ++recognitionSeqRef.current;
    function isCurrent(): boolean {
      return recognitionSeqRef.current === mySeq;
    }
    const handle = activeRecognizer({
      onInterim(interimText: string): void {
        if (!isCurrent()) return;
        heldRef.current = null;
        setText(interimText);
      },
      onFinal(finalText: string): void {
        if (!isCurrent()) return;
        setText(finalText);
        // S59-e (brief §3): `by` for the trace entry this starts --
        // `recognizerName`'s own doc explains the "browser" fallback. S60-b:
        // called HERE, not read as a plain value, so a clip that fell back
        // mid-session is traced by what actually ran for THIS clip.
        submitText(finalText, recognizerName?.() ?? "browser");
      },
      onError(kind, detail): void {
        if (!isCurrent()) return;
        endSession();
        if (kind === "not-allowed") {
          setStatus({
            kind: "shape",
            message:
              "The microphone was refused. Allow it in the browser's address bar and try again.",
          });
        } else if (kind === "no-speech") {
          setStatus({ kind: "shape", message: "Nothing was heard." });
        } else {
          setStatus({ kind: "shape", message: `The recogniser stopped: ${detail}.` });
        }
      },
      onEnd(): void {
        if (!isCurrent()) return;
        endSession();
      },
    });
    // The session may already have ended (a synchronous `onError`) during
    // the call above -- do not resurrect it as listening (review finding 2).
    if (!isCurrent()) return;
    recognitionRef.current = handle;
    setListening(true);
  }

  function handleMicClick(): void {
    if (listening) {
      stopListening();
      return;
    }
    if (recognizer) {
      startListening(recognizer);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter") {
      e.preventDefault();
      submitText(text);
      return;
    }
    if (e.key === "Escape") {
      // S59 (R-419): Escape always drops a "Show that day" press's pending
      // rerun, whichever of the branches below actually fires.
      pendingRerunRef.current = null;
      // S51 review fix: a lot writing in the background cannot be
      // cancelled by Escape either -- not even the launcher's own
      // "nothing left, close the panel" signal (`onEscapeIdle`) fires here,
      // since there IS something left: "Working…" stands untouched until
      // `runLotNow`'s own `.then()` replaces it with the result.
      if (runningLotRef.current) return;
      // S44-b: Escape while reading aborts it and clears the status, then
      // the existing Escape rules apply from the NEXT Escape (brief §3.3).
      if (readingAbortRef.current) {
        readingAbortRef.current.abort();
        readingAbortRef.current = null;
        readingSeqRef.current++;
        // S60-b (the S59 reviewer, 15 Sept): Escape on a "Reading…" spinner
        // is one of the trace's own three life-end triggers too (a cancel,
        // same as a typed cancel word gets) -- the entry was left open
        // otherwise, and this line would never be written. `answered`
        // records WHICH cancel this was, same field a confirm/cancel word
        // sets.
        if (traceRef.current) traceRef.current.answered = "escape";
        finishTrace();
        setStatus(null);
        return;
      }
      // S46-a: Escape while listening stops it, text and status untouched,
      // then the existing Escape rules apply from the NEXT Escape (brief
      // §2.2 -- the same shape as the reading branch above).
      if (recognitionRef.current) {
        // S60-b: same trace-closing fix as the reading branch above -- an
        // active listen has not necessarily opened a trace entry yet (no
        // `onFinal` has fired), so this is a no-op then; when it has
        // (interim text already produced a final on a PRIOR press, this one
        // stopping a fresh session), it closes it.
        if (traceRef.current) traceRef.current.answered = "escape";
        finishTrace();
        stopListening();
        return;
      }
      // First Escape clears the status line; a second clears the input.
      // S48-a: a THIRD Escape -- status already clear, input already empty
      // -- has nothing left to do here, so the launcher is told to close
      // the panel instead (`onEscapeIdle`, brief §2 item 2).
      if (status !== null) {
        // S51 (brief §2 item 1): drops a standing lot exactly as it drops a
        // single question.
        lotRef.current = null;
        // S60-b: Escape on a standing question is the third trigger this
        // fixes -- the question's own `asked` was written when it was
        // shown, but nothing ever closed the entry (a pick would have, via
        // `runCommand`'s own readout; Escape never ran that).
        if (traceRef.current) traceRef.current.answered = "escape";
        finishTrace();
        setStatus(null);
      } else if (text !== "") {
        setText("");
        heldRef.current = null;
      } else {
        onEscapeIdle?.();
      }
    }
  }

  return (
    <div className={styles.bar}>
      <div className={styles.row}>
        <label htmlFor="command-bar-input" className={styles.srOnly}>
          Tell the board
        </label>
        <input
          id="command-bar-input"
          ref={inputRef}
          type="text"
          className={`${fieldStyles.field} ${styles.input}`}
          value={text}
          placeholder={PLACEHOLDER}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
        {recognizer && (
          <>
            <button
              type="button"
              className={`${fieldStyles.btn} ${styles.micButton}`}
              aria-label="Speak a sentence"
              aria-pressed={listening}
              title="Uses the browser's speech recogniser; audio is sent to the browser maker's service"
              onClick={handleMicClick}
            >
              <Microphone size={18} filled={listening} />
            </button>
            {listening && <span className={styles.listeningLabel}>Listening…</span>}
          </>
        )}
      </div>
      <p
        className={
          status?.kind === "reading" ? `${styles.statusLine} ${styles.reading}` : styles.statusLine
        }
        aria-live="polite"
      >
        {status?.message ?? ""}
      </p>
      {status?.kind === "question" && status.candidates.length > 0 && (
        <div className={styles.candidates}>
          {status.candidates.map((c) => (
            <button
              key={c.key}
              type="button"
              className={fieldStyles.btn}
              onClick={() => {
                // S59-e (R-421, brief §3): "the answer given (a candidate
                // label ...)" -- one place for EVERY candidate button
                // (ambiguous picks, run_exists, block_exists, remove_which,
                // move_which, job_gone, "Show that day", the lot's own "Do
                // all N", ...), rather than threading this through every
                // `onClick` built in `questionToStatus` above.
                if (traceRef.current) traceRef.current.answered = c.label;
                c.onClick();
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
