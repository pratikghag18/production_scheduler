#!/usr/bin/env node
// scripts/tester-stack.mjs — a second Supabase stack, for the tester alone.
//
//   node scripts/tester-stack.mjs up        build (or rebuild) and start it
//   node scripts/tester-stack.mjs down       stop it
//   node scripts/tester-stack.mjs status     `supabase status`, passed through
//   node scripts/tester-stack.mjs env        print the PowerShell $env: lines to export
//
// R-366. Before this, the developer and the tester shared ONE Supabase stack
// (`supabase/config.toml`, `project_id = "production_scheduler"`, ports
// 54320-54329) and ONE Vite dev server (`localhost:5173`). A developer session
// hot-editing this folder, or seeding a fixture into the shared database, was
// therefore live under the tester's browser runs mid-test (F-127). The fix is
// not a rule to remember to follow — "never overlap" was rejected for that
// reason — it is a second stack the tester starts and points at, apart from
// the developer's in every way that matters: its own `project_id`, its own
// ports, its own containers, its own data.
//
// WHY A GENERATED SIBLING WORKDIR, NOT A SECOND COMMITTED config.toml. The
// Supabase CLI reads exactly one `config.toml` per workdir and its `env()`
// substitution has no defaults, so there is no way to carry two port sets in
// one committed file and pick one at start time. So this script keeps the
// committed `supabase/` untouched and, on `up`, generates a WHOLE SECOND copy
// of it — migrations, seed, dev_demo, tests, functions, and a `config.toml`
// rewritten for the tester's ports — in a workdir that lives beside the repo,
// never inside it, and is disposable: `up` always rebuilds it from whatever
// the worktree currently has committed.
//
// HOUSE STYLE: plain Node ESM, no new dependency (config.toml is edited by
// line-level string replacement, not a TOML parser — there isn't one in the
// deps, and the file is simple enough that adding one would be the wrong
// trade). Modelled on scripts/tester-run.mjs: small named functions, an
// execFileSync/spawnSync wrapper, a header that says why.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveWorkdir,
  statusFilePath,
  isInside,
  extractProjectId,
  transformConfig,
  assertGeneratedConfig,
} from "./lib/testerStack.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKDIR = resolveWorkdir(REPO_ROOT);
const STATUS_FILE = statusFilePath(WORKDIR);
// The tester's OWN default port, deliberately not 5173 — 5173 is the
// developer's default in e2e/env.ts, and the whole point of R-366 is that the
// two never share one. `E2E_PORT` still names the knob; the default just
// differs by which side of the fence you are reading this from.
const TESTER_PORT = Number(process.env.E2E_PORT || 5174);
const REPO_CONFIG = readFileSync(join(REPO_ROOT, "supabase", "config.toml"), "utf8");
const isWin = process.platform === "win32";

function refuseUnsafeWorkdir() {
  if (isInside(REPO_ROOT, WORKDIR)) {
    console.error(
      `tester-stack.mjs: refusing to run — the workdir (${WORKDIR}) is inside the repo ` +
        `(${REPO_ROOT}). It must be a SIBLING directory, generated and disposable; the ` +
        "committed supabase/ is not the place for a second, tester-only config.toml. Set " +
        "TESTER_STACK_DIR to somewhere outside the repo, or unset it to use the default.",
    );
    process.exit(1);
  }
}

function copySupabaseAssets() {
  const src = join(REPO_ROOT, "supabase");
  const dst = join(WORKDIR, "supabase");
  mkdirSync(dst, { recursive: true });
  for (const dir of ["migrations", "tests", "functions"]) {
    const from = join(src, dir);
    const to = join(dst, dir);
    rmSync(to, { recursive: true, force: true });
    if (existsSync(from)) cpSync(from, to, { recursive: true });
  }
  for (const file of ["seed.sql", "dev_demo.sql"]) {
    copyFileSync(join(src, file), join(dst, file));
  }
}

function writeGeneratedConfig() {
  const repoProjectId = extractProjectId(REPO_CONFIG);
  const generated = transformConfig(REPO_CONFIG, TESTER_PORT);
  assertGeneratedConfig(generated, TESTER_PORT, repoProjectId);
  writeFileSync(join(WORKDIR, "supabase", "config.toml"), generated);
  return extractProjectId(generated);
}

