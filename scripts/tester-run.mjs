#!/usr/bin/env node
// scripts/tester-run.mjs — the tester's fixed run order, in one command.
//
//   node scripts/tester-run.mjs            the standard run (plan check, types, tsc, lint, format, vitest, sweeps)
//   node scripts/tester-run.mjs --sql      also run every supabase/tests file against the local stack
//   node scripts/tester-run.mjs --e2e      also run Playwright
//   node scripts/tester-run.mjs --no-types skip `npm run db:types` (when the local Supabase stack is down;
//                                          tsc is then INCONCLUSIVE and the report says so)
//
// It runs the instruments in the order the project learned to run them, captures every runner's own
// output VERBATIM into test-results/tester-run-<date>.md, and prints a short summary. It decides
// nothing about what to file — the tester reads the report and files defects. It exists so the run
// is the same every time and so the report can be pasted rather than paraphrased.
//
// WHY EACH STEP IS WHERE IT IS
//   db:types before tsc   — tsc is inconclusive until database.types.ts matches the database. If the
//                           regeneration changes the file, the committed types were stale: a finding.
//   count vs plan.yaml    — the suite total must match the plan's newest confirmed session EXACTLY;
//                           a different number means a file did not load, or the plan was not updated.
//   sweeps after tests    — the three sweeps below are the checks no runner performs: they were each
//                           the cause of a shipped defect that every runner passed.
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const WANT_SQL = args.has("--sql");
const WANT_E2E = args.has("--e2e");
const SKIP_TYPES = args.has("--no-types");
const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";

const report = [];
const summary = [];
const H = (t) => report.push(`\n## ${t}\n`);
const P = (t) => report.push(t);
const CODE = (t) => report.push("```\n" + t.trimEnd() + "\n```");

