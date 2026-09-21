import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * DEF-0034: R-423 says Plant A's six demo operators (EMP-1001..EMP-1006) carry the real names
 * Sam Patel, Maria Lopez, John Kim, Priya Shah, Tom Baker and Lena Novak, applied by
 * scripts/demo/rename-plant-a-operators.sql — and that the two e2e specs naming them pass. But no
 * automated reset or e2e path applies that script: `supabase db reset` (ci-e2e.sh, tester-run
 * --e2e) loads only seed.sql + dev_demo.sql, and dev_demo.sql seeds "Operator A1".."Operator A6".
 * So on every fresh stack the six real names do not exist and e2e/linePeople.spec.ts and
 * e2e/viewerBoard.spec.ts fail.
 *
 * This pin reproduces the gap statically (no live DB): the rename script exists and names the six,
 * but nothing in the automated harness references it. It goes green when the developer wires the
 * rename into one automated entry point (ci-e2e.sh, the tester-run --e2e stack build, or a
 * playwright globalSetup).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RENAME = "scripts/demo/rename-plant-a-operators.sql";
const REAL_NAMES = [
  "Sam Patel",
  "Maria Lopez",
  "John Kim",
  "Priya Shah",
  "Tom Baker",
  "Lena Novak",
];

// The files that establish the world an e2e run drives. If the rename is applied at all
// automatically, one of these must name the script.
const AUTOMATED_ENTRY_POINTS = [
  "scripts/ci-e2e.sh",
  "scripts/tester-run.mjs",
  "playwright.config.ts",
  "supabase/config.toml",
  "package.json",
];

function read(rel: string): string {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

describe("DEF-0034: the Plant A rename script is applied by an automated path", () => {
  it("the rename script exists and names all six real operators (R-423 premise)", () => {
    const body = read(RENAME);
    expect(body, `${RENAME} must exist`).not.toBe("");
    for (const name of REAL_NAMES) {
      expect(body, `${RENAME} should name ${name}`).toContain(name);
    }
  });

  it("some automated reset/e2e entry point applies the rename (fails until it is wired in)", () => {
    const referrers = AUTOMATED_ENTRY_POINTS.filter((f) =>
      read(f).includes("rename-plant-a-operators"),
    );
    // Currently EMPTY — no automated path runs the rename, so a fresh stack keeps Operator A1..A6
    // and the R-423 e2e specs fail. This is the reproduction. When the rename is applied after
    // `supabase db reset` in one of these files, referrers becomes non-empty and this goes green.
    expect(
      referrers,
      "no automated entry point applies scripts/demo/rename-plant-a-operators.sql, so R-423's " +
        "real names are absent on every fresh stack and e2e/linePeople + e2e/viewerBoard fail",
    ).not.toHaveLength(0);
  });
});