/** `npx supabase --workdir <WORKDIR> <...args>`, streaming its own output. */
function supabaseInherit(args) {
  const r = spawnSync("npx", ["supabase", "--workdir", WORKDIR, ...args], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: isWin,
  });
  if (r.status !== 0) {
    console.error(`tester-stack.mjs: \`supabase ${args.join(" ")}\` exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

/** Same, but captured rather than streamed — for `status -o env`. */
function supabaseCapture(args) {
  const r = spawnSync("npx", ["supabase", "--workdir", WORKDIR, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: isWin,
  });
  if (r.status !== 0) {
    console.error(r.stdout || "");
    console.error(r.stderr || "");
    console.error(`tester-stack.mjs: \`supabase ${args.join(" ")}\` exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
  return r.stdout;
}

/** `KEY="value"` lines, one per line — the shape `status -o env` prints. */
function parseEnvLines(text) {
  const out = {};
  for (const m of text.matchAll(/^([A-Z_][A-Z0-9_]*)="(.*)"$/gm)) out[m[1]] = m[2];
  return out;
}

function cmdUp() {
  refuseUnsafeWorkdir();
  console.log(`tester-stack.mjs: workdir ${WORKDIR}`);
  copySupabaseAssets();
  const projectId = writeGeneratedConfig();
  console.log(
    `tester-stack.mjs: generated config.toml (project_id ${projectId}, port ${TESTER_PORT})`,
  );

  console.log("tester-stack.mjs: starting the stack (npx supabase start)...");
  supabaseInherit(["start"]);

  console.log(
    "tester-stack.mjs: loading migrations + seed.sql + dev_demo.sql (npx supabase db reset)...",
  );
  supabaseInherit(["db", "reset"]);

  console.log("tester-stack.mjs: reading credentials (npx supabase status -o env)...");
  const env = parseEnvLines(supabaseCapture(["status", "-o", "env"]));
  if (!env.API_URL || !env.ANON_KEY) {
    throw new Error(
      `tester-stack.mjs: \`status -o env\` did not print API_URL/ANON_KEY. Got keys: ${Object.keys(env).join(", ") || "(none)"}`,
    );
  }
  // DEF-0026: the mail catcher is a per-stack service the email-following
  // specs read back from; the CLI prints it under INBUCKET_URL (older) or
  // MAILPIT_URL (newer), both present on this version. A stack without either
  // is refused here rather than left for five specs to time out on.
  const mailUrl = env.INBUCKET_URL || env.MAILPIT_URL;
  if (!mailUrl) {
    throw new Error(
      `tester-stack.mjs: \`status -o env\` printed neither INBUCKET_URL nor MAILPIT_URL. Got keys: ${Object.keys(env).join(", ")}`,
    );
  }

  const record = {
    supabaseUrl: env.API_URL,
    anonKey: env.ANON_KEY,
    dbContainer: `supabase_db_${projectId}`,
    port: TESTER_PORT,
    mailUrl,
  };
  writeFileSync(STATUS_FILE, JSON.stringify(record, null, 2) + "\n");
  console.log(`tester-stack.mjs: wrote ${STATUS_FILE}`);
  console.log("");
  printPowerShellExports(record);
}

function cmdDown() {
  refuseUnsafeWorkdir();
  supabaseInherit(["stop"]);
}

function cmdStatus() {
  refuseUnsafeWorkdir();
  supabaseInherit(["status"]);
}

function printPowerShellExports(record) {
  console.log(
    "# Export these in the PowerShell session running the tester, then npm run dev / e2e:",
  );
  console.log(`$env:VITE_SUPABASE_URL = "${record.supabaseUrl}"`);
  console.log(`$env:VITE_SUPABASE_ANON_KEY = "${record.anonKey}"`);
  console.log(`$env:SUPABASE_DB_CONTAINER = "${record.dbContainer}"`);
  console.log(`$env:E2E_PORT = "${record.port}"`);
  console.log(`$env:E2E_MAIL_URL = "${record.mailUrl}"`);
  console.log(`$env:SUPABASE_WORKDIR = "${WORKDIR}"`);
}

function cmdEnv() {
  if (!existsSync(STATUS_FILE)) {
    console.error(
      `tester-stack.mjs: no ${STATUS_FILE} — run \`node scripts/tester-stack.mjs up\` first.`,
    );
    process.exit(1);
  }
  const record = JSON.parse(readFileSync(STATUS_FILE, "utf8"));
  printPowerShellExports(record);
}

const cmd = process.argv[2];
switch (cmd) {
  case "up":
    cmdUp();
    break;
  case "down":
    cmdDown();
    break;
  case "status":
    cmdStatus();
    break;
  case "env":
    cmdEnv();
    break;
  default:
    console.error(
      "usage: node scripts/tester-stack.mjs up | down | status | env\n\n" +
        `workdir: ${WORKDIR} (TESTER_STACK_DIR to override)`,
    );
    process.exit(2);
}
