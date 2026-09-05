/// <reference types="node" />
// Node types are referenced per-file rather than added to the app tsconfig, for
// the reason `scaleAudit.ts` gives: this is a browser app and only the audits
// touch the filesystem.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * ⚠️ `js-yaml` ships no type declarations and this repo has no `@types/js-yaml`.
 * Adding one for a pin would be a dependency change the tester does not get to
 * make, so `createRequire` reaches the same module the plan scripts already use
 * and the shape this file needs is written down here.
 */
const yaml = createRequire(import.meta.url)("js-yaml") as {
  load: (source: string) => unknown;
};

/**
 * DEF-0009 — POINTERS IN `docs/plan.yaml` THAT DO NOT RESOLVE AT THE OTHER END.
 *
 * Two kinds, one rule. A stage's `refs` and a session's `shipped` are the same
 * link read from two ends, and seven of them do not meet. A requirement's
 * `verified_by.file` names a file, and one of them names a file that was
 * deleted.
 *
 * `6086c23` added eight stage cards, S26-S33, for thirty requirements that had
 * belonged to no stage. Its own finding, F-093, says why the link matters:
 *
 *   "`shipped` on a session is not decoration, it is the only link between a
 *    day's work and the shape it belongs to."
 *
 * A stage's `refs` says WHICH SESSIONS SHIPPED IT. A session's `shipped` says
 * WHICH STAGES IT SHIPPED. They are one fact written twice, so they can be held
 * against each other — CLAUDE.md section 4's line about a list that appears
 * twice, applied to the record rather than to a column list.
 *
 * ⛔ THIS IS NOT A STYLE CHECK. Every broken link below is a stage card naming
 * a session that did the work of a DIFFERENT stage, or no work at all:
 *
 *   S27 "Standard cycle times"        refs session 51 -> "Tester run"
 *                                     refs session 52 -> the status picker (S26)
 *   S28 "One shell, one field..."     refs session 50 -> "The gate that was
 *                                                        actually stopping CI"
 *   S29 "Edit is one door"            refs session 49 -> the board's parts list
 *   S30 "The plant you chose..."      refs session 50 -> the CI gate again
 *
 * Measured from git rather than from the prose: `11e6fc1` added the cycle-times
 * grid and the plan names it in session 37; `159e094` added `Popover.tsx` and
 * the plan names it in session 35; `e6e0b7b` added the one chevron, session 31.
 * None of those sessions is named by the card that claims their work.
 *
 * ⚠️ THE ASSERTION IS DELIBERATELY THE WEAK DIRECTION. It does not demand that
 * every session shipping a stage names it — a session may touch a stage without
 * completing it, and the developer's judgement about that is not the tester's
 * to pin. It demands only that a session a stage NAMES AS ITS OWN agrees that
 * it shipped it. A card that points at a session which points back at nothing
 * is a claim with no other end.
 *
 * Green when the eight cards name the sessions that did the work (or when the
 * nine sessions that name a stage are joined by the ones that shipped S27-S30).
 * Either repair closes it; which one is the developer's call.
 */

interface Stage {
  id: string;
  title?: string;
  refs?: unknown[];
}
interface Session {
  id: unknown;
  title?: string;
  shipped?: unknown[];
}
interface Plan {
  stages: Stage[];
  sessions: Session[];
}

const PLAN = path.join(process.cwd(), "docs/plan.yaml");

function loadPlan(): Plan {
  return yaml.load(readFileSync(PLAN, "utf8")) as Plan;
}

/** Every `refs` entry of the form `session <n>`, paired with its stage. */
function sessionRefs(plan: Plan): Array<{ stage: string; session: string }> {
  const out: Array<{ stage: string; session: string }> = [];
  for (const stage of plan.stages) {
    for (const ref of stage.refs ?? []) {
      const match = /^session (\d+)$/.exec(String(ref).trim());
      if (match !== null) out.push({ stage: stage.id, session: match[1] });
    }
  }
  return out;
}

describe("DEF-0009: a stage's refs and a session's shipped are one link, read from two ends", () => {
  it("every session a stage names as its own agrees that it shipped that stage", () => {
    const plan = loadPlan();
    const byId = new Map(plan.sessions.map((s) => [String(s.id), s]));

    const broken = sessionRefs(plan)
      .filter(({ stage, session }) => {
        const entry = byId.get(session);
        if (entry === undefined) return true;
        return !(entry.shipped ?? []).map(String).includes(stage);
      })
      .map(({ stage, session }) => {
        const entry = byId.get(session);
        const shipped = JSON.stringify((entry?.shipped ?? []).map(String));
        return `${stage} refs session ${session} (${entry?.title ?? "NO SUCH SESSION"}) whose shipped is ${shipped}`;
      });

    expect(broken).toEqual([]);
  });

  /**
   * ⚠️ THE GUARD ON THE GUARD. The case above passes trivially if no stage
   * names a session at all — a file that had lost every `refs` entry would look
   * perfect. This one says the link exists to be checked.
   */
  it("there are session refs to check in the first place", () => {
    expect(sessionRefs(loadPlan()).length).toBeGreaterThan(10);
  });

  /**
   * ⛔ THE SECOND KIND, AND IT IS THE SAME COMMIT'S DOING ONE FILE OVER.
   * `cab45d9` promoted DEF-0007's pin and deleted the copy under
   * `src/test/defects/`. `c24bc69` repointed the DEFECT's `pin` field at the new
   * home — and R-239's `verified_by` still names the deleted file, so the
   * requirement that DEF-0007 and DEF-0010 both hang off cites evidence that is
   * not there.
   *
   * ⚠️ SEVEN ENTRIES ARE DELIBERATE PLACEHOLDERS and are excluded by shape, not
   * by name: `supabase/tests/56_ (full name not given in §19.74)` and its four
   * relatives say in the value itself that the file name was never recorded.
   * Anything without a space or a bracket is claiming to be a real path.
   */
  it("every verified_by entry that names a real path names a file that exists", () => {
    const plan = yaml.load(readFileSync(PLAN, "utf8")) as {
      requirements: Array<{ id: string; verified_by?: Array<{ file?: unknown }> }>;
    };

    const missing: string[] = [];
    let checked = 0;
    for (const req of plan.requirements) {
      for (const entry of req.verified_by ?? []) {
        const file = entry.file;
        if (typeof file !== "string") continue;
        if (/[ ()]/.test(file)) continue; // a placeholder, not a path
        checked++;
        if (!existsSync(path.join(process.cwd(), file))) missing.push(`${req.id} -> ${file}`);
      }
    }

    expect(checked).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });
});
