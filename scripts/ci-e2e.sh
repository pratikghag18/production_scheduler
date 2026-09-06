#!/usr/bin/env bash
# Run the WHOLE Playwright suite against a REAL backend, in one place CI calls and
# a developer can run locally against a fresh stack. This is the CI half of stage
# S34: until a push can sign in, the three signed-in specs skip, and a skip is not
# a pass.
#
# WHAT IT DOES, IN ORDER:
#   1. Ensure a Supabase stack is up. If none is running it starts one (Docker);
#      GitHub's ubuntu runners ship Docker, so this is the honest local stack --
#      GoTrue for sign-in and PostgREST for reads, which a bare Postgres cannot
#      give. If a stack is ALREADY up (a developer's own dev stack) it is used and
#      left alone.
#   2. When THIS script started the stack, load the exact world db:reset builds --
#      all migrations, then supabase/seed.sql, then supabase/dev_demo.sql, in the
#      order config.toml's sql_paths records -- via `supabase db reset`. That is
#      the same "harness/migrations + seed + dev_demo" world scripts/run-sql-test.sh
#      --demo proves, and the world the app is signed in against on a dev machine.
#   3. Read the started stack's real VITE_SUPABASE_URL and _ANON_KEY straight from
#      `supabase status` and export them. e2e/env.ts prefers process.env, so the
#      dev server Playwright starts (playwright.config.ts webServer: `npm run dev`)
#      is pointed at the real stack and hasRealBackend becomes true.
#   4. Run every browser case with `npx playwright test`.
#
# SAFETY: it stops ONLY a stack it started itself (CI's throwaway one). It never
# runs `supabase db reset` or `supabase stop` against a stack that was already
# running -- so pointing it at a developer's live stack neither wipes its data nor
# tears it down. Run it locally only when you can dedicate the stack (CI, or after
# `supabase stop`); against a live dev stack it reuses that stack read-mostly and
# does not reset it, which means it trusts that stack already holds the demo world.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STARTED_STACK=0
cleanup() {
  if [ "$STARTED_STACK" = "1" ]; then
    echo "ci-e2e: stopping the stack this script started"
    npx supabase stop || true
  fi
}
trap cleanup EXIT

# 1. Up already, or start one. `supabase status` exits non-zero when nothing runs.
if npx supabase status >/dev/null 2>&1; then
  echo "ci-e2e: a Supabase stack is already running; using it (will not reset or stop it)"
else
  echo "ci-e2e: starting a fresh Supabase stack via Docker"
  # Claim ownership BEFORE the start, so a start that fails half-way (leaving some
  # containers up) is still torn down by the trap on exit.
  STARTED_STACK=1
  npx supabase start
fi

# 2. On our own fresh stack, build the demo world deterministically: migrations +
#    seed.sql + dev_demo.sql, exactly as config.toml's sql_paths orders them. Only
#    ever on a stack we started -- never against one that was already up.
if [ "$STARTED_STACK" = "1" ]; then
  echo "ci-e2e: loading migrations + seed.sql + dev_demo.sql (supabase db reset)"
  npx supabase db reset
fi

# 3. Hand the started stack's real credentials to this shell, OVERRIDING any dummy
#    VITE_SUPABASE_* the CI job set at job level for the unit/typecheck/lint steps.
#    `--override-name` renames the CLI's own keys straight into the app's names;
#    `set -a` marks every var the eval assigns for export so the dev server
#    Playwright spawns inherits them. The CLI's upgrade notice goes to stderr, so
#    it never reaches the eval.
echo "ci-e2e: reading VITE_SUPABASE_* from the running stack"
set -a
eval "$(npx supabase status -o env \
  --override-name api.url=VITE_SUPABASE_URL \
  --override-name auth.anon_key=VITE_SUPABASE_ANON_KEY)"
set +a

if [ -z "${VITE_SUPABASE_URL:-}" ] || [ -z "${VITE_SUPABASE_ANON_KEY:-}" ]; then
  echo "ci-e2e: FAILED to read VITE_SUPABASE_* from supabase status" >&2
  exit 1
fi
echo "ci-e2e: app will use VITE_SUPABASE_URL=$VITE_SUPABASE_URL"

# 4. Every browser case. playwright.config.ts starts `npm run dev` with these
#    values, tunes retries/workers off process.env.CI, and the signed-in specs now
#    find a real backend and run instead of skipping. Extra args pass through.
echo "ci-e2e: running Playwright"
npx playwright test "$@"
