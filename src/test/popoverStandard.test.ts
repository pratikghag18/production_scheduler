/// <reference types="node" />
/**
 * THE POP-UP STANDARD GUARDRAIL.
 *
 * The maintainer, repeatedly: pop-ups keep drifting ("this unit thing happened
 * again... I asked you to create a standard for pop ups"). The cause was three
 * separate floating-panel implementations — the board's `BoardPopover`, a
 * line-for-line clone `AdminPopover`, and a hand-rolled `RecordPopover` that
 * quietly lacked a focus trap and Escape. They were consolidated into ONE shell,
 * `src/components/Popover.tsx`. This audit stops a fourth from appearing: it
 * fails the build if any component renders a floating dialog OUTSIDE that module.
 *
 * The signal is `role="dialog"`. Every real dialog in the app is the shared
 * `Popover` (it sets `role="dialog"` once); a composer uses `<Popover>` /
 * `<BoardPopover>` / `<AdminPopover>` and never writes the role itself. So a
 * `role="dialog"` anywhere but the shared module is, by construction, someone
 * hand-rolling a pop-up — exactly what must not happen again. (A hand-rolled
 * scrim without the role is caught by the same net in practice, because such a
 * panel needs the role to be a real dialog; `DeleteDialog` uses `role="group"`,
 * an inline panel, and is intentionally not a dialog.)
 *
 * Same shape as `iconStandard.test.ts` / `dateSeam.test.ts`. ⚠️ COMMENTS ARE
 * STRIPPED FIRST — this file and `Popover.tsx` name `role="dialog"` in prose, and
 * a matcher that read comments would flag the documentation.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

/** The one module allowed to render a dialog; everyone else composes it. */
export const POPOVER_ALLOWLIST: readonly string[] = ["src/components/Popover.tsx"];

const NEEDLES: readonly string[] = ['role="dialog"', "role='dialog'"];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Offences in one file, given its repo-relative path. Pure — falsifiable
 *  against synthetic input as well as the tree. */
export function popoverOffences(relPath: string, source: string): string[] {
  const norm = relPath.replace(/\\/g, "/");
  if (POPOVER_ALLOWLIST.includes(norm)) return [];
  const src = stripComments(source);
  return NEEDLES.filter((n) => src.includes(n)).map(
    () => `${norm}: role="dialog" — render pop-ups through <Popover> (@/components/Popover)`,
  );
}

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

export function auditPopoverStandard(root: string): string[] {
  const out: string[] = [];
  for (const rel of walkSources(root)) {
    out.push(...popoverOffences(rel, fs.readFileSync(`${root}/${rel}`, "utf8")));
  }
  return out;
}

describe("the pop-up guardrail catches a hand-rolled dialog (synthetic — rule 3)", () => {
  const stray = "src/features/board/components/Somewhere.tsx";

  it("flags a role=dialog outside the shared module", () => {
    expect(popoverOffences(stray, `<div role="dialog" style={{top}}>...</div>`)).toHaveLength(1);
    expect(popoverOffences(stray, `<div role='dialog'>...</div>`)).toHaveLength(1);
  });

  it("does NOT flag a component that composes <Popover>", () => {
    expect(
      popoverOffences(stray, `<Popover anchor={a} onClose={c} title="x">...</Popover>`),
    ).toEqual([]);
  });

  it("does NOT read the role out of a comment", () => {
    expect(popoverOffences(stray, `// we used to render role="dialog" by hand here`)).toEqual([]);
  });

  it("allows the shared Popover module its own role", () => {
    expect(popoverOffences("src/components/Popover.tsx", `<div role="dialog">...</div>`)).toEqual(
      [],
    );
  });
});

describe("the real source tree renders every pop-up through the shared Popover", () => {
  it("has no role=dialog outside src/components/Popover.tsx", () => {
    expect(auditPopoverStandard(process.cwd())).toEqual([]);
  });
});
