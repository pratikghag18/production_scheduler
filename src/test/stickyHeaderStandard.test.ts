/// <reference types="node" />
/**
 * THE FROZEN-HEADER STANDARD GUARDRAIL (R-372).
 *
 * The maintainer, from the running app: *"in all tabs where there could be a
 * large amount of rows like the activity, we should have the rows scrolled
 * within the window keeping the top portion frozen ... Right now, I scroll and
 * the top portion goes away and I can't see the column names at all."* And:
 * *"It should be recorded as a standard design choice just like we have for pop
 * up window."*
 *
 * A long list scrolls WITHIN a bounded region, not the page, so its column
 * header stays put. Two things make that real and this audit checks both:
 *   1. the scroll container is BOUNDED (`max-height`) and scrolls (`overflow`
 *      auto/scroll) -- an unbounded region grows to its content and the PAGE
 *      scrolls, which is exactly the bug: the sticky header leaves with it;
 *   2. the header cells are `position: sticky; top: 0` -- with a background and
 *      a z-index, but those are cosmetic and not asserted here.
 *
 * Same shape as `popoverStandard.test.ts` / `iconStandard.test.ts`: a registry
 * of the list surfaces under the standard, and a pure offence function run
 * against each surface's real CSS module. A new long-row tab is brought under
 * the standard by adding a row to `STICKY_HEADER_SURFACES`.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

/**
 * The list surfaces under the standard. `scroll` is the class on the bounded
 * scroll container; `header` is the class on the header cells inside it.
 *
 * ⚠️ THIS LIST IS THE STANDARD'S REACH. Activity is the first surface (the one
 * the maintainer reported). Operators, Products, the Matrix, Trainings and
 * Cycle times are the other long-row tabs and are queued to join it (plan
 * `next`); each joins by rendering a bounded scroll container with a sticky
 * header and adding its row here, which turns this audit on for it.
 */
export const STICKY_HEADER_SURFACES: ReadonlyArray<{
  name: string;
  cssModule: string;
  scroll: string;
  header: string;
}> = [
  {
    name: "Activity (AuditPanel)",
    cssModule: "src/features/admin/components/AuditPanel.module.css",
    scroll: "scroll",
    header: "th",
  },
  {
    // Access is an interactive editor, not a read-only table, so it satisfies
    // the SAME standard with a sticky GRID header (`.head`) rather than a
    // `<table>`'s `<th>` — the standard is the behaviour (bounded scroll +
    // frozen header), not the tag. Both its member list and its add list wear
    // `.tableScroll`, so one registration covers both.
    name: "Access (SiteAccessPanel)",
    cssModule: "src/features/admin/components/SiteAccessPanel.module.css",
    scroll: "tableScroll",
    header: "head",
  },
  // Every long-row admin tab, brought under the standard together (R-372, the
  // maintainer: it must apply to ALL current and future tabs). A grid list uses
  // a sticky `.head`/`.listHead`/`.peopleHead`; a `<table>` uses sticky `.th`.
  {
    name: "Operators (OperatorsPanel)",
    cssModule: "src/features/admin/components/OperatorsPanel.module.css",
    scroll: "tableScroll",
    header: "peopleHead",
  },
  {
    name: "Products (ProductsPanel)",
    cssModule: "src/features/admin/components/ProductsPanel.module.css",
    scroll: "tableScroll",
    header: "head",
  },
  {
    name: "Trainings (TrainingsPanel)",
    cssModule: "src/features/admin/components/TrainingsPanel.module.css",
    scroll: "tableScroll",
    header: "head",
  },
  {
    name: "Shifts (ShiftsPanel)",
    cssModule: "src/features/admin/components/ShiftsPanel.module.css",
    scroll: "tableScroll",
    header: "listHead",
  },
  {
    name: "Absences (AbsencesPanel)",
    cssModule: "src/features/admin/components/AbsencesPanel.module.css",
    scroll: "scroll",
    header: "th",
  },
  {
    // The Matrix has TWO stacked header rows (area/line bands, then training
    // names), so the whole `<thead>` is made sticky as one block rather than
    // per-cell — a single `top: 0` cannot pin the second row, whose offset
    // depends on the first row's height. The left frozen-label column composes
    // with this on its own `left: 0` axis.
    name: "Matrix (MatrixPanel)",
    cssModule: "src/features/admin/components/MatrixPanel.module.css",
    scroll: "scroll",
    header: "thead",
  },
  {
    name: "Cycle times (CycleTimesPanel)",
    cssModule: "src/features/admin/components/CycleTimesPanel.module.css",
    scroll: "scroll",
    header: "colHead",
  },
];

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * The declaration bodies of EVERY rule whose selector list names `.<cls>`,
 * joined. A class can be styled by more than one rule — a shared layout rule
 * (`.head, .row { display: grid }`) AND a dedicated one (`.head { position:
 * sticky }`) — and the standard's properties may be split across them, so the
 * check must see their union, not whichever comes first. Returns `null` only
 * when no rule names the class at all. (These modules have no `@media`/nested
 * blocks — asserted by the audit's own scope — so a flat rule split is exact.)
 */
export function ruleBody(css: string, cls: string): string | null {
  const src = stripComments(css);
  const rule = /([^{}]*)\{([^}]*)\}/g;
  const named = new RegExp("\\." + cls + "\\b");
  const bodies: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = rule.exec(src)) !== null) {
    if (named.test(m[1])) bodies.push(m[2]);
  }
  return bodies.length > 0 ? bodies.join("\n") : null;
}

