// scripts/lib/testerStack.mjs — where the tester's generated Supabase workdir
// lives, computed in exactly one place.
//
// `scripts/tester-stack.mjs` (which builds the workdir) and
// `scripts/tester-run.mjs` (which reads it to point a run at the right stack)
// both need this default, and CLAUDE.md section 4 is explicit that a value
// computed twice is a bug with a delay on it — the two copies agree today and
// silently stop agreeing the day only one of them is edited. R-366.
import { resolve, relative, isAbsolute } from "node:path";

/**
 * `<repo-root>/../scheduler-test-stack`, or `TESTER_STACK_DIR` if that is set,
 * always resolved to an absolute path. For the tester's worktree at
 * `C:\dev\scheduler-test` the default is `C:\dev\scheduler-test-stack` — a
 * SIBLING of the worktree, never inside it: the committed `supabase/`
 * directory is not where a second, generated `config.toml` belongs.
 */
export function resolveWorkdir(repoRoot) {
  return resolve(process.env.TESTER_STACK_DIR || resolve(repoRoot, "..", "scheduler-test-stack"));
}

/** The file `tester-stack.mjs up` writes and `env`/`tester-run.mjs` read. */
export function statusFilePath(workdir) {
  return resolve(workdir, "tester-stack.json");
}

/** True when `child` is `parent` itself or somewhere underneath it. */
export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// The config generator. Pure functions of text, kept HERE rather than in
// `tester-stack.mjs` so `src/test/testerStack.test.ts` can pin them against
// the real `supabase/config.toml` without importing a script whose top level
// runs a command. R-366's proof: every port line the repo's config carries is
// shifted, the project id changes, the dev-server port is rewritten, and a
// port under a key name the shifter does not know is REFUSED rather than
// started -- the one failure that would quietly put the tester back on the
// developer's stack.
// ---------------------------------------------------------------------------

export function extractProjectId(text) {
  const m = text.match(/^project_id = "(.*)"$/m);
  return m ? m[1] : null;
}

/**
 * The repo's config.toml, rewritten for a second stack that can run beside
 * the first: a distinct `project_id` (so the CLI names distinct containers),
 * every port shifted +100, and the dev-server port `site_url` /
 * `additional_redirect_urls` name shifted to the tester's own.
 *
 * WHICH PORTS, READ FROM THE WHOLE FILE (9 Sept): `[api] port = 54321`,
 * `[db] port = 54322` and `shadow_port = 54320`, `[db.pooler] port = 54329`,
 * `[studio] port = 54323`, `[inbucket] port = 54324`. Six lines, all matched
 * by the one `port`/`shadow_port` pattern below — nothing else in the file
 * uses either key name.
 */
export function transformConfig(repoConfigText, testerPort) {
  let text = repoConfigText;

  text = text.replace(
    /^project_id = "production_scheduler"$/m,
    'project_id = "production_scheduler_tester"',
  );

  text = text.replace(
    /^(\s*)(shadow_port|port)(\s*=\s*)(\d+)\s*$/gm,
    (_line, indent, key, eq, num) => `${indent}${key}${eq}${Number(num) + 100}`,
  );

  // The only place `5173` appears in config.toml is `[auth]`'s site_url and
  // additional_redirect_urls (F-106's allow-list); a plain substring swap is
  // safe because nothing else in the file names the developer's dev-server
  // port, and it is exactly what the assertion below checks was true.
  text = text.replaceAll("5173", String(testerPort));

  return text;
}

/**
 * Fail loudly rather than start a stack whose config still names a developer
 * port — a generated config that does that is the exact bug this script
 * exists to prevent, not a warning to notice later.
 */
export function assertGeneratedConfig(text, testerPort, repoProjectId) {
  const problems = [];
  const generatedProjectId = extractProjectId(text);
  if (generatedProjectId !== "production_scheduler_tester") {
    problems.push(
      `expected project_id "production_scheduler_tester", got ${JSON.stringify(generatedProjectId)}`,
    );
  }
  if (generatedProjectId === repoProjectId) {
    problems.push("generated project_id is identical to the repo's — refusing to collide");
  }
  if (/5432\d/.test(text)) {
    problems.push("still contains an unshifted developer port (54320-54329)");
  }
  if (String(testerPort) !== "5173" && text.includes("5173")) {
    problems.push("still names port 5173 (the developer's dev-server port)");
  }
  if (problems.length) {
    throw new Error(
      "tester-stack.mjs: refusing to write a bad config.toml:\n  - " + problems.join("\n  - "),
    );
  }
}
