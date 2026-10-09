/// <reference types="node" />
// Node types are referenced per-file rather than added to the app tsconfig, for
// the reason `scaleAudit.ts` gives: this is a browser app and only the audits
// touch the filesystem.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * DEF-0015 — A VIEWER IS OFFERED A CREATE FORM, A PERSON PICKER, SAVE AND DELETE.
 *
 * `board_window` answers `can_place: false` for a viewer, and `BoardPage.tsx`
 * reads it — for the Operators panel alone. The create pop-up and the
 * assignment pop-up open for anyone who presses Enter on a track or clicks a
 * chip, with a working picker and enabled Create / Save / Delete, and every
 * one of those writes is refused by the policies. Measured in the browser as
 * a viewer granted one cell (the defect file has the transcript).
 *
 * ⚠️ WHY THIS PIN READS THE SOURCE RATHER THAN RENDERING THE BOARD. The pop-ups
 * are opened by the interaction hook from board state, and rendering
 * `BoardPage` needs the session, the query client, the API and the drag
 * layer mocked at once; the tests beside the board render the pop-ups on
 * their own, which cannot show whether the BOARD offers them. This audit is
 * the same shape as `pickerPool.test.ts` (the developer's own source audit
 * for R-342): it reads `BoardPage.tsx` and asks whether each write-capable
 * pop-up is decided by the server's `can_place`. It accepts either fix — the
 * element inside a `canPlace` guard, or the element handed a
 * `canPlace` / `readOnly` / `canEdit` prop so it can disable its own writes.
 */

const BOARD_PAGE = path.join(process.cwd(), "src/features/board/BoardPage.tsx");
const src = readFileSync(BOARD_PAGE, "utf8");

/** Comments stripped, so a sentence about `canPlace` does not count as code. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/**
 * The JSX element `<Name ... />` (or `<Name ...>`), and the JSX expression
 * that encloses it: text from the nearest preceding `{` that opens a
 * `{cond && (` block up to the element. Both are searched for the guard.
 */
function elementAndGuard(name: string): { element: string; guard: string } | null {
  const open = code.indexOf(`<${name}`);
  if (open === -1) return null;
  const close = code.indexOf("/>", open);
  const closeAlt = code.indexOf(">", open);
  const end = close !== -1 && (closeAlt === -1 || close <= closeAlt + 1) ? close + 2 : closeAlt + 1;
  const element = code.slice(open, end);
  // Walk back to the `{` that opens the enclosing `{... && (` expression.
  const before = code.slice(0, open);
  const guardStart = before.lastIndexOf("{");
  const guard = before.slice(guardStart === -1 ? 0 : guardStart);
  return { element, guard };
}

const GATED_BY_CAN_PLACE = /\bcanPlace\b/;
const HANDED_THE_ANSWER = /\b(canPlace|readOnly|canEdit)\s*=/;

function isDecidedByTheServer(name: string): { ok: boolean; why: string } {
  const found = elementAndGuard(name);
  if (!found) return { ok: false, why: `<${name} is not rendered by BoardPage.tsx at all` };
  if (GATED_BY_CAN_PLACE.test(found.guard)) return { ok: true, why: "guarded by canPlace" };
  if (HANDED_THE_ANSWER.test(found.element))
    return { ok: true, why: "handed the answer as a prop" };
  return {
    ok: false,
    why: `<${name} is rendered under "${found.guard.trim().split("\n")[0]}" with no canPlace guard and no canPlace/readOnly/canEdit prop, so a viewer is offered its write controls (DEF-0015)`,
  };
}

describe("DEF-0015: the board offers a write-capable pop-up only where the server says the person can place people", () => {
  /**
   * ⛔ THE DEFECT, HALF ONE. The create pop-up opens for a viewer with a
   * picker and an enabled Create.
   */
  it("the create pop-up is decided by can_place", () => {
    const r = isDecidedByTheServer("CreatePopover");
    expect(r.ok, r.why).toBe(true);
  });

  /**
   * ⛔ THE DEFECT, HALF TWO. The assignment pop-up opens for a viewer with a
   * Person select, Save and Delete.
   */
  it("the assignment pop-up is decided by can_place", () => {
    const r = isDecidedByTheServer("AssignmentPopover");
    expect(r.ok, r.why).toBe(true);
  });

  /**
   * ⚠️ THE GUARD ON THE GUARD. The two cases above would go red for a broken
   * reader as readily as for the defect. The Operators panel IS gated on
   * `canPlace` since b605245; if this case is red at the same time as the
   * two above, the reader is broken and they are telling you nothing.
   */
  it("...and the reader sees the panel's existing canPlace guard", () => {
    const r = isDecidedByTheServer("OperatorPanel");
    expect(r.ok, r.why).toBe(true);
    expect(r.why).toBe("guarded by canPlace");
  });
});
