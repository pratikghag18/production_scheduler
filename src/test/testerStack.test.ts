import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  assertGeneratedConfig,
  extractProjectId,
  transformConfig,
} from "../../scripts/lib/testerStack.mjs";

/**
 * R-366: the tester's Supabase stack is generated from the developer's
 * `supabase/config.toml` by `scripts/tester-stack.mjs up`. These cases run the
 * generator over the REAL committed file, not a fixture, so the day someone
 * adds a port line the shifter does not recognise, this goes red here rather
 * than the tester quietly starting a stack that still names a developer port.
 */
const REPO_CONFIG = readFileSync("supabase/config.toml", "utf8");
const TESTER_PORT = 5174;

describe("R-366: the tester's config.toml is generated, never shared", () => {
  it("TS1: the repo's own config names the developer's project id", () => {
    expect(extractProjectId(REPO_CONFIG)).toBe("production_scheduler");
  });

  it("TS2: the generated config carries a different project id, so the CLI names different containers", () => {
    const out = transformConfig(REPO_CONFIG, TESTER_PORT);
    expect(extractProjectId(out)).toBe("production_scheduler_tester");
  });

  it("TS3: every port line in the repo's config is shifted by exactly 100 -- none left, none invented", () => {
    const portLines = (text: string) =>
      [...text.matchAll(/^\s*(?:shadow_port|port)\s*=\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));
    const before = portLines(REPO_CONFIG);
    const after = portLines(transformConfig(REPO_CONFIG, TESTER_PORT));
    expect(before.length).toBeGreaterThan(0);
    expect(after).toEqual(before.map((p) => p + 100));
  });

  it("TS4: no developer port (54320-54329) survives in the generated text", () => {
    expect(transformConfig(REPO_CONFIG, TESTER_PORT)).not.toMatch(/5432\d/);
  });

  it("TS5: the auth allow-list names the tester's dev-server port and no longer the developer's", () => {
    const out = transformConfig(REPO_CONFIG, TESTER_PORT);
    expect(out).not.toContain("5173");
    expect(out).toContain(`http://127.0.0.1:${TESTER_PORT}`);
    expect(out).toContain(`http://localhost:${TESTER_PORT}/**`);
  });

  it("TS6: the real config passes the assertion the script runs before writing", () => {
    const out = transformConfig(REPO_CONFIG, TESTER_PORT);
    expect(() =>
      assertGeneratedConfig(out, TESTER_PORT, extractProjectId(REPO_CONFIG)),
    ).not.toThrow();
  });

  it("TS7: a port under a key name the shifter does not know is refused, not started", () => {
    // The one failure that would quietly put the tester back on the
    // developer's database: a new `[section] something_port = 5432x` line the
    // regex never shifts. The assertion is the net; this pins that it holds.
    const withStranger = REPO_CONFIG + "\n[edge_runtime]\ninspector_port = 54327\n";
    const out = transformConfig(withStranger, TESTER_PORT);
    expect(() => assertGeneratedConfig(out, TESTER_PORT, extractProjectId(withStranger))).toThrow(
      /unshifted developer port/,
    );
  });

  it("TS8: a config whose project id did not change is refused -- two stacks with one name collide", () => {
    const sameId = transformConfig(REPO_CONFIG, TESTER_PORT).replace(
      'project_id = "production_scheduler_tester"',
      'project_id = "production_scheduler"',
    );
    expect(() => assertGeneratedConfig(sameId, TESTER_PORT, "production_scheduler")).toThrow(
      /project_id/,
    );
  });

  /*
   * DEF-0026: the first real use of the tester's stack found both
   * email-following specs still reading the DEVELOPER's mail catcher by
   * literal port. `tsc` cannot see a string; these two can.
   */
  it("TS9 / DEF-0026: no e2e spec names a Supabase service port by literal -- every per-stack URL comes from e2e/env.ts", () => {
    for (const f of ["e2e/invite.spec.ts", "e2e/passwordReset.spec.ts", "e2e/roleWalk.spec.ts"]) {
      const text = readFileSync(f, "utf8").replace(/^\s*(\/\/|\*).*$/gm, ""); // comments may cite a port; code may not
      expect(text, `${f} names a stack port by literal`).not.toMatch(
        /127\.0\.0\.1:5\d{4}|localhost:5\d{4}/,
      );
    }
  });

  it("TS10 / DEF-0026: e2e/env.ts's mailUrl follows E2E_MAIL_URL, and defaults to the developer's inbucket", async () => {
    vi.stubEnv("E2E_MAIL_URL", "http://127.0.0.1:54424");
    vi.resetModules();
    const withKnob = await import("../../e2e/env");
    expect(withKnob.mailUrl).toBe("http://127.0.0.1:54424");
    vi.unstubAllEnvs();
    vi.resetModules();
    const fallback = await import("../../e2e/env");
    // `.env.local` may or may not carry the knob on a given machine; either the
    // developer's default or whatever that file says, never the tester's.
    expect(fallback.mailUrl).not.toBe("http://127.0.0.1:54424");
  });
});
