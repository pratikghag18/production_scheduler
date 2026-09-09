/**
 * Where the e2e run gets its Supabase credentials, and the ONE place that
 * decides whether this run has a backend behind it at all.
 *
 * ⭐⭐ THIS FILE EXISTS BECAUSE THE ANSWER IS NEEDED IN TWO PLACES AND MUST NOT
 * BE COMPUTED TWICE. `playwright.config.ts` needs the values, to hand them to
 * the dev server it starts; the signed-in specs need the VERDICT, to skip
 * themselves when there is nothing to sign in to. Those are the same question,
 * and a second copy of "is this the dummy URL?" is exactly the shape CLAUDE.md
 * section 4 warns about — a list that appears twice is a bug with a delay on
 * it. The loader used to live inline in the config; it moved here whole.
 *
 * ⚠️ WHY THERE IS NO `dotenv` DEPENDENCY. This brief's stack does not include
 * one and adding a package to read six lines is not worth it. The parser below
 * is deliberately minimal: `KEY=value`, `#` comments, blank lines. It is not a
 * general .env implementation and should not grow into one — if a value ever
 * needs quoting or interpolation, that is the moment to take the dependency.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The values CI uses. They are not a mistake and not a placeholder to be
 * replaced: with no secrets and no database, they are the one state CI can
 * reproduce exactly, and they let `npm run build` and the signed-out smoke test
 * run on every push. What they cannot do is hold a session.
 */
export const DUMMY_URL = "https://example.supabase.co";
export const DUMMY_ANON_KEY = "dummy-anon-key";

