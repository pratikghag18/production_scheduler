import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * DEF-0034 — CONTRACT CHANGED 21 SEPT, AND THIS PIN WAS REWRITTEN FOR IT, NOT PATCHED.
 *
 * The original shape: R-423 kept the rename of Plant A's six demo operators (EMP-1001..EMP-1006,
 * to Sam Patel, Maria Lopez, John Kim, Priya Shah, Tom Baker, Lena Novak) in a standalone script,
 * `scripts/demo/rename-plant-a-operators.sql`, applied by hand against one machine's database. No
 * automated reset or e2e path ran it, so every fresh stack kept "Operator A1".."Operator A6" and
 * e2e/linePeople.spec.ts and e2e/viewerBoard.spec.ts failed on every automated run. That pin asserted
 * the script existed and named the six, and failed until some automated entry point referenced it.
 *
 * The maintainer, 21 Sept: "put the real names in the seed." So `supabase/dev_demo.sql` now names
 * the six itself (a new section after the week of schedule and before the dev credentials), the
 * script is deleted, and "wire an automated path to the script" is no longer the fix to reach for —
 * there is no script left to wire in. This pin now asserts the NEW contract statically: the seed
 * names the six, the SQL suite's demo case names the six, and the deleted script is well and truly
 * gone — no remaining file under scripts/, e2e/, supabase/, playwright.config.ts or package.json
 * still depends on it.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DELETED_SCRIPT_PATH = "scripts/demo/rename-plant-a-operators.sql";
const DELETED_SCRIPT_NAME = "rename-plant-a-operators";
const SEED = "supabase/dev_demo.sql";
const SQL_CASE = "supabase/tests/dev_demo_test.sql";

const REAL_NAMES = [
  "Sam Patel",
  "Maria Lopez",
  "John Kim",
  "Priya Shah",
  "Tom Baker",
  "Lena Novak",
];

const EMP_REFS = ["EMP-1001", "EMP-1002", "EMP-1003", "EMP-1004", "EMP-1005", "EMP-1006"];

// Every file that could still reference the deleted script's path. A hit here means some path in
// the automated harness still depends on a file that no longer exists.
const SURFACES_THAT_MUST_NOT_MENTION_THE_DELETED_SCRIPT = [
  "scripts/ci-e2e.sh",
  "scripts/tester-run.mjs",
  "scripts/run-sql-test.sh",
  "scripts/verify-db.sh",
  "playwright.config.ts",
  "package.json",
  "e2e/env.ts",
  "e2e/linePeople.spec.ts",
  "e2e/viewerBoard.spec.ts",
  "supabase/dev_demo.sql",
  "supabase/tests/dev_demo_test.sql",
  "supabase/config.toml",
];

function read(rel: string): string {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

describe("DEF-0034: Plant A's real names live in the seed, not a wired-in script", () => {
  it("supabase/dev_demo.sql names all six real people on their EMP refs", () => {
    const body = read(SEED);
    expect(body, `${SEED} must exist`).not.toBe("");
    for (const name of REAL_NAMES) {
      expect(body, `${SEED} should name ${name}`).toContain(name);
    }
    for (const ref of EMP_REFS) {
      expect(body, `${SEED} should key the rename on ${ref}`).toContain(ref);
    }
    // Pairwise, not two loops (the reviewer, 21 Sept): six names and six refs
    // each present would also pass with two people swapped. The seed writes
    // each rename as `SET display_name = '<name>' ... employee_ref = '<ref>'`,
    // so assert that shape for every pair.
    REAL_NAMES.forEach((name, i) => {
      const pair = new RegExp(
        `display_name = '${name}'\\s*WHERE org_id = v_org AND employee_ref = '${EMP_REFS[i]}'`,
      );
      expect(body, `${SEED} should rename ${EMP_REFS[i]} to ${name}, in that pairing`).toMatch(
        pair,
      );
    });
  });

  it("supabase/tests/dev_demo_test.sql has a case naming all six real people", () => {
    const body = read(SQL_CASE);
    expect(body, `${SQL_CASE} must exist`).not.toBe("");
    for (const name of REAL_NAMES) {
      expect(body, `${SQL_CASE} should name ${name}`).toContain(name);
    }
  });

  it("the deleted rename script does not exist on disk", () => {
    expect(
      existsSync(join(ROOT, DELETED_SCRIPT_PATH)),
      `${DELETED_SCRIPT_PATH} was deleted 21 Sept when the rename moved into the seed; it should ` +
        "not have come back",
    ).toBe(false);
  });

  it("no automated surface still depends on the deleted rename script (no dangling path)", () => {
    const referrers = SURFACES_THAT_MUST_NOT_MENTION_THE_DELETED_SCRIPT.filter((f) =>
      read(f).includes(DELETED_SCRIPT_NAME),
    );
    expect(
      referrers,
      `these files still mention ${DELETED_SCRIPT_NAME}, which no longer exists: ${referrers.join(", ")}`,
    ).toHaveLength(0);
  });
});
