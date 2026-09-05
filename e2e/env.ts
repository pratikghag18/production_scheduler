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

export const supabaseUrl = dotEnvLocal.VITE_SUPABASE_URL ?? DUMMY_URL;
export const supabaseAnonKey = dotEnvLocal.VITE_SUPABASE_ANON_KEY ?? DUMMY_ANON_KEY;

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
