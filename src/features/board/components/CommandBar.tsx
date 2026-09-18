import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { DateFormat } from "@/lib/format/dates";
import { isoPlusDays, isoWeekDays } from "@/lib/format/dates";
import { formatDayLabel, zonedTimeToInstant } from "../lib/time";
import fieldStyles from "@/components/Field.module.css";
import styles from "./CommandBar.module.css";
import type { Reader, Reading } from "@/lib/voice/readSentence";
import type { Recognizer, RecognizerHandle } from "@/lib/voice/recognizer";
import type { TraceEntry } from "@/lib/voice/trace";
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
  ResolveOptions,
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
import {
  createConversationStore,
  fileOpenTurn,
  finishTrace as finishTraceIn,
  settleTurn,
  flushTraceOnTeardown,
  postTrace,
  storeRef,
  type CandidateAction,
  type ConversationStore,
  type HistoryTurn,
  type PopupReporter,
  type PopupResult,
  type ResolvedAny,
  type Status,
} from "../store/commandConversation";

export type { Highlight };
/**
 * S51 (R-400, design §19.98/D127): a several's inner commands are always one
 * of the resolver's four SINGLE resolved shapes -- `SeveralCommand.commands`
 * is typed on `SingleCommand` (`parse.ts`'s own invariant: a several is
 * never itself nested inside another), so `resolveCommand` on each of them
 * can only ever return one of these four, never a fifth "several" shape.
 *
 * F-163: declared in `../store/commandConversation.ts` now (the LOT that
 * holds them is that store's state), re-exported here so every existing
 * importer -- `BoardPage`, `useDragGesture`, the tests -- is untouched.
 */
export type {
  ResolvedAny,
  Status,
  /** F-167: declared in the store so `CreatePopover` can take the type
   *  without importing this component; re-exported here because this is
   *  where the writer props that carry it are declared. */
  PopupResult,
  PopupReporter,
} from "../store/commandConversation";

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

/**
 * F-164 (the maintainer's swap, 17 Sept): WHAT THE WRITER ANSWERED.
 *
 * The bar used to record a single's readout under the trace entry's `ran`
 * the instant it handed the resolved command to `onOpen`/`onMove`/`onBook`/
 * `onSetHeadcount` — so the file said "Sam Patel → Housing A · Cell 3 ·
 * 08:00–12:00" ran for a sentence the database never received a row for.
 * Every one of those four props may now answer, synchronously or through a
 * promise, with what actually became of the write:
 *
 *   - `written`   the row is in (or the mutation resolved cleanly);
 *   - `refused`   the server or a client guard said no, with its message;
 *   - `popup`     the write was handed to a pop-up that is now waiting for
 *                 something (a reason, an override, a decision) — nothing is
 *                 written until a person answers it.
 *
 * F-168 (R-421/R-427/R-434): `onRetime`, `onRetimeRun`, `onUnassign` and the
 * retime half of `onMove` were the callers "not yet widened" this doc used to
 * excuse — a refused unassign or retime read as `written` in the trace and
 * the thread while the block stayed on the board, CLAUDE.md §4's own warning
 * in the bar's words. They answer for real now (see `WriteResult` below), so
 * `settleWrite` no longer has a caller left that returns nothing at all —
 * `undefined` is a defect to fix, never a success to assume.
 */
export type WriteOutcome =
  | { kind: "written" }
  | { kind: "refused"; message: string }
  | { kind: "popup"; waitingFor: string };

/** What a writer prop may answer with — nothing, an outcome, or a promise of
 *  one. Still carries `void` for `onOpen`/`onBook`/`onSetHeadcount` (F-164's
 *  own three, plus `onMove`'s move-cell half) — none of those has ever
 *  actually returned it, so the type is wider than the truth on purpose:
 *  narrowing it is a follow-up, not F-168's. */
export type WriteAnswer = void | WriteOutcome | Promise<WriteOutcome | void>;

/**
 * F-168: what `onRetime`, `onRetimeRun`, `onUnassign` and `onMove` must
 * answer with now — `WriteAnswer` minus its `void` member, so a writer that
 * never learned what became of the write (F-168's own four silent ones, a
 * fire-and-forget `.mutate` with a toast on error and nothing returned) no
 * longer type-checks against the prop. A guard that needs no await (DEF-0015's
 * `canPlace` check, an unknown id) still answers synchronously — only
 * answering with NOTHING is closed off.
 */
export type WriteResult = WriteOutcome | Promise<WriteOutcome>;

export interface CommandBarProps {
  /**
   * R-424 (the bar keeps its conversation): nullable, belt and braces.
   * `BoardPage` never has a genuinely EMPTY board to pass once its own
   * `useBoardWindow` fix lands (`placeholderData: keepPreviousData` keeps
   * the last window's `ctx` alive across a refetch), but this file does not
   * get to assume its caller never regresses that -- a `ctx` that goes
   * `null` and comes back must never crash a resolve/expand call that lands
   * in the gap, and must never lose the status, the pending question, the
   * lot or the open trace entry this component is already holding (those
   * all live in plain `useState`/refs, untouched by a prop changing) --
   * every functional use below reads `lastCtxRef.current` instead, which
   * only ever moves forward to a real `ResolveContext`.
   */
  ctx: ResolveContext | null;
  dateFormat: DateFormat;
  /** `index.zone` — D88a: the plant's own zone, never optional in spirit. */
  zone: string;
  onOpen: (
    resolved: ResolvedCommand,
    anchor: { x: number; y: number },
    /** F-167: the pop-up's own way back. A caller that opens no
     *  pop-up ignores it. */
    report: PopupReporter,
  ) => WriteAnswer;
  /** R-385: the resolved target is `retime` — the caller re-times the block
   *  through the drag's own path; nothing is created.
   *  F-168: answers `WriteResult` — never `void` — so a refused re-time (an
   *  RLS-filtered PATCH, a race) is a `refused` outcome, never a `Written`
   *  line for a block that never moved. */
  onRetime: (
    resolved: ResolvedCommand,
    anchor: { x: number; y: number },
    /** F-167: the pop-up's own way back. A caller that opens no
     *  pop-up ignores it. */
    report: PopupReporter,
  ) => WriteResult;
  /** S41-a: a "book a job" sentence resolved to a brand-new job — the caller
   *  opens `CreatePopover` in run mode, preset, through `submitCreateRun`. */
  onBook: (
    resolved: ResolvedBook,
    anchor: { x: number; y: number },
    /** F-167: the pop-up's own way back. A caller that opens no
     *  pop-up ignores it. */
    report: PopupReporter,
  ) => WriteAnswer;
  /** S41-a / R-387: the resolved target is `retime_run` — the caller
   *  re-times the job through the drag's own re-time path; nothing is
   *  created.
   *  F-168: answers `WriteResult` — see `onRetime`'s own note. */
  onRetimeRun: (
    resolved: ResolvedBook,
    anchor: { x: number; y: number },
    /** F-167: the pop-up's own way back. A caller that opens no
     *  pop-up ignores it. */
    report: PopupReporter,
  ) => WriteResult;
  /** S41-b / R-388: an "unassign" sentence resolved to the one block it
   *  names — the caller removes it through the SAME `dragApi.removeAssignment`
   *  the block's own Delete button calls. Nothing is created or re-timed.
   *  F-168: answers `WriteResult` — see `onRetime`'s own note; an
   *  RLS-filtered delete removes zero rows and must read as `refused`, never
   *  `written`, the exact CLAUDE.md §4 shape F-168 is named for. */
  onUnassign: (
    resolved: ResolvedUnassign,
    anchor: { x: number; y: number },
    /** F-167: the pop-up's own way back. A caller that opens no
     *  pop-up ignores it. */
    report: PopupReporter,
  ) => WriteResult;
  /** S41-c / R-389: a "move" sentence resolved to the one block it names --
   *  called for BOTH targets (`retime` and `move_cell`); the caller
   *  dispatches on `resolved.target.kind`. Nothing is created here either:
   *  a `retime` re-times through the drag's own path, a `move_cell` opens
   *  the create pop-up preset under `presetMove`.
   *  F-168: answers `WriteResult` on BOTH branches now — the `move_cell`
   *  half already reported through `openMoveFromCommand` (F-167); the
   *  `retime` half was F-168's own silent one and now reports through
   *  `retimeAssignmentFromCommand` the same way `onRetime` does. */
  onMove: (
    resolved: ResolvedMove,
    anchor: { x: number; y: number },
    /** F-167: the pop-up's own way back. A caller that opens no
     *  pop-up ignores it. */
    report: PopupReporter,
  ) => WriteResult;
  /**
   * S58 / R-415 (D132 item 4): a "job's headcount" sentence resolved to one
   * existing run and one existing write -- the caller commits it through the
   * SAME field-edit mutation the job panel's own headcount field uses (no
   * second door), then the bar shows the readout `resolveHeadcountCommand`
   * already wrote. Never part of a lot (`ResolvedHeadcount` is not a member
   * of `ResolvedAny` below -- a headcount can never reach `onRunLot`).
   */
  onSetHeadcount: (
    resolved: ResolvedHeadcount,
    anchor: { x: number; y: number },
    /** F-167: the pop-up's own way back. A caller that opens no
     *  pop-up ignores it. */
    report: PopupReporter,
  ) => WriteAnswer;
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
  /**
   * F-163 (S62-b): the conversation this bar is showing — the store that
   * holds the status, the held command, the pending question, the lot, the
   * pending rerun, the open trace entry and the input's own text
   * (`../store/commandConversation.ts`).
   *
   * `CommandLauncher` creates ONE per board mount and passes it here, so
   * closing the panel (an outside mousedown, Escape) unmounts this component
   * without losing anything and reopening shows exactly what stood.
   *
   * Omitted, this component makes its OWN store and keeps it for as long as
   * it is mounted — byte for byte the pre-F-163 behaviour, including the
   * unmount flush of an open trace entry (F-157/CB-t-14): a bar that owns its
   * conversation really does end it when it goes away. A bar handed one does
   * NOT flush on unmount; its owner (the launcher) does.
   */
  conversation?: ConversationStore;
}

