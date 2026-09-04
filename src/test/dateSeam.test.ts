/// <reference types="node" />
/**
 * THE DATE-SEAM GUARDRAIL.
 *
 * The maintainer, Sep 3: *"can we make sure we add something so any new date
 * displayed on the app in future automatically adopts this?"*
 *
 * A single display seam (`src/lib/format/dates.ts`) is only kept single if new
 * code is FORCED through it — this app had already grown two independent date
 * formatters and one of them was about to become a third. So this is a
 * file-content audit, the same shape as `scaleAudit`'s REM_SURFACES guard: it
 * fails the build when a calendar date is formatted anywhere it should not be.
 *
 * Two anti-patterns, each with its own allowlist:
 *
 *  - `Intl.DateTimeFormat` / `.toLocaleDateString` / `.toLocaleTimeString` —
 *    what a developer reaches for to render a date. Allowed ONLY in the two
 *    seams: `dates.ts` (calendar dates, this feature) and `board/lib/time.ts`
 *    (the board's instants, `BOARD_ZONE` / R-D88). Everything else must call
 *    `formatCalendarDay` and take its token from `useDateFormat`.
 *
 *  - a MONTH-NAME ARRAY literal (`"Jan","Feb",…`) — the hand-rolled formatter
 *    this app actually shipped. Allowed ONLY in `dates.ts` (the seam) and
 *    `operators.ts` (the dependency-free logic layer, which cannot import the
 *    seam under strip-types and so keeps the DEFAULT rendering for the reason
 *    strings it builds — `dateFormat.test.ts` pins the two defaults equal).
 *
 * ⚠️ `toLocaleString` (no Date/Time suffix) is NOT a needle, on purpose: it is
 * the number-formatting call too, and banning it would flag a legitimate future
 * `n.toLocaleString()`. The date-specific spellings are unambiguous.
 *
 * ⚠️ COMMENTS ARE STRIPPED BEFORE MATCHING — this file and `time.ts` both name
 * `Intl.DateTimeFormat` in prose, and a matcher that reads comments flags the
 * documentation. That mistake has been made repeatedly on this project
 * (`scaleAudit.ts` records three times). STRING LITERALS are kept, because the
 * month array lives in strings.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

/** Date-render calls allowed only in the two seams. */
export const INTL_NEEDLES: readonly string[] = [
  "Intl.DateTimeFormat",
  ".toLocaleDateString",
  ".toLocaleTimeString",
];

export const INTL_ALLOWLIST: readonly string[] = [
  "src/lib/format/dates.ts",
  "src/features/board/lib/time.ts",
];

export const MONTH_ALLOWLIST: readonly string[] = [
  "src/lib/format/dates.ts",
  "src/features/admin/lib/operators.ts",
];

/** Strip block and line comments; keep string literals. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** A month-name array literal — `"Jan","Feb"` or `"January","February"`,
 *  in that order, tolerant of whitespace. The signature of a hand-rolled date
 *  formatter. */
function hasMonthArray(src: string): boolean {
  return (
    /"Jan"\s*,\s*"Feb"/.test(src) ||
    /"January"\s*,\s*"February"/.test(src) ||
    /'Jan'\s*,\s*'Feb'/.test(src) ||
    /'January'\s*,\s*'February'/.test(src)
  );
}

/**
 * The offences in one file, given its repo-relative path (which decides the
 * allowlist). Pure — takes the source, so it is falsifiable against synthetic
 * input as well as the tree (rule 3).
 */
export function dateSeamOffences(relPath: string, source: string): string[] {
  const src = stripComments(source);
  const norm = relPath.replace(/\\/g, "/");
  const out: string[] = [];
  if (!INTL_ALLOWLIST.includes(norm)) {
    for (const needle of INTL_NEEDLES) {
      if (src.includes(needle))
        out.push(`${norm}: ${needle} — format dates through formatCalendarDay`);
    }
  }
  if (!MONTH_ALLOWLIST.includes(norm) && hasMonthArray(src)) {
    out.push(`${norm}: a month-name array — format dates through formatCalendarDay`);
  }
  return out;
}

/** Walk `src/`, skipping test files, declarations and the seam audit itself. */
function walkSources(root: string): string[] {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(`${base}/${rel}`, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
      } else if (
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".test.tsx") &&
        !entry.name.endsWith(".d.ts")
      ) {
        out.push(child);
      }
    }
  };
  walk("src");
  return out;
}

export function auditDateSeam(root: string): string[] {
  const out: string[] = [];
  for (const rel of walkSources(root)) {
    out.push(...dateSeamOffences(rel, fs.readFileSync(`${root}/${rel}`, "utf8")));
  }
  return out;
}

describe("the date-seam guardrail catches a bypass (synthetic — rule 3)", () => {
  const stray = "src/features/admin/components/Somewhere.tsx";

  it("flags Intl.DateTimeFormat outside the seams", () => {
    expect(dateSeamOffences(stray, `new Intl.DateTimeFormat("en-US").format(d)`)).toHaveLength(1);
  });

  it("flags toLocaleDateString / toLocaleTimeString outside the seams", () => {
    expect(dateSeamOffences(stray, `d.toLocaleDateString()`)).toHaveLength(1);
    expect(dateSeamOffences(stray, `d.toLocaleTimeString()`)).toHaveLength(1);
  });

  it("flags a hand-rolled month array outside the seams", () => {
    expect(
      dateSeamOffences(stray, `const M = ["Jan","Feb","Mar","Apr","May","Jun"];`),
    ).toHaveLength(1);
  });

  it("does NOT read the needle out of a comment", () => {
    expect(dateSeamOffences(stray, `// we deliberately avoid Intl.DateTimeFormat here`)).toEqual(
      [],
    );
  });

  it("allows the two seams their tools", () => {
    expect(
      dateSeamOffences("src/features/board/lib/time.ts", `new Intl.DateTimeFormat("en-US")`),
    ).toEqual([]);
    expect(dateSeamOffences("src/lib/format/dates.ts", `const M = ["Jan","Feb"];`)).toEqual([]);
    expect(
      dateSeamOffences("src/features/admin/lib/operators.ts", `const M = ["Jan","Feb"];`),
    ).toEqual([]);
  });

  it("passes a clean file", () => {
    expect(dateSeamOffences(stray, `formatCalendarDay(day, fmt)`)).toEqual([]);
  });
});

describe("the real source tree goes through the seam", () => {
  it("has no date formatted outside dates.ts / time.ts / operators.ts", () => {
    const offences = auditDateSeam(process.cwd());
    expect(offences).toEqual([]);
  });
});
