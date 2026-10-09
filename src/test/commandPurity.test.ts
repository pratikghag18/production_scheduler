/// <reference types="node" />
/**
 * P1-7a "NO SECOND DOOR" GUARDRAIL (brief §2, §9 U1/U2; CLAUDE.md §4: whatever a
 * client offers or hides must be decided by the same test the server runs).
 *
 * `src/lib/command/` is where a typed sentence becomes a form and then a set
 * of board records. It is explicitly NOT allowed to write to the database or
 * to hold a copy of a rule the server, `scope.ts` or the create pop-up already
 * hold: `parse.ts` imports nothing at all, and `resolve.ts` imports only a
 * TYPE from `parse.ts`, so `node --experimental-strip-types` can run either
 * file and the later local model can swap `parse.ts` out as a one-file change.
 * U1 fails the build the moment a runtime `import`, a `require(`, `new Date(`
 * or `Intl.` sneaks into either module — each is a sign that a rule, a clock,
 * or a second write path is creeping in beside the one door the create
 * pop-up already is.
 *
 * U2 guards the other end of the same rule: `CommandBar.tsx` (Lane B's file)
 * must never call `createAssignment`/`useCreateAssignment`/`supabase`, or
 * import `@/lib/api/mutations` directly — its whole job ends at opening the
 * existing pop-up pre-filled (brief §2, "If you find yourself importing
 * `createAssignment`, `useCreateAssignment` or `supabase` into anything under
 * `src/lib/command/` or into `CommandBar.tsx`, stop").
 *
 * Same shape as `popoverStandard.test.ts` / `iconStandard.test.ts` /
 * `dateSeam.test.ts`. ⚠️ COMMENTS ARE STRIPPED FIRST — this file and the
 * modules it audits name the forbidden words in prose, and a matcher that
 * read comments would flag the documentation instead of real code.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const COMMAND_DIR = "src/lib/command";
const COMMAND_BAR_PATH = "src/features/board/components/CommandBar.tsx";

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** U1's offences in one file's already-stripped source. Pure, falsifiable
 *  against synthetic input as well as the real tree. */
export function commandModuleOffences(relPath: string, strippedSource: string): string[] {
  const out: string[] = [];
  const lines = strippedSource.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("import") && !trimmed.startsWith("import type")) {
      out.push(`${relPath}: runtime import — only "import type" is allowed here`);
    }
  }
  if (/require\(/.test(strippedSource)) {
    out.push(
      `${relPath}: require( — no CommonJS in a module that must run under --experimental-strip-types`,
    );
  }
  if (/new Date\(/.test(strippedSource)) {
    out.push(`${relPath}: new Date( — this module must never read a clock (D88a/D88b)`);
  }
  if (/Intl\./.test(strippedSource)) {
    out.push(`${relPath}: Intl. — no locale/date formatting in the resolver`);
  }
  return out;
}

function listCommandTsFiles(root: string): string[] {
  const dir = path.join(root, COMMAND_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => `${COMMAND_DIR}/${e.name}`);
}

export function auditCommandPurity(root: string): string[] {
  const out: string[] = [];
  for (const rel of listCommandTsFiles(root)) {
    const source = fs.readFileSync(path.join(root, rel), "utf8");
    out.push(...commandModuleOffences(rel, stripComments(source)));
  }
  return out;
}

/** U2's offences in `CommandBar.tsx`'s already-stripped source ("" — never
 *  written — is the honest answer when Lane B has not yet added the file). */
const SECOND_DOOR_NEEDLES = [
  "createAssignment",
  "useCreateAssignment",
  "supabase",
  "@/lib/api/mutations",
];

export function commandBarOffences(strippedSource: string): string[] {
  return SECOND_DOOR_NEEDLES.filter((needle) => strippedSource.includes(needle)).map(
    (needle) =>
      `CommandBar.tsx: "${needle}" — the bar opens the pop-up pre-filled, it never writes (brief §2)`,
  );
}

export function auditCommandBar(root: string): string[] {
  const full = path.join(root, COMMAND_BAR_PATH);
  if (!fs.existsSync(full)) return [];
  return commandBarOffences(stripComments(fs.readFileSync(full, "utf8")));
}

describe("U1: src/lib/command/*.ts imports nothing but types, and never touches a clock (synthetic)", () => {
  it("flags a runtime import", () => {
    expect(
      commandModuleOffences("src/lib/command/resolve.ts", `import { x } from "./y";\n`),
    ).toHaveLength(1);
  });

  it("does not flag a type-only import", () => {
    expect(
      commandModuleOffences("src/lib/command/resolve.ts", `import type { X } from "./parse.ts";\n`),
    ).toEqual([]);
  });

  it("flags require(", () => {
    expect(
      commandModuleOffences("src/lib/command/parse.ts", `const x = require("fs");\n`),
    ).toHaveLength(1);
  });

  it("flags new Date(", () => {
    expect(
      commandModuleOffences("src/lib/command/resolve.ts", `const now = new Date();\n`),
    ).toHaveLength(1);
  });

  it("flags Intl.", () => {
    expect(
      commandModuleOffences("src/lib/command/resolve.ts", `Intl.DateTimeFormat().format(x);\n`),
    ).toHaveLength(1);
  });

  it("does not read a forbidden word out of a comment", () => {
    expect(
      commandModuleOffences(
        "src/lib/command/resolve.ts",
        stripComments("// we must never call new Date( or require( here\nexport const ok = 1;\n"),
      ),
    ).toEqual([]);
  });
});

describe("U1 on the real tree: src/lib/command holds no rule and no clock", () => {
  it("has no offences", () => {
    expect(auditCommandPurity(process.cwd())).toEqual([]);
  });
});

describe("U2: CommandBar.tsx never opens a second door (synthetic)", () => {
  it("flags createAssignment", () => {
    expect(commandBarOffences("createAssignment(x);")).toHaveLength(1);
  });

  it("flags useCreateAssignment", () => {
    expect(commandBarOffences("const m = useCreateAssignment();")).toHaveLength(1);
  });

  it("flags supabase", () => {
    expect(commandBarOffences("supabase.from('assignments')")).toHaveLength(1);
  });

  it("flags an @/lib/api/mutations import", () => {
    expect(
      commandBarOffences('import { createAssignment } from "@/lib/api/mutations";'),
    ).toHaveLength(2);
  });

  it("does not flag a clean bar", () => {
    expect(commandBarOffences("export function CommandBar() { return null; }")).toEqual([]);
  });
});

describe("U2 on the real tree: CommandBar.tsx (if it exists yet)", () => {
  it("has no second-door offences, or the file is not there yet (Lane B is writing it)", () => {
    const full = path.join(process.cwd(), COMMAND_BAR_PATH);
    if (!fs.existsSync(full)) {
      // Lane A ran before Lane B's file landed. The audit must still pass on
      // an empty string rather than error, so the case asserts that directly.
      expect(commandBarOffences("")).toEqual([]);
      return;
    }
    expect(auditCommandBar(process.cwd())).toEqual([]);
  });
});