/** S47 review fix: see `onConfirmWord`'s own doc above for what each value
 *  means. `PopoverConfirmHandle.submitIfClean()` (`CreatePopover.tsx`)
 *  returns the same three strings -- structurally, not by a shared import,
 *  since the bar imports nothing from the popover (brief §2: "no second
 *  door"). */
export type ConfirmWordResult = "created" | "needs-decision" | "none";

const PLACEHOLDER = "Assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2";

/** S63-a review fix (the maintainer): the empty-thread hint (CP-6) -- one
 *  constant so the JSX below and `commandBar.test.tsx`'s own pin never drift
 *  apart (CLAUDE.md §4). Not a `Status`, not a `HistoryTurn`: it is never
 *  set into the store and never reaches the trace file. */
const EMPTY_THREAD_HINT =
  "Tell the board what to do. For example: clear Cell 1 today, or assign Sam Patel to Cell 1 from 8 to 12.";

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
 *  mixing the two up here would silently check the wrong seven days).
 *
 *  F-153: unlike `renderReadout` below (fixed to build its instant through
 *  `zonedTimeToInstant`), this one is SAFE left exactly as it was --
 *  `getUTCDay`/`setUTCDate`/`toISOString` are used throughout, never a
 *  zone-aware formatter, so it never reads any real zone's wall clock; a
 *  calendar day's weekday and the seven ISOs of its week are the same in
 *  every zone, so pinning the arithmetic to UTC changes nothing it returns.
 *  It only ever produces ISO STRINGS, compared against other ISO strings
 *  (`isTargetOnBoard`'s own `have.has(iso)`), never formatted through
 *  `formatDayLabel`/`Intl` in a zone -- never `ctx`'s own day axis
 *  (`wallToOffset`/`wallOf`), which stays untouched either way.
 *
 *  R-426 (S62-a): the arithmetic itself now lives in `@/lib/format/dates`
 *  (`isoWeekDays`), which is where the F-153 reasoning above is written down
 *  once for every caller. This wrapper is kept only for the name the rest of
 *  this file reads by. */
function isoWeekOf(iso: string): string[] {
  return isoWeekDays(iso);
}

/**
 * F-158: the week each WEEK WORD names, as a shift in days from the week
 * `today` falls in -- the same three words, anchored the same way, as
 * `BoardPage`'s own `SHOW_DAY_WEEK_WORD_OFFSETS` (that map decides where the
 * window MOVES; this one decides when the held sentence may re-run, and the
 * two disagreeing would leave a sentence pending for ever on a board that
 * already shows its week).
 *
 * A repeat day's `day_off_board` now names one of these rather than an ISO
 * (`resolve.ts`'s own `OffBoardNaming`), so without this case
 * `isTargetOnBoard` fell through to its final `return false` and the rerun
 * NEVER fired: the button widened the board and the sentence was never asked
 * again.
 */
const SHOW_DAY_WEEK_WORD_SHIFT: Record<string, number> = {
  "this week": 0,
  "next week": 7,
  "last week": -7,
};

/** `iso` plus `days` -- the seam's calendar arithmetic (R-426), kept under its
 *  local name because the reasoning `isoWeekOf`'s F-153 note sets out is what
 *  makes it safe HERE: this only ever compares ISO strings against other ISO
 *  strings, never a zone's wall clock. */
const isoPlusDaysUtc = isoPlusDays;

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
  // F-158: a week WORD -- all seven of that week's days, anchored on the
  // week `today` falls in, exactly as the window move anchors it.
  const weekShift = SHOW_DAY_WEEK_WORD_SHIFT[target];
  if (weekShift !== undefined) {
    if (ctx.todayIndex === null) return false;
    const todayIso = ctx.days.find((d) => d.index === ctx.todayIndex)?.iso;
    if (todayIso === undefined) return false;
    const have = new Set(ctx.days.map((d) => d.iso));
    return isoWeekOf(todayIso)
      .map((iso) => isoPlusDaysUtc(iso, weekShift))
      .every((iso) => have.has(iso));
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

/**
 * R-427: a finished turn's last line -- what actually became of it, in the
 * three words the writers answer in (F-164's `outcome`).
 *
 * "Waiting" is a third label beyond the two the maintainer named, and it is
 * there because "Refused" would be a lie about the commonest case: a sentence
 * that opened the create pop-up is neither written nor refused, it is handed
 * over — which is exactly the state F-165 was hiding. An empty string means
 * nothing was ever attempted (a question still standing when the sentence
 * ended, a cancel, a sentence the bar could not read); the "Board:" line
 * above already says what happened.
 */
function turnResultLine(turn: HistoryTurn): string {
  const outcome = turn.outcome;
  // CP-7 (session 178): a LOT's last word is its own sentence -- "Done: N
  // commands." or "Did k of N; the next failed: … The k done stayed: …" --
  // and it is the thread's result line, the readouts that landed after it.
  // Before this, `ran` won and a lot that stopped at step two read
  // "Written: <step one>" with nothing saying why it stopped (F-154's
  // lesson, lost again on the way from the live line to the thread).
  if (outcome !== null && (outcome.startsWith("Done: ") || outcome.startsWith("Did "))) {
    return turn.ran.length > 0 ? `${outcome} Written: ${turn.ran.join("; ")}` : outcome;
  }
  if (turn.ran.length > 0) return `Written: ${turn.ran.join("; ")}`;
  if (outcome === null) return "";
  if (outcome.startsWith("popup: ")) return `Waiting: ${outcome.slice("popup: ".length)}`;
  if (outcome.startsWith("refused: ")) {
    const message = outcome.slice("refused: ".length);
    // WR-2 (reviewer, S64-c review): `nothing_to_do`'s own outcome
    // (`questionToStatus`) is the readout's RENDERED text verbatim, which
    // `traceQuestionStatus`'s "readout" branch has ALREADY put in `asked`
    // -- the bubble drawn just above this one. Rendering it again here,
    // now mislabelled "Refused:" for a sentence nothing ever refused (an
    // informational readout, not a write attempt), said the exact same
    // sentence twice in one turn -- the "turn drawn once" screenshot
    // finding (docs/plan.yaml session 177 summary) in a new shape.
    // Suppressed only when the two are the identical string: a genuine
    // refusal's message (CB-w-1..4, an RLS reason or a resize guard) is
    // never equal to the question that stood before it, so this never
    // hides a real one. The FILED entry still carries the full
    // `refused: <message>` outcome (R-434's own "never null" requirement,
    // and `bar.jsonl`'s record of what happened) -- only the rendered
    // SECOND bubble is what disappears.
    if (turn.asked !== null && message === turn.asked) return "";
    return `Refused: ${message}`;
  }
  // F-167: the pop-up was closed without writing -- neither done nor refused.
  if (outcome === "cancelled") return "Cancelled";
  return `Refused: ${outcome}`;
}

/**
 * F-162 (the maintainer, 17 Sept, two screenshots): THE ANSWER BOX.
 *
 * "Tom Baker is not certified for Cell 1: missing Welding. Say the reason to
 * schedule anyway, or no." -- above an input still holding the sentence. To
 * type the answer the person had to clear the sentence, and clearing the
 * sentence is what the bar read as abandoning it; the trace shows that
 * sentence typed three times with no answer ever recorded.
 *
 * So while a question STANDS the input is an ANSWER box, not the sentence
 * box: it is emptied, its placeholder says what the question takes, and the
 * sentence itself stays readable above (`sentence`, kept in the conversation
 * store). This function is the ONE place that decides both -- `null` means
 * "this status is not something to answer in the box", and the input keeps
 * the sentence exactly as it did before F-162.
 *
 * What is NOT an answer box, on purpose:
 *   - a `shape` hint ("Say it like: ..."), a `readout`, a `reading` -- there
 *     is nothing to answer; the sentence has to be EDITED, so it stays;
 *   - a question with no candidates and no reason to give ("No shift on Cell
 *     3 covers 09:00.", "There is no Housing A job on Cell 1 today; book it
 *     first, or say the hours.") -- same: those are answered by fixing the
 *     sentence;
 *   - a `day_off_board` question, whose only button is "Show that day" --
 *     pressing it re-runs the sentence, and a person may want to edit the day
 *     instead.
 * The one `shape` that IS a question is `which_job` ("make it 4 people" with
 * no job named): the bar keeps no memory of "it", so the whole sentence has
 * to be said again and emptying the box is the help, not the harm.
 */
function answerTakes(status: Status | null): string | null {
  if (status === null) return null;
  if (status.kind === "shape") {
    return status.message.startsWith("Say which job") ? "the job's name" : null;
  }
  if (status.kind !== "question") return null;
  // R-425 / F-165: the two free-TEXT questions. "yes" is refused on both (the
  // question wants a reason), so the placeholder never offers it.
  if (status.awaitingOverrideReason || status.awaitingAreaReason) return "the reason, or no";
  if (status.lot) return "yes or no";
  if (status.candidates.length === 0) return null;
  if (status.candidates.every((c) => c.action.kind === "show_day")) return null;
  // S62-b reviewer fix (A): ONLY A YES-SHAPED QUESTION OFFERS "yes".
  // `withBlockHighlight` appends the yes suffix to exactly one shape -- a
  // block question (remove_which / move_which / block_exists) with exactly
  // one candidate -- and that is the only single-button question a bare
  // "yes" actually answers. `run_exists` ("Join it, or make a separate
  // block?"), `ambiguous` ("Which person?"), `job_gone`, `block_gone` all
  // take a NAME; offering "yes" there invited a word the question refuses.
  const yesShaped =
    status.blockHighlight !== undefined &&
    !Array.isArray(status.blockHighlight) &&
    status.candidates.length === 1;
  // "or no" on every one of them: a cancel word now drops any standing
  // question (see `submitText`'s own floor), so it is always a true answer.
  return yesShaped ? "yes or no" : "a name, or no";
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

/**
 * S63-a (R-434, brief §5): THE REFUSAL THAT BORROWS THE DRAG'S WORDS.
 *
 * A capacity refusal reaches the bar as `useSchedulerToast.ts`'s own
 * `CapacityExceeded` message -- accurate for the DRAG, which really can
 * "try the split again" (D61's proactive probe already offers one), but the
 * bar has no split to retry: a sentence that runs into the same cap can only
 * be re-typed. Matched on the message's SHAPE (name, peak, cap), not on the
 * whole string, so a later wording change to the toast that keeps the same
 * numbers is still caught, and every OTHER writer message (`NotEligible`,
 * `RunOverlap`, an ordinary server refusal, ...) passes through untouched --
 * this is the one shape the bar itself has an opinion about.
 */
const CAP_REFUSAL =
  /^(.+) would reach (\d+)% \(cap (\d+)%\)\. Someone else changed their load — try the split again\.$/;

function rewriteCapRefusal(message: string): string {
  const m = CAP_REFUSAL.exec(message);
  if (!m) return message;
  const [, name, peak, cap] = m;
  return `${name} would be over the cap today (${peak}% of ${cap}%). Nothing changed.`;
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
  conversation,
}: CommandBarProps) {
  // F-163: the conversation is the store's, not this component's. A bar
  // handed one by the launcher keeps it across every open/close; one without
  // makes its own and owns it for its whole mount (see `conversation`'s own
  // doc above). `useState`'s initialiser form, never `createConversationStore()`
  // inline -- a fresh store on every render would be a new conversation on
  // every keystroke.
  const [ownStore] = useState(createConversationStore);
  const ownsStore = conversation === undefined;
  const store = conversation ?? ownStore;
  // One selector per field, never one returning a fresh object: zustand v5
  // compares snapshots with `Object.is`, so a selector that builds `{ text,
  // status }` every call re-renders for ever.
  const text = useStore(store, (s) => s.text);
  const status = useStore(store, (s) => s.status);
  const sentence = useStore(store, (s) => s.sentence);
  const setText = (next: string): void => store.getState().setText(next);
  const setStatus = (next: Status | null | ((prev: Status | null) => Status | null)): void =>
    store.getState().setStatus(next);
  const history = useStore(store, (s) => s.history);
  // S63-a review fix (the maintainer, looking at the panel): A FINISHED TURN
  // READS ONCE, NOT TWICE. `sentence`/`status` used to keep showing a
  // completed turn's own bubbles right below the thread even after
  // `finishTrace` had already filed the exact same turn into `history` --
  // "assign Sam Patel to Cell 1 from 8 to 12" appeared as a written turn in
  // the thread AND again as the live "You said" + readout underneath it.
  // Fixed at the source now (`commandConversation.ts`'s own `fileTurn`
  // clears `sentence`/`status` back to `null` the moment a turn is actually
  // filed), so this component reads them exactly as before -- there is
  // nothing "live" left to gate here once a turn is filed, because the
  // store itself no longer holds it.
  const [listening, setListening] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // R-427: the thread scrolls to the bottom -- the newest turn (or the live
  // one still open, S63-a) is the one being talked about, and the input sits
  // directly under it now.
  const threadRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, sentence, status]);
  // The last parsed command, kept so a candidate button can substitute one
  // field and so a run/job-question button can set `attach`/`existing`
  // without retyping the sentence (brief §6). Any edit to the input
  // invalidates it. S41-a widens this from `AssignCommand` to `Command`
  // (the union also holding `BookCommand`) since the bar now parses both.
  // F-163: every one of these used to be a `useRef` -- which is exactly why
  // closing the launcher's panel emptied the bar. They are now views onto the
  // conversation store (`storeRef`), so `heldRef.current = x` reads and writes
  // the same way it always did at every call site below while the value itself
  // outlives this component.
  const heldRef = storeRef(store, "held");
  /** F-165: the reasons already given for `heldRef.current`, accumulated
   *  across re-resolves so an answered certificate question is not asked
   *  again when an area question follows it. */
  const heldOptionsRef = storeRef(store, "heldOptions");
  // S51 (R-400/D127): the lot a `several` sentence is being walked through --
  // `commands` in the sentence's order, `index` the one being resolved right
  // now, `done` the resolutions gathered so far. `null` whenever no several
  // is standing (every pre-S51 path, and the ordinary end of a lot: a typed
  // edit, a cancel word, or Escape drops it back to `null`, same as a single
  // question). A ref, not state, for the same reason `heldRef` is one: it is
  // read and written from event handlers, never rendered directly -- what IS
  // rendered is always the derived `Status` those handlers build from it.
  const lotRef = storeRef(store, "lot");
  // S51 review fix (small 2): true while `onRunLot` is in flight for the
  // CURRENT lot -- `runLotNow`'s own early-return guard, so a second "yes"
  // can never start a second run over the same lot. Also read by
  // `submitText`/`handleChange`/Escape below: a lot writing in the
  // background cannot be cancelled or typed out from under itself, so all
  // three leave the "Working…" status exactly as it is while this is true.
  const runningLotRef = storeRef(store, "runningLot");
  // S51 review fix: bumped by every `runLotNow` call, compared on resolve --
  // the same shape as `readingSeqRef`/`recognitionSeqRef` below, so a run
  // that somehow settles after a newer one has started (never possible
  // today, since `runningLotRef` above already refuses a second run to
  // START -- kept anyway, belt and braces, exactly as those two refs are)
  // is discarded rather than clobbering whatever the bar is doing by then.
  const lotRunSeqRef = storeRef(store, "lotRunSeq");
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
  const pendingRerunRef = storeRef(store, "pendingRerun");
  // S44-b: the in-flight reading's own abort controller (null when nothing
  // is pending) and a sequence number bumped by every Enter, Escape and edit
  // so a reading that settles after a newer one has started is discarded
  // rather than clobbering whatever the bar is doing by then.
  const readingAbortRef = storeRef(store, "readingAbort");
  const readingSeqRef = storeRef(store, "readingSeq");
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
  const traceRef = storeRef(store, "trace");
  // R-424: the last real (non-null) `ctx` this component has ever seen --
  // initialised from whatever `ctx` the FIRST render carried (every real
  // caller's contract: `ctx` is only ever null before the board has EVER
  // loaded, which is also when this component is not mounted at all), kept
  // current by the effect below the moment a fresh non-null `ctx` arrives.
  // Every place that used to read the `ctx` prop directly to resolve or
  // expand a command reads `lastCtxRef.current` instead, so a `ctx` that
  // goes `null` and comes back (a refetch gap `BoardPage` should no longer
  // produce, but this file does not get to assume that) never crashes and
  // never loses track of the board it was last actually shown.
  const lastCtxRef = useRef<ResolveContext | null>(ctx);

  /** S59-e (R-421): the sentence's life ends here -- posts whatever the
   *  entry holds and clears it. F-163 moved the post itself into the
   *  conversation store (`commandConversation.ts`), so an entry can outlive
   *  this component exactly as the rest of the conversation now does; this
   *  wrapper keeps the name every call site below already reads by.
   *
   *  S63-a review fix (CP-5): the moment a turn is actually FILED (never
   *  just "ended" -- `fileOpenTurn`'s own "Waiting: …" hand-off ends nothing
   *  and must keep showing) is `commandConversation.ts`'s own `fileTurn`,
   *  which is where `sentence`/`status` are cleared back to idle now, so
   *  every path that reaches it (this wrapper, `settleTurn`, a popup's
   *  reporter) gets the fix once, not re-implemented per caller. */
  function finishTrace(): void {
    finishTraceIn(store);
  }

  /** S59-e: starts a fresh entry for `heard`/`by` -- flushes (posts) any
   *  entry still open first, since starting one IS "a new sentence" ending
   *  the previous one's life (R-421). `model` defaults to "no reader",
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
      // F-164: filled in by `settleWrite`/`runLotNow` once a writer has
      // actually answered; `null` means nothing was ever attempted.
      outcome: null,
    };
    // R-427: a new sentence offers nothing yet.
    store.getState().set({ offered: [] });
  }

  /**
   * R-434 item 3 (F-168/F-169's own audit, list A item 2): files a turn for a
   * sentence that never got an open trace entry of its own AND must NOT touch
   * whatever the bar is showing right now -- unlike `startTrace`/`finishTrace`
   * (which flush and then replace `traceRef.current`/`sentence`/`status`, the
   * ordinary "a new sentence ends the old one's life" rule), this never reads
   * or writes any of those three. The one caller today is `submitText`'s own
   * no-op while a lot is writing: "Working…" must keep standing (the
   * maintainer's own word for it) exactly as it is, so the dropped sentence
   * still gets a bubble and a result line in the thread, filed independently,
   * rather than fighting the live lot for the same `status`.
   */
  function fileStandaloneTurn(
    heard: string,
    by: "typed" | "browser" | "local",
    outcome: string,
  ): void {
    const entry: TraceEntry = {
      at: new Date().toISOString(),
      heard,
      by,
      model: { skipped: "no reader" },
      read: "",
      asked: null,
      answered: null,
      ran: [],
      outcome,
    };
    store.getState().appendTurn({
      at: entry.at,
      heard: entry.heard,
      by: entry.by,
      read: entry.read,
      asked: entry.asked,
      offered: [],
      answered: entry.answered,
      ran: entry.ran,
      outcome: entry.outcome,
    });
    postTrace(entry);
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

  /**
   * F-157 (R-421 brief §3, "an entry still open ... is flushed"): a
   * sentence's trace entry can be left open when the bar unmounts (R-424:
   * rarer now that `BoardPage` no longer unmounts it for a refetch, but the
   * launcher still unmounts it deliberately when the panel closes), when the
   * page is hidden (`visibilitychange` -- backgrounding a tab, or a tab
   * closing, which fires this before it actually goes away in every browser
   * that matters here), or when the tab closes outright. All three read
   * `traceRef.current` at the moment they fire and post it through
   * `postTraceOnTeardown` (sendBeacon, falling back to a keepalive fetch)
   * rather than `postTrace`'s ordinary fire-and-forget `fetch`, which is not
   * guaranteed to complete once the document is going away.
   */
  useEffect(() => {
    function flushOnHide(): void {
      if (document.visibilityState !== "hidden") return;
      flushTraceOnTeardown(store);
    }
    document.addEventListener("visibilitychange", flushOnHide);
    return () => {
      document.removeEventListener("visibilitychange", flushOnHide);
      // F-163: ONLY a bar that owns its own conversation flushes here. When
      // the launcher owns it, this unmount is the panel closing -- the
      // sentence is not over, the person is looking at the board, and the
      // entry must still be open when they reopen the panel. The launcher
      // flushes it on ITS unmount (the board going away), which is the
      // moment F-157 was actually about.
      if (ownsStore) flushTraceOnTeardown(store);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /**
   * R-427: WHAT WAS ON OFFER. The maintainer asked the thread to show "what
   * options were provided and what was chosen", and the trace entry has never
   * carried the first half -- `asked` is the question's sentence, not its
   * buttons. One effect, for the same reason the highlight and answer-box
   * effects are one each rather than a line at every `setStatus` call site.
   * Only a question with buttons writes: a question REPLACED by a
   * button-less one ("Say the reason, not yes.") must not erase what the
   * person was actually offered.
   */
  useEffect(() => {
    if (status?.kind === "question" && status.candidates.length > 0) {
      store.getState().set({ offered: status.candidates.map((c) => c.label) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // F-162's own answer-box effect (S61-a..S62-b) lived here: it emptied the
  // box and remembered the sentence keyed on `status` alone, the moment a
  // question that TAKES an answer started standing. R-437 (S63-a, the
  // maintainer) replaced it -- Enter now empties the box and sets `sentence`
  // ITSELF, at the exact points `submitText` (and its one reason-answering
  // fall-through) treats `value` as something to run, rather than waiting
  // for the resulting `status` to say whether an answer box is needed. See
  // `submitText`'s own comment where it now does this: `sentence` is set
  // ONCE per sentence and never cleared back to `null` again by anything in
  // this file, so a written single's own bubble reads exactly like an
  // unreadable one's (CB-ent-1/CB-ent-2) and a question's still reads like it
  // always did (CB-ans-1..4, unchanged) -- there is no separate "answer box"
  // moment left for an effect to catch.

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
    // R-424: remember the last real ctx BEFORE anything below reads it, so
    // a ctx that goes null and comes back never leaves `lastCtxRef` a render
    // stale. A null ctx here is a no-op for the rerun check below (nothing
    // to compare `isTargetOnBoard` against yet) -- `pendingRerunRef` simply
    // stays standing until a ctx that actually carries the target arrives.
    if (ctx !== null) lastCtxRef.current = ctx;
    if (ctx !== null && pendingRerunRef.current && isTargetOnBoard(pendingRerunRef.current, ctx)) {
      const command = pendingRerunRef.current.command;
      pendingRerunRef.current = null;
      runCommand(command);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  /**
   * F-153: this used to build `new Date(iso + "T00:00:00Z")` and format
   * THAT in `zone` -- a UTC-midnight instant read back in America/Chicago is
   * 19:00 the evening before, so every ISO day this bar ever printed to a
   * plant west of UTC came out a day early (the swap's own "4 commands
   * ready" listing said "Tue Sep 15" for four blocks whose own readouts,
   * once written, said 2026-09-16). `iso` names a CALENDAR day already
   * understood in the plant's own zone (`ctx.days`' own contract, same as
   * every other ISO token this file touches) -- the fix is to build the
   * INSTANT that reads back as midnight of THAT day IN `zone`
   * (`zonedTimeToInstant`, the same seam `time.ts`'s own `startOfDay` is
   * built on) rather than pin it to UTC and hope the zone is UTC too.
   */
  function renderReadout(readout: string): string {
    return readout.replace(ISO_DAY, (iso) => {
      const [yyyy, mm, dd] = iso.split("-").map(Number);
      return formatDayLabel(zonedTimeToInstant(zone, yyyy, mm, dd, 0, 0), dateFormat, zone);
    });
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
   *  `setStatus` that already shows it.
   *
   *  F-157 review (item 4/item 5): widened two ways.
   *   - `"shape"` (a parse failure's own "Say it like…"/`bad_time`/etc.
   *     hint) now sets `asked` exactly like a `"question"` does -- the
   *     original bug: the two "make Cell 3 4 people" lines in the
   *     maintainer's trace showed `read: "no_time"` and `asked: null` even
   *     though the bar plainly printed that hint on screen. Every caller
   *     that builds one of these (`submitText`/`fallbackToRules`/
   *     `pickCandidate`/`pickPartAsPlace`'s own re-parse branches) now
   *     passes it through here too.
   *   - `"readout"` only FILLS IN `asked`/`answered` when both are still
   *     `null` -- item 5's own finding: an ordinary single (no question, no
   *     candidate, no lot) runs straight off its own readout with no
   *     separate yes at all, so `asked` becomes that readout text and
   *     `answered` becomes the literal string `"auto"` (there was no word
   *     or button to record). A single that DID raise a real question first
   *     (CB-t-3's own case: a candidate button already set `answered` to
   *     its label, and this function already set `asked` to the question's
   *     own text) keeps that truer pair -- the readout that follows is
   *     what RAN, already captured in `ran`, not a second "question". */
  function traceQuestionStatus(status: Status): void {
    if (!traceRef.current) return;
    if (status.kind === "question" || status.kind === "shape") {
      traceRef.current.asked = status.message;
    } else if (status.kind === "readout") {
      if (traceRef.current.asked === null) traceRef.current.asked = status.message;
      if (traceRef.current.answered === null) traceRef.current.answered = "auto";
      finishTrace();
    }
  }

  /**
   * S61-a (R-425, F-155): `options`, when given, is `resolveCommand`'s own
   * third argument -- read only by an assign/move re-resolve after the bar
   * collected a `not_certified` "warn" question's override reason
   * (`submitText`'s own `awaitingOverrideReason` branch). Every other call
   * site omits it, byte-identical to before this parameter existed.
   */
  /**
   * F-167: the reporter handed to a writer prop for ONE sentence. Fires at
   * most once (a pop-up that both submits and then closes must not report
   * twice), fills in the entry it belongs to -- captured here, never
   * `traceRef.current` at the time it lands, which by then may be a different
   * sentence -- and ends that entry.
   *
   * A `written` result fills `ran` with the pop-up's own readout when it has
   * one, falling back to the readout the bar printed; `refused` and
   * `cancelled` leave `ran` empty, which is the truth.
   */
  function popupReporterFor(entry: TraceEntry | null, readout: string): PopupReporter {
    let fired = false;
    return (result: PopupResult): void => {
      if (fired) return;
      // S62-b reviewer fix (C): `handed_off` is a NOTE, not an answer -- the
      // write moved to another pop-up, which reports the real result through
      // this same reporter. So it neither closes the latch nor ends the
      // entry; it only changes what the thread says the sentence is waiting
      // on (before this, a split-coverage hand-off said "Waiting: the create
      // pop-up" for ever).
      if (result.kind === "handed_off") {
        if (entry) entry.outcome = `popup: ${result.what}`;
        fileOpenTurn(store);
        return;
      }
      fired = true;
      if (entry) {
        if (result.kind === "written") {
          entry.ran.push(result.readout ?? readout);
          entry.outcome = "written";
        } else if (result.kind === "refused") {
          entry.outcome = `refused: ${rewriteCapRefusal(result.message)}`;
        } else {
          entry.outcome = "cancelled";
        }
      }
      if (entry) settleTurn(store, entry);
    };
  }

  /**
   * S62-b re-check fix (1): THE ONE CANCEL.
   *
   * A cancel word is the only thing that ends a standing question without
   * answering it, and there were four places doing it -- the lot's question,
   * a block question, the override/area reason question, and F-166's own
   * floor -- three of which called `setStatus(null)` and left the status line
   * blank. A blank line is indistinguishable from a bar that did not hear the
   * word at all, which on a screen where the input has just been cleared is
   * exactly the wrong thing to be unsure about. Every cancel says the same
   * two words now, and every cancel drops the same things: the question, the
   * held command, the reasons already given for it, and any lot behind it.
   *
   * `value` is the word as said or typed -- recorded as the entry's `answered`
   * before the entry is posted, the same field a candidate button sets.
   *
   * S63-a review fix (CP-5): "Left it." is set on `status` AFTER the entry
   * is filed (below), so the live area (gated on `hasOpenTrace`) never shows
   * it -- the same instant it would appear, the turn is already filed and
   * the live bubbles stop rendering. Silence there would be exactly the bug
   * F-166 fixed (a cancel indistinguishable from one never heard), so the
   * entry's own `outcome` is set to `"cancelled"` BEFORE `finishTrace`,
   * which `turnResultLine` already renders as "Cancelled" (the same word a
   * pop-up's own cancel uses) -- the thread is where it reads now, not the
   * live line.
   */
  function cancelStanding(value: string): void {
    if (traceRef.current) {
      traceRef.current.answered = value;
      traceRef.current.outcome = "cancelled";
    }
    finishTrace();
    setStatus({ kind: "shape", message: "Left it." });
    setText("");
    heldRef.current = null;
    heldOptionsRef.current = {};
    lotRef.current = null;
  }

  /** F-164: true for anything a writer prop answered with that has to be
   *  waited on. Deliberately structural (a `.then`), not `instanceof Promise`
   *  -- a caller may hand back any thenable. */
  function isThenable(value: unknown): value is PromiseLike<WriteOutcome | void> {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { then?: unknown }).then === "function"
    );
  }

  /**
   * F-164 (the maintainer's swap, 17 Sept): THE SINGLE'S LAST WORD.
   *
   * `ran` used to be written the instant the bar called the writer, so a
   * sentence whose write never landed read in `bar.jsonl` exactly like one
   * that did. It is written HERE instead, only for an answer that actually
   * says `written` -- a `refused` or a `popup` records what happened under
   * `outcome` and leaves `ran` empty, which is the truth.
   *
   * F-168 (R-421/R-427/R-434): a writer that answers NOTHING is no longer
   * read as `written` -- that shim was the bug itself, in `onRetime`'s,
   * `onRetimeRun`'s, `onUnassign`'s and `onMove`'s retime half's own words: a
   * refused unassign or retime recorded as Written while the block sat right
   * there on the board (CLAUDE.md §4). Those four now always answer for real
   * (`WriteResult`, never `void`), and `onOpen`/`onBook`/`onSetHeadcount`
   * always have since F-164 -- so an `undefined` reaching here is a defect in
   * a caller this file does not yet know about, never a success to assume.
   * It is filed as a refusal, loud rather than silent, so the trace and the
   * thread say something is wrong instead of lying that the write landed.
   *
   * `entry` is captured BEFORE any await: a promise that settles after the
   * person has already said something else must fill in the entry it belongs
   * to, never whatever is open by then. `postTrace`'s own WeakSet makes the
   * "already superseded (and so already posted)" case a no-op rather than a
   * second line for the same sentence.
   */
  function settleWrite(readout: string, readoutStatus: Status, answer: WriteAnswer): void {
    const entry = traceRef.current;
    const apply = (outcome: WriteOutcome | void): void => {
      if (entry) {
        // F-157 item 5, unchanged: a single that ran straight off its own
        // readout was never asked anything and never answered by a word or
        // a button.
        if (entry.asked === null) entry.asked = readoutStatus.message;
        if (entry.answered === null) entry.answered = "auto";
        if (outcome === undefined) {
          // F-168: NOT a success -- see this function's own doc above. Every
          // writer this file calls answers for real now; a caller reaching
          // this branch is a regression, and the trace/thread say so rather
          // than a silent Written.
          entry.outcome = "refused: no answer from the writer";
        } else if (outcome.kind === "popup") {
          // F-167: NOT an ending. The write is with a pop-up now, and the
          // entry stays open until that pop-up reports back through the
          // reporter this sentence was given (`completePopup` below) -- or,
          // if it never does, until the page tears down (F-157). The turn is
          // filed into the thread straight away so the person can see it
          // waiting rather than nothing at all.
          entry.outcome = `popup: ${outcome.waitingFor}`;
          fileOpenTurn(store);
          return;
        } else if (outcome.kind === "written") {
          entry.ran.push(readout);
          entry.outcome = "written";
        } else {
          entry.outcome = `refused: ${rewriteCapRefusal(outcome.message)}`;
        }
      }
      if (entry) settleTurn(store, entry);
    };
    if (isThenable(answer)) {
      answer.then(apply, (err: unknown) =>
        apply({ kind: "refused", message: err instanceof Error ? err.message : String(err) }),
      );
      return;
    }
    apply(answer);
  }

  function runCommand(command: Command, suffix?: string, options?: ResolveOptions): void {
    // R-424: every functional read of the board's context goes through the
    // last REAL ctx this component has seen, never the possibly-null prop
    // directly (see `ctx`'s own doc and `lastCtxRef`'s). A `null` here means
    // no board has ever loaded for this bar at all -- nothing to resolve
    // against, so this is a no-op rather than a crash (belt and braces: a
    // real caller never actually reaches this, since the bar is not even
    // mounted until its first ctx lands).
    const activeCtx = lastCtxRef.current;
    if (activeCtx === null) return;
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
    const expanded = expandCommand(command, activeCtx);
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
    const resolution = resolveCommand(resolvedCommand, activeCtx, options);
    if (resolution.ok) {
      const resolved = resolution.resolved;
      // F-164: every one of these may now ANSWER -- `written`, `refused:
      // <message>` or `popup: <what it waits for>` -- and the trace records
      // which. The pre-F-164 shape (the readout pushed straight into `ran`
      // the instant the writer was called) is what let the maintainer's
      // trace show "Sam Patel -> Housing A . Cell 3 . 08:00-12:00" under
      // `ran` for a sentence the database never received a row for (F-165).
      const readoutStatus: Status = {
        kind: "readout",
        message: renderReadout(resolved.readout) + (suffix ?? ""),
      };
      // F-167: built BEFORE the writer is called -- a pop-up that answers
      // synchronously (a refusal it can see for itself) must have somewhere
      // to answer INTO.
      const report = popupReporterFor(traceRef.current, resolved.readout);
      let answer: WriteAnswer;
      if (resolved.intent === "book") {
        if (resolved.target.kind === "retime_run") {
          answer = onRetimeRun(resolved, anchorOfInput(), report);
        } else {
          answer = onBook(resolved, anchorOfInput(), report);
        }
      } else if (resolved.intent === "unassign") {
        answer = onUnassign(resolved, anchorOfInput(), report);
      } else if (resolved.intent === "move") {
        // S41-c: BOTH targets go through onMove -- the caller narrows on
        // `resolved.target.kind` (keep the types honest: never build a
        // ResolvedCommand-shaped call to reach onRetime from here).
        answer = onMove(resolved, anchorOfInput(), report);
      } else if (resolved.intent === "headcount") {
        // S58 (R-415, D132 item 4): one existing write, never a create or a
        // re-time -- see `onSetHeadcount`'s own doc above.
        answer = onSetHeadcount(resolved, anchorOfInput(), report);
      } else {
        if (resolved.target.kind === "retime") {
          answer = onRetime(resolved, anchorOfInput(), report);
        } else {
          answer = onOpen(resolved, anchorOfInput(), report);
        }
      }
      setStatus(readoutStatus);
      // F-164: the entry is finished by `settleWrite` now, once (and only
      // once) the writer has answered -- `resolved.readout` is the ONE
      // command this run asked for (never the `+ suffix` UI annotation,
      // which says WHY it was read, not what ran).
      settleWrite(resolved.readout, readoutStatus, answer);
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
    // R-424: same fallback as `runCommand`'s own -- see that function's
    // identical guard for why this can only ever be reached with a real
    // ctx in practice.
    const activeCtx = lastCtxRef.current;
    if (activeCtx === null) return;
    const command = lot.commands[lot.index];
    const resolution = resolveCommand(command, activeCtx);
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
      candidates: [{ key: "__do_all__", label: `Do all ${n}`, action: { kind: "run_lot" } }],
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
      // F-164: the lot's own last word, recorded BEFORE the entry is
      // finished. `runLotNow` used to call `finishTrace()` here and set the
      // failure status AFTER it, so the maintainer's trace listed three of
      // four readouts and NOTHING said why the fourth stopped. `asked`
      // already holds the lot's "N commands ready" question, so the result
      // goes in `outcome` -- the same sentence the status line shows.
      // CR-1 (reviewer fix, S63 review): `result.error` is "the same wording
      // a toast would show" (`LotResult`'s own doc) -- the identical
      // drag-borrowed capacity sentence `rewriteCapRefusal` exists to catch
      // on the single-sentence path (brief §5) reaches the bar this way too,
      // and was never rewritten here: a lot whose failing step was a
      // capacity refusal showed "try the split again" verbatim, the same bug
      // brief §5 named, just through the lot door instead of the single one.
      const lotError = result.error === null ? null : rewriteCapRefusal(result.error);
      // F-154 review fix: say what actually stood, never claim a revert
      // that never happened -- the steps before the failure wrote for
      // real and are still on the board, so they are named here.
      // `result.error` no longer carries the drag's own "— reverted."
      // wording at all (`useSchedulerToast.ts`'s own F-154 fix: that
      // suffix is now appended only by a caller that genuinely reverted
      // something, never baked into `buildSchedulerErrorToast`'s message
      // itself), so this reads it verbatim -- nothing to strip here any
      // more. CR-1: except the ONE shape `rewriteCapRefusal` rewrites
      // (`lotError`, above) -- the bar has no split to offer here either.
      const stayedReadouts = resolved.slice(0, result.done).map((r) => renderReadout(r.readout));
      const stayed =
        stayedReadouts.length > 0
          ? ` The ${result.done} done stayed: ${stayedReadouts.join("; ")}.`
          : "";
      const lotOutcome =
        lotError === null
          ? `Done: ${n} commands.`
          : `Did ${result.done} of ${n}; the next failed: ${lotError}${stayed}`;
      if (traceRef.current) traceRef.current.outcome = lotOutcome;
      // CP-7 (session 178, found by the typed walk): the status is set
      // BEFORE the entry is finished, the same order `settleWrite` uses, so
      // `fileTurn` clears it and the lot's last word is on screen ONCE, in
      // the thread. It used to be set after, so "Done: 2 commands." stayed
      // on the live line as a second copy of the filed turn, and the walk's
      // count of turns was one too high for every sentence that followed a
      // lot. The trace's `outcome` and the thread's result line are the same
      // sentence, "stayed" clause included.
      if (result.error === null) {
        setStatus({ kind: "readout", message: lotOutcome });
        setText("");
      } else {
        setStatus({ kind: "shape", message: lotOutcome });
      }
      finishTrace();
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
      const finalStatus: Status =
        reason === null
          ? base
          : { ...base, message: `${failurePrefixForReason(reason)}${base.message}` };
      setStatus(finalStatus);
      // F-157: the shape hint IS what the bar shows now -- `asked` records
      // it the same way a question's own text is recorded.
      traceQuestionStatus(finalStatus);
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
    // S63-a review fix (R-437, CB-ent-4): a candidate answer is still an
    // ANSWER, not a new sentence -- but it is also still a box that must end
    // up empty (the maintainer's own words: "the box is empty after every
    // Enter and every button press"). The rendered, now-complete form used
    // to go straight into the input (`setText(rendered)`); it goes into
    // `sentence` instead -- the person's own bubble -- so the box empties
    // and what the person's turn now reads as is the completed sentence,
    // never a half-typed one.
    store.getState().set({ sentence: rendered, text: "" });
    const parsed = parseCommand(rendered);
    if (!parsed.ok) {
      heldRef.current = null;
      // S59-e (brief §3): same as `submitText`'s own identical comment.
      if (traceRef.current) traceRef.current.read = parsed.failure.kind;
      const status = failureToStatus(parsed.failure);
      setStatus(status);
      traceQuestionStatus(status);
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
    // R-437 (CB-ent-4): same as `pickCandidate`'s own identical fix -- the
    // completed sentence goes into the person's bubble, never back into the
    // box.
    store.getState().set({ sentence: rendered, text: "" });
    const parsed = parseCommand(rendered);
    if (!parsed.ok) {
      heldRef.current = null;
      if (traceRef.current) traceRef.current.read = parsed.failure.kind;
      const status = failureToStatus(parsed.failure);
      setStatus(status);
      traceQuestionStatus(status);
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
  /** F-163: the overload set this used to carry is gone -- `runCandidateAction`
   *  below dispatches a `pick_existing` action whose `command` is a plain
   *  `Command` (the store holds DATA, not a closure that already narrowed it),
   *  and no overload signature accepts that. Each `questionToStatus` branch
   *  still builds its own action from the narrowed command it has in hand, so
   *  nothing that was type-checked there stopped being. */
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
    //
    // R-434 item 3: a "readout" status ends the entry's life the instant
    // `traceQuestionStatus` sees it (below), and nothing else this function
    // returns for `nothing_to_do` ever set `outcome` -- so the thread's last
    // line for "Housing A has nobody on it …"/"nobody on Cell 3 …" read
    // blank (`turnResultLine`'s own `outcome === null` case), the exact
    // "never a blank last line" rule R-434 states. Nothing was refused by a
    // server here, but `refused: ` is the one prefix the thread already
    // renders as a plain sentence (`turnResultLine`), so the readout's own
    // words become the outcome verbatim rather than inventing a fourth
    // category this lane was not asked to add.
    if (question.kind === "nothing_to_do") {
      const rendered = renderReadout(question.text);
      // The RENDERED text (the plant's own day, not the raw ISO token) --
      // the same string the "asked" bubble above already shows, so the
      // thread's result line never disagrees with its own question line.
      if (traceRef.current) traceRef.current.outcome = `refused: ${rendered}`;
      return { kind: "readout", message: rendered };
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
    // F-152 review follow-up (the maintainer, 16 Sept): a block that
    // genuinely crosses a day boundary and matches no shift band -- never
    // the window's own bounds (untrue and unanswerable for a whole-day
    // window's "00:00-00:00"). `question.hours` (the block's own real
    // span) stays on the question for the trace/tests, but the text itself
    // drops it -- `question.block` already carries the hours in its own
    // label, so printing both said them twice (the maintainer, wording
    // trim, 16 Sept).
    if (question.kind === "across_midnight") {
      return {
        kind: "question",
        message: `${question.person}'s ${question.block} block on ${question.cell} crosses midnight and matches no shift; split it at midnight first, or say the shift.`,
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
    // S61-a (R-425, F-155): the bar's own wording -- `describeQuestion`
    // carries only a baseline (its own comment: "the bar ... may refine
    // this further"), and never branches on `inLot` at all, so a lot's own
    // "warn" refusal (`inLot: true`) would otherwise get the single
    // sentence's "say the reason" offer, which a lot never honours (R-425:
    // "a lot never writes half of itself"). No candidates either way --
    // "warn"/single takes its answer as free TEXT (`awaitingOverrideReason`,
    // read by `submitText`), never a button; "block" or `inLot: true` accept
    // nothing at all.
    if (question.kind === "not_certified") {
      const missing = question.missing.join(", ");
      const base = `${question.person} is not certified for ${question.cell}: missing ${missing}.`;
      if (question.policy === "warn" && !question.inLot) {
        return {
          kind: "question",
          message: `${base} Say the reason to schedule anyway, or no.`,
          candidates: [],
          awaitingOverrideReason: true,
        };
      }
      return {
        kind: "question",
        message: question.inLot ? `${base} Nothing was written.` : base,
        candidates: [],
      };
    }
    // F-165 (S62-b): R-425's shape for the AREA rule -- the twin of the
    // branch above. A single sentence takes the reason as its next answer
    // (`awaitingAreaReason`, read by `submitText`) and re-resolves with
    // `{ areaReason }`; a lot is REFUSED before its yes and says nothing was
    // written (a lot never writes half of itself). No candidates either way:
    // this question's answer is free text, never a button.
    if (question.kind === "outside_area") {
      const base = `${question.person} is not from ${question.cell}'s area.`;
      if (question.inLot) {
        return { kind: "question", message: `${base} Nothing was written.`, candidates: [] };
      }
      return {
        kind: "question",
        message: `${base} Say the reason to schedule anyway, or no.`,
        candidates: [],
        awaitingAreaReason: true,
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
          action: { kind: "pick_candidate", command, field, candidate: c, text },
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
            action: { kind: "show_day", command, target: day },
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
              action: {
                kind: "pick_part_as_place",
                command: asPlaceCommand,
                product: text,
                candidate: c,
              },
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
              action: { kind: "pick_candidate", command, field, candidate: c, text },
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
            action: { kind: "pick_candidate", command, field, candidate: c, text },
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
            action: {
              kind: "pick_attach" as const,
              command: assignCommand,
              attach: { kind: "run" as const, runId: r.id },
            },
          })),
          {
            key: "__separate_block__",
            label: "Separate block",
            action: {
              kind: "pick_attach" as const,
              command: assignCommand,
              attach: { kind: "direct" as const },
            },
          },
        ],
      };
    }
    if (question.kind === "block_exists") {
      const assignCommand = command as AssignCommand;
      const separate = {
        key: "__separate_block__",
        label: "Separate block",
        action: {
          kind: "pick_existing" as const,
          command: assignCommand,
          existing: { kind: "separate" as const },
        },
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
              action: {
                kind: "pick_existing" as const,
                command: assignCommand,
                existing: { kind: "retime" as const, assignmentId: b.id },
              },
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
            action: {
              kind: "pick_existing",
              command: assignCommand,
              existing: { kind: "separate" },
            },
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
            action: {
              kind: "pick_existing",
              command: bookCommand,
              existing: { kind: "retime", runId: run.id },
            },
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
            action: { kind: "pick_existing", command: bookCommand, existing: null },
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
                action: {
                  kind: "pick_existing" as const,
                  command: unassignCommand,
                  existing: { kind: "remove" as const, assignmentId: only.id },
                },
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
            action: {
              kind: "pick_existing" as const,
              command: unassignCommand,
              existing: { kind: "remove" as const, assignmentId: b.id },
            },
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
            action: {
              kind: "pick_existing" as const,
              command: moveCommand,
              existing: { kind: "move" as const, assignmentId: b.id },
            },
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

  /**
   * F-163: the one place a `CandidateAction` becomes a call. The buttons in
   * a `Status` are data (see `commandConversation.ts`'s module doc) precisely
   * so a status built before the launcher's panel closed still works after it
   * reopens; this is the CURRENTLY MOUNTED bar turning one of them into the
   * same call the old inline `onClick` closure made.
   */
  function runCandidateAction(action: CandidateAction): void {
    switch (action.kind) {
      case "pick_candidate":
        pickCandidate(action.command, action.field, action.candidate, action.text);
        return;
      case "pick_part_as_place":
        pickPartAsPlace(action.command, action.product, action.candidate);
        return;
      case "pick_attach":
        pickAttach(action.command, action.attach);
        return;
      case "pick_existing":
        pickExisting(action.command, action.existing);
        return;
      case "show_day":
        pendingRerunRef.current = { command: action.command, target: action.target };
        onShowDay?.(action.target);
        return;
      case "run_lot":
        runLotNow();
        return;
    }
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
    // Brief 6: "Any edit to the input clears the held command and its
    // attach (a new sentence is a new question)." Clearing the held command
    // clears its `existing` (R-385) the same way it clears `attach`.
    //
    // F-162 EXCEPTION (widened from S61-a's `awaitingOverrideReason`-only
    // one): while ANY answer box stands, the box IS the answer being typed,
    // not a new sentence -- the standing question, its buttons, the lot and
    // the held command all survive every keystroke. The one thing that is
    // still a new sentence is text that PARSES as one (the CB-nc-6 rule,
    // found live by the S61-a reviewer: a second sentence typed while a
    // question stood was silently swallowed as its answer). `parseCommand`
    // is the same rules-only shape check every other guard here treats as
    // authoritative, and a real answer -- "yes", "Sam Patel", "covering for
    // Sam" -- essentially never parses as a command.
    const answering = answerTakes(status) !== null;
    // ⚠️ A CONFIRM/CANCEL WORD IS NEVER A NEW SENTENCE, even when the grammar
    // happens to read it as one. S50 widened the rules enough that "remove
    // it" parses as a place-less removal of an operator literally named "it"
    // -- so without this exemption, typing the very word that answers a
    // standing removal question would drop the question on the keystroke
    // before Enter could act on it (CB-yes-12, CB-yes-12c, CB-lot-6 all
    // caught exactly that).
    const answerIsANewSentence =
      answering &&
      !isConfirmOrCancelWord(normalizeWord(e.target.value)) &&
      parseCommand(e.target.value).ok;
    const keepingTheAnswer = answering && !answerIsANewSentence;
    if (!keepingTheAnswer) {
      heldRef.current = null;
      heldOptionsRef.current = {};
    }
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
      !keepingTheAnswer &&
      status?.kind === "question" &&
      status.blockHighlight &&
      !isConfirmOrCancelWord(normalizeWord(e.target.value))
    ) {
      lotRef.current = null;
    }
    setStatus((prev) => {
      if (prev?.kind === "reading") return null;
      // F-162: an answer box keeps its own question standing (see above).
      if (keepingTheAnswer) return prev;
      // ... and a whole new sentence typed into it drops that question,
      // whatever kind it was -- before F-162 only a BLOCK question (the one
      // kind with stale buttons bound to the old command) was dropped on a
      // typed edit, because the input still held the sentence and any other
      // question was answered by editing it. It is not the sentence box any
      // more, so every standing question goes.
      if (answerIsANewSentence) return null;
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
    //
    // R-434 item 3 (F-168/F-169's own audit, list A item 2): this used to be
    // a silent no-op -- the heard text (typed or the final transcript of a
    // spoken clip) discarded untraced, with nothing in the thread or the file
    // saying a sentence arrived at all. DECISION (documented here per the
    // brief, since either shape is a legitimate answer): the sentence is
    // reported DROPPED, in its own standalone turn (`fileStandaloneTurn`,
    // which never touches `status`/`sentence` -- "Working…" keeps standing,
    // exactly as the comment above promises), rather than QUEUED to re-run
    // once the lot finishes. Queuing would need its own state surviving this
    // call, its own re-resolution against whatever `ctx` is current by the
    // time the lot ends (the same staleness `pendingRerunRef`'s own
    // `isTargetOnBoard` guard exists to catch), and its own answer for a
    // SECOND sentence arriving before the first queued one ever runs --
    // three open product questions, not "the entry closes" this item asks
    // for. Saying plainly that it was dropped is small, honest (R-434's own
    // rule: never a blank last line) and reversible: the person can simply
    // say it again once the lot's own "Done: …"/"Did k of N…" turn lands.
    //
    // WR-1 (reviewer, S64-c review): a TYPED sentence can sit in the box
    // through this whole branch -- `handleChange` only blocks an edit once
    // `runningLotRef.current` is already true, so text typed while the
    // lot's own "Do all N" confirm question still stood (before the click
    // that starts it) survives into the run untouched, and `runLotNow`
    // itself does not clear it either (only its OWN `.then()` does, on a
    // clean sweep). Pressing Enter on that leftover sentence used to file
    // it -- exactly what this block now does -- while leaving the sentence
    // sitting in the input, which is R-437 verbatim ("a sent sentence
    // lives in the thread, never in the input") for a sentence that, as of
    // this fix, is now genuinely sent (a filed turn, not silent). `setText`
    // here is the one line missing next to `fileStandaloneTurn` to make
    // this branch behave like every other exit `submitText` has.
    if (runningLotRef.current) {
      fileStandaloneTurn(value, by, "refused: a lot was still writing; the sentence was dropped");
      setText("");
      return;
    }
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
    // S61-a (R-425, F-155): a `not_certified` "warn" question takes free
    // TEXT as its answer -- checked BEFORE the ordinary confirm/cancel
    // block below (which would otherwise either fall through and try to
    // PARSE a typed reason as a sentence, or -- for a bare "yes" -- treat
    // it as an ordinary confirm with no question kind that claims it,
    // losing the standing question entirely). A cancel word drops it, same
    // as any other question; a bare confirm word is refused in place (the
    // question is not "yes", it wants a reason); anything else -- typed or
    // the final transcript of a spoken clip -- IS the reason, and re-runs
    // `heldRef.current` (the same command this question was raised for)
    // with `{ overrideReason }`.
    //
    if (
      status?.kind === "question" &&
      (status.awaitingOverrideReason || status.awaitingAreaReason)
    ) {
      // F-165: WHICH reason this question is collecting. The server keeps
      // the two apart (`eligibility_override`/`override_reason` for a
      // certificate, `area_override`/`area_override_reason` for the area,
      // migration 0072's own two doors), so the bar has to as well -- and a
      // sentence that raised BOTH keeps the first answer in `heldOptionsRef`
      // so answering the second never re-asks the first.
      const reasonField: "overrideReason" | "areaReason" = status.awaitingAreaReason
        ? "areaReason"
        : "overrideReason";
      if (isCancel) {
        cancelStanding(value);
        return;
      }
      if (isConfirmCandidate) {
        setStatus({ ...status, message: "Say the reason, not yes." });
        return;
      }
      // S61-a review fix (R-425, F-155): EXCEPT when the text itself
      // parses as a full command (`parseCommand(value).ok`) -- the
      // reviewer's own live find: a second sentence typed while the
      // question stood ("assign Priya to ...") was silently swallowed as
      // the not_certified question's reason instead of running.
      // `parseCommand` is the same rules-only "shape" check every other
      // guard here already treats as authoritative (CB-nc-6 pins this) --
      // a true reason essentially never parses as a command in the first
      // place ("covering for Sam" has no operator/place/hours clause), so
      // this costs nothing for the ordinary case. NO return here: this
      // falls through to the ordinary path below, which starts a FRESH
      // trace entry (flushing this one -- "a new sentence" is one of its
      // own three life-end triggers) and runs the parsed command as usual,
      // exactly as if no question had stood at all.
      if (!parseCommand(value).ok) {
        if (traceRef.current) traceRef.current.answered = value;
        const command = heldRef.current;
        if (command === null) {
          // Belt and braces: `heldRef` is always set the moment this
          // question is raised (`runCommand`'s own success/question path)
          // and never cleared while it stands -- this is not reachable in
          // practice.
          return;
        }
        const nextOptions: ResolveOptions = {
          ...heldOptionsRef.current,
          [reasonField]: value,
        };
        heldOptionsRef.current = nextOptions;
        // S62-b reviewer fix (E): a person can fail BOTH gates -- no
        // certificate for the cell AND not from its area -- and is asked
        // twice, certificate first. The readout used to name only the
        // reason given LAST, so a block written with two overrides read as
        // if it carried one. Both are named, in the order they were asked.
        const suffixParts: string[] = [];
        if (nextOptions.overrideReason !== undefined) {
          suffixParts.push(` · override: ${nextOptions.overrideReason}`);
        }
        if (nextOptions.areaReason !== undefined) {
          suffixParts.push(` · area override: ${nextOptions.areaReason}`);
        }
        // R-437: this Enter answered the standing question with a reason --
        // never a new sentence (`sentence` already names the ORIGINAL one,
        // untouched here), but still an Enter, so the box empties for
        // whatever `runCommand` below turns into (a write, another
        // question, a refusal).
        setText("");
        runCommand(command, suffixParts.join(""), nextOptions);
        return;
      }
    }
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
          cancelStanding(value);
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
            runCandidateAction(status.candidates[0].action);
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
          cancelStanding(value);
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
      }
      if (status?.kind !== "question") {
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
          // "none" -- nothing on screen wanted it; answered below.
        } else if (isCancel && onCancelWord) {
          if (onCancelWord()) {
            setStatus(null);
            setText("");
            return;
          }
        }
        // F-166 (found in S62-b's own live run, 17 Sept): A BARE CONFIRM OR
        // CANCEL WORD WITH NOTHING STANDING IS NOT A SENTENCE.
        //
        // It used to fall through to the ordinary path -- which, with a model
        // reader wired, MEANT SENDING "yes" TO THE MODEL. The model has to
        // answer with a form, so it invents one: a bare "yes" came back read
        // as `unassign "everyone" on today` and the bar offered a two-command
        // lot that would have cleared the board. A word that means "do the
        // thing you just asked me about" must never become a thing.
        //
        // The pop-up hand-off above is untouched: `onConfirmWord` returning
        // "created"/"needs-decision" and `onCancelWord` returning true all
        // return before this, so R-384's spoken yes into a sentence-opened
        // create pop-up still works exactly as it did.
        startTrace(value, by);
        // R-437 IS unconditional (reviewer fix, S63 review -- settles the
        // judgment call an earlier comment here left open: "whether written,
        // refused or standing" is the maintainer's own wording for what R-437
        // covers, and a bare word with nothing standing is answered here the
        // same as any other sentence). The word goes to the thread as the
        // person's own bubble, same as any other sentence -- CB-yes-8 below
        // no longer keeps it in the box.
        store.getState().set({ sentence: value, text: "" });
        if (traceRef.current) {
          traceRef.current.model = { skipped: "no question standing" };
          traceRef.current.read = isCancel ? "cancel word" : "confirm word";
        }
        const nothingStatus: Status = {
          kind: "shape",
          message: isCancel ? "Nothing to cancel." : "Nothing to say yes to.",
        };
        setStatus(nothingStatus);
        traceQuestionStatus(nothingStatus);
        // Nothing can ever answer this, so the turn is finished here rather
        // than left open until the next sentence.
        finishTrace();
        return;
      }
      // ---------------------------------------------------------------
      // F-166, WIDENED (S62-b reviewer fix A): A BARE CONFIRM OR CANCEL WORD
      // IS NEVER A SENTENCE, WHATEVER STANDS.
      //
      // The first fix guarded only "no question standing" -- so at a question
      // that did not itself take the word (an `ambiguous` pick list, a
      // `run_exists`, a `no_job`) the word still fell through to the reader.
      // The reviewer's own live run: "no" at such a question went to the
      // model, came back read as a removal, and the bar WROTE it ("Removing
      // Tom Baker's Housing A block"). A word that means "leave it" must
      // never delete anything.
      //
      // So every branch above returns, and this is the floor under all of
      // them:
      //   - a CANCEL word at any question drops the question AND the held
      //     sentence, and says so;
      //   - a CONFIRM word at a question with no yes-shaped answer re-asks --
      //     "Say which one." when there are buttons to choose between, the
      //     question's own text otherwise.
      // Neither starts a trace entry: this is an answer to the sentence
      // already open, not a new one.
      if (isCancel) {
        cancelStanding(value);
        return;
      }
      setStatus(
        status.candidates.length > 0 ? { ...status, message: "Say which one." } : { ...status },
      );
      return;
    }
    // F-162: the answer box invited "a name, or no" -- so a typed name that
    // IS one of the standing question's buttons presses it, rather than
    // falling through to be parsed as a sentence and refused with a shape
    // hint. Checked after every confirm/cancel branch above (a confirm word
    // is never a candidate label) and before the sentence path below, so a
    // full sentence typed here is still a new sentence.
    if (status?.kind === "question" && answerTakes(status) !== null) {
      const picked = status.candidates.find((c) => normalizeWord(c.label) === normalized);
      if (picked) {
        if (traceRef.current) traceRef.current.answered = picked.label;
        runCandidateAction(picked.action);
        return;
      }
    }
    // S59-e (brief §3): a sentence submitted -- starts a fresh trace entry,
    // flushing (posting) whatever was still open from before ("a new
    // sentence" is one of the three life-end triggers). Placed after every
    // confirm/cancel branch above that returns without reaching here: none
    // of those is a NEW sentence, only an answer to (or a cancel of) the
    // one already open.
    startTrace(value, by);
    // R-437 (the maintainer): ENTER ALWAYS EMPTIES THE BOX NOW, whatever this
    // sentence turns out to do -- write, refuse, ask, fail to parse, or start
    // a lot (CB-ent-1, CB-ent-2). `sentence` is unconditionally overwritten
    // here, never guarded on "already set": `startTrace` above just flushed
    // whatever turn was open before into `history` (its own doc -- "a new
    // sentence" is one of the three life-end triggers), so any OLD bubble is
    // already a finished, past turn and this is a fresh one starting. It is
    // never cleared back to `null` again once set here (unlike the pre-R-437
    // F-162 effect this replaces) -- it keeps its bubble exactly as long as
    // the status line beside it keeps showing this sentence's own outcome,
    // and both are only ever replaced by the NEXT sentence reaching this same
    // line.
    store.getState().set({ sentence: value, text: "" });
    // F-162: a new sentence ends whatever stood. `handleChange` already does
    // this for a TYPED one (it can see the text parse), but a spoken final
    // transcript arrives here without ever passing through it, so a lot left
    // standing behind a new sentence would sit in the store unreachable.
    lotRef.current = null;
    // F-169 (R-419/R-421): a "Show that day" press's pending rerun is the
    // SAME shape of leftover -- `handleChange` already clears it on every
    // typed edit (line ~2677), but a spoken final sentence never passes
    // through `handleChange` either, so it survived here exactly as a
    // standing lot used to. Without this, "show Friday" (which sets
    // `pendingRerunRef`) followed by an unrelated sentence spoken before the
    // window landed would let the effect that waits for the window run the
    // OLD command once it did, overwriting THIS sentence's `read`/`ran`/
    // `outcome` in the trace and the thread with the stale rerun's.
    pendingRerunRef.current = null;
    heldOptionsRef.current = {};
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
      const status = failureToStatus(parsed.failure);
      setStatus(status);
      traceQuestionStatus(status);
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
        const message =
          kind === "not-allowed"
            ? "The microphone was refused. Allow it in the browser's address bar and try again."
            : kind === "no-speech"
              ? "Nothing was heard."
              : `The recogniser stopped: ${detail}.`;
        // R-434 item 3: one of the four life-ending paths the audit named
        // with no trace entry at all -- nothing was ever heard (a refused
        // mic, silence, or the session itself stopping), so `heard` is
        // empty, but the person still SAW an answer and the thread's own
        // turn must say so, in the SAME "Refused: …" words a write's own
        // refusal uses (`turnResultLine`'s `refused: ` prefix). `finishTrace`
        // files the turn and clears the store's own `status`/`sentence`
        // (CP-5) BEFORE the live line is set, the same order `cancelStanding`
        // already uses for its own "Left it." -- so the message still shows
        // live (CB-mic-7's own pin) as well as in the thread, rather than the
        // two racing to set `status` last.
        startTrace("", recognizerName?.() ?? "browser");
        if (traceRef.current) traceRef.current.outcome = `refused: ${message}`;
        finishTrace();
        setStatus({ kind: "shape", message });
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
        // R-437 (S63-a, CB-ent-3) CONTRACT CHANGED (CLAUDE.md §4): CB-ans-5
        // pinned that the sentence the answer box emptied out of the input
        // came BACK on Escape, so it could be edited rather than retyped.
        // The maintainer's own words for R-437 are the opposite: "Escape ...
        // no longer puts the sentence back into the box -- it stays readable
        // in its bubble ... the box stays empty." `finishTrace` below files
        // this turn (CP-5: `fileTurn` clears the now-live `sentence`/`status`
        // back to `null` the moment it does), so what was readable in the
        // live bubble is readable in the THREAD's own copy of this turn
        // instead -- there is nothing left to restore into the box either
        // way; CB-ent-3 replaces CB-ans-5 below.
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

  // S63-a review fix (R-437, CB-ent-3/4): true while `sentence` is still
  // worth its own bubble -- something to show, and never when the question
  // standing already quotes it verbatim (the pre-existing "nothing is said
  // twice" rule, unchanged). Once a turn is filed, `sentence`/`status` are
  // ALREADY `null` (`commandConversation.ts`'s own `fileTurn`, CP-5) -- there
  // is no separate "is this still live" flag to check here.
  const showSaidLine =
    sentence !== null && sentence !== "" && !(status?.message ?? "").includes(sentence);

  return (
    <div className={styles.bar}>
      {/* R-427: the thread -- every finished turn of the last day for this
          person on this plant, oldest first, scrolled to the bottom, PLUS
          (S63-a) the current turn's own live bubbles while it is still open
          -- one scrolling column, so the newest thing (filed or not) always
          sits directly above the input. A record, not a control: nothing
          FILED is clickable (the chips are spans); the only live buttons on
          screen are the CURRENT question's, below. */}
      <div className={styles.thread}>
        {history.length > 0 && (
          <div className={styles.threadHead}>
            <span>Earlier today</span>
            <button
              type="button"
              className={styles.threadClear}
              onClick={() => store.getState().clearHistory()}
            >
              Clear history
            </button>
          </div>
        )}
        {/*
          CR-4 (reviewer fix, S63 review): THE ANNOUNCEMENT WAS LOST. `status`
          set the readout/refusal text and `fileTurn` cleared it back to
          `null` in the SAME tick (`settleWrite`'s synchronous branch) -- React
          batches both, so the `<p aria-live>` below never actually held a
          finished turn's own words at any point a screen reader could catch,
          and the bubble it moved to (a plain `div`) had no live semantics of
          its own. `role="log"` + `aria-live="polite"` + `aria-relevant="additions"`
          here is the standard chat-log pattern instead: every turn APPENDED
          to this element (a new child of `history.map` below) is announced
          on its own, which is every turn there is, filed or not -- no second
          hidden live region, no deferred clear. `status`'s own `aria-live`
          keeps its job for what is genuinely still open (a question, a
          shape hint, "Reading…", "Working…") -- CP-5 already means it holds
          nothing else. The empty-state hint (`EMPTY_THREAD_HINT`, CP-6) is a
          sibling AFTER this element, not a child of it, precisely so it is
          never announced as though it were a turn.
        */}
        <div
          className={styles.threadBody}
          ref={threadRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
        >
          {history.map((turn, i) => {
            const result = turnResultLine(turn);
            return (
              <div className={styles.turn} key={`${turn.at}-${i}`}>
                {/* R-428: two colours, one per side -- the SIDE says who,
                    not a "You: "/"Board: " prefix any more.
                    WR-3 (reviewer, S64-c review): `turn.heard` is EMPTY for
                    the one caller R-434 item 3 added that has nothing to
                    show here -- a recogniser error (mic refused, nothing
                    heard, stopped): nobody said a word, so there is nothing
                    for a "you" bubble to hold, and an empty rounded box with
                    no text read as a rendering glitch, not a turn. The
                    board's own bubble below (`turn.asked`/the result line)
                    still carries the whole story alone. */}
                {turn.heard !== "" && (
                  <div className={styles.bubble} data-side="you">
                    {turn.heard}
                  </div>
                )}
                {turn.asked !== null && (
                  <div className={styles.bubble} data-side="board">
                    <p className={styles.turnBoard}>{turn.asked}</p>
                    {/* R-428: the offered chips sit INSIDE the board's own
                        bubble now, the chosen one marked -- they used to be
                        a separate line below it. */}
                    {turn.offered.length > 0 && (
                      <p className={styles.turnChips}>
                        {turn.offered.map((label, j) => (
                          <span
                            key={`${label}-${j}`}
                            className={
                              turn.answered === label
                                ? `${styles.chip} ${styles.chipChosen}`
                                : styles.chip
                            }
                          >
                            {label}
                            {turn.answered === label ? " ✓" : ""}
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                )}
                {result !== "" && (
                  <div className={styles.bubble} data-side="board">
                    <p className={styles.turnResult}>{result}</p>
                  </div>
                )}
              </div>
            );
          })}
          {/* R-428/S63-a: the CURRENT turn, reading the same way a filed one
              does -- the sentence a right bubble, the live status a left
              one, the live candidates inside IT -- but ONLY while it is
              still open; the instant it is filed, `sentence`/`status` are
              already `null` (`fileTurn`, CP-5) and this whole block stops
              rendering on its own, no separate flag to check. F-162:
              `sentence` is kept readable while a question stands, never
              inside the `aria-live` status line itself (which is the
              question, and is what every pin in `commandBar.test.tsx`
              reads). Wrapped in the SAME `.turn` class a filed turn uses, so
              the gap between its own two bubbles matches (never the wider
              gap between turns). */}
          {(showSaidLine || status !== null) && (
            <div className={styles.turn}>
              {showSaidLine && (
                <div className={styles.bubble} data-side="you">
                  <p className={styles.saidLine}>You said: {sentence}</p>
                </div>
              )}
              {status !== null && (
                <div className={styles.bubble} data-side="board">
                  <p
                    className={
                      status.kind === "reading"
                        ? `${styles.statusLine} ${styles.reading}`
                        : styles.statusLine
                    }
                    aria-live="polite"
                  >
                    {status.message}
                  </p>
                  {status.kind === "question" && status.candidates.length > 0 && (
                    <div className={styles.candidates}>
                      {status.candidates.map((c) => (
                        <button
                          key={c.key}
                          type="button"
                          className={fieldStyles.btn}
                          onClick={() => {
                            // S59-e (R-421, brief §3): "the answer given (a
                            // candidate label ...)" -- one place for EVERY
                            // candidate button (ambiguous picks, run_exists,
                            // block_exists, remove_which, move_which, job_gone,
                            // "Show that day", the lot's own "Do all N", ...),
                            // rather than threading this through every action
                            // built in `questionToStatus` above.
                            if (traceRef.current) traceRef.current.answered = c.label;
                            runCandidateAction(c.action);
                          }}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {/* The `aria-live="polite"` element itself is ALWAYS rendered
              SOMEWHERE, so a pin that reads it by role/attribute never finds
              nothing -- the bubble above carries it while `status` is set;
              this bare, empty one is what is left once filed (`status` back
              to `null`), or before anything has ever been said. */}
          {status === null && <p className={styles.statusLine} aria-live="polite"></p>}
        </div>
        {/* S63-a review fix (the maintainer): an empty thread with nothing
            open is not a blank box -- one board-side bubble, bottom-aligned
            just above the input (the same `flex-end`/`flex: 1 1 auto`
            `.threadBody` above it already uses to push its own content down
            leaves this sitting right after it). Not a turn: no `key`,
            nothing in the store, nothing traced -- gone the instant a
            sentence is submitted (`status` becomes non-null the moment one
            is) or a history turn exists, both checked here and nowhere else
            (CP-6). CR-4 (reviewer fix): a SIBLING of the log region above,
            never a CHILD of it, so it is never announced as though it were
            a turn. */}
        {history.length === 0 && status === null && (
          <div className={styles.bubble} data-side="board">
            <p className={styles.turnBoard}>{EMPTY_THREAD_HINT}</p>
          </div>
        )}
      </div>
      {/* S63-a review fix (the maintainer): the input row is the LAST child
          now -- a chat reads thread, then the current turn, then the box to
          type the next one, never the box in the middle of the
          conversation. Id, label and aria are unchanged. */}
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
          placeholder={answerTakes(status) ?? PLACEHOLDER}
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
    </div>
  );
}
