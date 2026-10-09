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
import {
  beyondLoopbackWarning,
  publishesBeyondLoopback,
} from "../../scripts/lib/loopbackNetwork.mjs";

const RECORD_SRC = readFileSync("scripts/voice/clips/record.mjs", "utf8");
const SERVE_SRC = readFileSync("scripts/voice/serve/serve.mjs", "utf8");
const TESTER_STACK_SRC = readFileSync("scripts/tester-stack.mjs", "utf8");
const DB_START_SRC = readFileSync("scripts/db-start.mjs", "utf8");
const PACKAGE_JSON = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};

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

/**
 * DEF-0059 (30 Sept, tester): the largest server the project starts was not on
 * session 194's list. `supabase start` publishes Postgres (default password),
 * the API, Studio and the mail catcher on `0.0.0.0`, and `config.toml` has no
 * bind-address setting. The Docker network whose bridge option should bind
 * every published port to loopback is ignored by this machine's Docker Desktop
 * (loopbackNetwork.mjs's header has the experiment), so each start script now
 * reads `docker ps` back and says, loudly, which ports answer beyond this
 * machine and which firewall rule closes them. These cases hold the read-back's
 * arithmetic, the warning's words and the rule's ports; the live proof is a
 * second device on the network, which is the defect's own reproduction.
 */
describe("R-460 (DEF-0059): the Supabase stacks say where they listen", () => {
  const PS_WIDE = [
    "supabase_db_production_scheduler_tester\t0.0.0.0:54422->5432/tcp, [::]:54422->5432/tcp",
    "supabase_kong_production_scheduler_tester\t8001/tcp, 8088/tcp, 8443-8444/tcp, 0.0.0.0:54421->8000/tcp",
    "supabase_db_production_scheduler\t0.0.0.0:54322->5432/tcp",
    "stocks_app-stock-tracker-1\t0.0.0.0:8080->8080/tcp",
  ].join("\n");
  const PS_LOOPBACK = [
    "supabase_db_production_scheduler_tester\t127.0.0.1:54422->5432/tcp",
    "supabase_kong_production_scheduler_tester\t8001/tcp, 127.0.0.1:54421->8000/tcp",
    "supabase_rest_production_scheduler_tester\t3000/tcp",
  ].join("\n");

  it("LN4: the read-back names every port of THIS stack published beyond loopback, IPv6 included", () => {
    expect(publishesBeyondLoopback(PS_WIDE, "production_scheduler_tester")).toEqual([
      "supabase_db_production_scheduler_tester 0.0.0.0:54422->5432/tcp",
      "supabase_db_production_scheduler_tester [::]:54422->5432/tcp",
      "supabase_kong_production_scheduler_tester 0.0.0.0:54421->8000/tcp",
    ]);
    // The developer's stack is judged by its own name; the tester's containers
    // and an unrelated project's are not its business.
    expect(publishesBeyondLoopback(PS_WIDE, "production_scheduler")).toEqual([
      "supabase_db_production_scheduler 0.0.0.0:54322->5432/tcp",
    ]);
  });

  it("LN5: a stack published on 127.0.0.1 only, with unpublished ports beside, reads clean", () => {
    expect(publishesBeyondLoopback(PS_LOOPBACK, "production_scheduler_tester")).toEqual([]);
  });

  it("LN6: both start scripts read the ports back after the start and print the warning", () => {
    for (const src of [TESTER_STACK_SRC, DB_START_SRC]) {
      expect(src).toMatch(/publishesBeyondLoopback\(/);
      expect(src).toMatch(/beyondLoopbackWarning\(/);
      expect(src).not.toMatch(/--network-id/);
    }
    // `npm run db:start` is the script, not the bare CLI.
    expect(PACKAGE_JSON.scripts["db:start"]).toBe("node scripts/db-start.mjs");
  });

  it("LN7: the read-back's warning names R-460, every open port, and the firewall rule", () => {
    // The warning is what a person actually reads; it must say what to do.
    const text = beyondLoopbackWarning("db-start.mjs", [
      "supabase_db_production_scheduler 0.0.0.0:54322->5432/tcp",
      "supabase_kong_production_scheduler [::]:54321->8000/tcp",
    ]);
    expect(text).toMatch(/^db-start\.mjs: WARNING \(R-460\)/);
    expect(text).toContain("0.0.0.0:54322->5432/tcp");
    expect(text).toContain("[::]:54321->8000/tcp");
    expect(text).toContain("scripts/db-firewall.ps1");
    expect(text).toContain("as an administrator");
  });

  it("LN8: the firewall rule blocks inbound TCP on both stacks' port ranges and nothing else", () => {
    const ps1 = readFileSync("scripts/db-firewall.ps1", "utf8");
    expect(ps1).toMatch(/-Direction Inbound -Action Block -Protocol TCP/);
    expect(ps1).toContain('"54320-54329"');
    expect(ps1).toContain('"54420-54429"');
    // The tester's range is the developer's shifted by 100, as testerStack.mjs shifts it.
    expect(ps1).not.toMatch(/-Action Allow/);
  });
});
