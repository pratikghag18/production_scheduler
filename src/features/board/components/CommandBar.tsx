import { useRef, useState } from "react";
import type { DateFormat } from "@/lib/format/dates";
import { formatDayLabel } from "../lib/time";
import fieldStyles from "@/components/Field.module.css";
import styles from "./CommandBar.module.css";
import { parseCommand, formatCommand, expectedShape } from "@/lib/command/parse";
import type {
  AssignCommand,
  BookCommand,
  UnassignCommand,
  MoveCommand,
  Command,
  Attach,
  Existing,
  ParseFailure,
} from "@/lib/command/parse";
import { resolveCommand, describeQuestion } from "@/lib/command/resolve";
import type {
  ResolveContext,
  ResolvedCommand,
  ResolvedBook,
  ResolvedUnassign,
  ResolvedMove,
  Question,
  Candidate,
} from "@/lib/command/resolve";

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
 */

type Status =
  | { kind: "shape"; message: string }
  | { kind: "question"; message: string; candidates: CandidateButton[] }
  | { kind: "readout"; message: string };

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
}

const PLACEHOLDER = "Assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2";

/** The readout's day is an ISO token (`resolve.ts` cannot import the date
 *  seam); this is the one place it is rendered through it (brief §3). */
const ISO_DAY = /\d{4}-\d{2}-\d{2}/;

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
}: CommandBarProps) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The last parsed command, kept so a candidate button can substitute one
  // field and so a run/job-question button can set `attach`/`existing`
  // without retyping the sentence (brief §6). Any edit to the input
  // invalidates it. S41-a widens this from `AssignCommand` to `Command`
  // (the union also holding `BookCommand`) since the bar now parses both.
  const heldRef = useRef<Command | null>(null);

  function renderReadout(readout: string): string {
    return readout.replace(ISO_DAY, (iso) =>
      formatDayLabel(new Date(`${iso}T00:00:00Z`), dateFormat, zone),
    );
  }

  function anchorOfInput(): { x: number; y: number } {
    const rect = inputRef.current?.getBoundingClientRect();
    return { x: rect?.left ?? 0, y: rect?.bottom ?? 0 };
  }

  function runCommand(command: Command): void {
    heldRef.current = command;
    const resolution = resolveCommand(command, ctx);
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
      } else {
        if (resolved.target.kind === "retime") {
          onRetime(resolved, anchorOfInput());
        } else {
          onOpen(resolved, anchorOfInput());
        }
      }
      setStatus({ kind: "readout", message: renderReadout(resolved.readout) });
      return;
    }
    setStatus(questionToStatus(resolution.question, command));
  }

  function pickCandidate(
    command: Command,
    field: "operator" | "product" | "place",
    candidate: Candidate,
  ): void {
    // "operator" only ever comes from an AssignCommand's ambiguous question
    // (a `BookCommand` has no operator field, and an `UnassignCommand`'s
    // ambiguous-operator question re-resolves through its own `operator`
    // field below rather than this cast). "product" only ever comes from
    // AssignCommand or BookCommand (S41-b: unassign names no part at all).
    // Both casts mirror those invariants rather than re-deriving them from
    // `command.intent`.
    const next: Command =
      field === "operator"
        ? command.intent === "unassign"
          ? { ...command, operator: candidate.word }
          : { ...(command as AssignCommand), operator: candidate.word }
        : field === "product"
          ? { ...(command as AssignCommand | BookCommand), product: candidate.word }
          : { ...command, place: [candidate.word] };
    const rendered = formatCommand(next);
    setText(rendered);
    const parsed = parseCommand(rendered);
    if (!parsed.ok) {
      heldRef.current = null;
      setStatus(failureToStatus(parsed.failure));
      return;
    }
    runCommand(parsed.command);
  }

  function pickAttach(command: AssignCommand, attach: Attach): void {
    // R-383: the sentence stays as it is -- only the held command's `attach`
    // changes -- so this re-resolves directly rather than going back through
    // `parseCommand` (which always returns `attach: null`).
    runCommand({ ...command, attach });
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
    runCommand({ ...command, existing } as Command);
  }

  function questionToStatus(question: Question, command: Command): Status {
    // CU4 (S41-b brief §5): a question's message can carry an ISO day too
    // (`remove_which`/`no_block`'s whole-day `when`) -- the same
    // `renderReadout` substitution the successful-open readout gets.
    const message = renderReadout(describeQuestion(question));
    if (question.kind === "ambiguous") {
      const field = question.field;
      return {
        kind: "question",
        message,
        candidates: question.candidates.map((c) => ({
          key: c.id,
          label: c.label,
          onClick: () => pickCandidate(command, field, c),
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
      if (question.same) {
        return { kind: "question", message, candidates: [separate] };
      }
      return {
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
      };
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
      if (question.blocks.length === 1) {
        const only = question.blocks[0];
        return {
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
        };
      }
      return {
        kind: "question",
        message,
        candidates: question.blocks.map((b) => ({
          key: b.id,
          label: `Remove ${b.label}`,
          onClick: () => pickExisting(unassignCommand, { kind: "remove", assignmentId: b.id }),
        })),
      };
    }
    if (question.kind === "move_which") {
      // Only ever asked from the move path (S41-c). Unlike remove_which,
      // this is never asked for exactly one block (a move takes it without
      // asking), so there is no one-block branch here.
      const moveCommand = command as MoveCommand;
      return {
        kind: "question",
        message,
        candidates: question.blocks.map((b) => ({
          key: b.id,
          label: `Move ${b.label}`,
          onClick: () => pickExisting(moveCommand, { kind: "move", assignmentId: b.id }),
        })),
      };
    }
    if (question.kind === "no_block" || question.kind === "block_gone_remove") {
      return { kind: "question", message, candidates: [] };
    }
    return { kind: "question", message, candidates: [] };
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setText(e.target.value);
    // Brief §6: "Any edit to the input clears the held command and its
    // attach (a new sentence is a new question)." Clearing the held command
    // clears its `existing` (R-385) the same way it clears `attach`.
    heldRef.current = null;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter") {
      e.preventDefault();
      const parsed = parseCommand(text);
      if (!parsed.ok) {
        heldRef.current = null;
        setStatus(failureToStatus(parsed.failure));
        return;
      }
      runCommand(parsed.command);
      return;
    }
    if (e.key === "Escape") {
      // First Escape clears the status line; a second clears the input.
      if (status !== null) {
        setStatus(null);
      } else {
        setText("");
        heldRef.current = null;
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
      </div>
      <p className={styles.statusLine} aria-live="polite">
        {status?.message ?? ""}
      </p>
      {status?.kind === "question" && status.candidates.length > 0 && (
        <div className={styles.candidates}>
          {status.candidates.map((c) => (
            <button key={c.key} type="button" className={fieldStyles.btn} onClick={c.onClick}>
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
