#!/usr/bin/env node
// scripts/voice/serve/build-whisper-image.mjs — S57-a brief §0: this
// machine (Windows on Snapdragon, Docker Desktop's linux/arm64) can pull
// `ghcr.io/ggml-org/whisper.cpp:main-arm64` (the arm64 tag whisper.cpp's own
// CI publishes) just fine, but every binary in it raises SIGILL the moment
// it runs here -- `whisper-cli --help`, `whisper-bench --help`, and the
// server all crash the same way. The published arm64 image is built on
// GitHub's own arm64 runners with GGML_NATIVE (ggml's CMake default) tuned
// to THEIR cores, which this machine's Snapdragon cores do not fully share
// (its /proc/cpuinfo has no `sve`, which that image's kernels use
// unconditionally rather than behind a runtime check) -- a cross-machine
// binary problem, not a missing-manifest one.
//
// The fix proven by hand for this brief: clone whisper.cpp and build its own
// `.devops/main.Dockerfile` locally. `cmake`'s GGML_NATIVE then tunes to
// THIS machine's actual cores (no SVE instructions emitted), and the result
// runs `whisper-server --help` cleanly. This script automates exactly that,
// once, the same shape as `npm run voice:whisper:fetch` automates the model
// download -- `npm run voice:whisper:build`.
//
// The clone lives under `data/voice/whisper/src/` (gitignored alongside the
// model file); a second run reuses it (`git pull`) rather than re-cloning.
//
// IMPORTANT (CLAUDE.local.md: "no PowerShell text patching"): the clone MUST
// be made with `core.autocrlf=false`. whisper.cpp's `models/download-ggml-
// model.sh` is a POSIX shell script; Windows git's default `autocrlf=true`
// rewrites its LF endings to CRLF on checkout, and the build stage's `make
// base.en` (run inside the ubuntu:22.04 build container, a real POSIX
// shell) then fails on the embedded `\r` ("$'\r': command not found") before
// it ever reaches the compile step. This bit the first attempt at this
// brief; cloning with `-c core.autocrlf=false` avoided it.
import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const WHISPER_IMAGE_TAG = "scheduler-whisper-server:arm64-local";

const REPO_URL = "https://github.com/ggml-org/whisper.cpp.git";
const SRC_DIR = fileURLToPath(new URL("../../../data/voice/whisper/src", import.meta.url));
const DOCKERFILE = ".devops/main.Dockerfile";

function run(cmd, args, opts) {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function ensureSource() {
  if (existsSync(`${SRC_DIR}/.git`)) {
    console.log(`${SRC_DIR} already exists -- pulling the latest instead of re-cloning.`);
    run("git", ["-c", "core.autocrlf=false", "pull", "--ff-only"], { cwd: SRC_DIR });
    return;
  }
  mkdirSync(fileURLToPath(new URL("../../../data/voice/whisper", import.meta.url)), {
    recursive: true,
  });
  run("git", ["-c", "core.autocrlf=false", "clone", "--depth", "1", REPO_URL, SRC_DIR]);
}

function buildImage(tag) {
  console.log(
    `building ${tag} from ${SRC_DIR}/${DOCKERFILE} (this machine's own CPU baseline) ...`,
  );
  run("docker", ["build", "-f", DOCKERFILE, "-t", tag, "."], { cwd: SRC_DIR });
  console.log(`built ${tag}. Sanity check:`);
  run(
    "docker",
    ["run", "--rm", "--entrypoint", "bash", tag, "-c", "/app/build/bin/whisper-server --help"],
    {
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    },
  );
}

function main() {
  const tag = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? WHISPER_IMAGE_TAG;
  ensureSource();
  buildImage(tag);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