/**
 * Offences for one surface. Pure: falsifiable against synthetic CSS, not only
 * the tree. Returns human-readable strings, empty when the surface conforms.
 */
export function stickyHeaderOffences(
  name: string,
  css: string,
  scrollCls: string,
  headerCls: string,
): string[] {
  const out: string[] = [];
  const scroll = ruleBody(css, scrollCls);
  const header = ruleBody(css, headerCls);

  if (scroll === null) {
    out.push(`${name}: no \`.${scrollCls}\` rule found -- the bounded scroll container is missing`);
  } else {
    if (!/max-height\s*:/.test(scroll)) {
      out.push(
        `${name}: \`.${scrollCls}\` has no max-height, so the region grows and the page scrolls`,
      );
    }
    if (!/overflow(-y)?\s*:\s*(auto|scroll)/.test(scroll)) {
      out.push(`${name}: \`.${scrollCls}\` does not scroll (overflow auto/scroll)`);
    }
  }

  if (header === null) {
    out.push(`${name}: no \`.${headerCls}\` rule found -- the header cells are missing`);
  } else {
    if (!/position\s*:\s*sticky/.test(header)) {
      out.push(`${name}: \`.${headerCls}\` is not position: sticky, so it scrolls away`);
    }
    if (!/top\s*:\s*0/.test(header)) {
      out.push(`${name}: \`.${headerCls}\` has no top: 0, so sticky has nowhere to pin`);
    }
  }
  return out;
}

const repoRoot = process.cwd();

describe("stickyHeaderStandard: every registered list surface freezes its header", () => {
  it.each(STICKY_HEADER_SURFACES)("$name scrolls its body under a frozen header", (s) => {
    const css = fs.readFileSync(`${repoRoot}/${s.cssModule}`, "utf8");
    expect(stickyHeaderOffences(s.name, css, s.scroll, s.header)).toEqual([]);
  });

  // ⚠️ NOT VACUOUS: the offence function must actually catch the two failures.
  it("flags an unbounded container and a non-sticky header", () => {
    const bad = ".scroll { overflow-x: auto; } .th { top: 0; font-weight: 600; }";
    const offences = stickyHeaderOffences("synthetic", bad, "scroll", "th");
    expect(offences.length).toBe(3); // no max-height, no overflow auto/scroll, not sticky
    const good = ".scroll { overflow: auto; max-height: 60vh; } .th { position: sticky; top: 0; }";
    expect(stickyHeaderOffences("synthetic", good, "scroll", "th")).toEqual([]);
  });
});