function run(label, cmd, cmdArgs, { cwd = ROOT, allowFail = false } = {}) {
  H(`${label} — \`${[cmd, ...cmdArgs].join(" ")}\``);
  const t0 = Date.now();
  const r = spawnSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    shell: isWin,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  CODE(out || "(no output)");
  P(`exit ${r.status} · ${secs}s`);
  const ok = r.status === 0;
  summary.push(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` (exit ${r.status})`}`);
  if (!ok && !allowFail) {
    // Keep going: the tester wants the whole picture, not the first red step.
  }
  return { ok, out };
}
const git = (a) => execSync(`git ${a}`, { cwd: ROOT, encoding: "utf8" }).trim();

// ---------------------------------------------------------------- 0. where we are
const head = git("rev-parse --short HEAD");
const branch = git("rev-parse --abbrev-ref HEAD");
const dirty = git("status --porcelain");
const plan = yaml.load(readFileSync(join(ROOT, "docs", "plan.yaml"), "utf8"));
const confirmed = plan.sessions.find((s) => s.confirmed);
const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
report.push(`# Tester run · ${stamp} · ${branch} @ ${head}`);
P(
  `Plan tip: \`${plan.meta.tip}\` · newest confirmed session ${confirmed.id} says ${confirmed.numbers.app_tests} tests in ${confirmed.numbers.app_test_files} files.`,
);
if (dirty) {
  P(
    "⚠️ **The working tree is DIRTY.** The tester tests committed work only; anything below may be measuring uncommitted edits.",
  );
  CODE(dirty);
  summary.push("WARN  working tree dirty — results may include uncommitted edits");
}

// ---------------------------------------------------------------- 1. the plan itself
run("plan validates", "node", ["scripts/render-plan.mjs", "--check"]);

// ---------------------------------------------------------------- 2. generated types, then tsc
if (!SKIP_TYPES) {
  const before = existsSync(join(ROOT, "src/lib/database.types.ts"))
    ? readFileSync(join(ROOT, "src/lib/database.types.ts"), "utf8")
    : "";
  const r = run("db:types (regenerate from the local database)", npm, ["run", "db:types"]);
  const after = readFileSync(join(ROOT, "src/lib/database.types.ts"), "utf8");
  if (r.ok && before !== after) {
    P(
      "⚠️ **`database.types.ts` CHANGED when regenerated.** The committed types did not match the database. That is a finding (doc-drift class) — the developer committed a migration without regenerating, or regenerated against a different stack.",
    );
    CODE(git("diff --stat -- src/lib/database.types.ts"));
    summary.push(
      "WARN  database.types.ts was stale — regenerated copy differs from the committed one",
    );
  } else if (!r.ok) {
    P("db:types failed — is the local Supabase stack running? **tsc below is INCONCLUSIVE.**");
    summary.push("WARN  db:types failed; tsc is inconclusive");
  }
} else {
  H("db:types — SKIPPED (--no-types)");
  P("**tsc below is INCONCLUSIVE**: database.types.ts may not describe the current database.");
  summary.push("WARN  db:types skipped; tsc is inconclusive");
}
run("typecheck", npm, ["run", "typecheck"]);
run("lint", npm, ["run", "lint"]);
run("format:check", npm, ["run", "format:check"]);

// ---------------------------------------------------------------- 3. the suite, and the count
const vitest = run("vitest", npm, ["run", "test"]);
const files = vitest.out.match(/Test Files\s+(\d+) passed \((\d+)\)/);
const tests = vitest.out.match(/Tests\s+(\d+) passed \((\d+)\)/);
H("Suite count vs the plan");
if (!files || !tests) {
  P(
    "Could not find vitest's own total lines in the output. **Do not reason to a number** — read the output above.",
  );
  summary.push("FAIL  vitest total line not found");
} else {
  const nTests = Number(tests[2]);
  const nFiles = Number(files[2]);
  const passedAll = tests[1] === tests[2] && files[1] === files[2];
  P(
    `Runner says: **${nTests} tests in ${nFiles} files**${passedAll ? "" : " — NOT ALL PASSED"}. Plan says ${confirmed.numbers.app_tests} in ${confirmed.numbers.app_test_files}.`,
  );
  if (nTests === confirmed.numbers.app_tests && nFiles === confirmed.numbers.app_test_files) {
    P("Match. Exactly.");
    summary.push(`ok    count matches the plan: ${nTests} in ${nFiles}`);
  } else {
    P(
      "**MISMATCH.** Either a test file did not load, or work landed without a session entry in `docs/plan.yaml`. Find out which before anything else; the last baseline drift went unnoticed for a whole session.",
    );
    summary.push(
      `FAIL  count ${nTests}/${nFiles} ≠ plan ${confirmed.numbers.app_tests}/${confirmed.numbers.app_test_files}`,
    );
  }
}

// ---------------------------------------------------------------- 4. optional runners
if (WANT_SQL) {
  const tests = readdirSync(join(ROOT, "supabase/tests"))
    .filter((f) => /^\d\d_.*\.sql$/.test(f))
    .sort();
  run("sql: rebuild the scratch database", "bash", ["scripts/run-sql-test.sh", "--rebuild"]);
  for (const f of tests) run(`sql: ${f}`, "bash", ["scripts/run-sql-test.sh", f]);
  const upgrades = readdirSync(join(ROOT, "supabase/tests"))
    .filter((f) => /^upgrade_.*\.sql$/.test(f))
    .sort();
  P(
    `Upgrade checks not run by this script (they need a pre-migration database): ${upgrades.join(", ")}. See scripts/verify-db.sh UPGRADE_CHECKS.`,
  );
}
if (WANT_E2E) run("playwright e2e", npm, ["run", "e2e"]);

// ---------------------------------------------------------------- 5. sweeps no runner performs
H("Sweep 1 — columns made NULLABLE since the plan's tip");
P(
  "A migration that drops NOT NULL is a CLIENT change db:types does not surface: the app keeps compiling and starts refusing real rows (§19.76). For each column below, read every guard in `src/` that mentions it.",
);
let newMigrations = [];
try {
  newMigrations = git(`diff --name-only ${plan.meta.tip}..HEAD -- supabase/migrations`)
    .split("\n")
    .filter(Boolean);
} catch {
  P(`Could not diff against \`${plan.meta.tip}\` — is the plan's tip a commit on this branch?`);
}
if (newMigrations.length === 0) P("No migrations since the plan's tip.");
for (const m of newMigrations) {
  const sql = readFileSync(join(ROOT, m), "utf8");
  const drops = [...sql.matchAll(/alter\s+column\s+(\w+)\s+drop\s+not\s+null/gi)].map((x) => x[1]);
  const adds = [...sql.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi)].map(
    (x) => x[1],
  );
  P(
    `- \`${m}\`: DROP NOT NULL on [${drops.join(", ") || "none"}]; ADD COLUMN [${adds.join(", ") || "none"}]`,
  );
  for (const col of drops) {
    const hits = grepSrc(col);
    P(
      `  - \`${col}\` is mentioned in: ${hits.length ? hits.join(", ") : "NOTHING in src/ — either unused or read through a wildcard select; check the parsers"}`,
    );
  }
  if (drops.length)
    summary.push(`READ  ${m} drops NOT NULL on ${drops.join(", ")} — read the client guards`);
}

