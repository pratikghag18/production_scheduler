#!/usr/bin/env node
// scripts/db-start.mjs — `npm run db:start`: the developer's Supabase stack,
// and the truth about where it listens (R-460, DEF-0059).
//
// A bare `supabase start` publishes Postgres, the API, Studio and the mail
// catcher on every interface, and nothing said so. This starts the stack and
// then reads `docker ps` back: if any of its ports is published beyond the
// loopback address it says which, loudly, and names the firewall rule that
// closes them (scripts/db-firewall.ps1) -- the address a tool prints is the
// address it listens on. It does not refuse a stack a person needs for their
// work. See scripts/lib/loopbackNetwork.mjs for what was tried instead.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractProjectId } from "./lib/testerStack.mjs";
import { beyondLoopbackWarning, publishesBeyondLoopback } from "./lib/loopbackNetwork.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const projectId = extractProjectId(
  readFileSync(join(REPO_ROOT, "supabase", "config.toml"), "utf8"),
);
if (!projectId) {
  console.error("db-start.mjs: supabase/config.toml names no project_id");
  process.exit(1);
}

const started = spawnSync("npx", ["supabase", "start"], {
  cwd: REPO_ROOT,
  stdio: "inherit",
  shell: isWin,
});
if (started.status !== 0) process.exit(started.status ?? 1);

const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"], { encoding: "utf8" });
const beyond = publishesBeyondLoopback(ps.stdout ?? "", projectId);
if (beyond.length > 0) console.error(beyondLoopbackWarning("db-start.mjs", beyond));
else console.log("db-start.mjs: every published port is on 127.0.0.1.");
