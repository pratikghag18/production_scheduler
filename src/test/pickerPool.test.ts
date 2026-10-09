/// <reference types="node" />
/**
 * THE PICKER-POOL GUARDRAIL.
 *
 * The maintainer, 6 Sept: *"Operators from other plants should not be shown in
 * the list, period, it is the same as the operators shown on the left panel."*
 *
 * The second half of that sentence is the requirement, and it is a SAMENESS
 * requirement rather than a filtering one. The left panel already shows the
 * plant's own people (`operatorPool` in `BoardPage`, `ownedInScope` over the
 * board's scoped nodes). What went wrong was not that the pickers filtered
 * badly -- it is that they were handed a DIFFERENT list, `boardQuery.data
 * .operators`, which `board_window` deliberately returns unfiltered so that a
 * cross-plant assignment can still be DRAWN (S18). One list on the left, a
 * wider one in the pop-up, and nothing on screen said so.
 *
 * ⭐⭐ WHY AN AUDIT AND NOT A CODE REVIEW. Both props are `BoardOperator[]`.
 * Handing one the panel's list and the other the raw payload type-checks, mounts
 * and renders; the only symptom is a name in a dropdown that should not be
 * there, on somebody else's plant, found by a person who tried to schedule them.
 * `tsc` cannot see the difference between two variables of the same type, and
 * a rendering test would have to know which plant it was pretending to be. What
 * CAN be checked, cheaply and forever, is that every person picker on the board
 * is handed THE SAME VARIABLE -- because then they cannot drift, whatever that
 * variable comes to mean later.
 *
 * ⚠️ THE LIST OF PICKERS IS NAMED HERE ON PURPOSE, unlike `plantFilterStandard`'s
 * directory walk. A board component is not identifiable by its filename the way
 * `*Panel.tsx` is, and most of them take no operators at all. Adding a name here
 * is the deliberate edit that says "this is a place a person is chosen".
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = process.cwd();

const BOARD_PAGE = "src/features/board/BoardPage.tsx";

/** The one variable every person picker on the board must be handed. */
export const POOL = "operatorPool";

/**
 * Every element on the board that offers a PERSON to choose, and what each is
 * for. The left panel is in the list rather than assumed: it is the thing the
 * maintainer named as the standard, so if it ever stops reading the pool the
 * standard has moved and this file should say so.
 */
export const PERSON_PICKERS: ReadonlyMap<string, string> = new Map<string, string>([
  ["OperatorPanel", "The left rail -- the list the maintainer named as the standard."],
  ["CreatePopover", "The create pop-up: the direct-assignment tab's Operator select."],
  [
    "AssignmentPopover",
    "The assignment pop-up's person control (R-343, changing who is on an assignment in place).",
  ],
]);

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

/**
 * Comments out first. `BoardPage`'s header discusses `operatorPool` at length,
 * and a JSX block that has been commented out is not a wiring.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * The JSX element `<Name ... />` or `<Name ...>`, as written -- attributes only,
 * up to the first `>` that closes the opening tag.
 *
 * A prop whose value is a JSX expression containing `>` (a comparison, an arrow
 * function) truncates this -- and two of the three elements carry one today,
 * `defaultTargetFor={(...) => ...}`, so the tag is read only up to that prop.
 * The audit passes because `operators={operatorPool}` is listed before it;
 * moving `operators` after an arrow prop would turn this red with a message
 * saying the prop is missing when it is not. It can only ever false-FAIL:
 * `operatorsPropOf` below looks for a bare identifier, so a truncation shows
 * up as a missing prop -- loudly -- never as a false pass.
 */
export function openingTag(src: string, name: string): string | null {
  const m = new RegExp(`<${name}\\b[^>]*`).exec(stripComments(src));
  return m === null ? null : m[0];
}

/**
 * What `operators={...}` is given, when it is given a bare identifier.
 *
 * `operators={operatorPool}` -> `"operatorPool"`.
 * `operators={boardQuery.data?.operators ?? []}` -> `null` -- an expression is
 * not the shared variable, and calling it one is the whole defect.
 */
export function operatorsPropOf(tag: string): string | null {
  const m = /\boperators=\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(tag);
  return m === null ? null : m[1];
}

