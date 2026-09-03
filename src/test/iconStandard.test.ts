/// <reference types="node" />
/**
 * THE ICON STANDARD GUARDRAIL.
 *
 * The maintainer, 3 Sept: the collapse chevron looked different on the board and
 * the admin pages. The cause was four surfaces each drawing their own raw glyph —
 * `«`/`»` for the panel toggles, `▸`/`▾` for the tree carets, `◀`/`▶` for the
 * day-nav — and a raw glyph renders in whatever font, weight and size the
 * surrounding text happens to use. `src/components/icons.tsx` now owns ONE
 * chevron; this audit fails the build if a chevron/nav glyph is drawn anywhere
 * else, so the four cannot drift apart again. Same shape as `dateSeam.test.ts`
 * and `scaleAudit`'s surface guard.
 *
 * ⚠️ SCOPE IS DELIBERATELY NARROW. Only DIRECTIONAL CONTROL glyphs are banned:
 *   - `«` `»` `▸` `▾` `◀` `▶` `◄` `►`
 * NOT banned, on purpose:
 *   - `‹` `›` — the breadcrumb SEPARATOR (`Plant 1 › Line A`), not a control.
 *   - `▲` `▼` `↻` `✓` `×` `·` — the matrix STATUS glyphs (`STATE_GLYPH`), a
 *     separate semantic set the maintainer chose; they are not affordances.
 * A future directional control belongs in `icons.tsx`; a new status glyph does
 * not, and this audit draws that line by listing only the arrows a chevron
 * replaces.
 *
 * ⚠️ COMMENTS ARE STRIPPED FIRST — `icons.tsx` (allowlisted) and this file name
 * the banned glyphs in prose, and a matcher that reads comments flags the
 * documentation. That mistake has been made repeatedly on this project.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

/** Directional control glyphs a chevron replaces — banned outside the icon module. */
export const BANNED_GLYPHS: readonly string[] = ["«", "»", "▸", "▾", "◀", "▶", "◄", "►"];

/** The one module allowed to name them (it draws the chevron that replaces them). */
export const ICON_ALLOWLIST: readonly string[] = ["src/components/icons.tsx"];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * The banned glyphs found in one file, given its repo-relative path. Pure — takes
 * the source, so it is falsifiable against synthetic input as well as the tree.
 */
export function iconGlyphOffences(relPath: string, source: string): string[] {
  const norm = relPath.replace(/\\/g, "/");
  if (ICON_ALLOWLIST.includes(norm)) return [];
  const src = stripComments(source);
  return BANNED_GLYPHS.filter((g) => src.includes(g)).map(
    (g) => `${norm}: "${g}" — use <Chevron> from @/components/icons`,
  );
}

/** Walk `src/`, skipping test files and declarations. */
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

export function auditIconStandard(root: string): string[] {
  const out: string[] = [];
  for (const rel of walkSources(root)) {
    out.push(...iconGlyphOffences(rel, fs.readFileSync(`${root}/${rel}`, "utf8")));
  }
  return out;
}

describe("the icon-standard guardrail catches a raw glyph (synthetic — rule 3)", () => {
  const stray = "src/features/board/components/Somewhere.tsx";

  it("flags a raw chevron/toggle glyph", () => {
    expect(iconGlyphOffences(stray, `<button>{open ? "«" : "»"}</button>`)).toHaveLength(2);
    expect(iconGlyphOffences(stray, `<span>{collapsed ? "▸" : "▾"}</span>`)).toHaveLength(2);
    expect(iconGlyphOffences(stray, `<button>◀ Prev</button>`)).toHaveLength(1);
  });

  it("does NOT flag the breadcrumb separator or the status glyphs", () => {
    expect(iconGlyphOffences(stray, `label.join(" › ")`)).toEqual([]);
    expect(iconGlyphOffences(stray, `const g = { expiring: "▲", expired: "↻" };`)).toEqual([]);
  });

  it("does NOT read a glyph out of a comment", () => {
    expect(iconGlyphOffences(stray, `// the old toggle used « and »`)).toEqual([]);
  });

  it("allows the icon module its own glyphs (in prose)", () => {
    expect(iconGlyphOffences("src/components/icons.tsx", `« » ▸ ▾`)).toEqual([]);
  });

  it("passes a file that uses the Chevron component", () => {
    expect(iconGlyphOffences(stray, `<Chevron direction="left" />`)).toEqual([]);
  });
});

describe("the real source tree draws chevrons through the icon module", () => {
  it("has no raw chevron/nav glyph outside src/components/icons.tsx", () => {
    expect(auditIconStandard(process.cwd())).toEqual([]);
  });
});
