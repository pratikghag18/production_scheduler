import { useRef, useState } from "react";
import type { DateFormat } from "@/lib/format/dates";
import { formatDayLabel } from "../lib/time";
import fieldStyles from "@/components/Field.module.css";
import styles from "./CommandBar.module.css";
import { parseCommand, formatCommand, expectedShape } from "@/lib/command/parse";
import type { AssignCommand, Attach, Existing, ParseFailure } from "@/lib/command/parse";
import { resolveCommand, describeQuestion } from "@/lib/command/resolve";
import type { ResolveContext, ResolvedCommand, Question, Candidate } from "@/lib/command/resolve";

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
}

const PLACEHOLDER = "Assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2";

/** The readout's day is an ISO token (`resolve.ts` cannot import the date
 *  seam); this is the one place it is rendered through it (brief §3). */
const ISO_DAY = /\d{4}-\d{2}-\d{2}/;

/** The one sentence shown when the bar cannot read the line (brief §6);
 *  `bad_time`/`bad_day` get the offending text named first. */
function failureToStatus(failure: ParseFailure): Status {
  const shape = expectedShape();
  if (failure.kind === "bad_time" || failure.kind === "bad_day") {
    return { kind: "shape", message: `I could not read "${failure.text}". ${shape}` };
  }
  return { kind: "shape", message: shape };
}

export function CommandBar({ ctx, dateFormat, zone, onOpen, onRetime }: CommandBarProps) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The last parsed command, kept so a candidate button can substitute one
  // field and so a run-question button can set `attach` without retyping the
  // sentence (brief §6). Any edit to the input invalidates it.
  const heldRef = useRef<AssignCommand | null>(null);

  function renderReadout(readout: string): string {
    return readout.replace(ISO_DAY, (iso) =>
      formatDayLabel(new Date(`${iso}T00:00:00Z`), dateFormat, zone),
    );
  }

  function anchorOfInput(): { x: number; y: number } {
    const rect = inputRef.current?.getBoundingClientRect();
    return { x: rect?.left ?? 0, y: rect?.bottom ?? 0 };
  }

  function runCommand(command: AssignCommand): void {
    heldRef.current = command;
    const resolution = resolveCommand(command, ctx);
    if (resolution.ok) {
      if (resolution.resolved.target.kind === "retime") {
        onRetime(resolution.resolved, anchorOfInput());
      } else {
        onOpen(resolution.resolved, anchorOfInput());
      }
      setStatus({ kind: "readout", message: renderReadout(resolution.resolved.readout) });
      return;
    }
    setStatus(questionToStatus(resolution.question, command));
  }

  function pickCandidate(
    command: AssignCommand,
    field: "operator" | "product" | "place",
    candidate: Candidate,
  ): void {
    const next: AssignCommand =
      field === "operator"
        ? { ...command, operator: candidate.word }
        : field === "product"
          ? { ...command, product: candidate.word }
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

  function pickExisting(command: AssignCommand, existing: Existing): void {
    // R-385: the twin of `pickAttach` -- the sentence stays as it is, only
    // the held command's `existing` changes, re-resolved directly rather
    // than through `parseCommand` (which always returns `existing: null`).
    runCommand({ ...command, existing });
  }

  function questionToStatus(question: Question, command: AssignCommand): Status {
    const message = describeQuestion(question);
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
      return {
        kind: "question",
        message,
        candidates: [
          ...question.runs.map((r) => ({
            key: r.id,
            label: r.label,
            onClick: () => pickAttach(command, { kind: "run", runId: r.id }),
          })),
          {
            key: "__separate_block__",
            label: "Separate block",
            onClick: () => pickAttach(command, { kind: "direct" }),
          },
        ],
      };
    }
    if (question.kind === "block_exists") {
      const separate = {
        key: "__separate_block__",
        label: "Separate block",
        onClick: () => pickExisting(command, { kind: "separate" }),
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
            onClick: () => pickExisting(command, { kind: "retime", assignmentId: b.id }),
          })),
          separate,
        ],
      };
    }
    if (question.kind === "block_gone") {
      return {
        kind: "question",
        message,
        candidates: [
          {
            key: "__new_block__",
            label: "New block",
            onClick: () => pickExisting(command, { kind: "separate" }),
          },
        ],
      };
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
