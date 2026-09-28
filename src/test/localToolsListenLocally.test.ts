/**
 * DEF-0039 / R-460 (S194-C, brief docs/agent-briefs/s194-c-scripts-and-seed-
 * brief.md piece 1) — "a tool the project runs on this machine listens on
 * this machine only." `record.mjs` used to call `server.listen(port, cb)`
 * with no host, which Node binds to every interface -- anyone on the same
 * network could read or silently overwrite the maintainer's recorded voice
 * clips (no authentication on `/clip/<n>` or `/manifest.json`). `serve.mjs`
 * published the llama.cpp model container on every interface too, with no
 * comment defending the asymmetry against the Whisper container two blocks
 * above it, which was already loopback-only.
 *
 * This reads the SOURCE TEXT of both files rather than starting a real
 * server or a real container (`record.mjs`'s own header says "no build step,
 * no dependencies" and `serve.mjs` shells out to `docker`, neither of which
 * belongs in a unit suite) -- the same shape `voiceData.test.ts` and
 * `testerStack.test.ts` use for a `.mjs` script's own text/behaviour. The
 * developer's own manual proof (starting `record.mjs` for real on a scratch
 * port and reading `netstat`) is the report for DEF-0039, not this file;
 * this file is what stops a REGRESSION once that proof is gone.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const RECORD_SRC = readFileSync("scripts/voice/clips/record.mjs", "utf8");
const SERVE_SRC = readFileSync("scripts/voice/serve/serve.mjs", "utf8");

describe("R-460: local tools listen on this machine only", () => {
  it("record.mjs's http server listens on the loopback host explicitly", () => {
    // Node binds every interface when `listen()`'s host argument is omitted
    // -- `server.listen(port, cb)` (no middle argument) is exactly the bug.
    expect(RECORD_SRC).toMatch(/server\.listen\(\s*args\.port\s*,\s*"127\.0\.0\.1"\s*,/);
    // And the banner it prints still matches what it actually does.
    expect(RECORD_SRC).toMatch(/recording page: http:\/\/127\.0\.0\.1:\$\{args\.port\}\//);
  });

  it("every docker -p/--publish publish in serve.mjs begins 127.0.0.1: (loopback only)", () => {
    // Every `-p`/`--publish` flag's own published-port STRING (the next array
    // element after the flag literal) must start with the loopback host. A
    // bare `${HOST_PORT}:${CONTAINER_PORT})` with no host binds every
    // interface (DEF-0039's model-container half of the bug). Docker accepts
    // `--publish` as `-p`'s long-form spelling; a first version of this check
    // matched only `"-p"` by name, so renaming ONE of the two `-p` flags to
    // `--publish` (still with a wide-open value) silently dropped it from
    // `publishValues` while `publishValues.length > 0` stayed true on the
    // OTHER flag's own loopback value -- a real, undetected regression that
    // reads green (S194-C review). Matching both spellings closes that gap.
    const publishValues = [...SERVE_SRC.matchAll(/"(?:-p|--publish)",\s*\n?\s*`([^`]+)`/g)].map(
      (m) => m[1],
    );
    // Two publishes today (Whisper's own container and the model container);
    // asserting the exact count, not just >0, so a THIRD flag added under yet
    // another name (or a publish moved out of this literal-array shape
    // entirely) is caught by count instead of silently matching fewer than
    // intended.
    expect(publishValues.length).toBe(2);
    for (const value of publishValues) {
      expect(value.startsWith("127.0.0.1:")).toBe(true);
    }
  });
});