H("Sweep 2 — dark columns (in the database, read by nothing)");
P(
  "`skills.active`, `operator_skills.certified_at` and `skills.external_id` each shipped and sat unread for weeks. A column in `database.types.ts` that no file under `src/` mentions is one of these.",
);
const typesSrc = readFileSync(join(ROOT, "src/lib/database.types.ts"), "utf8");
const tables = [...typesSrc.matchAll(/^\s{6}(\w+): \{\s*\n\s{8}Row: \{([\s\S]*?)\n\s{8}\}/gm)];
const dark = [];
for (const [, table, body] of tables) {
  for (const [, col] of body.matchAll(/^\s{10}(\w+)\??:/gm)) {
    if (["id", "org_id", "created_at", "updated_at"].includes(col)) continue;
    if (grepSrc(col).length === 0) dark.push(`${table}.${col}`);
  }
}
if (dark.length) {
  P(dark.map((d) => `- \`${d}\``).join("\n"));
  summary.push(
    `READ  ${dark.length} dark column(s): ${dark.slice(0, 6).join(", ")}${dark.length > 6 ? "…" : ""}`,
  );
} else P("None.");

H("Sweep 3 — sentences in the code that may describe a rule the server no longer has");
P(
  "A comment or label saying what the server does is a hypothesis with a date on it (§19.77's `OperatorsPanel` comment was false for a week). Read each hit against the current migrations.",
);
const phrases = [
  "does not yet",
  "not yet refuse",
  "company-wide",
  "no longer",
  "in this release",
  "for now",
  "server does not",
  "the server will",
];
const driftHits = [];
for (const ph of phrases) for (const h of grepSrc(ph, true)) driftHits.push(`${h}  «${ph}»`);
if (driftHits.length) P(driftHits.map((d) => `- ${d}`).join("\n"));
else P("None.");

// ---------------------------------------------------------------- 6. write the report
function grepSrc(needle, withLine = false) {
  const r = spawnSync("git", ["grep", "-n", "-I", "--fixed-strings", "--", needle, "src/"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) return [];
  const lines = r.stdout.split("\n").filter((l) => l && !l.startsWith("src/lib/database.types.ts"));
  if (withLine) return lines.map((l) => l.split(":").slice(0, 2).join(":"));
  return [...new Set(lines.map((l) => l.split(":")[0]))];
}
mkdirSync(join(ROOT, "test-results"), { recursive: true });
const outPath = join(ROOT, "test-results", `tester-run-${stamp}.md`);
report.splice(1, 0, "\n## Summary\n", "```\n" + summary.join("\n") + "\n```");
writeFileSync(outPath, report.join("\n") + "\n");
console.log(summary.join("\n"));
console.log(`\nfull report: ${outPath}`);
process.exit(summary.some((s) => s.startsWith("FAIL")) ? 1 : 0);