function loadDotEnvLocal(): Record<string, string> {
  // `e2e/` sits one level under the repo root, where `.env.local` lives.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = path.join(root, ".env.local");
  const parsed: Record<string, string> = {};
  if (!existsSync(envPath)) return parsed;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    parsed[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return parsed;
}

const dotEnvLocal = loadDotEnvLocal();

/**
 * ⭐ PROCESS ENV WINS, THEN `.env.local`, THEN THE DUMMY. CI has no `.env.local`
 * and must not grow one: `scripts/ci-e2e.sh` stands up a real stack and exports
 * the VITE_SUPABASE_* values that stack prints, so reading `process.env` FIRST is
 * what lets a push run the signed-in specs — without committing a secret and
 * without a file the script would have to write over a developer's own
 * `.env.local`. Locally, with nothing exported, `.env.local` still answers
 * exactly as it did before, and a developer with neither still gets the dummy and
 * the honest skip below.
 */
function pick(name: string, fallback: string): string {
  return process.env[name] || dotEnvLocal[name] || fallback;
}

export const supabaseUrl = pick("VITE_SUPABASE_URL", DUMMY_URL);
export const supabaseAnonKey = pick("VITE_SUPABASE_ANON_KEY", DUMMY_ANON_KEY);

/**
 * ⭐ THE TESTER'S PORT KNOB (R-366). One Vite dev server on a fixed
 * `localhost:5173` meant the tester's browser runs executed whatever was on
 * the developer's disk mid-edit (F-127's four attempts). `E2E_PORT` lets a
 * run choose its own port; the default, 5173, is the developer's port
 * unchanged, so a developer session that exports nothing behaves exactly as
 * before. `playwright.config.ts` needs this value for `use.baseURL` AND
 * `webServer.url`/`command`, and a few specs need it directly (a redirect URL,
 * an `Origin` header, a manually-created browser context that does not
 * inherit `use.baseURL`) — the same "needed in more than one place" shape as
 * `supabaseUrl` above, so it is computed once here rather than risking a
 * second copy that drifts from this one.
 */
export const e2ePort = Number(process.env.E2E_PORT || 5173);
export const e2eBaseUrl = `http://localhost:${e2ePort}`;

/**
 * ⛔ THE MAIL CATCHER IS PER STACK TOO (DEF-0026). `invite.spec.ts` and
 * `passwordReset.spec.ts` follow a real email their own run just sent, and
 * both had `http://127.0.0.1:54324` written into them -- the DEVELOPER's
 * inbucket. The tester's stack sends its mail to ITS inbucket (54424 under
 * the +100 shift), so on the first real use of R-366 every email-following
 * case timed out, deterministically, against a mailbox that was full. Same
 * loader as `supabaseUrl`: process env first (what `scripts/tester-stack.mjs
 * env` prints, read straight off `supabase status`), then `.env.local`, then
 * the developer's default -- never derived from the API port, because "+3"
 * is a coincidence of today's port scheme, not a contract.
 */
export const mailUrl = pick("E2E_MAIL_URL", "http://127.0.0.1:54324");

/**
 * ⭐ THE VERDICT, AND IT IS DELIBERATELY ABOUT THE URL RATHER THAN ABOUT `CI`.
 * A developer with no `.env.local` gets the same skip a CI run does, which is
 * the honest answer for both: there is no backend here. Keying on
 * `process.env.CI` instead would tell a developer their signed-in specs
 * "passed" when they had never run.
 *
 * ⚠️ IT DOES NOT PROMISE THE BACKEND IS UP, only that this run was pointed at a
 * real one. A stopped Supabase is a FAILURE, not a skip — a suite that goes
 * quiet when the database is down is how a green run stops meaning anything.
 */
export const hasRealBackend = supabaseUrl !== DUMMY_URL && supabaseAnonKey !== DUMMY_ANON_KEY;

/** Said once, so every skipped spec gives the reader the same next step. */
export const NO_BACKEND_REASON =
  `No Supabase to sign in to: this run is pointed at ${DUMMY_URL}. ` +
  "Put VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local and start " +
  "the local stack (npm run db:start) to run the signed-in specs.";

/**
 * ⭐⭐ THE OTHER HALF OF `hasRealBackend`, AND THE ONE THAT WAS MISSING.
 * `hasRealBackend` answers "was this run pointed at a real stack?" — a NO is an
 * honest skip. It deliberately does NOT answer "is that stack actually
 * answering?", and the comment above has always said what the answer means: a
 * stopped Supabase is a FAILURE, not a skip. Nothing enforced it. The two live
 * pins each open with `hasRealBackend` and then, further down, treat "the
 * function is not being served", "could not sign in as Dana" and "Operator A2
 * not found" the same way — `console.warn` and `return` — which vitest counts
 * as PASSED, not skipped.
 *
 * ⛔ MEASURED, 9 Sept, not argued. `supabase_edge_runtime_production_scheduler`
 * had exited (255) overnight while the other nine containers stayed up. The
 * DEF-0020 pin then reported `1 passed` with a body that ran in 19ms and made
 * zero network calls; with the container restarted the same body takes ~678ms
 * and makes four. A run that could not ask the question reported the same word
 * as a run that asked it and got the right answer. Under the full parallel
 * suite the dead container instead showed up as the OPTIONS probe hanging past
 * the 5s default — which is why F-122 read as a random flake that "only fails
 * in company": one dead container wearing two faces, and neither of them the
 * worker contention F-122 suspected.
 *
 * So: past the `hasRealBackend` gate, a dependency that does not answer calls
 * this, and the run goes red with the reason and the way back.
 */
export function liveBackendGone(detail: string): never {
  throw new Error(
    `${detail}\n\n` +
      `This run IS pointed at a real backend (${supabaseUrl}), so this is a FAILURE, not a skip: ` +
      "a live pin that goes quiet when its dependency is down reports the same word whether the " +
      "rule it guards holds or was never asked about. Check the stack is whole — " +
      "`docker ps` should list ten supabase_* containers, and the edge runtime is the one that " +
      "dies quietly (`docker start supabase_edge_runtime_production_scheduler`). " +
      "If you meant to run without a backend, unset VITE_SUPABASE_URL so the skip is the honest one.",
  );
}

/**
 * ⚠️ WHY THESE PINS GET AN EXPLICIT TIMEOUT AND IT IS THIS GENEROUS. They are
 * the only tests in the unit suite that make real network round trips — four of
 * them, in sequence, one of which boots a Deno function that may be cold. Warm
 * and alone that is ~678ms; a cold edge runtime spent 336ms on the preflight
 * ALONE, and under a full parallel run the whole suite's workers are competing
 * for the same stack. Vitest's 5s default was tight enough that a cold start
 * read as a failure, which is the wrong lesson: slow is not broken. The fix
 * pulls in both directions on purpose — stricter about pretending to pass
 * (`liveBackendGone`), more patient about being slow (this).
 */
export const LIVE_PIN_TIMEOUT_MS = 30_000;
