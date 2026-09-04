#!/usr/bin/env node
// scripts/defects-inbox.mjs — the developer's inbox, run automatically at every session start.
//
// Wired as a Claude Code SessionStart hook in .claude/settings.json. Whatever this prints is
// placed in the session's context before the first message, so the merge and the list of open
// defects cannot be skipped by forgetting. CLAUDE.md §1 step 2 says what to do with them.
//
// It does two things and refuses to do either half-way:
//   1. `git merge tester` — if the branch exists and we are not on it. A conflicting merge is
//      ABORTED and reported, never left half-applied in the working tree.
//   2. Print every defect in docs/defects/ whose status is open, reopened or fix-claimed.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFECTS = join(ROOT, "docs", "defects");
const out = [];
const say = (t) => out.push(t);
const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });

const branch = (git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "").trim();
say(`## Defects inbox (session start, branch \`${branch}\`)`);

if (branch === "tester") {
  say("This is the tester's worktree; nothing to merge. The tester merges Development itself.");
} else if (git(["rev-parse", "--verify", "--quiet", "refs/heads/tester"]).status !== 0) {
  say("No `tester` branch exists yet; nothing to merge.");
} else if ((git(["status", "--porcelain"]).stdout || "").trim()) {
  say(
    "⚠️ Working tree is DIRTY, so `git merge tester` was NOT attempted (a merge onto uncommitted " +
      "work is how files get lost). Commit or stash, then run `git merge tester` yourself.",
  );
} else {
  const m = git(["merge", "--no-edit", "tester"]);
  const text = (m.stdout + m.stderr).trim();
  if (m.status === 0) {
    say(
      /Already up to date/i.test(text)
        ? "`git merge tester`: already up to date."
        : "`git merge tester`: merged.\n```\n" + text + "\n```",
    );
  } else {
    git(["merge", "--abort"]);
    say(
      "⚠️ `git merge tester` CONFLICTED and was aborted; the tree is as it was. Run it by hand — " +
        "the conflict is almost always both sides adding a session entry at the top of " +
        "`docs/plan.yaml`: keep both, newest first, then `npm run plan -- --check`.\n```\n" +
        text +
        "\n```",
    );
  }
}

const files = existsSync(DEFECTS)
  ? readdirSync(DEFECTS)
      .filter((f) => /^DEF-\d{4}\.md$/.test(f))
      .sort()
  : [];
const open = [];
for (const f of files) {
  const raw = readFileSync(join(DEFECTS, f), "utf8");
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const status = fm && (fm[1].match(/^status:\s*(\S+)/m) || [])[1];
  if (["open", "reopened", "fix-claimed"].includes(status)) open.push({ f, raw, status });
}

if (open.length === 0) {
  say("**No open defects.** Say so to the maintainer in one line and carry on with the queue.");
} else {
  say(
    `**${open.length} defect${open.length === 1 ? "" : "s"} need${open.length === 1 ? "s" : ""} attention.** ` +
      "Per CLAUDE.md §1 step 2: before touching any code, tell the maintainer, for each one, in " +
      "plain language — what a user would see go wrong, which rule it breaks (by title), what the " +
      "tester suspects (as a suspicion) — and whether you agree. Fix-claimed ones are waiting on " +
      "the tester, not on you.",
  );
  for (const d of open) {
    say(`\n### ${d.f} — ${d.status}\n`);
    say(d.raw.length > 6000 ? d.raw.slice(0, 6000) + "\n…(truncated; read the file)" : d.raw);
  }
}

process.stdout.write(out.join("\n") + "\n");
