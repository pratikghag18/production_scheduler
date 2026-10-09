/// <reference types="node" />
/**
 * ⭐⭐ THE RULE: A LIVE PIN MAY GO QUIET FOR EXACTLY ONE REASON.
 *
 * Two pins under `src/test/defects/` drive the running stack rather than a
 * fixture, because the thing they guard has no pure seam — DEF-0020's promise
 * lives in a Deno Edge Function, DEF-0022's in a Postgres function's range
 * bounds. Both open with `hasRealBackend`, which answers "was this run pointed
 * at a real stack?" A no there is an honest skip: CI runs on a dummy URL with
 * no secrets, on purpose.
 *
 * ⛔ WHAT THIS FILE EXISTS TO PREVENT, BECAUSE IT ALREADY HAPPENED. Past that
 * gate, both pins used to treat every OTHER unreachable dependency the same way
 * — `console.warn` and `return` — and a test that returns without asserting is
 * counted by vitest as PASSED, not skipped. On 9 Sept the edge-runtime
 * container had exited (255) overnight while the other nine stayed up:
 * DEF-0020's body ran in 19ms, made zero network calls, and the file reported
 * `1 passed`. With the container restarted the same body takes ~678ms and makes
 * four. Three sites had this shape — "the function is not being served", "could
 * not sign in as Dana", "Operator A2 not found" — and the last two do not even
 * mean the stack is off; they mean it is ON and broken, which is precisely what
 * a pin should shout about.
 *
 * `e2e/env.ts` had said so in prose since it was written — *"A stopped Supabase
 * is a FAILURE, not a skip — a suite that goes quiet when the database is down
 * is how a green run stops meaning anything"* — and nothing enforced it. That
 * is the same shape as the `--ui-scale` rule in `scaleAudit.ts`: written down
 * correctly, violated later, because no test ever read the files against it.
 * The fix is not just to correct the two files; it is to make the next live pin
 * unable to repeat the pattern.
 *
 * ⚠️ WHAT THIS AUDIT CAN AND CANNOT TELL YOU, SAID PLAINLY. It reads text. It
 * proves that the only silent exit in a live pin is the `hasRealBackend` one,
 * and that the file has the vocabulary for a loud one. It does NOT prove the
 * loud exit is wired to the right branch — a pin could import `liveBackendGone`
 * and never call it. That half is proved by mutation instead, and was: stopping
 * `supabase_edge_runtime_production_scheduler` turns DEF-0020 red in ~10s with
 * its reason; a wrong password and a non-existent operator name each turn
 * DEF-0022 red with theirs. Recorded in session 100 rather than automated,
 * because automating it means killing a container inside a unit run.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";

const DEFECTS_DIR = "src/test/defects";

/** How far back to look for the guard that justifies a quiet exit. */
const PREAMBLE_CHARS = 240;

/** The import specifier every live pin pulls its vocabulary from. */
const ENV_IMPORT = 'from "../../../e2e/env"';

/**
 * ⛔ EVERYTHING PAST THE IMPORT, AND THE REASON IS A FALSE PASS THIS AUDIT
 * ACTUALLY PRODUCED. The first version asked `text.includes("LIVE_PIN_TIMEOUT_MS")`.
 * Deleting the timeout ARGUMENT from DEF-0022 left the identifier sitting in the
 * import list, so the whole file still reported `5 passed` — the audit written to
 * stop a test that cannot fail could not fail. Caught by mutating it rather than
 * by reading it, which is the only way this class ever gets caught (DEF-0024 was
 * the same shape: a slice that did not stop where the thing it asserted stopped).
 * So the search starts after the import and an imported-but-unused name cannot
 * satisfy anything.
 */
function bodyOf(text: string): string {
  const at = text.lastIndexOf(ENV_IMPORT);
  return at === -1 ? text : text.slice(at + ENV_IMPORT.length);
}

function livePinFiles(): { name: string; text: string }[] {
  return fs
    .readdirSync(DEFECTS_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => ({ name, text: fs.readFileSync(`${DEFECTS_DIR}/${name}`, "utf-8") }))
    .filter((f) => f.text.includes("hasRealBackend"));
}

describe("live pins may go quiet for exactly one reason", () => {
  it("there are live pins to audit at all -- this suite is not vacuously green", () => {
    // Without this the whole file passes by finding nothing, which is the very
    // failure mode it was written to stop.
    expect(
      livePinFiles()
        .map((f) => f.name)
        .sort(),
      `no file under ${DEFECTS_DIR} imports hasRealBackend; either the live pins were deleted or the directory moved, and this audit is now checking nothing`,
    ).toEqual(["DEF-0020.test.ts", "DEF-0022.test.ts"]);
  });

  for (const { name, text } of livePinFiles()) {
    it(`${name}: its only console.warn is the no-backend skip`, () => {
      const warns = [...text.matchAll(/console\.warn\(/g)];
      expect(
        warns.length,
        `${name} has ${warns.length} console.warn calls. A live pin gets exactly ONE -- the honest "this run was never pointed at a stack" skip. Every other unreachable dependency means the stack IS configured and broken, and must call liveBackendGone() so the run goes red. See e2e/env.ts.`,
      ).toBe(1);

      const at = warns[0].index;
      const preamble = text.slice(Math.max(0, at - PREAMBLE_CHARS), at);
      expect(
        preamble,
        `${name}'s console.warn is not guarded by !hasRealBackend within the preceding ${PREAMBLE_CHARS} characters, so it is warning about something other than "no backend configured" and then, presumably, returning -- which vitest counts as PASSED.`,
      ).toContain("!hasRealBackend");
    });

    it(`${name}: CALLS the loud exit and sets an explicit timeout`, () => {
      const body = bodyOf(text);
      expect(
        body,
        `${name} never calls liveBackendGone() outside its import. A live pin needs a way to fail loudly when its dependency is unreachable; without one the only exits available are "pass" and "time out". Importing the name is not using it -- that exact gap made an earlier version of this audit pass a file with its timeout deleted.`,
      ).toContain("liveBackendGone(");
      expect(
        body,
        `${name} does not pass LIVE_PIN_TIMEOUT_MS to it(). Vitest's 5s default is tight for four real round trips against a possibly-cold edge function -- a cold start read as a failure is what made F-122 look like a random flake.`,
      ).toContain("LIVE_PIN_TIMEOUT_MS");
    });
  }
});
