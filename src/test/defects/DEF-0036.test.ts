import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * DEF-0036: scaleAudit.ts enforces R-D84 through two hand-kept lists (CHROME_FILES, REM_SURFACES),
 * and its completeness guard (D89, `missingRemSurfaces`) walks the ADMIN feature directory only. So
 * a new BOARD stylesheet escapes the D84 audit unless someone remembers to list it — nothing fails
 * if they don't. Two board panels added this window are in neither list:
 * OperatorPanel.module.css (operator rail, S65) and ShiftLayer.module.css (shift band, S66-c).
 *
 * This pin reads scaleAudit.ts and asserts it names both files. It goes green once the developer
 * brings them under the audit (via CHROME_FILES, a board ignore list, or a new board completeness
 * walk) — whichever the fix chooses, the audit will then name them.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AUDIT = join(ROOT, "src/test/scaleAudit.ts");
const NEW_BOARD_SURFACES = [
  "OperatorPanel.module.css", // operator rail, S65
  "ShiftLayer.module.css", // shift band on cells, S66-c
];

describe("DEF-0036: new board stylesheets are brought under the scale audit (R-D84)", () => {
  const auditSrc = readFileSync(AUDIT, "utf8");
  for (const file of NEW_BOARD_SURFACES) {
    it(`scaleAudit.ts names ${file} (fails until it is enrolled in the D84 audit)`, () => {
      expect(
        auditSrc.includes(file),
        `${file} is audited by nothing: scaleAudit's completeness guard walks the admin tree only, ` +
          `so this board surface escapes R-D84`,
      ).toBe(true);
    });
  }
});