describe("the matcher can tell a shared pool from a fresh expression", () => {
  it("reads a bare identifier", () => {
    expect(operatorsPropOf(`<CreatePopover operators={operatorPool} nodeId={id}`)).toBe(
      "operatorPool",
    );
  });

  it("⭐ refuses the expression the defect was written as", () => {
    expect(operatorsPropOf(`<CreatePopover operators={boardQuery.data?.operators ?? []}`)).toBe(
      null,
    );
  });

  it("⚠️ is not fooled by a mention inside a comment", () => {
    const excuse = `
      {/* CreatePopover once took operators={operatorPool} here */}
      <CreatePopover nodeId={id} />`;
    // The tag runs to the first `>`, so the self-closing slash is part of it —
    // harmless, since `operatorsPropOf` reads a named prop and not a position.
    expect(openingTag(excuse, "CreatePopover")).toBe("<CreatePopover nodeId={id} /");
    expect(operatorsPropOf(openingTag(excuse, "CreatePopover") ?? "")).toBe(null);
  });

  it("does not confuse one element for another whose name merely starts the same", () => {
    // ⚠️ THIS IS WHAT THE `\b` BUYS, and it was measured rather than assumed:
    // there is no word boundary between the `r` of `CreatePopover` and the `L`
    // of `Legacy`, so the pattern skips the decoy entirely and lands on the
    // real element. Written the other way round — a bare prefix match — the
    // audit would read the first element it saw and pass on a stale wiring.
    const src = `<CreatePopoverLegacy operators={oldList} />\n<CreatePopover operators={pool} />`;
    expect(operatorsPropOf(openingTag(src, "CreatePopover") ?? "")).toBe("pool");
  });
});

/**
 * P1-7a: the typed command bar is a person picker too -- it resolves an
 * operator name to a record the same way the popover does, and would drift
 * from the panel/pop-up's own list exactly as easily as a fourth JSX prop
 * would. It is not a JSX prop, though: `BoardPage` builds `commandCtx` in a
 * plain object literal (`useMemo`) and hands the whole context to
 * `<CommandBar ctx={commandCtx} .../>`, so there is no `operators={...}` tag
 * attribute to read here -- the source-text check has to look for
 * `operators: operatorPool` inside the `commandCtx` builder instead of
 * `operators={...}` on an opening tag. Same idea as `operatorsPropOf`
 * (a bare-identifier match, never an expression), a different shape of source.
 */
const COMMAND_CTX_SPAN = /\bconst\s+commandCtx\s*=\s*useMemo[\s\S]*?\n {2}\}, \[/;

/** What `commandCtx`'s own `operators:` field is given, read the same way
 *  `operatorsPropOf` reads a JSX prop -- a bare identifier only. */
export function commandCtxOperatorsOf(src: string): string | null {
  const clean = stripComments(src);
  const span = COMMAND_CTX_SPAN.exec(clean);
  if (span === null) return null;
  const m = /\boperators:\s*([A-Za-z_$][\w$]*)\s*,/.exec(span[0]);
  return m === null ? null : m[1];
}

describe("R-342: every person picker on the board is handed the same list", () => {
  const src = read(BOARD_PAGE);

  it("the page still defines the pool the left panel is built from", () => {
    expect(new RegExp(`\\bconst\\s+${POOL}\\s*=`).test(stripComments(src))).toBe(true);
  });

  it(`<CommandBar>'s ctx.operators is ${POOL} -- the typed bar must resolve names against the same list the panel and the pop-up show, or a person could match the bar and not exist to place (R-342)`, () => {
    const given = commandCtxOperatorsOf(src);
    expect(
      given,
      `commandCtx.operators must be the shared ${POOL}. It is currently ` +
        `${given === null ? "an expression, or no `operators:` field at all" : `\`${given}\``}.`,
    ).toBe(POOL);
  });

  for (const [name, why] of PERSON_PICKERS) {
    it(`<${name}> is handed ${POOL} -- ${why}`, () => {
      const tag = openingTag(src, name);
      expect(tag, `${BOARD_PAGE} renders no <${name}> at all`).not.toBe(null);
      const given = operatorsPropOf(tag ?? "");
      expect(
        given,
        `<${name}> must be handed the shared ${POOL}, the same list the left panel shows ` +
          `(R-342). It is currently given ${given === null ? "an expression, or no `operators` prop at all" : `\`${given}\``}.`,
      ).toBe(POOL);
    });
  }
});
