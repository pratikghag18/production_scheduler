import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { DateFormat } from "@/lib/format/dates";
import { isoPlusDays, isoWeekDays } from "@/lib/format/dates";
import { formatDayLabel, zonedTimeToInstant } from "../lib/time";
import fieldStyles from "@/components/Field.module.css";
import styles from "./CommandBar.module.css";
import type { Reader, Reading } from "@/lib/voice/readSentence";
import type { ClipInfo, Recognizer, RecognizerHandle } from "@/lib/voice/recognizer";
import type { TraceEntry } from "@/lib/voice/trace";
import { postClip } from "@/lib/voice/trace";
import {
  parseCommand,
  formatCommand,
  expectedShape,
  ASSIGN_VERBS,
  BOOK_VERBS,
  UNASSIGN_VERBS,
  MOVE_VERBS,
  HEADCOUNT_VERBS,
  REPLACE_VERBS,
  SWAP_VERBS,
  COPY_VERBS,
  ABSENCE_WORDS,
  ADJUST_VERBS,
  SAME_AS_WORDS,
  DAY_GROUNDING_WORDS,
  markAbsence,
} from "@/lib/command/parse";
import type {
  AssignCommand,
  BookCommand,
  UnassignCommand,
  MoveCommand,
  HeadcountCommand,
  SingleCommand,
  SeveralCommand,
  Command,
  Attach,
  Existing,
  ParseFailure,
} from "@/lib/command/parse";
import { groundReading, groundDays, type VerbLists } from "@/lib/command/grounded";
import {
  guessVerbs,
  misheardVerbWord,
  describeVerbGuess,
  spokenCommand,
} from "@/lib/voice/verbGuess";
import {
  resolveCommand,
  describeQuestion,
  describeGateReason,
  describeReplaceBlocked,
  replaceBlockedLabel,
  expandCommand,
  thingsCount,
  oneOrThem,
  readClearAsPerson,
} from "@/lib/command/resolve";
import type {
  Coupled,
  ReplaceBlockedDetail,
  ResolveContext,
  ResolveOptions,
  ResolvedCommand,
  ResolvedBook,
  ResolvedUnassign,
  ResolvedMove,
  ResolvedRunRemoval,
  ResolvedRunTrim,
  ResolvedAbsenceRecord,
  ResolvedHeadcount,
  Question,
  Candidate,
} from "@/lib/command/resolve";
import type { Highlight } from "../lib/highlight";
import type { PrecheckResult } from "../lib/busyElsewhere";
import { splitEvenly } from "../lib/interaction";
import { Microphone } from "@/components/icons";
import {
  createConversationStore,
  fileMovingTurn,
  finishTrace as finishTraceIn,
  settleTurn,
  flushTraceOnTeardown,
  postTrace,
  storeRef,
  type CandidateAction,
  type ConversationStore,
  type HistoryTurn,
  type LotOverlap,
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
 * shows on screen -- the person sees the GUESSED part named in that
 * readout, exactly the same as any other model reading, before anything is
 * written (`onOpen`/`onBook`/etc. still wait on the pop-up or a further
 * confirm). R-459: this readout no longer carries a "read by the model"
 * suffix -- the thread says only the fact, never how it was read. A future
 * training pass that teaches the
 * model this shape (S56's successor) only ever needs to start emitting
 * `product: ""` itself -- this file needs no change either way, since it
 * already renders whatever `resolveCommand` answers.
 */

/**
 * S71-m (F-212/F-215, R-435/R-431, docs/agent-briefs/s71-m-grounded-reading-
 * brief.md): `groundReading`'s own verb lists (`src/lib/command/
 * grounded.ts`), extracted from `parse.ts`'s exports rather than retyped --
 * `grounded.ts` cannot import them itself (`commandPurity.test.ts`'s U1
 * audits every `.ts` file under `src/lib/command/`, not only `parse.ts`/
 * `resolve.ts`, for a runtime import), so this file -- outside that
 * directory, and already the door `formatCommand`/`parseCommand` come
 * through -- builds the lists and hands them in.
 *
 * `unassign` unions `ABSENCE_WORDS` ("off", "on leave", ...), `move` unions
 * `ADJUST_VERBS` ("extend", "shorten", ...), and `copy` unions
 * `SAME_AS_WORDS` ("same as"): each is a SECOND accepted spelling for the
 * same intent (R-409's absence grammar, R-412's `parseAdjustRest`, R-408's
 * `SAME_AS_RE`, all still `intent: "unassign"`/`"move"`/`"copy"`), found
 * live by running the existing `commandBar.test.tsx` model-reader cases red
 * before this piece landed (CB-x-14, CB-y-15) or by the reviewer reading
 * `parse.ts` directly (`SAME_AS_RE`) -- see this lane's own report.
 * `split` joins no exported list in `parse.ts` on purpose (`SPLIT_RE`'s own
 * comment: a single fixed first word, nothing to keep in sync) -- the one
 * word here is not a second copy of a rule, since there is no rule, only a
 * literal already inlined there.
 */
const GROUNDING_VERBS: VerbLists = {
  assign: ASSIGN_VERBS,
  book: BOOK_VERBS,
  unassign: [...UNASSIGN_VERBS, ...ABSENCE_WORDS],
  move: [...MOVE_VERBS, ...ADJUST_VERBS],
  headcount: HEADCOUNT_VERBS,
  replace: REPLACE_VERBS,
  swap: SWAP_VERBS,
  copy: [...COPY_VERBS, ...SAME_AS_WORDS],
  split: ["split"],
};

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
  | {
      kind: "written";
      /** F-233, third pass (S194-G3): the real id of the row this write
       *  created, when it created one -- see `PopupResult`'s own identical
       *  field (`commandConversation.ts`) for why this replaced a count. */
      id?: string;
    }
  | { kind: "refused"; message: string }
  /**
   * S195-D (DEF-0054): `waitingFor` is now the ONE plain sentence the thread
   * shows while the pop-up stands (R-459; `popupWords.ts`), never a
   * developer's phrase. `standing: false` says the pop-up may not be on
   * screen at all yet -- a create the bar may press by itself
   * (R-384/F-205 keeps such a pop-up hidden) -- so nothing is said to be
   * waiting until the pop-up itself reports that it stands
   * (`{ kind: "handed_off" }`, `CreatePopover`).
   */
  | { kind: "popup"; waitingFor: string; standing?: boolean };

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
  /**
   * F-233 (S194-G): true while any row in the window is still a
   * placeholder -- its own create (`useCreateAssignment`/
   * `useApplySplitCoverage`/`useCreateRun`) not yet replaced by the real
   * row (`optimisticId.ts`). Deliberately NOT part of `ctx`/
   * `ResolveContext`: `ctx.settled` already has an established, narrower
   * meaning (CB-showday-12 pins it: gates the "Show that day" rerun only,
   * never an ordinary new sentence) that this must not widen. A sentence
   * submitted while this is true is held and rerun once it turns false,
   * within a bound (`runCommand`'s own gate, below) -- never true unless
   * `BoardPage`'s own index actually holds a placeholder row, so it never
   * delays a sentence for an unrelated reason (a plain background refetch
   * leaves this `false`).
   */
  hasPendingCreate: boolean;
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
  /**
   * S196-A (DEF-0060, F-239, R-465, R-431): the capacity probe, asked BEFORE the
   * bar says anything about a step that places a person over a span (a create,
   * a move, a re-time -- alone, inside a lot, or as every answer of a question
   * such as "Join it, or make a separate block?"). Answers the plant's own
   * sentence ("Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2
   * pm.") when a block the caller cannot read makes the person busy
   * (`busy_elsewhere`); S200-A (R-468): `overlap` when they are busy on blocks
   * the caller CAN read and change -- a lot's step asks about it in the bar, a
   * single sentence ignores it (the board's split pop-up answers it);
   * S204-A (R-470): `overlap_locked` when one of them she can read but not
   * change -- refused up front, for a single sentence as for a lot's step; `ok` for
   * anything else. Never rejects (a probe that fails is `ok`: the server's
   * write is the gate). Omitted, the bar says and writes exactly as it did
   * before this existed -- every caller that has no probe to give.
   */
  precheck?: (step: ResolvedCommand | ResolvedMove) => Promise<PrecheckResult>;
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
  /**
   * S71-d (R-451, brief docs/agent-briefs/s71-d-mic-shortcut-brief.md): the
   * launcher's own Ctrl+M count -- this component does not listen for the
   * key itself (it is rendered only while the panel is open, so it can
   * never see a press that OPENS the panel), it just acts once per
   * increment as though the mic button had been clicked. `0` (the default,
   * and every caller that is not the launcher) never acts -- a mount is not
   * a request.
   */
  micRequest?: number;
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
 *  seam); this is the one place it is rendered through it (brief §3).
 *  S194-D third pass: GLOBAL -- a string can carry two days ("from
 *  2026-09-28 to 2026-10-02", an absence over a span), and a single replace
 *  left the second one raw. */
const ISO_DAY = /\d{4}-\d{2}-\d{2}/g;

/**
 * S194-D third pass: THE one renderer of the ISO days a resolver sentence
 * carries -- every one of them, never only the first -- in the plant's zone
 * and date format (R-426: `zonedTimeToInstant`, never a UTC midnight).
 * Exported so a test renders exactly what the person reads, never a mirror
 * of it (a mirror copied the single-replace bug and could not catch it).
 */
export function renderIsoDays(text: string, zone: string, dateFormat: DateFormat): string {
  return text.replace(ISO_DAY, (iso) => {
    const [yyyy, mm, dd] = iso.split("-").map(Number);
    return formatDayLabel(zonedTimeToInstant(zone, yyyy, mm, dd, 0, 0), dateFormat, zone);
  });
}
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
    // F-191: the plant's own today, on the board or not.
    const have = new Set(ctx.days.map((d) => d.iso));
    return isoWeekOf(ctx.todayIso)
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
  // DEF-0052 / R-432 (CONTRACT CHANGED, 28 Sept): a lot's PARTIAL failure is
  // now `buildLotOutcome`'s own SEPARATE-LINES sentence, "I made k of N
  // changes.\nDone: ...\nNot done: ...\nNot tried: ...". Its own "Done:"
  // line already names every change that landed, so this returns it as-is
  // -- appending " Written: <ran>" here too would repeat the same readouts
  // a second time, exactly the redundancy R-459's plain-sentence register
  // rules out.
  if (outcome !== null && outcome.startsWith("I made ")) return outcome;
  // CP-7 (session 178): a clean lot's last word is its own sentence --
  // "Done, N things." (R-459) -- and it is the thread's result line, the
  // readouts that landed after it. Before this, `ran` won and a lot that
  // stopped at step two read "Written: <step one>" with nothing saying why
  // it stopped (F-154's lesson, lost again on the way from the live line to
  // the thread).
  if (outcome !== null && (outcome.startsWith("Done, ") || outcome.startsWith("Did "))) {
    // DEF-0043: each readout ends in its own full stop, so they join with a
    // space -- "; " printed ".; ".
    return turn.ran.length > 0 ? `${outcome} Written: ${turn.ran.join(" ")}` : outcome;
  }
  if (turn.ran.length > 0) return `Written: ${turn.ran.join(" ")}`;
  if (outcome === null) return "";
  // S196-A: a turn filed while its write is still in flight (another sentence
  // or Escape came first) says so; the answer corrects it.
  if (outcome === WRITE_IN_FLIGHT) return "Working…";
  if (outcome.startsWith("popup: ")) {
    // S195-D: while a pop-up stands the turn's own board line IS the sentence
    // saying what it asks (`popupWords.ts`), so it is not said twice. Any
    // other "popup: ..." outcome (a held sentence's) keeps the plain prefix.
    const what = outcome.slice("popup: ".length);
    return what === turn.asked ? "" : `Waiting: ${what}`;
  }
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
    // R-459: every refusal leads with "Not done:" (the register's own
    // example, CLAUDE.md §0/this lane's brief) -- this is the ONE place a
    // genuine write-time refusal (a cap, an RLS reason, a resize guard) is
    // turned into the thread's own last line, so the prefix lives here once.
    return `Not done: ${message}`;
  }
  // F-167: the pop-up was closed without writing -- neither done nor refused.
  // S195-D: one wording for every cancel -- a pop-up's, a standing question's,
  // a lot's -- and it says what is true of all of them.
  if (outcome === "cancelled") return "Cancelled. Nothing changed.";
  return `Not done: ${outcome}`;
}

/**
 * F-207 review fix (the maintainer, 23 Sept): `HistoryTurn.answered` is not
 * always a genuine answer -- `commandConversation.ts` has no single shared
 * list of its own sentinels, so this file keeps the two it renders around in
 * one place rather than repeating the literals. `"auto"` is set by
 * `traceQuestionStatus`'s "readout" branch and by `settleWrite` for a single
 * that ran straight off its own readout, "never asked anything and never
 * answered by a word or a button" (both functions' own comments). `"escape"`
 * is set by every Escape branch in `handleKeyDown` that closes a trace entry
 * (a reading aborted, a listen stopped, a standing question dropped) --
 * a CANCEL, not a word the person said, so it reads just as wrong in a "you"
 * bubble as "auto" would. Anything else non-null is a real answer (a chip's
 * own label or a spoken/typed word) and gets the bubble.
 */
const NON_ANSWER_SENTINELS = new Set(["auto", "escape"]);

/** Reviewer fix (R-455 / F-219, 24 Sept session 191): how long a "Moved the
 *  board to …" rerun waits for the new window's ctx before giving up rather
 *  than hanging silently -- see `armPendingRerun`'s own doc. */
const PENDING_RERUN_TIMEOUT_MS = 15000;

/**
 * F-233, second pass (S194-G2): how long the FIRST sentence held while a
 * write is still settling waits before the bar gives up and refuses --
 * "on a slow connection the window is seconds wide" (the fault's own
 * words), so this is generous over an ordinary round trip without hanging
 * the bar as long as a whole new window's own fetch is allowed to
 * (`PENDING_RERUN_TIMEOUT_MS`). Starts when the FIRST sentence is held
 * (`armHoldBound`) and is NEVER restarted by a later hold or a later
 * create -- the bound is about how long the PERSON has been waiting, not
 * about the latest write. Past it, the bar does not guess: it refuses in
 * plain words (`HOLD_BOUND_MESSAGE`) rather than resolve a sentence
 * against a board that may still be missing what it is about.
 */
const HOLD_BOUND_MS = 5000;

/**
 * S196-A (F-239, R-431): the live line while a write is asked of the server, or
 * the capacity probe is. Nothing is printed as done until it is.
 */
function workingStatus(): Status {
  return { kind: "reading", message: "Working…" };
}

/** The trace entry's outcome while an ordinary write is in flight: posted at
 *  the ask (DEF-0049), corrected to written, refused or cancelled at the answer.
 *  Not a `popup:` -- nothing was handed to a pop-up. */
const WRITE_IN_FLIGHT = "writing";

/**
 * S196-A (DEF-0060, R-465): the resolved steps that place a person over a span
 * -- a create, a move to other hours or another cell, a re-time -- and so the
 * ones the capacity probe can refuse before the bar speaks.
 */
function isPlacementStep(r: { intent: string }): r is ResolvedCommand | ResolvedMove {
  return r.intent === "assign" || r.intent === "move";
}

/** "a", "a and b", "a, b and c". */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** S202-A (DEF-0067, R-449): the places of a list named once, in the order given. */
function distinctPlaces(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/**
 * S202-A (DEF-0067, R-468): the overlap question's own half -- where the time is split.
 * Each PLACE is named once. When every block is on a place of its own, none the new
 * step's, they are listed with the new one last ("between Cell 1, Cell 3 and Cell 2");
 * when two of them share a place, or one is on the new step's own place, the list
 * would repeat a name, so the question says what it means instead ("across those
 * blocks and the new one on Cell 2"). The listing's clause (`withSplit`) shares the
 * same de-duplication.
 */
function splitQuestion(o: LotOverlap): string {
  const cells = o.blocks.map((b) => b.nodeName);
  const places = distinctPlaces([...cells, o.place]);
  const where =
    places.length === cells.length + 1
      ? `between ${andList(places)}`
      : o.blocks.length === 1
        ? `between that block and the new one on ${o.place}`
        : `across those blocks and the new one on ${o.place}`;
  return `Split ${o.person}'s time evenly ${where}, or skip ${o.person}?`;
}

/**
 * S200-A (R-468): a lot step the person chose to split reads, in its own
 * sentence, whose time is split with which places -- "... making Housing A,
 * Sam Patel's time split evenly with Cell 1." -- inserted before the readout's
 * first full stop (a joined job's sentence, if any, follows it). A step with no
 * split is unchanged.
 */
function splitClause(text: string, r: ResolvedAny): string {
  if (r.intent !== "assign" || r.split === undefined) return text;
  const at = text.indexOf(" Joining the ");
  const head = at === -1 ? text : text.slice(0, at);
  const tail = at === -1 ? "" : text.slice(at);
  const bare = head.endsWith(".") ? head.slice(0, -1) : head;
  return `${bare}, ${r.split.person}'s time split evenly with ${r.split.with}.${tail}`;
}

/**
 * S198-A (R-425, R-467, R-449): the reasons a person gave for ONE write, read
 * back as plain clauses after its readout -- the ONE builder. A single
 * sentence builds it from the options it collected as it asked; a lot's listing
 * and its result lines build it from the resolved step itself (its `override`
 * and `areaOverride` ARE the reasons that step was given), so a lot of two
 * names Lena's reason with Lena's step and never on Sam's.
 */
function reasonsGivenText(reasons: { overrideReason?: string; areaReason?: string }): string {
  const parts: string[] = [];
  if (reasons.overrideReason !== undefined)
    parts.push(` The reason given: ${reasons.overrideReason}.`);
  if (reasons.areaReason !== undefined)
    parts.push(` The area reason given: ${reasons.areaReason}.`);
  return parts.join("");
}

/** The reasons a resolved step of a lot was given, as `reasonsGivenText` reads them. */
function reasonsOfStep(r: ResolvedAny): { overrideReason?: string; areaReason?: string } {
  const step = r as { override?: { reason: string }; areaOverride?: { reason: string } };
  return {
    ...(step.override ? { overrideReason: step.override.reason } : {}),
    ...(step.areaOverride ? { areaReason: step.areaOverride.reason } : {}),
  };
}

/**
 * F-233, second pass: the exact words past the bound (the main session's
 * own choice, to be shown to the maintainer -- built exactly, never
 * reworded). Read by both the live status and the trace/thread entry each
 * dropped held sentence closes with, so the two can never drift apart.
 */
const HOLD_BOUND_MESSAGE = "The board is still saving your last change. Say it again in a moment.";

/** S194-D (R-430): how many of the caller's own people or parts a dead-end
 *  person/part question offers -- the resolver's own cap for a place or part
 *  list (`offeredSuggestions`/`trackCellSuggestions`, resolve.ts: eight). */
const UNKNOWN_FALLBACK_CAP = 8;

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
/**
 * S71-m review fix (F-212, R-435): "yes" must answer a one-button question,
 * and `askUngrounded`'s own question is one -- but it carries no
 * `blockHighlight` (there is no board block to outline: nothing has
 * resolved yet). Rather than hand it a `blockHighlight` it does not mean
 * (that shape also drives `confirmsQuestion`'s "remove it"/"move it" words
 * and the kind-specific re-ask wording below, none of which apply to an
 * ungrounded book/assign/move/headcount reading), this is the SAME
 * "exactly one candidate that a bare yes actually answers" test
 * `answerTakes` and `submitText`'s own floor each used to compute on their
 * own (CLAUDE.md §7: the same predicate, one place), now also true for a
 * question whose one candidate is `run_ungrounded`.
 *
 * R-456 / F-222 (24 Sept, session 191): widened the same way again for
 * `run_sentence` -- a verb-guess question with exactly one candidate
 * (`verbGuessStatus`, above) is answered by a bare "yes" the identical
 * reason `run_ungrounded`'s single-button ask is: nothing to pick between,
 * only to confirm. CB-ground-5/6 (this file) pin the case this widening
 * keeps unbroken: the F-212 shape ("Housing A on Cell 1 ... from 6 to 2",
 * no verb at all) used to ask through `askUngrounded` (`run_ungrounded`);
 * `verbGuessStatus` now answers it FIRST (§4's own "before refuseUngrounded/
 * askUngrounded"), with `guessVerbs`' own shape-candidate rule reconstructing
 * the identical one sentence ("book " + the heard text) as its one
 * candidate -- a `run_sentence` action, not `run_ungrounded`, so this
 * predicate has to name it too or "yes" stops answering a question that
 * still only ever offers one thing to agree to.
 */
function isYesShapedQuestion(status: Status): boolean {
  if (status.kind !== "question" || status.candidates.length !== 1) return false;
  if (status.blockHighlight !== undefined && !Array.isArray(status.blockHighlight)) return true;
  const kind = status.candidates[0].action.kind;
  return kind === "run_ungrounded" || kind === "run_sentence";
}

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
  if (status.yesNo) return "yes or no";
  if (status.candidates.length === 0) return null;
  if (status.candidates.every((c) => c.action.kind === "show_day")) return null;
  // S62-b reviewer fix (A): ONLY A YES-SHAPED QUESTION OFFERS "yes".
  // `withBlockHighlight` appends the yes suffix to exactly one shape -- a
  // block question (remove_which / move_which / block_exists) with exactly
  // one candidate -- and that is the only single-button question a bare
  // "yes" actually answers. `run_exists` ("Join it, or make a separate
  // block?"), `ambiguous` ("Which person?"), `job_gone`, `block_gone` all
  // take a NAME; offering "yes" there invited a word the question refuses.
  // S71-m review fix: `isYesShapedQuestion` widens this by one more shape,
  // `run_ungrounded`'s own one-button question -- see that function's own
  // doc.
  // "or no" on every one of them: a cancel word now drops any standing
  // question (see `submitText`'s own floor), so it is always a true answer.
  return isYesShapedQuestion(status) ? "yes or no" : "a name, or no";
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
  // R-459: no shape was read at all -- "I did not understand that." plus the
  // one worked example (`expectedShape`, parse.ts), never the old four-
  // grammar reference card.
  return { kind: "shape", message: `I did not understand that. ${shape}` };
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

/**
 * S194-D (R-432 restated 28 Sept, R-459): widened from the one capacity shape
 * to every refusal a writer answers the bar with in the plant's words -- the
 * ONE rewriter (R-449), used by the single sentence's refusal (`settleWrite`,
 * the pop-up reporter) and by a lot's "Not done:" line (`buildLotOutcome`)
 * alike, so the two can never say the same refusal two ways. Matched on each
 * message's SHAPE, as the capacity one always was; a message matching none
 * passes through unchanged (the report lists which kinds still do).
 */
const NOT_CERTIFIED_REFUSAL = /^(.+) is not certified for (.+): missing (.+)\.$/;
const NO_EDIT_RIGHTS_REFUSAL = /^You don't have permission to edit (.+)\.$/;
const AREA_REFUSAL =
  /^That person belongs to a different part of the structure, so it can't be used here\.$/;
const ABSENCE_OVERLAP_REFUSAL =
  /^This person already has an absence over some of those days(?: \(.*\))?\.$/;

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A node id as the server prints it. */
const NODE_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `nodeNameOf` (S202-A, DEF-0065, R-459) answers a node id with the cell's own name
 * from the board the bar reads, or null for an id it does not know (another
 * company's node, a stale board): the server's "You don't have permission to edit
 * <node id>." is then said with the name, or as "that block", never as a uuid.
 */
function rewriteRefusal(
  message: string,
  nodeNameOf: (id: string) => string | null = () => null,
): string {
  const cap = CAP_REFUSAL.exec(message);
  if (cap) {
    const [, name, peak, capPct] = cap;
    return `${name} would be over the cap today (${peak}% of ${capPct}%). Nothing changed.`;
  }
  const cert = NOT_CERTIFIED_REFUSAL.exec(message);
  if (cert) {
    const [, name, cell, missing] = cert;
    const skills = missing.split(", ").filter((x) => x !== "");
    return `${name} is not certified for ${joinWithAnd(skills)}, which ${cell} needs.`;
  }
  const rights = NO_EDIT_RIGHTS_REFUSAL.exec(message);
  if (rights) {
    const named = nodeNameOf(rights[1]);
    if (named !== null) return `You cannot change ${named} from here.`;
    // A message that already carries a name (the toast layer's own wording) stays;
    // an id nobody can read is never printed.
    if (NODE_ID_SHAPE.test(rights[1])) return "You cannot change that block from here.";
    return `You cannot change ${rights[1]} from here.`;
  }
  if (message === "You don't have permission to change that.") {
    return "You cannot change that from here.";
  }
  if (message === "You do not have edit rights on this cell.") {
    return "You cannot change this cell from here.";
  }
  if (AREA_REFUSAL.test(message)) return "That person is not from this cell's area.";
  if (ABSENCE_OVERLAP_REFUSAL.test(message)) {
    return "An absence is already recorded on some of those days.";
  }
  // F-233 (S194-G): `describeSchedulerError`'s own catch-all for an
  // `Unknown`-kind error (errors.ts) -- an unexpected server refusal a lot
  // step hits (the placeholder-id race this lane fixes was one; any other
  // unclassified error is another). Named by its own `attempted` already
  // (`buildLotOutcome`'s "Not done: <attempted>. <reason>"), so the reason
  // only needs to say THIS ONE step went wrong, never repeat the generic
  // "try again" a person cannot act on mid-lot.
  if (message === "Something went wrong. Please try again.") {
    return "Something went wrong with that one.";
  }
  return message;
}

export function CommandBar({
  ctx,
  hasPendingCreate,
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
  precheck,
  reader = null,
  recognizer = null,
  recognizerName,
  micRequest = 0,
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
  // Reviewer fix (R-455, 24 Sept session 191): a pending rerun's own bound --
  // see `armPendingRerun`/`clearPendingRerun` below, near the effect that
  // consumes it.
  const pendingRerunTimeoutRef = useRef<number | null>(null);
  /**
   * F-233, second pass (S194-G2, finding 2): sentences held because a write
   * was still settling when they were submitted -- a QUEUE now, run in the
   * order they were said, each to its own outcome, each with its own trace
   * entry (`entry`, detached from `traceRef` the instant it is held --
   * `fileOpenTurn` below posts it into the thread right away, and a later
   * `startTrace` for the NEXT sentence must not re-finish it a second time).
   * The single-slot ref this replaced (`pendingUnsettledRef`) dropped every
   * held sentence but the last; this is a plain array for exactly the
   * reason a store field is not needed for it (see the old comment's own
   * reasoning, still true): the wait is at most a few seconds, never
   * something that needs to survive this component remounting.
   */
  const heldQueueRef = useRef<
    {
      command: Command;
      suffix: string | undefined;
      options: ResolveOptions | undefined;
      entry: TraceEntry;
      // F-233, second pass, review fix: true once a LATER sentence's own
      // `startTrace` -> `finishTrace()` has already flushed this entry into
      // the thread the ordinary way (F-162's existing supersede rule) --
      // set the moment `holdSentence` sees it happen (only the queue's
      // previous LAST item can ever be the one superseded, since nothing
      // else touches `store.trace` while sentences are held). `drainHeldQueue`
      // reads it to tell `commandConversation.ts` this entry is already
      // filed before letting it resolve again, so the SAME row is patched
      // (`fileTurn`'s "already filed" branch) instead of appended a second
      // time. The item that has NEVER been superseded (ordinarily the
      // queue's own last one, at push time) stays `false`: it has no row
      // yet, so its own first resolution is correctly a fresh append.
      filed: boolean;
    }[]
  >([]);
  /**
   * F-233, second pass (finding 1): the bar's OWN count of writes it has
   * itself called and not yet seen reflected on the board -- the exact
   * signal the brief asks for, in place of the cache-derived
   * `hasPendingCreate` prop (kept only as a fallback for a drag/pop-up's own
   * write, which the bar never calls itself). `inFlight` is up the instant a
   * writer prop is called (before any await -- see every call site below)
   * and down the instant its own outcome is KNOWN (written/refused,
   * synchronously or via its promise); at that same moment `awaitingCtx`
   * goes up, and it is only cleared by the `[ctx]` effect below actually
   * observing a NEW `ctx` -- "at least until the writer's promise settles
   * AND the refetch it triggers has landed" (the brief's own words), never
   * just the first half.
   */
  const barWritesInFlightRef = useRef(0);
  const barWritesAwaitingCtxRef = useRef(0);
  /** F-233, second pass, review fix: the `ctx` reference the `[ctx,
   *  hasPendingCreate]` effect below last cleared `barWritesAwaitingCtxRef`
   *  for -- see that effect's own comment for the race this closes (a
   *  `hasPendingCreate`-only render clearing the wait against a STALE
   *  `ctx`). `null` at mount is never mistaken for "already drained": the
   *  effect only compares against a NON-null `ctx`. */
  const lastDrainedCtxRef = useRef<ResolveContext | null>(null);
  /**
   * F-233, third pass (S194-G3): THE COUNT PROXY IS GONE. `awaitingRowCountRef`
   * (the second pass's own fix: wait until `ctx.assignments.length`/
   * `ctx.runs.length` had grown past a snapshot taken at dispatch) broke the
   * app on the real walk -- every sentence after a create was held the full
   * five seconds and refused, even minutes later, even once the row was
   * confirmed in the database. Two real bugs, not one: (1) `dropHeldQueue`
   * (the bound's own refusal) reset `barWritesInFlightRef`/
   * `barWritesAwaitingCtxRef` back to zero but never cleared
   * `awaitingRowCountRef` itself -- once the FIRST create's own wait timed
   * out, that stale snapshot stayed armed and silently gated every LATER
   * write's own "has ctx caught up" check for the rest of the session,
   * whether or not that later write had anything to do with a create at
   * all. (2) even freshly taken, a count is not the row: the FIRST render
   * after a create's own refetch lands can already include OTHER rows this
   * component never asked about (another person's own placement, a
   * background sync, anything else changing in the same window) that move
   * the count without the AWAITED row's own presence being what moved it,
   * and conversely a `ctx` that legitimately drops a DIFFERENT row in the
   * very same refetch can hold a count at or below the snapshot even though
   * the awaited row is right there. Proven by mutation in this pass's own
   * report; not repaired here on the maintainer's own instruction --
   * replaced.
   *
   * The brief's own exact mechanism: the writers now answer the REAL id of
   * the row they made (`WriteOutcome`/`PopupResult`'s own `id` field), and
   * this ref remembers which one, and which collection (`ctx.assignments`
   * or `ctx.runs`), the bar is waiting to see. `null` means either nothing
   * is held for a create's own reason, or the create's own row can never
   * legitimately appear in `ctx` at all (see `dayIsInCtxWindow` below) --
   * either way an ordinary write's own wait (a genuinely new `ctx`,
   * `lastDrainedCtxRef`'s own check, no id needed) is all that applies.
   */
  const awaitingRowIdRef = useRef<{ collection: "assignments" | "runs"; id: string } | null>(null);
  /**
   * F-233, third pass: which collection a create in flight would land in,
   * set the instant the writer is called (before its own outcome is known)
   * so `settleWrite`'s `apply`/`popupReporterFor`'s own returned function --
   * neither of which otherwise knows whether the entry it is closing was a
   * create at all -- can tell `awaitingRowIdRef` which array the id it is
   * eventually handed belongs to. `null` for every write that is not a
   * create (unassign, move, retime, headcount) and for a create whose own
   * target day this render's `ctx` does not cover (`dayIsInCtxWindow`),
   * since neither ever has an id worth waiting for.
   */
  const pendingCreateCollectionRef = useRef<"assignments" | "runs" | null>(null);
  /** F-233, second pass: the hold's own five-second bound
   *  (`HOLD_BOUND_MS`) -- armed once, by the FIRST sentence held while the
   *  queue is empty, and never re-armed by a later hold (the brief: "a
   *  later create does not restart it"). */
  const holdBoundTimeoutRef = useRef<number | null>(null);
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
  // S71-j (R-454, docs/agent-briefs/s71-j-progress-words-out-of-the-input-
  // brief.md): the maintainer's 23 Sept screenshot -- "Why is it writing the
  // listening and transcribing in the chat box? ... there is also a
  // listening indicator right by the microphone" -- the input never shows a
  // word the person did not type or say. `interimHint` is the recogniser's
  // latest PARTIAL transcript (`onInterim`, below), shown only as the
  // input's placeholder (`answerTakes(status) ?? PLACEHOLDER` still wins
  // once this is empty again); `micPhase` is the recogniser's own progress
  // (`onStatus`, "listening" or "transcribing"), shown beside the mic
  // button, never in the box at all. Both are reset in `endSession()` below
  // -- a fresh press starts with neither standing from the last session.
  // This replaces F-206's own `lastInterimTextRef` (S71-i): that ref existed
  // only to tell a genuinely typed sentence apart from a status word
  // `onInterim` had written into the same box's VALUE; now that neither an
  // interim nor a status word is ever written into the value at all, there
  // is nothing left for a second mic press to clean up there.
  const [interimHint, setInterimHint] = useState("");
  const [micPhase, setMicPhase] = useState<"listening" | "transcribing" | null>(null);
  // S59-e (R-421, brief §3): one trace entry in progress for the CURRENT
  // sentence, `null` whenever none is open. A ref, not state, same reason as
  // `heldRef`/`lotRef` above: read and written from event handlers and one
  // `.then()`, never rendered.
  const traceRef = storeRef(store, "trace");
  // S71-f (R-453, R-434, brief docs/agent-briefs/s71-f-clip-capture-brief
  // .md §1.B): the local recogniser's `onClip` fires strictly BEFORE the
  // `onFinal`/`onError` that answers it (`localRecognizer.ts`'s own doc:
  // posted right before the fetch) -- so there is no trace entry open yet
  // to carry its numbers when it arrives. This stashes them; `startTrace`
  // in listening's `onFinal`/`onError` below reads it via
  // `attachPendingClip` once the fresh entry for THIS clip's outcome
  // actually exists.
  //
  // Review fix (session leak): `seq` is the STASHING session's own `mySeq`
  // (`startListening`'s local constant, captured once per session, never
  // mutated by a later session ending) -- not the shared, mutable
  // `recognitionSeqRef.current`. A session A can fire `onClip` (stashing
  // here) and then be superseded (stop, then a fresh press starts session
  // B) before A's own `onFinal`/`onError` ever arrives; A's callbacks are
  // then no-ops (`isCurrent()`), so nothing ever consumes or clears A's
  // stash on its own path. Without a stamp, B's `attachPendingClip` would
  // find A's stale clip still sitting here and attach A's numbers (and
  // repost A's WAV) onto B's unrelated entry. `attachPendingClip` compares
  // the stash's `seq` against the CALLING session's own `mySeq` (a stable
  // closure constant, immune to any session's `endSession()` bumping the
  // shared ref), so a stash from any other session is always ignored;
  // `endSession()` also clears this outright, so a superseded session's
  // stash cannot outlive it even before a next session ever starts.
  const pendingClipRef = useRef<{ seq: number; info: ClipInfo } | null>(null);
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
  // F-233 (S194-G): mirrors the `hasPendingCreate` prop into a ref for the
  // same reason `lastCtxRef` exists -- `runCommand`'s own retry (below) is
  // scheduled by a `setTimeout` that may fire many renders later, and a
  // plain captured variable in that closure would read whatever this prop
  // was AT SCHEDULING TIME, not the current one. Assigned every render
  // (not inside an effect): a ref mirror needs no effect, only to always
  // hold the latest value by the time anything reads `.current`.
  const hasPendingCreateRef = useRef(hasPendingCreate);
  hasPendingCreateRef.current = hasPendingCreate;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  /**
   * F-233, third pass (item 4, "a row outside the board's window"): a
   * create whose own target range falls entirely within the days `ctx`
   * currently covers CAN appear in `ctx.assignments`/`ctx.runs` once the
   * refetch lands; one that does not (a copy to another week, a repeat over
   * next week -- R-455 moves the board for an ordinary single sentence
   * naming an off-board day BEFORE it ever resolves, so this is mostly a
   * safety net rather than the everyday case) never will, and arming an
   * id-wait for it would hold every later sentence for the full five
   * seconds, always, for a write that actually succeeded -- the same fault
   * this pass exists to fix, wearing a different hat. `range` is in minutes
   * from `ctx.windowStart`, the same units `buildCreateAssignmentInput`
   * already sends the server; the window's own span is `ctx.days.length`
   * full days.
   */
  function dayIsInCtxWindow(
    range: { startMin: number; endMin: number },
    activeCtx: ResolveContext,
  ): boolean {
    const windowMinutes = activeCtx.days.length * 1440;
    return range.startMin >= 0 && range.endMin <= windowMinutes;
  }

  /**
   * F-233, second pass: true while a sentence submitted right now would be
   * resolved against a board that may not yet reflect a write already
   * asked for -- the bar's own writes (`barWritesInFlightRef`/
   * `barWritesAwaitingCtxRef`) OR the cache-derived fallback
   * (`hasPendingCreateRef`, a drag/pop-up's own create). `runCommandBody`'s
   * own hold gate and `drainHeldQueue`'s own loop both read this, and only
   * this -- never `ctx.settled`.
   */
  function writesStillSettling(): boolean {
    return (
      barWritesInFlightRef.current > 0 ||
      barWritesAwaitingCtxRef.current > 0 ||
      hasPendingCreateRef.current
    );
  }

  /** F-233, second pass: a writer's own outcome is now known (written or
   *  refused -- never called for "popup", which is not an ending). Moves
   *  the count from "in flight" to "awaiting ctx": the write happened, but
   *  nothing may safely be said to have caught up with it until the `[ctx]`
   *  effect below actually observes a fresh `ctx`. */
  function barWriteSettled(alreadyReleased = false): void {
    // S195-D: a write that waited on a pop-up gave its "in flight" count back
    // when the pop-up began to stand (nothing is being written while a person
    // decides, so a new sentence must not be held behind it), and only
    // starts the catch-up half now that the pop-up has answered.
    if (!alreadyReleased) {
      barWritesInFlightRef.current = Math.max(0, barWritesInFlightRef.current - 1);
    }
    barWritesAwaitingCtxRef.current += 1;
    // F-233, fourth pass, THE CAUSE AS SEEN IN A BROWSER (29 Sept). Every
    // mutation the board makes keeps its promise open until the refetch after
    // it has landed, so by the time a writer answers, the board has usually
    // ALREADY been handed the `ctx` that holds the result: the `[ctx]` effect
    // below ran first, found nothing to wait for, and no further `ctx` ever
    // comes. Waiting for "the next new ctx" then waits for something that has
    // already happened, until the bound refuses the sentence -- which is what
    // the second and third passes did after every create. So the question
    // "has the board caught up?" is asked of the `ctx` the bar holds NOW, one
    // macrotask on (so a render already scheduled has committed, and so the
    // caller, which arms `awaitingRowIdRef` right after this returns, has done
    // so), and asked again by the effect on every later `ctx`.
    window.setTimeout(checkCaughtUp, 0);
  }

  /** Has the board the bar holds now caught up with the bar's own last write?
   *  For a create, when it holds the row the server answered with, by id. For
   *  any other write, as soon as the writer has answered, because its promise
   *  does not settle before the refetch has landed. */
  function checkCaughtUp(): void {
    if (barWritesAwaitingCtxRef.current === 0) {
      drainHeldQueue();
      return;
    }
    const need = awaitingRowIdRef.current;
    const held = ctxRef.current;
    const rowLanded =
      need === null ||
      (held !== null &&
        (need.collection === "assignments"
          ? held.assignments.some((a) => a.id === need.id)
          : held.runs.some((r) => r.id === need.id)));
    if (rowLanded) {
      awaitingRowIdRef.current = null;
      barWritesAwaitingCtxRef.current = 0;
    }
    drainHeldQueue();
  }

  /** F-233, second pass: a writer's own outcome resolved to nothing having
   *  been asked of the server at all (a pop-up closed without writing) --
   *  there is nothing new for `ctx` to catch up WITH, so this drops the
   *  count outright rather than moving it to "awaiting ctx". */
  function barWriteAbandoned(): void {
    barWritesInFlightRef.current = Math.max(0, barWritesInFlightRef.current - 1);
  }

  /**
   * F-233, second pass (finding 4): while a sentence is held, the bar shows
   * the SAME status a write already in flight shows -- "Working…", never a
   * new word -- and the entry is posted AT ONCE, DEF-0049's own shape (post
   * at the ask, correct at the outcome) -- the SAME call
   * `traceQuestionStatus`'s own "question" branch already makes,
   * `postTrace(entry)`, to the dev trace file, not the thread.
   *
   * Review fix: this used to also call `fileOpenTurn` (filing a "Waiting: …"
   * row into the THREAD right away) and null `traceRef.current`. Two bugs
   * came from that: (1) `fileOpenTurn` marks the store's own single
   * `filedTurnAt` slot -- a SECOND held sentence stole it from the first,
   * so the first's row could never be patched again (`fileTurn`'s own
   * "already filed" check only matches the LAST one marked) and drained
   * either stale or duplicated; (2) nulling `traceRef.current` threw away
   * "this is still the open turn", so a held sentence that resolved to a
   * QUESTION (not a terminal write) after draining rendered as a second,
   * separate live bubble next to the stale filed row instead of the one
   * turn continuing.
   *
   * Left alone (`traceRef.current` untouched, still this entry), a held
   * sentence is filed into the thread the SAME way an ordinary, un-held
   * question already is when something supersedes it before it is
   * answered (F-162): the NEXT sentence's own `startTrace` -> `finishTrace()`
   * flushes it with a plain `appendTurn`, no special marker needed. Its
   * real outcome, once known, then corrects that SAME row through
   * `settleTurn`'s existing "superseded" branch (an `at`-matched
   * `updateTurn`, not `filedTurnAt` at all). `drainHeldQueue` marks `filed`
   * on the record above so it can tell `commandConversation.ts` this one
   * needs that same "already filed" treatment on the way back in, since
   * restoring it as `traceRef.current` there would otherwise look "still
   * current" (never filed) to `settleTurn` all over again.
   */
  function holdSentence(
    command: Command,
    suffix: string | undefined,
    options: ResolveOptions | undefined,
  ): void {
    const entry = traceRef.current;
    if (entry) {
      entry.outcome = "popup: the board to finish saving your last change";
      postTrace(entry);
      const queue = heldQueueRef.current;
      // This sentence's own `startTrace` (called by `submitText` just
      // before `runCommand` reached this hold gate) already flushed
      // whatever was `store.trace` a moment ago -- the queue's previous
      // last item, if there is one.
      if (queue.length > 0) queue[queue.length - 1].filed = true;
      queue.push({ command, suffix, options, entry, filed: false });
    }
    setStatus({ kind: "reading", message: "Working…" });
    armHoldBound();
  }

  /** F-233, second pass: the hold's own bound -- armed once, by the first
   *  sentence held while nothing else is already waiting; a later hold
   *  never restarts it (the brief's own words). */
  function armHoldBound(): void {
    if (holdBoundTimeoutRef.current !== null) return;
    holdBoundTimeoutRef.current = window.setTimeout(() => {
      holdBoundTimeoutRef.current = null;
      dropHeldQueue();
    }, HOLD_BOUND_MS);
  }

  function clearHoldBound(): void {
    if (holdBoundTimeoutRef.current !== null) {
      window.clearTimeout(holdBoundTimeoutRef.current);
      holdBoundTimeoutRef.current = null;
    }
  }

  /**
   * F-233, second pass ("Past the bound"): every sentence still held past
   * the five-second bound is refused with the SAME plain sentence,
   * `HOLD_BOUND_MESSAGE` -- never resolved against a board that may still
   * be missing what it is about. Each one's own trace entry is closed with
   * that reason; the live status shows it too, once, for the last one (the
   * person's own most recent wait).
   *
   * F-233, third pass (S194-G3): THE LEAK THAT BROKE THE REAL APP.
   * `awaitingRowIdRef`/`pendingCreateCollectionRef` were never reset here in
   * the second pass -- once the FIRST create's own wait timed out (this
   * function ran), its stale id stayed armed and silently gated the `[ctx,
   * hasPendingCreate]` effect's own "has the board caught up" check for
   * every write after it, for the rest of the session, whether or not that
   * later write had anything to do with a create at all. That is why the
   * real walk took over four minutes where it takes thirty seconds: not one
   * sentence held, every sentence after the first create held, each for the
   * full five seconds. Cleared here now, the same as the write counters
   * just above.
   */
  function dropHeldQueue(): void {
    const held = heldQueueRef.current;
    heldQueueRef.current = [];
    barWritesInFlightRef.current = 0;
    barWritesAwaitingCtxRef.current = 0;
    pendingCreateCollectionRef.current = null;
    awaitingRowIdRef.current = null;
    for (const h of held) {
      h.entry.outcome = `refused: ${HOLD_BOUND_MESSAGE}`;
      settleTurn(store, h.entry);
    }
    if (held.length > 0) {
      setStatus({ kind: "shape", message: HOLD_BOUND_MESSAGE });
    }
  }

  /**
   * F-233, second pass (finding 3): Escape, or a typed cancel word, while
   * one or more sentences are held -- every one of them is dropped, write
   * nothing, each closed with `outcome: "cancelled"` (the same word every
   * other cancel in this file uses, `cancelStanding`'s own). UNLIKE
   * `dropHeldQueue` (the bound's own refusal), the write counters are left
   * alone: the ORIGINAL write the hold was waiting on is not itself
   * cancelled by this -- only the sentences said while it was still
   * settling are. Returns whether anything was actually dropped, so the
   * caller (Escape, a cancel word) can decide whether it still owes the
   * rest of its own usual handling.
   */
  function dropHeldQueueAsCancelled(answeredWith: string): boolean {
    const held = heldQueueRef.current;
    heldQueueRef.current = [];
    clearHoldBound();
    for (const h of held) {
      setAnswered(h.entry, answeredWith);
      h.entry.outcome = "cancelled";
      settleTurn(store, h.entry);
    }
    return held.length > 0;
  }

  /**
   * F-233, second pass (finding 2): drains the queue in order, one
   * sentence at a time, stopping the instant a write is settling again
   * (the sentence just drained started one of its own) OR a question/lot
   * is standing (F-162's existing rule: a sentence typed while one stands
   * is not a new sentence to resolve -- the ones still queued wait for a
   * person to answer or cancel it, exactly as they would if they had been
   * typed just now instead of held).
   *
   * Review fix: the standing check reads `status?.kind === "question"`
   * (the SAME predicate the rest of this file already uses for F-162, see
   * `handleKeyDown`/`submitText`'s own reads of it) rather than a blanket
   * `status === null`. Finding 4 has `holdSentence` set `status` to its own
   * "Working…" (`kind: "reading"`) for as long as something is held -- a
   * plain `=== null` check would read THAT as if it were a standing
   * question too, and nothing ever drains: the hold's own status would be
   * mistaken forever for the very thing draining is supposed to replace.
   */
  function drainHeldQueue(): void {
    while (
      heldQueueRef.current.length > 0 &&
      !writesStillSettling() &&
      store.getState().status?.kind !== "question" &&
      lotRef.current === null
    ) {
      const held = heldQueueRef.current.shift()!;
      traceRef.current = held.entry;
      // See `holdSentence`'s own doc: an item already flushed into the
      // thread (every one except an un-superseded last) needs
      // `filedTurnAt` set so its real outcome PATCHES that same row
      // instead of a second `appendTurn` for the same `at`. `fileTurn`
      // clears this itself once it reads it, so nothing here undoes it
      // for the next item.
      if (held.filed) store.getState().set({ filedTurnAt: held.entry.at });
      runCommand(held.command, held.suffix, held.options);
    }
    // F-233, second pass: the bound is about a SENTENCE sitting in the
    // queue, not about whatever write happens to be pending right now --
    // once nothing is held, there is nothing left for it to be timing.
    if (heldQueueRef.current.length === 0) clearHoldBound();
  }

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
    // R-427: a new sentence offers nothing yet. S194-D: and has asked nothing.
    store.getState().set({ offered: [], traceCarry: null });
  }

  /**
   * R-434 (S194-D): the entry's `asked` -- after whatever this sentence
   * already asked and had answered (`traceCarry`, set when a night shift
   * question is answered, R-461), so one sentence that asks two questions in
   * a row is ONE entry holding both asks, in order, newline-joined. With no
   * carry, byte for byte the plain assignment it replaces.
   */
  function setAsked(entry: TraceEntry, message: string): void {
    const carry = store.getState().traceCarry;
    entry.asked = carry ? `${carry.asked}\n${message}` : message;
  }

  /** R-434 (S194-D): the entry's `answered`, the twin of `setAsked`. */
  function setAnswered(entry: TraceEntry, value: string): void {
    const carry = store.getState().traceCarry;
    entry.answered = carry ? `${carry.answered}\n${value}` : value;
  }

  /** S71-f (brief §1.B): call once the fresh trace entry for a clip's
   *  outcome actually exists (right after `startTrace` ran, whether that
   *  was `onFinal`'s `submitText` or `onError`'s own direct call) -- attaches
   *  `pendingClipRef`'s numbers to it and posts the WAV to `/__clip` under
   *  that entry's own `at`, then clears the ref so a later, unrelated
   *  trace entry never picks up a stale clip. A no-op when no clip is
   *  pending (a typed sentence, a confirm word, a session that never
   *  reached `onClip` at all) or when the session went stale before this
   *  ran (`isCurrent()` already guards every caller).
   *
   *  Review fix (session leak): `callerSeq` is the CALLING session's own
   *  `mySeq` -- when the stashed clip's `seq` disagrees, it belongs to an
   *  earlier, superseded session (stop, then a fresh press, before that
   *  session's own `onFinal`/`onError` ever arrived) and is dropped rather
   *  than attached to this unrelated entry. See `pendingClipRef`'s own doc. */
  function attachPendingClip(callerSeq: number): void {
    const pending = pendingClipRef.current;
    pendingClipRef.current = null;
    if (!pending || pending.seq !== callerSeq || !traceRef.current) return;
    const info = pending.info;
    traceRef.current.clip = {
      durationMs: info.durationMs,
      recordedMs: info.recordedMs,
      endedBy: info.endedBy,
      speechStarted: info.speechStarted,
      peakRms: info.peakRms,
      meanRms: info.meanRms,
      framesAboveFloor: info.framesAboveFloor,
    };
    postClip(traceRef.current.at, info.wav, traceRef.current.clip, info.hint);
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
      // Reviewer fix (R-455): a pending rerun's own timeout (`armPendingRerun`)
      // is exactly the same shape of leftover -- nothing left mounted for it
      // to post a readout into once it fires.
      if (pendingRerunTimeoutRef.current !== null) {
        window.clearTimeout(pendingRerunTimeoutRef.current);
        pendingRerunTimeoutRef.current = null;
      }
      // F-251 (1 Oct, session 200): the hold's five-second bound
      // (`armHoldBound`) is the same shape of leftover again. Left armed
      // past unmount it fired into whatever bar stood NEXT -- in the unit
      // suite, a later test's fetch stub received a stale entry's "did not
      // catch up" refusal as its last post, and three unrelated cases went
      // red by turns under six workers (CB-rep-1, CB-pre-10, CB-night-1).
      if (holdBoundTimeoutRef.current !== null) {
        window.clearTimeout(holdBoundTimeoutRef.current);
        holdBoundTimeoutRef.current = null;
      }
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

  /**
   * Reviewer fix (R-455 / F-219, 24 Sept session 191): a pending rerun used
   * to wait for a `ctx` that names its target FOREVER -- if the window's own
   * fetch for the new day never lands (an error the board's own render gate
   * treats as "no board data at all", or any other way the new window's ctx
   * never actually arrives with the target on it), `pendingRerunRef` just
   * sat there, the "Moved the board to …" turn never got a second word, and
   * the rerun's own command silently never ran -- no readout, no refusal,
   * nothing (R-434's own "every write is a trace entry" broken the same way
   * the known hole was, just by a different door). This bounds it: arming a
   * pending rerun also arms a timeout; if nothing has consumed the SAME
   * rerun by the time it fires, it drops itself and closes the entry with a
   * refusal rather than hanging silently.
   */
  function clearPendingRerunTimer(): void {
    if (pendingRerunTimeoutRef.current !== null) {
      window.clearTimeout(pendingRerunTimeoutRef.current);
      pendingRerunTimeoutRef.current = null;
    }
  }

  /** Drops whatever pending rerun stands, if any, and its timer -- the one
   *  function every existing "a typed edit / a cancel word / Escape / a new
   *  sentence drops the pending rerun" site now calls, so none of them can
   *  leave a stale timer counting down toward a rerun that is already gone. */
  function clearPendingRerun(): void {
    clearPendingRerunTimer();
    pendingRerunRef.current = null;
  }

  function armPendingRerun(command: Command, target: string): void {
    clearPendingRerunTimer();
    // R-455 (S194-D): the answers already given to this sentence ride along,
    // so the rerun after the board moves never asks them again.
    pendingRerunRef.current = { command, target, options: { ...heldOptionsRef.current } };
    pendingRerunTimeoutRef.current = window.setTimeout(() => {
      pendingRerunTimeoutRef.current = null;
      // A no-op unless THIS SAME rerun is still the one standing -- a later
      // sentence, cancel, Escape or a successful rerun already cleared it
      // (and its own timer with it) by the time this fires.
      if (
        pendingRerunRef.current === null ||
        pendingRerunRef.current.command !== command ||
        pendingRerunRef.current.target !== target
      ) {
        return;
      }
      pendingRerunRef.current = null;
      if (traceRef.current) {
        traceRef.current.outcome = `refused: Could not load ${target}.`;
      }
      finishTrace();
    }, PENDING_RERUN_TIMEOUT_MS);
  }

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
    // R-455 / F-219 (24 Sept, session 191): `ctx.settled` gates this exactly
    // like `isTargetOnBoard` does -- a ctx whose `days` axis already names
    // the target but whose `assignments`/`runs` are still the PREVIOUS
    // window's (`keepPreviousData`, `settled: false` while `BoardPage`'s own
    // fetch is in flight) leaves `pendingRerunRef` standing rather than
    // re-running `command` against data that has not caught up -- the same
    // race `isTargetOnBoard` was already built to gate, one layer deeper
    // (that one asks "is the target ON the axis"; this one asks "is
    // EVERYTHING ELSE about this ctx actually the target's own window").
    // `ctx !== null` already implies `ctx.settled` is a real boolean, not a
    // guess -- `settled: false` is a flag on a full ctx, never a reason for
    // this bar to go null (R-424).
    if (
      ctx !== null &&
      ctx.settled &&
      pendingRerunRef.current &&
      isTargetOnBoard(pendingRerunRef.current, ctx)
    ) {
      const { command, options } = pendingRerunRef.current;
      clearPendingRerun();
      runCommand(command, undefined, options);
    }
    // F-233, second pass (S194-G2): a NEW `ctx` is exactly "the board caught
    // up with itself" -- `barWritesAwaitingCtxRef`'s own wait ends here,
    // whatever write it was for (the bar's own, or the cache-derived
    // fallback's), and the held queue gets a chance to drain. No
    // `isTargetOnBoard` check: this was never about a day/place target,
    // only about a pending write catching up with itself.
    //
    // Review fix, found by the reviewer's own reproduction ("Cell 1 has
    // nobody on it" over a block just placed) surviving the first version of
    // this fix: this effect's own dependency array is `[ctx, hasPendingCreate]`
    // -- `hasPendingCreate` can flip false on a render where `ctx` ITSELF is
    // still the SAME, stale, pre-write reference (`pendingCreateCount`, the
    // module-level store `optimisticId.ts` keeps, is its own subscription,
    // `useSyncExternalStore`, entirely separate from the query the board's
    // own `ctx` is built from -- the two can notify React on different
    // ticks). The old code cleared `barWritesAwaitingCtxRef` unconditionally
    // whenever EITHER dependency changed, using whatever `ctx` this render
    // happened to carry -- so a `hasPendingCreate`-only render could clear
    // the wait a render early, before `ctx` had actually caught up, exactly
    // the gap the held "clear Cell 1" fell into. `lastDrainedCtxRef` remembers
    // which `ctx` reference this effect has already drained against; the
    // wait is only considered over when `ctx` is a GENUINELY NEW one this
    // effect has not yet seen -- a `hasPendingCreate`-only firing still calls
    // `drainHeldQueue()` (harmless: its own loop re-checks `writesStillSettling()`
    // itself), but never clears `barWritesAwaitingCtxRef` on that ctx's account
    // twice.
    if (ctx !== null && ctx !== lastDrainedCtxRef.current) {
      lastDrainedCtxRef.current = ctx;
      // `awaitingRowIdRef`'s own doc: a create's own wait needs the REAL
      // row, by id, not merely a `ctx` this effect has not seen before.
      const need = awaitingRowIdRef.current;
      const rowLanded =
        need === null ||
        (need.collection === "assignments"
          ? ctx.assignments.some((a) => a.id === need.id)
          : ctx.runs.some((r) => r.id === need.id));
      if (rowLanded) {
        awaitingRowIdRef.current = null;
        barWritesAwaitingCtxRef.current = 0;
      }
    }
    drainHeldQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, hasPendingCreate]);

  // F-233, second pass: the twin trigger `drainHeldQueue` also needs --
  // `status` clearing back to `null` is "a standing question or lot just
  // concluded with nothing further to write" (a cancel, an answered
  // question with no write, a lot's own settle already cleared it via
  // `finishTrace`), the one case the `[ctx]` effect above cannot see on its
  // own (no write means no new `ctx` ever arrives to trigger it). Reads the
  // reactive `status`, not a ref -- this is a plain "try draining whenever
  // the standing thing goes away" watch, not a value `runCommand` itself
  // needs synchronously.
  useEffect(() => {
    if (status === null) drainHeldQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

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
    return renderIsoDays(readout, zone, dateFormat);
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
   *     what RAN, already captured in `ran`, not a second "question".
   *
   *   - R-455 / F-219 review fix (24 Sept, session 191): `status.moving`
   *     (the "Moved the board to …" readout, ONLY) still fills in `asked`/
   *     `answered` exactly as any other readout, but does NOT `finishTrace`
   *     -- that would post the entry and null `traceRef.current` before the
   *     rerun this move triggers (`pendingRerunRef`) has said anything, which
   *     is the hole F-219's own reproduction found: the move posted alone
   *     and the rerun's write posted nothing at all, `traceRef.current`
   *     already gone by the time `runCommand` ran it. `fileMovingTurn` files
   *     the turn (so it appears in the thread this same tick, unchanged) and
   *     leaves the entry open and unposted for the rerun's own
   *     `settleWrite`/`finishTrace` to patch with `ran`/`outcome` and post
   *     once, truthfully -- or, if a cancel/Escape/new sentence drops the
   *     rerun first, THAT path's own `finishTrace`/`startTrace` flushes this
   *     same still-open entry exactly as it always would. */
  function traceQuestionStatus(status: Status): void {
    if (!traceRef.current) return;
    if (status.kind === "question" || status.kind === "shape") {
      setAsked(traceRef.current, status.message);
      // DEF-0049 (28 Sept, tester): posted the MOMENT the bar asks, not
      // only once the sentence's life ends -- a question the tester's own
      // page closed on (or a sentence that ended up refusing outright with
      // no further answer) used to never reach `bar.jsonl` at all. Every
      // later change to this same entry (an answer, a write, a refusal, or
      // the teardown flush) posts again and revises this line (`postTrace`'s
      // own doc) -- never a second, competing idea of "when is a turn worth
      // recording" (R-434: "anything the bar ... asks ... is a trace
      // entry").
      postTrace(traceRef.current);
    } else if (status.kind === "readout") {
      if (traceRef.current.asked === null) traceRef.current.asked = status.message;
      if (traceRef.current.answered === null) traceRef.current.answered = "auto";
      if (status.moving) {
        fileMovingTurn(store);
      } else {
        finishTrace();
      }
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
  function popupReporterFor(
    entry: TraceEntry | null,
    readout: string,
    readoutMessage: string = readout,
  ): PopupReporter {
    let fired = false;
    // S195-D (DEF-0054, item 1e): true once the pop-up this reporter belongs
    // to STANDS -- the write is with a person now, nothing is in flight, and
    // the count `runCommandBody` took for it comes back down (once), so a new
    // sentence typed meanwhile is read at once instead of being held five
    // seconds and refused with "still saving your last change".
    let released = false;
    return (result: PopupResult): void => {
      if (fired) return;
      // S62-b reviewer fix (C): `handed_off` is a NOTE, not an answer -- the
      // write moved to another pop-up, which reports the real result through
      // this same reporter. So it neither closes the latch nor ends the
      // entry; it only changes what the thread says the sentence is waiting
      // on (before this, a split-coverage hand-off said "Waiting: the create
      // pop-up" for ever).
      //
      // S195-D (DEF-0054): `what` is the ONE plain sentence saying what the
      // board is asking (`popupWords.ts`); it becomes the turn's board line
      // (never the done-form readout, R-431), the entry is POSTED at this ask
      // (DEF-0049's shape: a page closed with the pop-up standing still
      // leaves a line), and the live area empties into the filed turn so the
      // sentence is said once, not twice.
      if (result.kind === "handed_off") {
        if (!released) {
          released = true;
          barWriteAbandoned();
        }
        if (entry) {
          // `answered` stays as it is (null): nobody has answered yet, exactly
          // as for a question standing (DEF-0049).
          entry.asked = result.what;
          entry.outcome = `popup: ${result.what}`;
          postTrace(entry);
          if (traceRef.current === entry) {
            fileMovingTurn(store);
          } else {
            store.getState().updateTurn(entry.at, {
              asked: entry.asked,
              outcome: entry.outcome,
            });
          }
        }
        return;
      }
      fired = true;
      if (result.kind === "written" || result.kind === "refused") {
        // F-233, second pass: the write this reporter was handed to a
        // pop-up for has NOW actually settled -- brings the count
        // `barWritesInFlightRef` took when the writer was first called
        // (above, `runCommandBody`) down, and starts the "wait for ctx to
        // catch up" half instead.
        barWriteSettled(released);
        // F-233, third pass: a WRITTEN create with an id is what
        // `awaitingRowIdRef` waits for; anything else (a refusal, or a
        // written answer with no id -- `pendingCreateCollectionRef` was
        // never armed, or the writer genuinely made no row) clears it, so
        // the plain "a genuinely new ctx" wait every other write already
        // uses is what applies instead.
        const collection = pendingCreateCollectionRef.current;
        pendingCreateCollectionRef.current = null;
        awaitingRowIdRef.current =
          result.kind === "written" && collection !== null && result.id !== undefined
            ? { collection, id: result.id }
            : null;
      } else {
        // "cancelled": the pop-up closed without asking the server
        // anything -- nothing for `ctx` to catch up WITH.
        if (!released) barWriteAbandoned();
        pendingCreateCollectionRef.current = null;
        awaitingRowIdRef.current = null;
      }
      if (entry) {
        // S195-D: a pop-up that never stood (an auto-pressed create) leaves the
        // turn with no board line yet -- the readout is what the write did or
        // tried, as a direct write's always was. One that DID stand keeps the
        // sentence it asked, and a cancel never gets the readout back: after
        // Cancel nothing changed, and the thread must not say it did.
        if (result.kind !== "cancelled" && entry.asked === null) entry.asked = readoutMessage;
        if (entry.answered === null) entry.answered = "auto";
        if (result.kind === "written") {
          entry.ran.push(result.readout ?? readout);
          entry.outcome = "written";
        } else if (result.kind === "refused") {
          entry.outcome = `refused: ${rewriteRefusal(result.message, nodeNameOf)}`;
        } else {
          entry.outcome = "cancelled";
        }
      }
      if (entry) settleTurn(store, entry);
      drainHeldQueue();
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
      setAnswered(traceRef.current, value);
      traceRef.current.outcome = "cancelled";
    }
    finishTrace();
    setStatus({ kind: "shape", message: "Left it." });
    setText("");
    heldRef.current = null;
    heldOptionsRef.current = {};
    lotRef.current = null;
    // F-233, second pass (finding 3): a typed cancel word is THE ONE CANCEL
    // this file has -- drops every sentence still queued behind whatever
    // this word just cancelled, the same as Escape does.
    dropHeldQueueAsCancelled(value);
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
  function settleWrite(
    readout: string,
    readoutStatus: Status,
    answer: WriteAnswer,
    report: PopupReporter,
  ): void {
    const entry = traceRef.current;
    const apply = (outcome: WriteOutcome | void): void => {
      // S195-D (DEF-0054): a write handed to one of the board's own pop-ups is
      // NOT done and says nothing done -- it is settled here before anything
      // below could file the readout as what the turn asked or ran.
      if (outcome !== undefined && outcome.kind === "popup") {
        if (outcome.standing === false) {
          // Not on screen yet (an auto-pressed create): the pop-up itself
          // says when it stands. Until then the write is simply in progress.
          if (entry) {
            entry.outcome = `popup: ${outcome.waitingFor}`;
            postTrace(entry);
          }
          setStatus({ kind: "reading", message: "Working…" });
          return;
        }
        // The one path a standing pop-up is recorded through -- the same call
        // the pop-up's own reporter makes (`handed_off`).
        report({ kind: "handed_off", what: outcome.waitingFor });
        return;
      }
      // F-233, second pass (finding 1): the count this writer's own call
      // took (`runCommandBody`, above) comes back down here -- REGARDLESS
      // of whether there is a trace entry to record the outcome in, since
      // the write itself, and the board's own need to catch up with it,
      // does not depend on that. `WriteOutcome` carries no "cancelled" of
      // its own (unlike `PopupResult`, `popupReporterFor`'s own union) --
      // "popup" is the one non-terminal case here (returns early below,
      // before this would even matter); "written" and "refused" both
      // settled a real write, so both bring the count down the same way.
      {
        barWriteSettled();
        // F-233, third pass: only a WRITTEN create with an id keeps
        // `awaitingRowIdRef` armed -- an undefined answer or a refusal
        // will never produce a row for `ctx` to hold, so falling back to
        // the plain "a genuinely new ctx" wait (every other write's own
        // contract) is what actually lets a held sentence resolve once the
        // board is simply told the create did not happen (Proving item 3).
        const collection = pendingCreateCollectionRef.current;
        pendingCreateCollectionRef.current = null;
        awaitingRowIdRef.current =
          outcome !== undefined &&
          outcome.kind === "written" &&
          collection !== null &&
          outcome.id !== undefined
            ? { collection, id: outcome.id }
            : null;
      }
      if (entry) {
        // F-157 item 5: a single that ran straight off its own readout was
        // never asked anything and never answered by a word or a button.
        // S196-A (F-239, R-431): CONTRACT CHANGED -- that readout is what the
        // entry `asked` only once it is TRUE. It used to be filed here for a
        // refusal too, so a write the server refused read in the trace and the
        // thread as a statement that it had happened, then "Not done". A
        // refusal asked nothing and was answered by nothing; its `outcome` is
        // the whole story.
        if (outcome !== undefined && outcome.kind === "written") {
          if (entry.asked === null) entry.asked = readoutStatus.message;
          if (entry.answered === null) entry.answered = "auto";
        }
        if (outcome === undefined) {
          // F-168: NOT a success -- see this function's own doc above. Every
          // writer this file calls answers for real now; a caller reaching
          // this branch is a regression, and the trace/thread say so rather
          // than a silent Written.
          entry.outcome = "refused: no answer from the writer";
        } else if (outcome.kind === "written") {
          entry.ran.push(readout);
          entry.outcome = "written";
        } else {
          entry.outcome = `refused: ${rewriteRefusal(outcome.message, nodeNameOf)}`;
        }
      }
      if (entry) settleTurn(store, entry);
      drainHeldQueue();
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
    // DEF-0046, the bar's half (28 Sept, tester): wraps the whole body --
    // see `reportBarCrash`'s own doc, right after `runCandidateAction`,
    // below, for why these four functions each catch at their own body
    // rather than one shared try higher up. `wrote` tracks whether a writer
    // prop was actually CALLED (and returned/threw synchronously without
    // itself throwing) before the crash -- "only claim nothing was changed
    // when that is known" (piece 2's own brief line): a crash before this is
    // ever set is a genuine "nothing changed"; a crash after it names the
    // one thing that was, the same vocabulary piece 1's `buildLotOutcome`
    // uses ("Done:"/"Not done:"), never the fuller lot shape (nothing here
    // is ever a real multi-item `Lot` write -- see `reportBarCrash`'s doc).
    let wrote: { readout: string } | null = null;
    try {
      runCommandBody();
    } catch (err) {
      reportBarCrash(err, wrote);
    }
    return;

    function runCommandBody(): void {
      // R-424: every functional read of the board's context goes through the
      // last REAL ctx this component has seen, never the possibly-null prop
      // directly (see `ctx`'s own doc and `lastCtxRef`'s). A `null` here means
      // no board has ever loaded for this bar at all -- nothing to resolve
      // against, so this is a no-op rather than a crash (belt and braces: a
      // real caller never actually reaches this, since the bar is not even
      // mounted until its first ctx lands).
      const activeCtx = lastCtxRef.current;
      if (activeCtx === null) return;
      // F-233, second pass (S194-G2): a write the bar itself asked for (or,
      // as a fallback, a drag/pop-up's own create) may not be reflected on
      // the board yet -- a sentence said the instant after placing someone
      // ("remove Lena") must not resolve against a board that is
      // momentarily missing the row it is about. Held here, in order,
      // behind whatever else is already waiting (`holdSentence`/
      // `heldQueueRef`), and drained once the board catches up
      // (`drainHeldQueue`, the `[ctx]` effect below) -- bounded
      // (`HOLD_BOUND_MS`) so a connection slow enough to never settle at
      // all still gets a plain refusal instead of hanging or answering
      // wrongly (`dropHeldQueue`).
      if (writesStillSettling()) {
        holdSentence(command, suffix, options);
        return;
      }
      const givenSuffix = suffix ?? "";
      // DEF-0048 / R-409 (S194-D): THE one place both paths meet -- the rules
      // (`fallbackToRules`/`submitText`) and the model (`applyReading`) both
      // land here. The grammar already marks a typed absence ("Sam Patel is
      // off tomorrow"); the served model's reading carries no such key (its
      // schema is not taught it), so the words that were heard mark it here.
      // A no-op on a command already marked and on anything but a removal.
      command = markAbsence(command, traceRef.current?.heard ?? "");
      // DEF-0040 / R-461 (S194-D): the answers given so far to this sentence's
      // night shift questions (and any reason), held for the NEXT question's
      // buttons to carry forward -- see `answer_other_day_part`.
      if (options !== undefined) heldOptionsRef.current = options;
      // DEF-0055 (R-434): "clear Maria Lopez tomorrow" -- the grammar reads
      // the words after "clear" as a place with the reserved "everyone"; the
      // board knows the words are a person. Rewritten HERE, before the trace
      // records what was read, so the trace, the held command and every
      // button pressed after all say the person reading -- the same command
      // "remove Maria Lopez tomorrow" is. A question (both readings, or
      // neither and a close name) is left to `expandCommand` below.
      const clearReading = readClearAsPerson(command, activeCtx, options);
      if (clearReading.kind === "person") command = clearReading.command;
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
      const expanded = expandCommand(command, activeCtx, options);
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
        // S70-d (R-436): `expanded.runRemovals` -- an `everyone` clear's own
        // run removals, ALREADY resolved -- rides beside `resolvedCommand`
        // rather than inside its `commands` (see `ResolvedRunRemoval`'s own
        // doc in `resolve.ts`); `startLot` holds them until every person
        // command has resolved, then appends them to `done` after.
        startLot(resolvedCommand.commands, {
          runRemovals: expanded.runRemovals,
          runTrims: expanded.runTrims,
          absenceRecord: expanded.absenceRecord,
          summary: expanded.summary,
          // S198-A: what a day off the board re-runs (the whole sentence), and
          // whether the steps belong together (a replace, a swap, a copy).
          source: command,
          coupled: expanded.coupled,
        });
        return;
      }
      // DEF-0048: an absence that became ONE removal and records nothing says
      // why after the removal's own readout (the summary's own words).
      if (expanded.summary !== undefined) {
        suffix = `${suffix ?? ""} ${renderReadout(expanded.summary)}`;
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
        // S194-D third pass: the trace and the thread record the readout AS
        // SPOKEN (every ISO day rendered) -- the lot path already did
        // (DEF-0043 item 1); the single path handed the raw one on, so a
        // single write's "Written:" line showed "2026-09-03".
        // S196-A (R-425, R-459): the reasons the person typed ("The reason
        // given: ...") are read back on the readout of the write once it is
        // WRITTEN -- the Written line, the thread bubble and the trace's ran --
        // never on a live line while it is still in flight. Only the reasons
        // the caller passed in: the absence summary appended below says why a
        // sentence was read, not what ran.
        const spoken = renderReadout(resolved.readout) + givenSuffix;
        const report = popupReporterFor(traceRef.current, spoken, readoutStatus.message);
        // F-233, second pass (finding 1): up the instant a writer is
        // called, synchronously, before any of them has a chance to
        // await anything -- `settleWrite`'s own `apply` (written/refused)
        // or `popupReporterFor`'s own returned function (a hand-off's own
        // eventual written/refused/cancelled) is what brings it back down.
        barWritesInFlightRef.current += 1;
        // S196-A: the writer is called through this, so the pre-check below can
        // put the server's own answer about the person BEFORE it -- the one
        // place every single write is handed on.
        const callWriter = (): WriteAnswer => {
          let answer: WriteAnswer;
          if (resolved.intent === "book") {
            if (resolved.target.kind === "retime_run") {
              pendingCreateCollectionRef.current = null;
              answer = onRetimeRun(resolved, anchorOfInput(), report);
            } else {
              // A job/run create -- see `awaitingRowIdRef`'s own doc. Armed
              // only when the row's own day is inside this `ctx`'s window;
              // outside it (item 4: a copy to another week, a repeat) the id
              // could never appear here, and waiting for it would be exactly
              // today's fault (a five-second refusal for ever) for a write
              // that actually succeeded.
              pendingCreateCollectionRef.current = dayIsInCtxWindow(resolved.range, activeCtx)
                ? "runs"
                : null;
              answer = onBook(resolved, anchorOfInput(), report);
            }
          } else if (resolved.intent === "unassign") {
            pendingCreateCollectionRef.current = null;
            answer = onUnassign(resolved, anchorOfInput(), report);
          } else if (resolved.intent === "move") {
            // S41-c: BOTH targets go through onMove -- the caller narrows on
            // `resolved.target.kind` (keep the types honest: never build a
            // ResolvedCommand-shaped call to reach onRetime from here).
            pendingCreateCollectionRef.current = null;
            answer = onMove(resolved, anchorOfInput(), report);
          } else if (resolved.intent === "headcount") {
            // S58 (R-415, D132 item 4): one existing write, never a create or a
            // re-time -- see `onSetHeadcount`'s own doc above.
            pendingCreateCollectionRef.current = null;
            answer = onSetHeadcount(resolved, anchorOfInput(), report);
          } else {
            if (resolved.target.kind === "retime") {
              pendingCreateCollectionRef.current = null;
              answer = onRetime(resolved, anchorOfInput(), report);
            } else {
              // An assignment create -- see `awaitingRowIdRef`'s own doc, and
              // `onBook`'s own identical comment just above for the window
              // check.
              pendingCreateCollectionRef.current = dayIsInCtxWindow(resolved.range, activeCtx)
                ? "assignments"
                : null;
              answer = onOpen(resolved, anchorOfInput(), report);
            }
          }
          // DEF-0046: the writer was called and did not itself throw -- from
          // here on a crash names this readout as done, never "nothing
          // changed" (see this function's own opening doc).
          wrote = { readout: resolved.readout };
          return answer;
        };
        let answer: WriteAnswer;
        if (precheck !== undefined && isPlacementStep(resolved)) {
          // S196-A (DEF-0060, R-465, R-431): ask the server's capacity probe
          // before saying or writing anything. A person busy on a place the
          // caller cannot read is refused in one sentence -- no readout, no
          // write. Until it answers the live line says the bar is working,
          // and the trace already holds the entry (DEF-0049's shape).
          answer = precheck(resolved).then((checked): WriteAnswer =>
            // S204-A (DEF-0068, R-470, CONTRACT CHANGED): a block she can read but
            // not change is refused here too, as a place she cannot read is -- the
            // sentence never reaches the writer and its split pop-up.
            checked.kind === "busy_elsewhere" || checked.kind === "overlap_locked"
              ? { kind: "refused", message: checked.sentence }
              : callWriter(),
          );
        } else {
          answer = callWriter();
        }
        // S195-D (DEF-0054, R-431): a writer that answered NOW that it handed
        // the write to a pop-up has done nothing yet, so the done-form readout
        // is never shown for it (`settleWrite` says what is being asked).
        const handedToPopup =
          !isThenable(answer) && answer !== undefined && (answer as WriteOutcome).kind === "popup";
        if (isThenable(answer)) {
          // S196-A (F-239, R-431): CONTRACT CHANGED. The done-form readout was
          // printed the moment the writer was CALLED, so a slow write read as
          // done while the database still held the old hours, and the trace had
          // no entry. Nothing is said as done until it is: the live line is
          // the bar's own "Working…" and the entry is posted at the ask;
          // `settleWrite` files the readout only once the writer says written.
          setStatus(workingStatus());
          if (traceRef.current) {
            traceRef.current.outcome = WRITE_IN_FLIGHT;
            postTrace(traceRef.current);
          }
        } else if (!handedToPopup) {
          setStatus(readoutStatus);
        }
        // F-164: the entry is finished by `settleWrite` now, once (and only
        // once) the writer has answered -- `resolved.readout` is the ONE
        // command this run asked for (never the `+ suffix` UI annotation,
        // which says WHY it was read, not what ran).
        settleWrite(spoken, readoutStatus, answer, report);
        return;
      }
      // `resolvedCommand`, not `command`: when `expandCommand` collapsed a
      // board-answered sentence down to the ONE ordinary command it produced
      // (brief §2: "a single: the existing path"), that is what was actually
      // handed to `resolveCommand` and so what a candidate button must
      // substitute a field into -- for an ordinary sentence the two are the
      // same object, so this is unchanged from before S55 there.
      const next = questionToStatus(resolution.question, resolvedCommand);
      // S196-A (DEF-0060, R-465, R-431): a question whose EVERY answer leads to
      // a write the server would refuse for a block the caller cannot read
      // ("Join it, or make a separate block?") is not asked -- the refusal is
      // said instead, and nothing else.
      const asking = refusalBeforeAsking(next, resolvedCommand, options, activeCtx);
      if (asking !== null) {
        const entry = traceRef.current;
        setStatus(workingStatus());
        void asking.then((refusal) => {
          // Another sentence, Escape or an edit has happened since -- that one
          // already closed or replaced this turn; say nothing for it.
          if (traceRef.current !== entry || store.getState().status?.kind !== "reading") return;
          if (refusal === null) {
            setStatus(next);
            traceQuestionStatus(next);
            return;
          }
          refuseBeforeSpeaking(refusal);
        });
        return;
      }
      setStatus(next);
      traceQuestionStatus(next);
    }
  }

  /**
   * S196-A (DEF-0060, R-465, R-431): the turn ends here, in the one sentence,
   * with nothing said before it. `asked` stays empty (the bar asked nothing and
   * printed nothing as done); `outcome` is the whole story, and the thread
   * reads it "Not done: ...". Closed through `settleTurn`, so a turn that was
   * filed early is corrected rather than doubled.
   */
  function refuseBeforeSpeaking(sentence: string): void {
    const entry = traceRef.current;
    if (entry) {
      entry.outcome = `refused: ${sentence}`;
      settleTurn(store, entry);
      return;
    }
    setStatus({ kind: "shape", message: sentence });
  }

  /**
   * S196-A (DEF-0060, R-465, R-431): for a question about to be asked, what
   * the server's probe says about what EVERY answer would write. `null` when
   * there is nothing to settle first (no probe wired, a lot's own step, a
   * question with no buttons or whose answers are not all placements of a
   * person -- the ordinary path, untouched and synchronous). Otherwise a
   * promise of the refusal sentence, or `null` when at least one answer would
   * be allowed (the question is then asked as always). The answers are read
   * through the SAME substitution pressing the button makes
   * (`candidateCommand`, `pickAttach`, `pickExisting`) and resolved with the
   * SAME `resolveCommand`, so no answer is read two ways.
   */
  function refusalBeforeAsking(
    asked: Status,
    command: Command,
    options: ResolveOptions | undefined,
    activeCtx: ResolveContext,
  ): Promise<string | null> | null {
    if (precheck === undefined || lotRef.current !== null || asked.kind !== "question") return null;
    const steps: Array<ResolvedCommand | ResolvedMove> = [];
    if (asked.awaitingOverrideReason || asked.awaitingAreaReason) {
      // A free-text reason is the answer; every reason leads to the same write.
      if (command.intent === "several") return null;
      const r = resolveCommand(command, activeCtx, {
        ...options,
        overrideReason: options?.overrideReason ?? "-",
        areaReason: options?.areaReason ?? "-",
      });
      if (!r.ok || !isPlacementStep(r.resolved)) return null;
      steps.push(r.resolved);
    } else {
      if (asked.candidates.length === 0 || asked.candidates.length > 8) return null;
      for (const c of asked.candidates) {
        const a = c.action;
        let answer: Command | null = null;
        if (a.kind === "pick_candidate") {
          const parsed = parseCommand(
            formatCommand(candidateCommand(a.command, a.field, a.candidate, a.text)),
          );
          answer = parsed.ok ? parsed.command : null;
        } else if (a.kind === "pick_attach") {
          answer = { ...a.command, attach: a.attach };
        } else if (a.kind === "pick_existing") {
          answer = { ...a.command, existing: a.existing } as Command;
        }
        if (answer === null || answer.intent === "several") return null;
        const r = resolveCommand(answer, activeCtx, options);
        if (!r.ok || !isPlacementStep(r.resolved)) return null;
        steps.push(r.resolved);
      }
    }
    if (steps.length === 0) return null;
    return Promise.all(steps.map((step) => precheck(step))).then((answers) => {
      const said = answers.flatMap((x) =>
        x.kind === "busy_elsewhere" || x.kind === "overlap_locked" ? [x.sentence] : [],
      );
      return said.length === answers.length ? [...new Set(said)].join(" ") : null;
    });
  }

  /** S51: starts a fresh lot from a several's inner commands and resolves
   *  the first one (brief §2 item 1). S70-d (R-436): `runRemovals` --
   *  `expandEveryoneUnassign`'s own already-resolved run removals -- ride
   *  alongside `commands` and are appended to `done` once every one of
   *  `commands` has resolved (`resolveLotStep`'s own terminal branch),
   *  never resolved themselves.
   *
   *  DEF-0046, the bar's half: wrapped -- never writes anything itself
   *  (only `resolveCommand`, pre-write), so a crash here is always
   *  "nothing changed" (`reportBarCrash`'s own doc, below `runCandidateAction`). */
  function startLot(
    commands: SingleCommand[],
    // DEF-0040 / DEF-0048 (S194-D): the steps the expansion built already
    // resolved -- a clear's job trims and removals, an absence's record --
    // and the absence sentence's own answer.
    extras: {
      runRemovals?: ResolvedRunRemoval[];
      runTrims?: ResolvedRunTrim[];
      absenceRecord?: ResolvedAbsenceRecord;
      summary?: string;
      // S198-A (DEF-0061/DEF-0062): see `Lot`'s own fields of these names.
      source?: Command;
      coupled?: Coupled;
      runNow?: true;
    } = {},
  ): void {
    try {
      lotRef.current = {
        commands,
        index: 0,
        done: [],
        runRemovals: extras.runRemovals ?? [],
        runTrims: extras.runTrims ?? [],
        ...(extras.absenceRecord ? { absenceRecord: extras.absenceRecord } : {}),
        ...(extras.summary !== undefined ? { summary: extras.summary } : {}),
        ...(extras.source ? { source: extras.source } : {}),
        ...(extras.coupled ? { coupled: extras.coupled } : {}),
        ...(extras.runNow ? { runNow: true as const } : {}),
      };
      resolveLotStep();
    } catch (err) {
      reportBarCrash(err, null);
    }
  }

  /**
   * S51: resolves `lotRef.current`'s CURRENT command with the same
   * `resolveCommand` a single sentence uses; an `ok` result is kept and the
   * lot advances to the next command (recursing, exactly as a chain of
   * always-resolved single sentences would); a question is shown numbered
   * "i of N: ..." with that question's own buttons and outline
   * (`questionToStatus`, unchanged); once every command has resolved, the
   * lot status is shown instead (brief §2 items 1-2).
   *
   * DEF-0046, the bar's half (28 Sept, tester): wrapped -- DEF-0046's own
   * crash (`resolveMoveCommand` inside `resolveCommand`) reaches exactly
   * here for a lot step, and this function recurses on its own name (a step
   * that resolves calls itself for the next one), so wrapping its own body
   * catches at whichever recursion depth actually threw, never a caller
   * three steps back that has already moved on. Never writes anything
   * itself (only `resolveCommand`, pre-write) -- a crash here is always
   * "nothing changed" (`reportBarCrash`'s own doc, below `runCandidateAction`).
   */
  function resolveLotStep(): void {
    try {
      resolveLotStepBody();
    } catch (err) {
      reportBarCrash(err, null);
    }
  }

  function resolveLotStepBody(): void {
    const lot = lotRef.current;
    if (!lot) return;
    if (lot.index >= lot.commands.length) {
      // S70-d (R-436): every person command has resolved -- fold the lot's
      // own run removals (already resolved, never through `resolveCommand`)
      // onto the end of `done` now, ONCE (`runRemovals` is cleared right
      // after, so a repeat call -- `updateLotCommand` re-resolving the last
      // step, say -- never appends them twice). People first, jobs after:
      // brief §2, so a job's cascade delete never removes a block the lot
      // has already listed as its own earlier step.
      // DEF-0040 / R-461 (S194-D): the job TRIMS first (the crew were trimmed
      // or removed in the person steps just before them), then the job
      // removals, then -- DEF-0048 -- the absence record, LAST, so nothing is
      // recorded unless every block it was about went first. Each folded in
      // ONCE and cleared, same as the removals always were.
      const tail: ResolvedAny[] = [
        ...(lot.runTrims ?? []),
        ...(lot.runRemovals ?? []),
        ...(lot.absenceRecord ? [lot.absenceRecord] : []),
      ];
      if (tail.length > 0) {
        lotRef.current = {
          ...lot,
          done: [...lot.done, ...tail],
          runRemovals: [],
          runTrims: [],
          absenceRecord: undefined,
        };
      }
      // S198-A (DEF-0062, R-466): the lot a "take off anyway" press started --
      // the press WAS the yes, so it runs as soon as it has resolved, with no
      // listing and no probe (the removals place nobody).
      if (lotRef.current !== null && lotRef.current.runNow) {
        runLotNow();
        return;
      }
      // S198-A (R-467): steps refused under the block policy are named in the
      // listing's own words, the rest are listed; when nothing is left the
      // refusal stands alone. Nothing is written before the yes either way.
      const gateNotes = lotRef.current?.notes ?? [];
      if (lotRef.current !== null && gateNotes.length > 0 && lotRef.current.done.length === 0) {
        refuseLotAlone(gateNotes.join(" "));
        return;
      }
      if (precheck !== undefined && lotRef.current !== null) {
        const placing = lotRef.current.done.some(isPlacementStep);
        if (placing) {
          refuseBusyLotSteps(lotRef.current);
          return;
        }
      }
      // S202-A (DEF-0066): the reason questions queued while stepping are asked
      // now, in step order (`askLotNext`), when there is no probe to wait for.
      if (lotRef.current !== null && (lotRef.current.provisional?.size ?? 0) > 0) {
        askLotNext();
        return;
      }
      showLotStatus(gateNotes.length > 0 ? gateNotes.join(" ") : undefined);
      return;
    }
    // R-424: same fallback as `runCommand`'s own -- see that function's
    // identical guard for why this can only ever be reached with a real
    // ctx in practice.
    const activeCtx = lastCtxRef.current;
    if (activeCtx === null) return;
    const command = lot.commands[lot.index];
    // S198-A (R-467): the reasons already given for THIS step, and no other's.
    const resolution = resolveCommand(command, activeCtx, lot.stepOptions?.[lot.index]);
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
        const dropMessage = "I could not read that as more than one thing. Say them one at a time.";
        // DEF-0049 (28 Sept, tester): this used to `setStatus` and return --
        // a genuine terminal refusal that never touched the trace entry's
        // `outcome` at all, so it read exactly like an open, unanswered
        // question forever (R-434: every refusal is a trace entry, this one
        // silently was not). Closed here the same way `refuseUngrounded`
        // closes its own outright refusal.
        if (traceRef.current) {
          traceRef.current.asked = dropMessage;
          traceRef.current.answered = "auto";
          traceRef.current.outcome = `refused: ${dropMessage}`;
        }
        finishTrace();
        setStatus({ kind: "shape", message: dropMessage });
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
    // S198-A (DEF-0061, R-467): a step short a certificate under the BLOCK
    // policy has no reason to ask for -- it is refused and named in the
    // listing's own words, and the rest of the lot is carried on to (the shape a
    // step busy elsewhere gets, R-465). Under warn the question below asks.
    const gateQuestion = resolution.question;
    if (gateQuestion.kind === "not_certified" && gateQuestion.policy === "block") {
      const who = gateQuestion.attempted ?? `${gateQuestion.person} on ${gateQuestion.cell}`;
      lotRef.current = {
        ...lot,
        notes: [
          ...(lot.notes ?? []),
          `Not doing ${renderReadout(who)}: ${describeGateReason(gateQuestion)}`,
        ],
        index: lot.index + 1,
      };
      resolveLotStep();
      return;
    }
    // S202-A (DEF-0066, F-247, R-468): a certificate or area REASON question is
    // QUEUED, not asked, while the lot is still stepping. Every answer to it is
    // the same placement (the reason is only what the write carries), so the step
    // is resolved for the probe with a placeholder reason, exactly as a single
    // sentence's `refusalBeforeAsking` does, and its real question is asked after
    // the one probe, in step order, with the overlap questions (`askLotNext`). A
    // step the probe refuses is named and never asked its reason (F-247). Any OTHER
    // question changes WHAT is placed (which shift, join or separate, a day off the
    // board, an unknown name) and is asked at once, below, as before.
    if (
      (gateQuestion.kind === "not_certified" &&
        gateQuestion.policy === "warn" &&
        !gateQuestion.inLot) ||
      (gateQuestion.kind === "outside_area" && !gateQuestion.inLot)
    ) {
      const given = lot.stepOptions?.[lot.index] ?? {};
      const stand = resolveCommand(command, activeCtx, {
        ...given,
        overrideReason: given.overrideReason ?? "-",
        areaReason: given.areaReason ?? "-",
      });
      if (stand.ok && stand.resolved.intent !== "headcount") {
        lotRef.current = {
          ...lot,
          done: [...lot.done, stand.resolved],
          index: lot.index + 1,
          provisional: new Map(lot.provisional ?? []).set(stand.resolved, lot.index),
        };
        resolveLotStep();
        return;
      }
    }
    // S198-A (DEF-0061): a day off the board re-runs the WHOLE sentence once
    // the board has moved -- never the one step that met the day, which used to
    // run alone and leave the rest of the sentence never mentioned.
    const base = questionToStatus(
      resolution.question,
      resolution.question.kind === "day_off_board" ? (lot.source ?? command) : command,
    );
    if (base.kind !== "question") {
      // R-455 / F-219 reviewer fix (24 Sept, session 191): this branch's OWN
      // pre-R-455 comment ("always a 'question' status ... this branch
      // exists only so TypeScript sees the numbering below is safe") went
      // stale the instant `day_off_board` started returning a "readout"
      // (`moving: true`) instead -- a lot step landing off the board reaches
      // HERE now, for real, every time. Numbered exactly as the "question"
      // branch below numbers its own message (a supervisor reading the
      // trace still needs to know WHICH step moved the board).
      //
      // Deliberately NOT `traceQuestionStatus`/`fileMovingTurn` (the
      // top-level `runCommand` path's own treatment): a lot's trace entry is
      // ONE entry for the WHOLE lot, filed only once the lot itself finishes
      // (`showLotStatus`'s/`settleWrite`'s own terminal call) -- exactly why
      // the "question" branch right below sets `asked` inline rather than
      // through `traceQuestionStatus` too. A step landing off the board gets
      // the SAME inline treatment: `asked`/`answered` recorded truthfully
      // (this step ran on its own say-so, not a person's), nothing filed or
      // closed early. Without this, the move ran silently inside a lot -- no
      // `asked` at all, the exact hole the top-level path had before its own
      // fix, one layer deeper.
      //
      // `nothing_to_do`'s own plain "readout" (pre-existing, not this
      // lane's) is UNCHANGED: `moving` is unset for it, so this still skips
      // straight to the bare `setStatus` it always took.
      const moved =
        base.kind === "readout" && base.moving
          ? { ...base, message: `${lot.index + 1} of ${lot.commands.length}: ${base.message}` }
          : base;
      if (moved.kind === "readout" && moved.moving && traceRef.current) {
        traceRef.current.asked = moved.message;
        traceRef.current.answered = "auto";
      }
      setStatus(moved);
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
    if (traceRef.current) {
      setAsked(traceRef.current, next.message);
      // DEF-0049: posted at the ask, same as `traceQuestionStatus`'s own
      // branch -- see that function's doc.
      postTrace(traceRef.current);
    }
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
   * DEF-0043 item 3 (28 Sept, tester): "Those two lines (2 and 5) are about
   * the same block; say them one at a time." answers a person who said ONE
   * sentence -- there are no "lines" to point at (R-459: never an internal
   * word/position no supervisor typed). Every lot today reaches
   * `showLotStatus` from exactly one parsed sentence (`startLot`'s only
   * caller is `runCommand`'s `intent === "several"` branch, itself only
   * ever the expansion of ONE typed/spoken sentence -- there is no separate
   * "typed list of several sentences" door in this file today); the brief's
   * own allowance for keeping line numbers is for a door that does not
   * exist yet, so this always uses the plain-sentence form. Names the block
   * from the board's OWN facts (`ctx.assignments`/`ctx.operators`/
   * `ctx.nodeById`), never a re-derivation of the readout's own words --
   * falls back to "the same block" when the assignment or its operator/node
   * cannot be found (a lot resolved against a since-stale ctx), which
   * cannot happen in practice (the lot's own `done` was just resolved
   * against this same ctx) but must never throw.
   */
  function describeDuplicateBlockRefusal(
    done: readonly ResolvedAny[],
    dup: [number, number],
  ): string {
    const id = namedAssignmentId(done[dup[0] - 1]);
    const ctx = lastCtxRef.current;
    const a = id !== null && ctx !== null ? ctx.assignments.find((x) => x.id === id) : undefined;
    const person = a ? ctx?.operators.find((o) => o.id === a.operatorId)?.displayName : undefined;
    const place = a ? ctx?.nodeById.get(a.nodeId)?.name : undefined;
    const block = person && place ? `${person}'s block on ${place}` : "the same block";
    return `I could not do that in one go: two of the changes are about ${block}. Say them one at a time.`;
  }

  /** The cell's name for a node id, from the board the bar reads (S202-A, DEF-0065). */
  function nodeNameOf(id: string): string | null {
    return lastCtxRef.current?.nodeById.get(id)?.name ?? null;
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
  /**
   * S196-A (DEF-0060, R-465, R-431): before the lot is listed, every step that
   * places a person is put to the server's probe, all together. A step whose
   * person is busy on a place the caller cannot read is dropped from the lot and
   * named in the listing's own words, one sentence each; the rest are listed as
   * always. When nothing is left the refusal stands alone. Nothing is listed as
   * a thing to do that the server would refuse.
   */
  function refuseBusyLotSteps(lot: NonNullable<typeof lotRef.current>): void {
    if (precheck === undefined) return;
    const entry = traceRef.current;
    setStatus(workingStatus());
    const steps = lot.done;
    void Promise.all(
      steps.map((step) =>
        isPlacementStep(step) ? precheck(step) : Promise.resolve<PrecheckResult>({ kind: "ok" }),
      ),
    ).then((answers) => {
      // R-465: the steps whose person is busy on a place the caller cannot read.
      // S202-A (DEF-0065): a person booked on a block she can read but not change
      // is refused the same way (the sentence says so); only an overlap she can
      // change is ever asked.
      const refusals = answers.map((a) =>
        a.kind === "busy_elsewhere" || a.kind === "overlap_locked" ? a.sentence : null,
      );
      // Escape, an edit or another sentence has happened since: that one
      // already closed or replaced this turn, and the lot it held goes with it.
      if (traceRef.current !== entry || store.getState().status?.kind !== "reading") {
        if (lotRef.current === lot) lotRef.current = null;
        return;
      }
      if (lotRef.current !== lot) return;
      const kept: ResolvedAny[] = [];
      const busyNotes: string[] = [];
      steps.forEach((step, i) => {
        const refusal = refusals[i];
        if (refusal === null) kept.push(step);
        else busyNotes.push(`Not doing ${renderReadout(step.attempted)}: ${refusal}`);
      });
      // S198-A (R-467): the steps already refused under the block policy are
      // named first, in the same listing.
      const gateNotes = lot.notes ?? [];
      // S200-A (R-468): a step whose person is already booked on blocks the
      // caller CAN read asks, in the bar, before the listing -- split the time
      // evenly, or skip the person. A several, a copy and a replace's placement
      // ask it; a SWAP does not (its placement overlaps the very block its first
      // step removes, so there the writer stays the gate). A block another step
      // of this lot removes or moves EARLIER in the lot is not what makes the
      // person busy once the lot has run (the lot writes in order): that one is
      // left to the writer.
      const overlaps: LotOverlap[] = [];
      const ctxNow = lastCtxRef.current;
      const replacing = lot.coupled?.kind === "replace";
      if (lot.coupled?.kind !== "swap" && ctxNow !== null) {
        const namedAt = new Map<string, number>();
        steps.forEach((s, i) => {
          const id = namedAssignmentId(s);
          if (id !== null && !namedAt.has(id)) namedAt.set(id, i);
        });
        let keptIndex = 0;
        steps.forEach((step, i) => {
          if (refusals[i] !== null) return;
          const at = replacing ? i : keptIndex;
          keptIndex += 1;
          const answer = answers[i];
          if (answer.kind !== "overlap") return;
          if (step.intent !== "assign" || step.target.kind === "retime") return;
          if (answer.blocks.some((b) => (namedAt.get(b.assignmentId) ?? Infinity) < i)) return;
          overlaps.push({
            step: at,
            person:
              ctxNow.operators.find((o) => o.id === step.operatorId)?.displayName ?? "That person",
            sentence: answer.sentence,
            blocks: answer.blocks.map((b) => ({
              assignmentId: b.assignmentId,
              nodeName: b.nodeName,
            })),
            capPercent: answer.capPercent,
            place: ctxNow.nodeById.get(step.nodeId)?.name ?? "this place",
          });
        });
      }
      if (busyNotes.length === 0 && overlaps.length === 0) {
        if ((lot.provisional?.size ?? 0) > 0) {
          askLotNext();
          return;
        }
        showLotStatus(gateNotes.length > 0 ? gateNotes.join(" ") : undefined);
        return;
      }
      // S198-A (DEF-0062, R-466): a replace is ONE intent -- when its incoming
      // person cannot go, the bar ASKS what to do next (the probe's own
      // sentence, then the question) instead of dropping her step and listing
      // the removal alone. Nothing is written before the answer.
      // S200-A (R-469): the question is built from the steps its press will run.
      // S200-A (R-468): when her placement overlaps a readable block too, that
      // question comes FIRST (split or skip, on every step of the lot, none yet
      // dropped); the replace question is then built from what is left -- a
      // skipped placement counts as one she cannot take (`finishLotOverlaps`).
      if (replacing) {
        if (overlaps.length > 0) {
          lotRef.current = { ...lot, overlaps, refusals };
          askLotNext();
          return;
        }
        askReplaceFrom(lot, steps, refusals);
        return;
      }
      // S198-A: a SWAP has no half a supervisor would want -- it is refused
      // whole, before its yes, and says nothing was changed. A COPY is a lot of
      // independent placements (each copied block stands alone), so it takes
      // the several's path below: the busy step is named, the rest are listed
      // for one yes (R-465).
      if (lot.coupled?.kind === "swap") {
        refuseLotAlone(`${busyNotes.join(" ")} Nothing changed.`);
        return;
      }
      const notes = [...gateNotes, ...busyNotes];
      if (kept.length === 0) {
        // Every step refused: the refusal alone (DEF-0049's shape -- `asked` is
        // what the bar said).
        refuseLotAlone(notes.join(" "));
        return;
      }
      if (overlaps.length > 0) {
        lotRef.current = {
          ...lot,
          done: kept,
          ...(notes.length > 0 ? { notes } : {}),
          overlaps,
        };
        askLotNext();
        return;
      }
      // S202-A (DEF-0066): the steps still owed a reason are asked now, after the
      // probe, in step order.
      if (kept.some((s) => lot.provisional?.has(s))) {
        lotRef.current = { ...lot, done: kept, ...(notes.length > 0 ? { notes } : {}) };
        askLotNext();
        return;
      }
      lotRef.current = { ...lot, done: kept };
      showLotStatus(notes.join(" "));
    });
  }

  /**
   * S198-A / S200-A (R-466, R-469): the replace question, from the lot's steps
   * (removals first, then one placement per block) and which placements cannot
   * go (`refusals`, aligned with `steps`, null where one can). The press runs
   * the steps that can go.
   */
  function askReplaceFrom(
    lot: NonNullable<typeof lotRef.current>,
    steps: ResolvedAny[],
    refusals: Array<string | null>,
  ): void {
    if (lot.coupled?.kind !== "replace") return;
    const c = lot.coupled;
    const kept = steps.filter((_, i) => refusals[i] === null);
    const why = [...new Set(refusals.filter((x): x is string => x !== null))].join(" ");
    const k = steps.length / 2;
    const shaped =
      Number.isInteger(k) &&
      steps.slice(0, k).every((s) => s.intent === "unassign") &&
      steps.slice(k).every((s) => s.intent === "assign");
    const detail: ReplaceBlockedDetail | undefined =
      shaped && c.blocks !== undefined && c.blocks.length === k
        ? {
            incoming: c.incoming,
            blocks: c.blocks.map((b, i) => ({ ...b, refused: refusals[k + i] !== null })),
          }
        : undefined;
    askReplaceBlocked(
      describeReplaceBlocked(why, c.outgoing, c.place, detail),
      replaceBlockedLabel(c.outgoing, c.incoming, detail),
      { kind: "run_removals", resolved: kept },
    );
  }

  /**
   * S198-A (R-467, R-449): the lot is refused outright, in one message, with
   * nothing to say yes to -- the ONE place a lot ends that way (every step
   * refused, a swap or a copy that cannot go). `asked` is what the bar said,
   * after whatever it asked and had answered before (a reason, `traceCarry`).
   */
  function refuseLotAlone(message: string): void {
    lotRef.current = null;
    const entry = traceRef.current;
    if (entry) {
      setAsked(entry, message);
      if (entry.answered === null) entry.answered = "auto";
      entry.outcome = `refused: ${message}`;
      settleTurn(store, entry);
    } else {
      setStatus({ kind: "shape", message });
    }
  }

  /**
   * S198-A (DEF-0062, R-466): the ONE status a blocked replace asks, whichever
   * door found the block (the bar's probe, the resolver's own gates): the
   * sentence (`describeReplaceBlocked`, built once in `resolve.ts`) and two
   * buttons of one width (R-447, `yesNo` -- a typed yes and no press them). The
   * first takes the outgoing person off anyway and IS the yes; the second
   * leaves everything as it is.
   */
  function replaceBlockedStatus(message: string, label: string, takeOff: CandidateAction): Status {
    return {
      kind: "question",
      message,
      candidates: [
        { key: "clear", label, action: takeOff },
        { key: "keep", label: "Leave it", action: { kind: "leave_it" } },
      ],
      yesNo: true,
    };
  }

  /** The probe's door to that question: the lot is dropped (the answer carries
   *  what it needs as data), the question is shown and traced as asked. */
  function askReplaceBlocked(message: string, label: string, takeOff: CandidateAction): void {
    lotRef.current = null;
    const status = replaceBlockedStatus(renderReadout(message), label, takeOff);
    setStatus(status);
    traceQuestionStatus(status);
  }

  /** The button's press: run the removal now (the press is the yes). */
  function runRemovalsNow(action: { resolved?: ResolvedAny[]; commands?: SingleCommand[] }): void {
    if (action.resolved !== undefined) {
      lotRef.current = {
        commands: [],
        index: 0,
        done: action.resolved,
        runRemovals: [],
        runTrims: [],
      };
      runLotNow();
      return;
    }
    startLot(action.commands ?? [], { runNow: true });
  }

  /**
   * S198-A (DEF-0061, R-467): the typed reason answers the lot's CURRENT step,
   * and only that step -- it is recorded against the step's index, the step is
   * re-resolved with it, and the lot carries on (a later step asks its own
   * question). The trace entry keeps the ask, the reason and what comes next in
   * order (`traceCarry`, the night shift question's own mechanism, R-434).
   */
  function answerLotReason(field: "overrideReason" | "areaReason", value: string): void {
    const lot = lotRef.current;
    if (!lot) return;
    const entry = traceRef.current;
    if (entry) {
      store
        .getState()
        .set({ traceCarry: { asked: entry.asked ?? "", answered: entry.answered ?? "" } });
    }
    // S202-A (DEF-0066): a reason question asked after the probe belongs to the
    // provisional step standing at `lot.asking`; its command is the one recorded.
    if (lot.asking !== undefined) {
      const cmd = lot.provisional?.get(lot.done[lot.asking]);
      if (cmd !== undefined) {
        const had = lot.stepOptions?.[cmd] ?? {};
        lotRef.current = {
          ...lot,
          asking: undefined,
          stepOptions: { ...(lot.stepOptions ?? {}), [cmd]: { ...had, [field]: value } },
        };
        askLotNext();
        return;
      }
    }
    const given = lot.stepOptions?.[lot.index] ?? {};
    lotRef.current = {
      ...lot,
      stepOptions: { ...(lot.stepOptions ?? {}), [lot.index]: { ...given, [field]: value } },
    };
    resolveLotStep();
  }

  /**
   * S200-A (R-468): the next lot step whose person is already booked on a block
   * the caller can read, asked in the bar and numbered as the lot's step -- the
   * probe's own sentence, then "split evenly, or skip?" with two buttons of one
   * width. Nothing is written. When every one has been answered the lot goes on
   * to its listing (`finishLotOverlaps`).
   */
  function askLotNext(): void {
    const lot = lotRef.current;
    if (!lot) return;
    const activeCtx = lastCtxRef.current;
    // S202-A (DEF-0066, F-247, R-468): EVERY question the lot asks after its probe
    // comes in STEP ORDER -- for step k its reason question (if the step was queued
    // with a placeholder reason), then its overlap question, then step k+1's -- all
    // numbered "k of N" over the steps that are left. Then the listing.
    for (let i = 0; i < lot.done.length; i++) {
      const cmd = lot.provisional?.get(lot.done[i]);
      if (cmd !== undefined && activeCtx !== null) {
        const resolution = resolveCommand(lot.commands[cmd], activeCtx, lot.stepOptions?.[cmd]);
        if (resolution.ok && resolution.resolved.intent !== "headcount") {
          // Every reason it needs has been given: the real step stands in for the
          // provisional one, and the next question is looked for from the top.
          const done = lot.done.slice();
          done[i] = resolution.resolved;
          lotRef.current = { ...lot, done, asking: undefined };
          askLotNext();
          return;
        }
        const base = resolution.ok
          ? null
          : questionToStatus(resolution.question, lot.commands[cmd]);
        if (base !== null && base.kind === "question") {
          const next = { ...base, message: `${i + 1} of ${lot.done.length}: ${base.message}` };
          lotRef.current = { ...lot, asking: i };
          setStatus(next);
          if (traceRef.current) {
            setAsked(traceRef.current, next.message);
            postTrace(traceRef.current);
          }
          return;
        }
      }
      const owed = lot.overlaps?.find((o) => o.step === i && o.answer === undefined);
      if (owed !== undefined) {
        askLotOverlap(lot, owed);
        return;
      }
    }
    if (lot.overlaps !== undefined) {
      finishLotOverlaps(lot);
      return;
    }
    showLotStatus(
      lot.notes !== undefined && lot.notes.length > 0 ? lot.notes.join(" ") : undefined,
    );
  }

  function askLotOverlap(lot: NonNullable<typeof lotRef.current>, next: LotOverlap): void {
    const message = `${next.step + 1} of ${lot.done.length}: ${renderReadout(next.sentence)} ${splitQuestion(next)}`;
    const status: Status = {
      kind: "question",
      message,
      candidates: [
        {
          key: "split",
          label: "Split evenly",
          action: { kind: "answer_lot_overlap", step: next.step, answer: "split" },
        },
        {
          key: "skip",
          label: `Skip ${next.person}`,
          action: { kind: "answer_lot_overlap", step: next.step, answer: "skip" },
        },
      ],
      pair: true,
    };
    setStatus(status);
    if (traceRef.current) {
      setAsked(traceRef.current, message);
      postTrace(traceRef.current);
    }
  }

  /** The step with the even split its person chose: the existing blocks first,
   *  the new one last (the pop-up's own order), the shares from `splitEvenly`. */
  function withSplit(step: ResolvedCommand, o: LotOverlap): ResolvedCommand {
    const shares = splitEvenly(o.blocks.length + 1, o.capPercent);
    return {
      ...step,
      split: {
        adjustments: o.blocks.map((b, j) => ({
          assignmentId: b.assignmentId,
          efficiencyPercent: shares[j],
        })),
        efficiencyPercent: shares[o.blocks.length],
        person: o.person,
        with: andList(distinctPlaces(o.blocks.map((b) => b.nodeName))),
      },
    };
  }

  /** The button's press: record the answer against its step and ask the next. */
  function answerLotOverlap(step: number, answer: "split" | "skip"): void {
    const lot = lotRef.current;
    if (!lot) return;
    const entry = traceRef.current;
    // The ask and its answer stay in the entry; the next ask (or the listing)
    // lands after them, in order (R-434, the night shift question's own carry).
    if (entry) {
      store
        .getState()
        .set({ traceCarry: { asked: entry.asked ?? "", answered: entry.answered ?? "" } });
    }
    lotRef.current = {
      ...lot,
      overlaps: (lot.overlaps ?? []).map((o) => (o.step === step ? { ...o, answer } : o)),
    };
    askLotNext();
  }

  /** Every overlap answered: a skipped step is named in the listing's own words
   *  (`Not doing ...`, the shape a step busy elsewhere gets), a split step is
   *  kept with the even shares `splitEvenly` gives -- the existing blocks first,
   *  the new one last, the pop-up's own order -- and the lot is listed. */
  function finishLotOverlaps(lot: NonNullable<typeof lotRef.current>): void {
    const overlaps = lot.overlaps ?? [];
    if (lot.coupled?.kind === "replace") {
      // The replace question, built from what is left: a skipped placement is one
      // she cannot take (its sentence is the reason), a split one is kept.
      const refusals = [...(lot.refusals ?? lot.done.map(() => null))];
      const steps = lot.done.map((step, i) => {
        const o = overlaps.find((x) => x.step === i);
        if (o === undefined || step.intent !== "assign") return step;
        if (o.answer === "skip") {
          refusals[i] = o.sentence;
          return step;
        }
        return withSplit(step, o);
      });
      if (refusals.every((r) => r === null)) {
        lotRef.current = { ...lot, done: steps, overlaps: undefined, refusals: undefined };
        showLotStatus();
        return;
      }
      askReplaceFrom(lot, steps, refusals);
      return;
    }
    const kept: ResolvedAny[] = [];
    const notes = [...(lot.notes ?? [])];
    lot.done.forEach((step, i) => {
      const o = overlaps.find((x) => x.step === i);
      if (o === undefined || step.intent !== "assign") {
        kept.push(step);
        return;
      }
      if (o.answer === "skip") {
        notes.push(`Not doing ${renderReadout(step.attempted)}: ${renderReadout(o.sentence)}`);
        return;
      }
      kept.push(withSplit(step, o));
    });
    if (kept.length === 0) {
      refuseLotAlone(notes.join(" "));
      return;
    }
    lotRef.current = { ...lot, done: kept, overlaps: undefined, notes: undefined };
    showLotStatus(notes.length > 0 ? notes.join(" ") : undefined);
  }

  /** A lot step as the thread says it: its readout (S200-A: and, for a step the
   *  person chose to split, whose time is split with which places), then the
   *  reasons it was given (R-467) -- the one builder a single sentence's readout
   *  shares. */
  function spokenStep(r: ResolvedAny): string {
    return splitClause(renderReadout(r.readout), r) + reasonsGivenText(reasonsOfStep(r));
  }

  function showLotStatus(dropped?: string): void {
    const lot = lotRef.current;
    if (!lot) return;
    const dup = findDuplicateBlockPair(lot.done);
    if (dup) {
      lotRef.current = null;
      const dupMessage = describeDuplicateBlockRefusal(lot.done, dup);
      // DEF-0049 (28 Sept, tester): this used to `setStatus` and return with
      // no trace bookkeeping at all -- a genuine terminal refusal (this lot
      // never even reaches its own "Ready to do N things" question) that
      // left the entry's `outcome` null forever, exactly the "moved-then-
      // refused" shape of the same defect: "clear Line 1 for the rest of the
      // week" moves the board, reruns, and the two-lines-collide refusal
      // that followed was not in the entry either. Closed here the same way
      // `refuseUngrounded` closes its own outright refusal (R-455: "the
      // trace entry stays open across the move and the rerun's outcome
      // closes it" -- this IS that rerun's own outcome, when the rerun
      // lands on a lot).
      if (traceRef.current) {
        traceRef.current.asked = dupMessage;
        traceRef.current.answered = "auto";
        traceRef.current.outcome = `refused: ${dupMessage}`;
      }
      finishTrace();
      setStatus({ kind: "shape", message: dupMessage });
      return;
    }
    const n = lot.done.length;
    // S55 (brief §4): unchanged for a lot of up to 6 (every existing CB-lot
    // case pins this small format); above it, the first 5 numbered readouts
    // followed by a count of the rest -- `expandCommand` can hand back many
    // more than a person would ever read one by one, and the "Ready to do N
    // things" question and the outline (`buildLotHighlights`, below) already
    // say what the whole lot touches.
    const shown = n > 6 ? lot.done.slice(0, 5) : lot.done;
    // DEF-0043 (R-459, tester 30 Sept): a lot of ONE is not numbered; the
    // readouts are joined with a space (each already ends in its own full
    // stop -- "; " printed ".; "), and "And 16 more." is its own sentence, so
    // "Say yes" never runs on from it.
    // S198-A (R-467): a step's own reasons are named with it, the one builder a
    // single sentence's readout uses (`reasonsGivenText`).
    const readouts =
      n === 1 ? spokenStep(shown[0]) : shown.map((r, i) => `${i + 1}. ${spokenStep(r)}`).join(" ");
    const readoutText = n > 6 ? `${readouts} And ${n - 5} more.` : readouts;
    // R-459 (§0's own lot example): "Ready to do N things: ... Say yes to do
    // them, or no." -- never "commands" (a developer's word for a sentence).
    // R-459: `readoutText`'s last item already ends in its own period (every
    // readout sentence does) -- a second, hardcoded one here would print
    // "making Housing A.. Say yes ..." Say yes joins with a leading space,
    // never its own leading period.
    const message = `${dropped !== undefined ? `${dropped} ` : ""}Ready to do ${thingsCount(n)}: ${readoutText} Say yes to do ${oneOrThem(n)}, or no.`;
    setStatus({
      kind: "question",
      message,
      // S195-D: a lot of ONE reads "Do it" -- the sentence above already says
      // "Say yes to do it", and "Do all 1" is no way to talk about one thing.
      candidates: [
        {
          key: "__do_all__",
          label: n === 1 ? "Do it" : `Do all ${n}`,
          action: { kind: "run_lot" },
        },
      ],
      blockHighlight: buildLotHighlights(lot.done),
      lot: true,
    });
    // S59-e (brief §3): the lot's own single question, same as a per-step
    // one above.
    if (traceRef.current) {
      setAsked(traceRef.current, message);
      // DEF-0049: posted at the ask -- see `traceQuestionStatus`'s own doc.
      postTrace(traceRef.current);
    }
  }

  /**
   * S51 (brief §2 item 3): the lot's single "yes" -- a busy status while
   * `onRunLot` is in flight, then either "Done, N things." (input cleared) or
   * `buildLotOutcome`'s own SEPARATE-LINES failure sentence, "I made k of the
   * N changes.\nDone: ...\nNot done: ...\nNot tried: ..." (input kept,
   * DEF-0052 / R-432, 28 Sept -- replaces the old count-only "Did k of N
   * things; the next failed: ..."). The
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
  /**
   * DEF-0052 / R-432 (restated 28 Sept by the maintainer, "SEPARATE LINES",
   * `docs/plan.yaml`'s own R-432 note carries the exact layout she chose
   * from two candidates): a lot's PARTIAL failure names every change, in
   * three groups -- a person who never saw the app can tell from the answer
   * alone what the board looks like now.
   *
   *   I made 1 of the 3 changes.
   *   Done: Sam Patel is on Cell 2 today from 8 am to 4 pm.
   *   Not done: Lena Novak on Cell 3. She is not certified for Welding,
   *   which Cell 3 needs.
   *   Not tried: Tom Baker stays on Cell 1.
   *
   * A clean sweep is unchanged: still the one plain sentence, "Done, N
   * things." -- this shape is for the failure case only.
   *
   * DONE: each already-written change's own readout, `renderReadout`'d --
   * the exact builder the success path and the question before it both use
   * (DEF-0043 item 1: `runLotNow` used to push the RAW `r.readout` here and
   * to the trace, `2026-10-12` and all, while the "Ready to do N things"
   * question just before it rendered the same field through
   * `renderReadout` -- same builder at both, now).
   *
   * NOT DONE: the refused change, named by its own `attempted` ("Lena
   * Novak on Cell 3") -- S194-D: every resolved kind now carries `attempted`
   * and `notTried` beside its `readout`, built by the resolver from the same
   * facts (lane E's interim, which named the refused change by its READOUT
   * and so said it happened, is gone) -- then the reason IN THE PLANT'S WORDS
   * through `rewriteRefusal`, the one rewriter the single sentence uses too
   * (R-449).
   *
   * NOT TRIED: every change after the refused one, each said as what stays
   * (`notTried`: "Tom Baker stays on Cell 1.").
   */
  function buildLotOutcome(
    n: number,
    result: LotResult,
    resolved: readonly ResolvedAny[],
    summary?: string,
  ): string {
    // DEF-0048: an absence lot's clean sweep also says, in its own words,
    // who is off and whether the absence is recorded.
    if (result.error === null) {
      return summary === undefined
        ? `Done, ${thingsCount(n)}.`
        : `Done, ${thingsCount(n)}. ${renderReadout(summary)}`;
    }
    const done = result.done;
    const lines: string[] = [
      `I made ${done === 0 ? "none" : done} of the ${n} ${n === 1 ? "change" : "changes"}.`,
    ];
    if (done > 0) {
      const doneText = resolved
        .slice(0, done)
        .map((r) => spokenStep(r))
        .join(" ");
      lines.push(`Done: ${doneText}`);
    }
    // S194-D (R-432 as the maintainer chose it, 28 Sept): the refused change
    // is named by its OWN `attempted` -- who and where, never the readout,
    // which said it happened -- and the reason in the plant's words through
    // the one rewriter. Every change after it is said as what STAYS
    // (`notTried`), each step's own sentence, built by the resolver.
    const refused = resolved[done];
    const reason = rewriteRefusal(result.error, nodeNameOf);
    const notDoneText = refused ? `${renderReadout(refused.attempted)}. ${reason}` : reason;
    lines.push(`Not done: ${notDoneText}`);
    const notTried = resolved.slice(done + 1);
    if (notTried.length > 0) {
      lines.push(`Not tried: ${notTried.map((r) => renderReadout(r.notTried)).join(" ")}`);
    }
    return lines.join("\n");
  }

  function runLotNow(): void {
    if (runningLotRef.current) return;
    const lot = lotRef.current;
    if (!lot) return;
    runningLotRef.current = true;
    const mySeq = ++lotRunSeqRef.current;
    const n = lot.done.length;
    const resolved = lot.done;
    const summary = lot.summary;
    setStatus({ kind: "reading", message: "Working…" });
    const settle = (result: LotResult): void => {
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
      // DEF-0043 item 1: `renderReadout`'d, same as the trace/thread do
      // everywhere else a written readout is recorded.
      if (traceRef.current) {
        traceRef.current.ran.push(
          ...resolved.slice(0, result.error === null ? n : result.done).map((r) => spokenStep(r)),
        );
      }
      // F-164: the lot's own last word, recorded BEFORE the entry is
      // finished. `runLotNow` used to call `finishTrace()` here and set the
      // failure status AFTER it, so the maintainer's trace listed three of
      // four readouts and NOTHING said why the fourth stopped. `asked`
      // already holds the lot's "Ready to do N things" question, so the result
      // goes in `outcome` -- the same sentence the status line shows.
      const lotOutcome = buildLotOutcome(n, result, resolved, summary);
      if (traceRef.current) traceRef.current.outcome = lotOutcome;
      // CP-7 (session 178, found by the typed walk): the status is set
      // BEFORE the entry is finished, the same order `settleWrite` uses, so
      // `fileTurn` clears it and the lot's last word is on screen ONCE, in
      // the thread. It used to be set after, so "Done, 2 things." stayed
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
      // F-233, second pass: the lot's own write (however many of its steps
      // actually ran) has settled either way -- bring `barWritesInFlightRef`
      // back down and let the queue try to drain.
      barWriteSettled();
      drainHeldQueue();
    };
    // S194-D (lane E's open item): the runner's promise used to have no
    // catch, so a REJECTION (a writer that threw past the runner's own
    // try, a network fault in the runner itself) left "Working…" standing
    // for ever with the trace entry open. Now: a rejection that still says
    // how many were done (a `LotResult`-shaped value) is answered like any
    // other partial failure, through `buildLotOutcome`; one that cannot say
    // is `reportBarCrash`'s, which never claims nothing changed when that is
    // not known. Traced either way (both close the entry with its outcome).
    const fail = (err: unknown): void => {
      if (lotRunSeqRef.current !== mySeq) return;
      if (
        typeof err === "object" &&
        err !== null &&
        typeof (err as { done?: unknown }).done === "number"
      ) {
        const e = err as { done: number; error?: unknown };
        settle({
          done: e.done,
          error: typeof e.error === "string" && e.error !== "" ? e.error : "Something went wrong.",
        });
        return;
      }
      reportBarCrash(err, null, "lot");
    };
    let answer: Promise<LotResult>;
    // F-233, second pass: up the instant `onRunLot` is called, synchronously
    // -- the lot's own settle/fail (above) or a crash caught below is what
    // brings it back down; see those for why.
    barWritesInFlightRef.current += 1;
    try {
      answer = onRunLot(resolved);
    } catch (err) {
      fail(err);
      return;
    }
    answer.then(settle, fail);
  }

  /** R-459 (the maintainer, 24 Sept, this lane's decision on the wording
   *  table's own unsure row): one fixed lead-in, regardless of which of the
   *  three reasons (`unavailable`/`timeout`/`garbled`) sent this sentence to
   *  the rules -- a supervisor does not need to know WHY the voice model
   *  did not answer, only that it did not. `traceModelField` (below) still
   *  records the specific reason for the trace. */
  function failurePrefixForReason(_reason: "unavailable" | "timeout" | "garbled"): string {
    return "I could not reach the voice model, so I read this as typed: ";
  }

  /**
   * R-456 / F-222 (24 Sept, session 191): the verb question -- `guessVerbs`
   * (`src/lib/voice/verbGuess.ts`, S72-a) against the RAW heard text,
   * never the model's own structured reading (that reading is exactly what
   * had no verb, or the wrong one, in the first place). `null` when there is
   * nothing to guess (a real verb was already heard, or the sentence has no
   * shape of a command at all) -- the caller keeps its old answer, unchanged
   * (R-456: never the hint/refusal first for a sentence with a shape).
   * `misheardVerbWord` is asked ONLY once `guessVerbs` has already answered
   * non-empty (that function's own caller contract).
   */
  function verbGuessStatus(sentence: string): Status | null {
    const guesses = guessVerbs(sentence, GROUNDING_VERBS);
    if (guesses.length === 0) return null;
    const heardWord = misheardVerbWord(sentence, GROUNDING_VERBS);
    return {
      kind: "question",
      message: describeVerbGuess(heardWord, guesses),
      candidates: guesses.map((g) => ({
        key: g.verb,
        label: g.label,
        action: { kind: "run_sentence", sentence: g.sentence },
      })),
    };
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
      // R-456 / F-222: before the grammar hint, ask whether a VERB was heard
      // differently -- a hint ("Say it like: assign <person> ...") is not an
      // option; a guessed verb is. Only when there is nothing to guess does
      // the hint show, unchanged.
      const verbStatus = verbGuessStatus(sentence);
      if (verbStatus !== null) {
        setStatus(verbStatus);
        traceQuestionStatus(verbStatus);
        return;
      }
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
    // S72-e (F-224, R-435): the rules grammar's own §1 work reads every
    // shape this checks for, so this fires only for a phrase outside what
    // that work covers, or an intent this lane never touched -- the same
    // safety net `applyReading`'s own twin call is for the model.
    const dayGrounding = groundDays(sentence, parsed.command, DAY_GROUNDING_WORDS);
    if (!dayGrounding.ok) {
      askDayDropped(sentence, parsed.command, dayGrounding.phrase);
      return;
    }
    // R-459 (the maintainer, 24 Sept): the "· read by the rules (...)"
    // suffix used to be appended to the readout here whenever a down model
    // sent this path to the rules instead -- dropped from the thread
    // entirely, nothing replaces it (the trace's own `model` field, set by
    // `traceModelField`, still records why).
    runCommand(parsed.command);
  }

  /** S59-e (brief §2/§3): the trace entry's own `model` field for `result`
   *  -- the raw answer when the reader got far enough to have one (a form,
   *  or a garbled answer past "no message content"), the plain reason
   *  otherwise. `readSentence.ts`'s own `reason`s map onto the brief's own
   *  words ("no service", "timeout", "network") rather than the thread's
   *  own fixed lead-in (`failurePrefixForReason`), which is written for a
   *  person, not a log. */
  function traceModelField(result: Reading): TraceEntry["model"] {
    if (result.ok) return { raw: result.raw ?? "" };
    if (result.reason === "garbled" && result.raw !== undefined) return { raw: result.raw };
    if (result.reason === "no-service") return { skipped: "no service" };
    if (result.reason === "timeout") return { skipped: "timeout" };
    if (result.reason === "unavailable") return { skipped: "network" };
    return { skipped: "garbled" };
  }

  /**
   * S71-m (F-215, R-435/R-431): a sweeping model reading -- an ungrounded
   * unassign, or a lot of more than one command with no word in the heard
   * text for ANY of them -- is refused outright, no button, the same shape
   * a parse failure's own "shape" hint takes on screen. The trace entry
   * ends right here (`cancelStanding`'s own order: the fields go on first,
   * `finishTrace` files the turn -- which clears `status` back to null --
   * and ONLY THEN does this sets the fresh status that is this instant's
   * own last word, same as `cancelStanding`'s "Left it." does).
   */
  function refuseUngrounded(sentence: string, command: Command, versPhrase: string): void {
    // R-459 (the maintainer, 24 Sept): every refusal leads with "Not done:",
    // this one included.
    const message = `Not done: nothing in "${sentence}" says ${versPhrase}. Say it again.`;
    if (traceRef.current) {
      traceRef.current.read = formatCommand(command);
      traceRef.current.asked = message;
      traceRef.current.answered = "auto";
      traceRef.current.outcome = "refused: ungrounded";
    }
    finishTrace();
    setStatus({ kind: "shape", message });
    heldRef.current = null;
  }

  // DEF-0043 item 2 (28 Sept, tester): `spokenCommand` (`@/lib/voice/
  // verbGuess`, imported above) strips the quotes `formatCommand`'s own
  // `quoteIfNeeded` puts around the reserved word "everyone" -- needed only
  // for a round trip back through `parseCommand`, which `askUngrounded`/
  // `askDayDropped` (just below) never do (their candidate reruns the
  // COMMAND OBJECT). See that function's own doc for the full reasoning;
  // shared with `verbGuess.ts`'s own candidate labels rather than a second,
  // hand-synced copy (CLAUDE.md §4). The trace's own `read` field keeps
  // `formatCommand`'s raw, quoted form unchanged (R-459: "the trace keeps
  // its own compact form; this rule is about the thread"). Untouched:
  // `pickCandidate`/`pickPartAsPlace`/`pickPlaceParent` (below), whose
  // rendered text IS fed back into `parseCommand`, so the quoting there
  // still matters.

  /**
   * S71-m (F-212, R-435): a single ungrounded reading is ASKED, never run
   * -- one candidate button, the model's own readout (`formatCommand`) as
   * its label, through the ORDINARY question machinery (`Status.kind:
   * "question"`, `CandidateButton`, `traceQuestionStatus`) rather than a
   * second question shape (brief §1: "do not build a second question
   * shape"). Pressing it is `run_ungrounded` (`runCandidateAction`, above),
   * which calls `runCommand` exactly as an ordinary grounded model reading
   * would; "no" or Escape drop it through the same generic floor every
   * other single-candidate, no-`blockHighlight` question already falls to
   * (`submitText`'s own "F-166 WIDENED" section -- untouched by this piece).
   */
  function askUngrounded(sentence: string, command: Command): void {
    const readout = formatCommand(command);
    // DEF-0043 item 2: the trace keeps `readout` (raw, quoted) below; the
    // thread shows the spoken form (no quotes around "everyone").
    const spoken = spokenCommand(command);
    const message = `I heard "${sentence}". Did you mean: ${spoken}?`;
    const next: Status = {
      kind: "question",
      message,
      candidates: [
        { key: "run_ungrounded", label: spoken, action: { kind: "run_ungrounded", command } },
      ],
    };
    if (traceRef.current) traceRef.current.read = readout;
    setStatus(next);
    traceQuestionStatus(next);
  }

  /**
   * S72-e (F-224, R-435): `groundDays`'s own question (`src/lib/command/
   * grounded.ts`) -- a day or week phrase the heard sentence said that
   * NEITHER reader kept. The candidate is built by RE-PARSING the heard
   * sentence through the RULES grammar (`parseCommand`) -- now that this
   * lane's own §1 grammar work reads every shape `DAY_GROUNDING_WORDS`
   * checks for, that re-parse succeeds whenever the dropped phrase is one of
   * ours (the model's own stale reading is what usually trips this guard --
   * the served model has not been retrained on the wider unassign day
   * shape this lane's own report names). A phrase the guard's word list
   * recognises but the grammar still cannot place falls to the plain
   * question, no button -- the same "nothing to press, only to answer in
   * words" shape `verbGuessStatus`'s own empty case leaves the caller to
   * fall through from.
   */
  function askDayDropped(sentence: string, originalCommand: Command, phrase: string): void {
    const reparsed = parseCommand(sentence);
    const prefix = `I heard "${phrase}" but read it as today.`;
    const next: Status = reparsed.ok
      ? {
          kind: "question",
          // DEF-0043 item 2: display-only, spoken form -- see `spokenCommand`'s
          // own doc. `reparsed.command` is never re-parsed from this text (the
          // candidate reruns the object directly), so quoting buys nothing here.
          message: `${prefix} Did you mean: ${spokenCommand(reparsed.command)}?`,
          candidates: [
            {
              key: "run_ungrounded",
              label: spokenCommand(reparsed.command),
              action: { kind: "run_ungrounded", command: reparsed.command },
            },
          ],
        }
      : {
          kind: "question",
          message: `${prefix} Which days? Say today, tomorrow, a weekday, this week or next week.`,
          candidates: [],
        };
    if (traceRef.current) traceRef.current.read = formatCommand(originalCommand);
    setStatus(next);
    traceQuestionStatus(next);
  }

  /** S44-b: settles a reading that is still current (brief §3.3). */
  function applyReading(sentence: string, result: Reading): void {
    if (traceRef.current) traceRef.current.model = traceModelField(result);
    if (result.ok) {
      // S71-m (F-212/F-215, R-435/R-431): the model's own reading runs
      // unchanged only when it is GROUNDED -- the heard text names its own
      // intent, in some spelling `parse.ts` itself accepts. Checked here,
      // before `runCommand` ever sees it, so neither a write nor a lot's
      // own "Ready to do N things" can stand on a reading nothing in the
      // sentence actually said.
      const grounding = groundReading(sentence, result.command, GROUNDING_VERBS);
      if (!grounding.ok) {
        // R-456 / F-222: before refusing (the sweeping case) or asking to
        // confirm the model's own ungrounded reading, ask whether a VERB was
        // heard differently -- "Show up Lena Novak and Priya Shah today"
        // (a sweeping ungrounded unassign, the model's own guess) becomes a
        // swap question here, never a flat refusal.
        const verbStatus = verbGuessStatus(sentence);
        if (verbStatus !== null) {
          setStatus(verbStatus);
          traceQuestionStatus(verbStatus);
          return;
        }
        if (grounding.reason === "sweeping") {
          refuseUngrounded(sentence, result.command, grounding.intent);
        } else {
          askUngrounded(sentence, result.command);
        }
        return;
      }
      // S72-e (F-224, R-435): grounded on its VERB does not mean the DAY
      // survived -- the served model has not been retrained on unassign's
      // own wider day shape (this lane's own report), so it may still
      // answer `day: null` for a sentence that plainly named a week. Checked
      // second, still before `runCommand` ever sees it.
      const dayGrounding = groundDays(sentence, result.command, DAY_GROUNDING_WORDS);
      if (!dayGrounding.ok) {
        askDayDropped(sentence, result.command, dayGrounding.phrase);
        return;
      }
      // R-459: the "· read by the model" suffix used to be appended to the
      // readout here -- dropped from the thread entirely (the trace's own
      // `model` field still records the raw model answer).
      runCommand(result.command);
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

  /**
   * The command a candidate button's answer makes of `command` -- the one
   * place a picked candidate is substituted in, so pressing it
   * (`pickCandidate`) and asking beforehand what every answer would write
   * (`answersRefusedBeforeAsking`, S196-A) can never read the answer two ways.
   */
  function candidateCommand(
    command: Command,
    field: "operator" | "product" | "place" | "shift",
    candidate: Candidate,
    text?: string,
  ): Command {
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
    return next;
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
    const next = candidateCommand(command, field, candidate, text);
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

  /**
   * R-457 / F-220 (24 Sept, session 191): the `place_mismatch` question's
   * "elsewhere" button -- substitutes the candidate's PARENT name at the
   * qualifier's OWN index in `command.place` (never index 1 -- see the
   * `CandidateAction` doc, commandConversation.ts), leaving `place[0]` (the
   * cell) and every other qualifier untouched, then re-runs exactly as
   * `pickCandidate`'s own place branch does (formatted back to a sentence
   * and reparsed, so the trace and the held command agree on what was
   * actually said -- never a hand-built command the parser never saw).
   * `place_mismatch` is never asked for a `SeveralCommand` (its only
   * question is `several_unsupported`, with no candidates -- same
   * invariant `pickCandidate`'s own place branch already relies on).
   */
  function pickPlaceParent(command: Command, qualifierIndex: number, candidate: Candidate): void {
    const narrowed = command as Exclude<Command, SeveralCommand>;
    const place = [...narrowed.place];
    place[qualifierIndex] = candidate.word;
    const next = { ...narrowed, place };
    if (lotRef.current) {
      updateLotCommand(next as SingleCommand);
      return;
    }
    const rendered = formatCommand(next);
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
    // CU4 (S41-b brief §5): a question's message can carry an ISO day too
    // (`remove_which`/`no_block`'s whole-day `when`) -- the same
    // `renderReadout` substitution the successful-open readout gets.
    //
    // R-459 (the maintainer, 24 Sept): `resolve.ts`'s `describeQuestion` is
    // now the ONE builder for every question sentence -- this used to be
    // computed further down, after a run of ~10 branches that each kept a
    // second, hand-written copy of the SAME fact (`lot_too_big`,
    // `split_needed`, `across_midnight`, `swap_which`, `day_order`,
    // `no_start`, `no_shift_at`, `adjust_inverts`, `adjust_off_day`,
    // `split_outside`, `no_job`, `which_job`) -- the very duplicate control
    // R-449 forbids, and the two copies had already drifted (`split_needed`
    // read two different ways depending on which one answered). Every kind
    // below now falls straight through to this one `message`; only
    // `not_certified`/`outside_area` still need a branch of their own, for
    // the `awaitingOverrideReason`/`awaitingAreaReason` FLAG (never a second
    // copy of the text -- both read `message` too).
    const message = renderReadout(describeQuestion(question));
    // S61-a (R-425, F-155): "warn" (never "block") on a single sentence
    // (never `inLot` -- a lot is refused before its yes, R-425: "a lot
    // never writes half of itself") is the ONE shape that takes a reason as
    // its next answer, free TEXT (`awaitingOverrideReason`, read by
    // `submitText`), never a button.
    if (question.kind === "not_certified") {
      return {
        kind: "question",
        message,
        candidates: [],
        ...(question.policy === "warn" && !question.inLot ? { awaitingOverrideReason: true } : {}),
      };
    }
    // F-165 (S62-b): R-425's shape for the AREA rule -- the twin of the
    // branch above.
    if (question.kind === "outside_area") {
      return {
        kind: "question",
        message,
        candidates: [],
        ...(!question.inLot ? { awaitingAreaReason: true } : {}),
      };
    }
    // S198-A (DEF-0062, R-466): a replace whose incoming person fails a gate
    // the resolver itself runs (certificate, area) -- the same question the
    // probe's door asks (`askReplaceBlocked`), its sentence built from the
    // gate's own question.
    if (question.kind === "replace_blocked") {
      return replaceBlockedStatus(
        message,
        replaceBlockedLabel(question.outgoing, question.incoming),
        {
          kind: "run_removals",
          commands: question.removals,
        },
      );
    }
    // DEF-0040 / R-461 (S194-D): the night shift question -- Yes and No, one
    // pair of the same width (R-447, `yesNo`), each carrying the answers
    // already given to this sentence so the second question never loses the
    // first's (`answer_other_day_part`).
    if (question.kind === "other_day_part") {
      const options: ResolveOptions = { ...heldOptionsRef.current };
      return {
        kind: "question",
        message,
        candidates: question.answers.map((a) => ({
          key: a.id,
          label: a.label,
          action: {
            kind: "answer_other_day_part",
            command,
            direction: question.direction,
            answer: a.id === "clear" ? "clear" : "keep",
            options,
          },
        })),
        yesNo: true,
      };
    }
    // R-430 (S194-D third pass): a window inside a job -- the windows that
    // would work, as buttons (traced as any pick is).
    if (question.kind === "job_hole") {
      return {
        kind: "question",
        message,
        candidates: question.spans.map((s) => ({
          key: s.label,
          label: s.label,
          action: { kind: "pick_span", command, span: { start: s.start, end: s.end } },
        })),
      };
    }
    // DEF-0055 / R-430 / R-435: "clear Maria Lopez tomorrow" -- a person or a
    // place? Both (or the nearest of each) are the buttons; the answer reruns
    // the sentence as that reading (`answer_clear_reading`).
    if (question.kind === "place_or_person") {
      return {
        kind: "question",
        message,
        candidates: question.candidates.map((c) => ({
          key: `${c.reading ?? "place"}:${c.id}`,
          label: c.label,
          action: {
            kind: "answer_clear_reading",
            command,
            reading: c.reading ?? "place",
            word: c.word,
          },
        })),
      };
    }
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
    // R-455 / F-219 (24 Sept, session 191) -- CONTRACT CHANGED (CLAUDE.md
    // §4): this used to ask a question with a "Show that day" button (S59 /
    // R-419's own comment, kept below for the mechanism it still uses). The
    // maintainer's word after the second spoken round: the board just goes
    // there, no press needed. So this pushes a READOUT ("Moved the board to
    // …") and dispatches the SAME move a press used to
    // (`pendingRerunRef`/`onShowDay`) immediately, inline -- every guard
    // R-419 built around that move (the rerun effect above, Escape dropping
    // `pendingRerunRef`, new typing dropping it, the race fix (b) below) is
    // untouched; only the button, and the wait for a press, are gone. The
    // `show_day` action kind stays (`runCandidateAction`'s own case, and the
    // `CandidateAction` union) -- nothing else in this file names it, but a
    // later caller building its own candidates could still reach it the same
    // way.
    //
    // Original S59 / R-419 doc: "Show that day" moves the window through
    // `onShowDay` (the caller's job, see that prop's own doc) and holds
    // `command` (the exact command this question came from -- the ordinary
    // sentence, or a lot's own current step, whichever `questionToStatus`
    // was called with) until the effect above sees a new `ctx` and re-runs
    // it.
    if (question.kind === "day_off_board") {
      const day = question.text;
      armPendingRerun(command, day);
      onShowDay?.(day);
      return {
        kind: "readout",
        // Same day formatting every other readout gets (R-426) -- an ISO
        // token in `day` becomes the plant's own day label; a word already
        // in English ("today", "Thursday", …) passes through unchanged.
        message: renderReadout(`Moved the board to ${day}.`),
        // R-455 / F-219 review fix: this entry is not finished -- the rerun
        // `pendingRerunRef` above just queued still owes an answer. See
        // `Status`'s own `moving` doc (commandConversation.ts) and
        // `traceQuestionStatus`'s own `moving` branch.
        moving: true,
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
            // R-459 review fix (S72-d): `label` used to be `c.label`, which
            // is a PATH for a place candidate (`nodeSuggestions`/
            // `trackCellSuggestions`, resolve.ts: "Cell 2 — Plant 1 ›
            // Assembly ›...", built from `placeLabel`) -- harmless here
            // (this branch only ever fires for `field === "product"`, whose
            // own suggestions always carry `label === word`, a plain name),
            // but the SAME pattern one branch down genuinely showed an
            // arrow-path on a button; fixed to `c.word` in both places for
            // the one rule (never two copies of "which field can this be").
            candidates: suggestions.map((c) => ({
              key: c.id,
              label: c.word,
              action: { kind: "pick_candidate", command, field, candidate: c, text },
            })),
          };
        }
        const fieldNoun = field === "operator" ? "person" : field === "product" ? "part" : "place";
        return {
          kind: "question",
          message: `No ${fieldNoun} called "${text}" on this board. Did you mean one of these?${moreTail}`,
          // R-459 review fix (S72-d, CB-unknown-3b pin below): this used to
          // render `c.label` -- for `field === "place"`, a place candidate's
          // `label` is `placeLabel`'s own arrow-path chain ("Cell 2 — Plant
          // 1 › Assembly › Line 1"), never a bare name (`nodeSuggestions`,
          // resolve.ts). `CB-unknown-3`'s own pin never caught this because
          // its mock (`withUnknownSuggestions`) happened to set `label`
          // equal to `word`; the REAL resolver's place suggestions never do.
          // `c.word` is the bare name every other candidate button in this
          // file shows (`place_mismatch`'s own candidates, just above,
          // already get this right).
          candidates: suggestions.map((c) => ({
            key: c.id,
            label: c.word,
            action: { kind: "pick_candidate", command, field, candidate: c, text },
          })),
        };
      }
      // DEF-0051 / R-430 (28 Sept, tester): a dead end offers the nearest
      // choices -- "No cell called ... on this board." with NO buttons was
      // exactly that dead end for Ana, typing "clear Cell 3 today": Cell 3
      // is a real cell in the plant, one line over, so `resolve.ts`'s own
      // nearest-match suggestions (computed against HER ctx, which never
      // heard of it) come back empty -- a name that exists is not the same
      // as a name that is CLOSE, and only the second gets a suggestion from
      // the server today. The fix is client-only, on purpose: the bar must
      // not say WHERE Cell 3 really is (a line supervisor cannot read a
      // place above her own grant, CLAUDE.md §4's "resolved by the server
      // as a definer" standard applied to a REFUSAL's wording, not only a
      // write) and must not learn it either -- so this never asks the
      // server again or inspects the question for a hint. It offers her OWN
      // board's cells instead (`ctx.cells`, already on the client for the
      // toolbar), exactly the choices `resolveCellStep` would have let her
      // pick from if she had typed a cell already on her board -- the
      // "nearest" a client that cannot see past her grant can honestly
      // offer. Only for `field === "place"`: a person/part with no
      // suggestions keeps its own plain fallback just above, unchanged
      // (not this defect's own reproduction; a candidate list this wide for
      // every person or part in the plant is a different, unverified
      // question this lane did not test).
      if (question.field === "place") {
        const ctx = lastCtxRef.current;
        const cells = ctx?.cells ?? [];
        if (cells.length > 0) {
          const text = question.text;
          return {
            kind: "question",
            message: `No cell called "${text}" on your board. Did you mean one of these?`,
            candidates: cells.map((cell) => ({
              key: cell.id,
              label: cell.name,
              action: {
                kind: "pick_candidate",
                command,
                field: "place",
                candidate: { id: cell.id, label: cell.name, word: cell.name },
                text,
              },
            })),
          };
        }
      }
      // S194-D (R-430 for a person, the open item lane E left): a person the
      // resolver found no near name for is the same dead end DEF-0051 was for
      // a place. Offered here: the people the caller's OWN board already holds
      // (`ctx.operators`, active only -- the create pop-up's own pool), in
      // the board's order, capped at eight the way the resolver caps a place
      // or part list, with "and more" past it -- never a guess at who was
      // meant, never a name from outside what she can see.
      //
      // NOT for a part, on purpose: `resolvePartStep` answers a part with no
      // near name by offering what the resolved CELL makes (R-422) -- it
      // reaches this no-suggestions shape only when that cell makes nothing
      // at all, and then every part on the board would be refused there
      // (`not_offered`). Offering them would break R-431 to satisfy R-430.
      if (question.field === "operator") {
        const ctx = lastCtxRef.current;
        const pool = (ctx?.operators ?? [])
          .filter((o) => o.active)
          .map((o) => ({ id: o.id, name: o.displayName }));
        if (pool.length > 0) {
          const text = question.text;
          const field = question.field;
          const noun = "person";
          const shown = pool.slice(0, UNKNOWN_FALLBACK_CAP);
          const tail = pool.length > UNKNOWN_FALLBACK_CAP ? ` … and more — say the ${noun}.` : "";
          return {
            kind: "question",
            message: `No ${noun} called "${text}" on your board. Did you mean one of these?${tail}`,
            candidates: shown.map((it) => ({
              key: it.id,
              label: it.name,
              action: {
                kind: "pick_candidate",
                command,
                field,
                candidate: { id: it.id, label: it.name, word: it.name },
                text,
              },
            })),
          };
        }
      }
      return { kind: "question", message, candidates: [] };
    }
    // R-457 / F-220 (24 Sept, session 191): "There is no Cell 5 in Line 1"
    // used to leave the person to retype the sentence with the right
    // qualifier by hand. `elsewhere` (resolve.ts's `elsewhereParents`) names
    // each matched cell's own PARENT -- offered here as a button, same shape
    // `unknown`'s suggestions already use. `elsewhereParents` builds each
    // candidate's `label` from `placeLabel` (a PATH: "Line 3 — Plant 1 ›
    // Assembly", never a bare name), so the button shows `candidate.word`
    // (the parent's bare name, what a person would actually say) and the key
    // carries the path -- two different parents named the same thing stay
    // distinct buttons. An empty `elsewhere` (every matched cell has no
    // parent node at all -- F-213's own edge case, `describeQuestion` already
    // stops after one sentence for it) shows no buttons, unchanged.
    if (question.kind === "place_mismatch") {
      if (question.elsewhere.length === 0) {
        return { kind: "question", message, candidates: [] };
      }
      const narrowed = command as Exclude<Command, SeveralCommand>;
      // Never assume index 1 (CLAUDE.md §4): the qualifier that mismatched
      // is matched back against the command's own `place` array by word.
      const qualifierIndex = narrowed.place.indexOf(question.qualifier);
      if (qualifierIndex < 0) {
        return { kind: "question", message, candidates: [] };
      }
      return {
        kind: "question",
        message,
        candidates: question.elsewhere.map((c) => ({
          key: c.label,
          label: c.word,
          action: { kind: "pick_place_parent", command, qualifierIndex, candidate: c },
        })),
      };
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
  /**
   * DEF-0046, the bar's half (28 Sept, tester): "extend everyone on Cell 1
   * by 30 minutes" -- typed, or the same reading offered as a button after a
   * garbled model transcript -- throws inside `resolveMoveCommand`
   * (`resolve.ts`), reached from here through `pick_candidate`'s/
   * `run_ungrounded`'s own call into `pickCandidate`/`runCommand`. Before
   * this, the throw reached `onClick` uncaught: nothing in the console but
   * the browser's own unhandled-rejection style report, the question and its
   * buttons frozen exactly as they were (React never re-rendered past the
   * throw), no trace entry at all (R-434's own rule broken a fourth way,
   * beside the three DEF-0049 lists). `runCommand`/`resolveLotStep`/
   * `startLot` each already catch at their own body (their own doc,
   * `reportBarCrash`'s doc, right below) -- most of this switch's own cases
   * end up back in one of those (`pick_candidate` -> `pickCandidate` ->
   * `runCommand`, `run_lot` -> `runLotNow`, and so on) and are covered
   * there; this wraps the switch itself too, the backstop for a throw in a
   * `pick*` helper's OWN code before it ever reaches one of the three
   * (building the substituted command, say), or in the dispatch here.
   */
  function runCandidateAction(action: CandidateAction): void {
    try {
      runCandidateActionBody(action);
    } catch (err) {
      reportBarCrash(err, null);
    }
  }

  function runCandidateActionBody(action: CandidateAction): void {
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
      case "pick_place_parent":
        pickPlaceParent(action.command, action.qualifierIndex, action.candidate);
        return;
      case "pick_existing":
        pickExisting(action.command, action.existing);
        return;
      case "show_day":
        armPendingRerun(action.command, action.target);
        onShowDay?.(action.target);
        return;
      case "run_ungrounded":
        // R-459: the "· read by the model" suffix is gone from the thread.
        runCommand(action.command);
        return;
      case "run_sentence":
        // R-456 / F-222 (24 Sept, session 191): the generic candidate-button
        // `onClick` (below) already set the entry this closes (`traceRef.
        // current.answered`) to this button's own label before this ran --
        // `submitText` starts a FRESH entry for `action.sentence`, finishing
        // that one first, same as Enter on any typed sentence.
        submitText(action.sentence);
        return;
      case "run_lot":
        runLotNow();
        return;
      case "run_removals":
        runRemovalsNow(action);
        return;
      case "leave_it":
        cancelStanding("Leave it");
        return;
      case "answer_lot_overlap":
        answerLotOverlap(action.step, action.answer);
        return;
      case "pick_span": {
        // R-430 (S194-D third pass): the same sentence with the offered span,
        // printed and re-read like every other pick, so the bubble and the
        // trace say what was actually run.
        const next = { ...(action.command as UnassignCommand), span: action.span };
        const rendered = formatCommand(next);
        store.getState().set({ sentence: rendered, text: "" });
        const parsed = parseCommand(rendered);
        if (!parsed.ok) {
          if (traceRef.current) traceRef.current.read = parsed.failure.kind;
          const status = failureToStatus(parsed.failure);
          setStatus(status);
          traceQuestionStatus(status);
          return;
        }
        runCommand(parsed.command, undefined, { ...heldOptionsRef.current });
        return;
      }
      case "answer_clear_reading": {
        // DEF-0055: the person chose. The PERSON reading is the sentence
        // "remove <name> <day>" (the words after clear become the operator);
        // the PLACE reading is the same sentence with `clearAs: "place"`, so
        // `readClearAsPerson` does not ask a second time.
        const base = action.command as UnassignCommand;
        const next: UnassignCommand =
          action.reading === "person"
            ? { ...base, operator: action.word, place: [] }
            : { ...base, place: [action.word] };
        const rendered = formatCommand(next);
        store.getState().set({ sentence: rendered, text: "" });
        const parsed = parseCommand(rendered);
        if (!parsed.ok) {
          if (traceRef.current) traceRef.current.read = parsed.failure.kind;
          const status = failureToStatus(parsed.failure);
          setStatus(status);
          traceQuestionStatus(status);
          return;
        }
        runCommand(parsed.command, undefined, {
          ...heldOptionsRef.current,
          ...(action.reading === "place" ? { clearAs: "place" as const } : {}),
        });
        return;
      }
      case "answer_other_day_part": {
        // DEF-0040 / R-461 (S194-D): the Yes or No of a night shift question.
        // The entry already holds this ask and this answer (the button's
        // onClick, or the typed yes/no) -- carried so a SECOND question
        // lands after them in the same entry (R-434), never over them.
        const entry = traceRef.current;
        if (entry) {
          store.getState().set({
            traceCarry: { asked: entry.asked ?? "", answered: entry.answered ?? "" },
          });
        }
        const next: ResolveOptions = {
          ...action.options,
          ...(action.direction === "previous"
            ? { previousDayPart: action.answer }
            : { nextDayPart: action.answer }),
        };
        runCommand(action.command, undefined, next);
        return;
      }
    }
  }

  /**
   * DEF-0046, the bar's half (28 Sept, tester): the one place `runCommand`/
   * `resolveLotStep`/`startLot`/`runCandidateAction` each land on a throw --
   * never a second, hand-written copy of "what does a crash say" per
   * function (R-449/CLAUDE.md §4). `wrote`, when given, is the one readout
   * a caller already confirmed a writer prop was called for before the
   * throw (see `runCommand`'s own doc) -- there is no real multi-item LOT
   * write in scope for any of these four (a lot's own writes happen only
   * inside `runLotNow`, which is not one of them; see this function's own
   * report note), so this never builds `buildLotOutcome`'s fuller shape,
   * only its same Done/Not-done vocabulary for the ONE thing that may have
   * happened.
   *
   * R-434: recorded as a trace entry with its outcome, through the SAME
   * `refused: <message>` shape every other refusal already uses
   * (`turnResultLine` renders it "Not done: <message>", R-459's own prefix,
   * never a second rendering rule for a fourth outcome kind). The question
   * and its buttons never stay frozen: `lotRef.current` is dropped and a
   * fresh `status` replaces whatever stood, the same as `cancelStanding`'s
   * own "Left it." floor.
   */
  function reportBarCrash(
    err: unknown,
    wrote: { readout: string } | null,
    // S194-D: "lot" -- the lot's own runner rejected without saying how many
    // of its changes it made, so this cannot claim nothing changed.
    during?: "lot",
  ): void {
    const detail = err instanceof Error ? err.message : String(err);
    const message =
      during === "lot"
        ? "Something went wrong while making the changes; some may have been made. Check the board before saying it again."
        : wrote
          ? `${renderReadout(wrote.readout)} Something went wrong after that; check the board before saying it again.`
          : "Something went wrong and nothing was changed. Say it again.";
    if (traceRef.current) {
      if (traceRef.current.answered === null) traceRef.current.answered = "auto";
      traceRef.current.outcome = `refused: ${message}`;
      finishTrace();
    } else {
      // R-434: no entry was open (belt and braces -- every real caller here
      // starts one before it can reach a `resolve.ts` call at all) -- filed
      // as its own standalone turn rather than the fault going unrecorded.
      fileStandaloneTurn(message, "typed", `refused: ${message}`);
    }
    lotRef.current = null;
    runningLotRef.current = false;
    setStatus({ kind: "shape", message });
    setText("");
    heldRef.current = null;
    heldOptionsRef.current = {};
    // F-233, second pass: `wrote` non-null means a writer WAS already
    // called (`runCommandBody`'s own increment, above) before this crash --
    // and a lot crash (`during === "lot"`) always means `onRunLot` was
    // called too. Either way the count that call took must come back down
    // here, or a single crashed write would hold every later sentence for
    // the rest of the session. Neither case means nothing happened server
    // side (the message above already says so), so this settles rather
    // than abandons.
    if (wrote !== null || during === "lot") {
      barWriteSettled();
      drainHeldQueue();
    }
    console.error("CommandBar: caught while resolving/running a command:", detail, err);
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
    clearPendingRerun();
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
    // never reaches here at all (S71-j: it sets `interimHint`, the
    // placeholder, not `text`), so `status` itself is untouched by an
    // interim result. F-197 (22 Sept): that used to be only half true in
    // effect -- `onInterim` still unconditionally cleared `heldRef.current`,
    // the ref an override-reason answer is re-resolved against, so a spoken
    // reason lost its held command even though the question stayed on
    // screen. `onInterim` carries the same `answerTakes`-gated guard this
    // block does, so a speech result that is still interim (the person may
    // be about to say "yes", or still speaking a reason) leaves both the
    // question AND the command it will answer alone, on purpose.
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
    // F-197 REVIEW FIX (the reviewer, 22 Sept): `submitText` is called both
    // from a fresh, current-render closure (`handleKeyDown`'s own Enter
    // branch, always up to date) and from `onFinal`, a closure created back
    // when `startListening` was called -- a browser session can run for
    // several seconds, and this component re-renders (and `status` changes)
    // freely in that window, so by the time a LATE final actually arrives
    // the `status` this function would otherwise close over is whatever it
    // was AT THE MOMENT THE MIC WAS PRESSED, not what is standing now. Every
    // branch below decides what a `value` MEANS (a reason, a candidate
    // pick, a lot's yes, a cancel, or a whole new sentence) by reading
    // `status` -- so a stale `status` here does not just show a stale
    // MESSAGE, it can re-answer a question that already finished, a
    // different way, a second time (CB-stale-1's own pin, below, found by
    // the reviewer: an ambiguous "Which person?" question widened F-197's own
    // mic-press guard now keeps alive through a press; the person types
    // "Sam Patel" instead of finishing the voice turn -- written once -- and
    // the still-listening session's own LATE final, "Sam Ortiz", matched
    // that same (long since answered) candidate list and wrote it AGAIN).
    // Reading the store directly here, once, shadows the outer `status` for
    // the rest of this function with whatever is standing AT THE MOMENT
    // THIS SUBMISSION IS ACTUALLY PROCESSED -- identical to the outer one
    // for every TYPED call (nothing else runs between the keystroke and this
    // line), and the fix for a LATE spoken one.
    const status = store.getState().status;
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
    // say it again once the lot's own "Done, …"/"Did k of N…" turn lands.
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
    if (isCancel) clearPendingRerun();
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
        if (traceRef.current) setAnswered(traceRef.current, value);
        // S198-A (DEF-0061, R-467): a lot is standing -- this reason answers
        // the lot's CURRENT step, never `heldRef` (which holds whatever
        // single sentence came before, or nothing: `runCommand`'s several
        // branch returns before it is set). That was the bug in both orders.
        if (lotRef.current !== null) {
          setText("");
          answerLotReason(reasonField, value);
          return;
        }
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
        // R-459: no "·" in a sentence the bar shows -- each reason is its
        // own plain clause, appended after the readout's own period.
        // S198-A (R-449): one builder, `reasonsGivenText`, shared with the lot's
        // listing.
        // R-437: this Enter answered the standing question with a reason --
        // never a new sentence (`sentence` already names the ORIGINAL one,
        // untouched here), but still an Enter, so the box empties for
        // whatever `runCommand` below turns into (a write, another
        // question, a refusal).
        setText("");
        runCommand(command, reasonsGivenText(nextOptions), nextOptions);
        return;
      }
    }
    // DEF-0040 / R-461 (S194-D): a night shift question is answered by a
    // bare yes or no -- "no" here is the answer No (keep the other day's
    // part), never the cancel it is at every other question; the other
    // cancel words still drop the sentence. Pressed through the buttons' own
    // actions, so a typed answer and a click are one path.
    if (status?.kind === "question" && status.yesNo && (isConfirmCandidate || isCancel)) {
      const yes = status.candidates.find((c) => c.key === "clear");
      const no = status.candidates.find((c) => c.key === "keep");
      if (UNIVERSAL_CONFIRM_WORDS.has(normalized) && yes) {
        if (traceRef.current) setAnswered(traceRef.current, yes.label);
        setText("");
        runCandidateAction(yes.action);
        return;
      }
      if (normalized === "no" && no) {
        if (traceRef.current) setAnswered(traceRef.current, no.label);
        setText("");
        runCandidateAction(no.action);
        return;
      }
      if (isCancel) {
        cancelStanding(value);
        return;
      }
      // R-461 (29 Sept): the re-ask agrees with the question's own ending.
      setStatus({ ...status, message: "Say yes or no, or cancel to stop." });
      return;
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
          if (traceRef.current) setAnswered(traceRef.current, value);
          runLotNow();
          return;
        }
        const n = lotRef.current?.done.length ?? status.candidates.length;
        setStatus({
          ...status,
          message:
            n === 1
              ? "That is 1 thing; say yes to do it, or no."
              : `That is ${thingsCount(n)} at once; say yes to do them all, or no.`,
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
            if (traceRef.current) setAnswered(traceRef.current, value);
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
        // Reviewer fix (R-455 / F-219, 24 Sept session 191): a LOT can be
        // standing (`lotRef.current`) even though the CURRENT status is not
        // a "question" -- the current step's own `day_off_board` readout
        // ("N of M: Moved the board to …", `resolveLotStep`'s own `moved`
        // branch, still visible while its rerun is pending). Without this, a
        // cancel word here fell straight to the "nothing standing" floor
        // below -- "Nothing to cancel." -- while the lot itself sat there
        // stuck, never actually cancelled, the exact lie R-434 exists to
        // catch in the trace, now caught live instead.
        if (isCancel && lotRef.current) {
          cancelStanding(value);
          return;
        }
        if (isConfirmCandidate && onConfirmWord) {
          const result = onConfirmWord();
          if (result === "created") {
            setText("");
            return;
          }
          if (result === "needs-decision") {
            setStatus({ kind: "shape", message: "Answer the window that is open first." });
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
      // S71-m review fix (F-212, R-435): the one shape below the block/lot
      // branches above that a bare "yes" DOES answer -- `askUngrounded`'s
      // own one-button question (`isYesShapedQuestion`, above). Pressing it
      // is the same call the button's own `onClick` makes.
      if (isConfirmCandidate && isYesShapedQuestion(status)) {
        if (traceRef.current) setAnswered(traceRef.current, value);
        runCandidateAction(status.candidates[0].action);
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
        if (traceRef.current) setAnswered(traceRef.current, picked.label);
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
    clearPendingRerun();
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
      // R-456 / F-222 (24 Sept, session 191): the SAME check `fallbackToRules`
      // makes (CLAUDE.md §4, "extract, never retype" -- this branch is that
      // one's own twin for the no-reader/empty-text path, not a second copy
      // of the rule): before the grammar hint, ask whether a verb was heard
      // differently. Without this, a typed sentence with no reader wired at
      // all (this bar's own default) never reached R-456 -- the hint showed
      // first every time.
      const verbStatus = verbGuessStatus(value);
      if (verbStatus !== null) {
        setStatus(verbStatus);
        traceQuestionStatus(verbStatus);
        return;
      }
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
    // S71-f review fix (session leak): a clip this session stashed via
    // `onClip` but never itself consumed (no `onFinal`/`onError` reached it
    // before this session ended) can never legitimately attach to whatever
    // session starts next -- dropped here rather than left for
    // `attachPendingClip`'s own `seq` check to catch later.
    pendingClipRef.current = null;
    // S71-j (R-454): a session's own progress and interim hint die with it
    // -- neither carries into whatever the box shows next (a typed sentence,
    // idle, or a fresh session's own first "listening").
    setInterimHint("");
    setMicPhase(null);
  }

  /** S46-a: stops the in-flight recognition session, if any -- shared by a
   *  second press of the mic button and by Escape while listening. Text is
   *  kept and the status line is left untouched (brief §2.2). S71-j: this
   *  used to also decide (via F-206's `lastInterimTextRef`) whether the
   *  box's TEXT was a half-typed sentence worth keeping or just the last
   *  status word `onInterim` had written into it -- moot now that neither a
   *  status word nor an interim transcript is ever written into the text at
   *  all (`onInterim` only ever sets `interimHint`, the placeholder), so
   *  there is nothing left here to clean up. */
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
    //
    // F-197 (the spoken walk, 22 Sept, R-425/R-434): S47's own guard only
    // ever named `blockHighlight` (remove_which/move_which/block_exists),
    // never the other question kinds a fresh mic press can be answering --
    // a `not_certified` warn question wanting a REASON ("The line supervisor
    // approved the cover.") is exactly as answerable by voice as a removal's
    // "yes", and the walk's own trace shows the question wiped the instant
    // the mic was pressed, before a word was even said. `answerTakes` (this
    // file's own "is there an answer box standing" predicate, already used
    // by `handleChange`'s identical typed-edit guard below) is the SAME
    // check, taken from there rather than re-derived (CLAUDE.md §4/§7): it
    // is non-null for every question kind that genuinely wants an answer
    // (a reason, a lot's yes/no, an ambiguous name, a block question's own
    // yes) and null for the handful that do not (a shape hint, a readout, a
    // reading, a bare "Show that day" prompt) -- so this widens the survivor
    // set to match `handleChange`'s, never narrows it (every `blockHighlight`
    // question `answerTakes` already answers "yes or no" for, so nothing
    // S47 protected stops being protected).
    // R-458 / F-221 (24 Sept, session 191): a mic press used to clear
    // `status` unless `answerTakes` recognised it as an answerable question
    // (F-197's own widening, above) -- the maintainer's word after the
    // second spoken round is that NOTHING standing is dropped by a mic
    // press, not even a plain readout or a refusal: "Listening…" shows
    // beside the button while whatever was last on the line stays put, and
    // the NEXT answer (a final transcript, a pick, a new sentence) replaces
    // it exactly as it always did. So this is now a pure no-op left for the
    // history above; nothing here clears `status` on a mic START (a stop
    // already left it alone -- `stopListening`/`endSession` never touched
    // it either).
    const mySeq = ++recognitionSeqRef.current;
    function isCurrent(): boolean {
      return recognitionSeqRef.current === mySeq;
    }
    const handle = activeRecognizer({
      onInterim(interimText: string): void {
        if (!isCurrent()) return;
        // F-197 (the spoken walk, 22 Sept): mirrors `handleChange`'s own
        // `keepingTheAnswer` guard below -- while an answer box stands, an
        // interim transcript is the ANSWER being composed, not a new
        // sentence, exactly the same reason a typed keystroke does not drop
        // it either (that guard's own comment already claimed this handler
        // "leaves a standing question alone regardless, on purpose", which
        // was true for `status` but not for `heldRef`: every interim result
        // -- there are several before the final one -- unconditionally
        // cleared `heldRef.current` here, so by the time the final
        // transcript reached `submitText`'s own `awaitingOverrideReason`
        // branch the held command was already gone, its "belt and braces"
        // early return fired, and the trace line was left with `answered`
        // set to the spoken reason and `outcome` stuck at null -- written
        // nowhere. `answerTakes` is the same predicate `startListening`'s
        // own mic-press guard above now uses, taken from there rather than
        // re-derived.
        if (answerTakes(status) === null) heldRef.current = null;
        // S71-j (R-454): a partial transcript is shown as the input's
        // PLACEHOLDER only (`interimHint`, read in the JSX below) -- never
        // written into the value the way `setText` used to. `heldRef`'s own
        // guard above is untouched: it is about which COMMAND a spoken
        // reason resolves against, not about what the box displays.
        setInterimHint(interimText);
      },
      // S71-j (R-454): the recogniser's own progress -- "listening" while
      // the microphone is open waiting for speech, "transcribing" once a
      // clip has been posted and an answer is awaited. Shown beside the mic
      // button (the JSX below), never in the box. `localRecognizer.ts` is
      // the only caller today; a plain `browserRecognizer()` session never
      // fires this, so `micPhase` simply stays `null` for it and the label
      // shows nothing, unchanged from before this event existed.
      onStatus(phase: "listening" | "transcribing"): void {
        if (!isCurrent()) return;
        setMicPhase(phase);
      },
      // S71-f (brief §1.B): fires once, before `onFinal`/`onError`, with
      // the clip `localRecognizer.ts` is about to post -- stashed here,
      // attached once `onFinal`/`onError` below has actually opened the
      // fresh trace entry for it (`attachPendingClip`'s own doc).
      onClip(info: ClipInfo): void {
        if (!isCurrent()) return;
        pendingClipRef.current = { seq: mySeq, info };
      },
      onFinal(finalText: string): void {
        if (!isCurrent()) return;
        setText(finalText);
        // S59-e (brief §3): `by` for the trace entry this starts --
        // `recognizerName`'s own doc explains the "browser" fallback. S60-b:
        // called HERE, not read as a plain value, so a clip that fell back
        // mid-session is traced by what actually ran for THIS clip.
        submitText(finalText, recognizerName?.() ?? "browser");
        attachPendingClip(mySeq);
      },
      onError(kind, detail): void {
        if (!isCurrent()) return;
        // S71-f review fix (session leak): `attachPendingClip` below must
        // run BEFORE `endSession()` -- `endSession()` now clears
        // `pendingClipRef` outright (`pendingClipRef`'s own doc), and a
        // clip THIS session posted just before erroring out (e.g. Whisper
        // answered a non-speech tag only, `no-speech`) must still attach to
        // THIS session's own entry, not be wiped by its own session ending.
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
        attachPendingClip(mySeq);
        finishTrace();
        endSession();
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

  // S71-d (R-451): the launcher's Ctrl+M reaches this component only through
  // `micRequest`, a counter it cannot act on itself (it does not own the
  // recogniser). This fires once per increment and does exactly what a mic
  // click does -- `handleMicClick` above already reads `listening`/
  // `recognizer` live, so there is nothing stale to guard here (unlike
  // `submitText`'s own `store.getState()` read, CB-stale-1's fix: that one
  // guards an ASYNC callback created long before it runs, while this effect
  // body is the CURRENT render's closure, run synchronously once React
  // commits the very render that changed `micRequest`).
  //
  // `micRequest === 0` never fires, which covers two cases at once: a bar
  // with no launcher above it (every caller that never sets the prop), and
  // this bar's OWN first mount with the default -- so a fresh mount is only
  // ever mistaken for a request when the launcher deliberately opened the
  // panel WITH a non-zero count already on it (brief §0 case 1: Ctrl+M on a
  // closed panel opens it AND starts listening, in that same press).
  useEffect(() => {
    if (micRequest === 0) return;
    handleMicClick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micRequest]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter") {
      e.preventDefault();
      submitText(text);
      return;
    }
    if (e.key === "Escape") {
      // S59 (R-419): Escape always drops a "Show that day" press's pending
      // rerun, whichever of the branches below actually fires.
      clearPendingRerun();
      // F-233, second pass (finding 3): checked BEFORE the "a lot writing
      // in the background" guard just below, on purpose -- a held sentence
      // has NOT started (it is only queued, waiting its turn), unlike a lot
      // actually running, which this Escape still leaves alone either way.
      // The two can stand at once (a lot in flight is itself a write the
      // bar is waiting on, so a sentence said while it runs is held behind
      // it) -- dropping the queue here cancels only what has not started.
      if (dropHeldQueueAsCancelled("escape")) {
        setStatus(null);
        return;
      }
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
        // R-461 as amended (29 Sept): through `setAnswered`, so an Escape at
        // the second night shift question keeps the first question's answer
        // ("Yes\nescape") -- identical to the plain write when nothing is
        // carried.
        if (traceRef.current) setAnswered(traceRef.current, "escape");
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
                {/* F-207: a button press already reads back through the chip
                    tick above, but a VOICE or TYPED answer folds straight
                    into `turn.answered` with no bubble at all -- a "say or
                    type yes" question has no chips to tick in the first
                    place, so nothing on screen changed until the result
                    line landed and the person said "yes" again, to
                    "Nothing to say yes to." `NON_ANSWER_SENTINELS` (above)
                    names the two values that are not a genuine answer --
                    every other non-null value is one, whether it is a
                    chip's own label (the tick stays; showing it here too is
                    what makes voice and button read the same) or the
                    literal spoken/typed word. */}
                {turn.answered !== null && !NON_ANSWER_SENTINELS.has(turn.answered) && (
                  <div className={styles.bubble} data-side="you">
                    {turn.answered}
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
                    <div
                      className={
                        status.yesNo || status.pair
                          ? `${styles.candidates} ${styles.answerPair}`
                          : styles.candidates
                      }
                    >
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
                            if (traceRef.current) setAnswered(traceRef.current, c.label);
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
            just above the input (`.threadBody`'s own `flex: 1 1 auto` above
            it grows to fill the panel and leaves this sitting right after
            it -- F-192 replaced that rule's OWN bottom-anchoring, the now
            -removed `justify-content: flex-end`, with `margin-top: auto` on
            `.turn:first-child`, which does not touch this sibling at all).
            Not a turn: no `key`,
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
          // S71-j (R-454): a recogniser's interim transcript (`interimHint`)
          // is shown here, as the placeholder, never written into `value` --
          // it wins over the ordinary `answerTakes(status) ?? PLACEHOLDER`
          // placeholder only while it is non-empty.
          placeholder={interimHint !== "" ? interimHint : (answerTakes(status) ?? PLACEHOLDER)}
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
              title="Uses the browser's speech recogniser; audio is sent to the browser maker's service (Ctrl+M)"
              onClick={handleMicClick}
            >
              <Microphone size={18} filled={listening} />
            </button>
            {/* S71-j (R-454): the recogniser's own progress, from
                `onStatus` -- never a status word in the box above. `null`
                (idle, or a plain browser session that never reports a
                phase) renders nothing, same as `listening === false` did
                before this event existed. */}
            {micPhase !== null && (
              <span className={styles.listeningLabel}>
                {micPhase === "listening" ? "Listening…" : "Transcribing…"}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
