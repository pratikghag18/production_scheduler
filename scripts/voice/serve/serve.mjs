#!/usr/bin/env node
// scripts/voice/serve/serve.mjs — S44-a: starts the llama.cpp server
// container beside the database, serving the fine-tuned voice model on
// http://127.0.0.1:8089 (R-393, design §19.92 / D121). Runs in the
// foreground like `npm run dev` -- Ctrl+C stops the container the same way
// stopping the dev server stops Vite. `--stop` is the other half: it stops
// a container left running from a previous foreground run without needing
// the same terminal.
//
// S57-a (brief docs/agent-briefs/s57-a-whisper-brief.md §1, design-plan
// §19.102 / D131): the SAME command also starts a second container,
// `scheduler-whisper`, running whisper.cpp's server on 127.0.0.1:8090 for
// the command bar's local (non-browser) microphone recogniser. `--stop`
// stops both. Whichever piece (the model's `.gguf`, whisper's own model
// file, or its docker image) is missing on this machine, the OTHER service
// still starts -- a machine mid-setup for one never loses the other.
//
// `npm run voice:serve [-- --model <path-to-gguf> | <path-to-gguf>] [--whisper-model <name>] [--stop]`
//
// Model path, in order: `--model <path>` or the bare positional argument
// (either form), else `VOICE_MODEL`, else `data/voice/model/scheduler-voice.gguf`
// (S44-a brief §3 step 1; that default path is gitignored -- .gitignore --
// and is where the README under this directory tells the maintainer to
// copy the S43 model file).
import { existsSync, statSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WHISPER_IMAGE_TAG } from "./build-whisper-image.mjs";

const CONTAINER_NAME = "scheduler-voice";
const HOST_PORT = 8089;
const CONTAINER_PORT = 8080;
const IMAGE = "ghcr.io/ggml-org/llama.cpp:server";
const DEFAULT_MODEL_PATH = fileURLToPath(
  new URL("../../../data/voice/model/scheduler-voice.gguf", import.meta.url),
);

// S57-a: `WHISPER_IMAGE_TAG` is this machine's own locally-built image
// (`npm run voice:whisper:build`, scripts/voice/serve/build-whisper-
// image.mjs) -- the published `ghcr.io/ggml-org/whisper.cpp:main-arm64`
// raises SIGILL here (that file's own header comment has the story); that
// script's sanity check is what proved this tag runs on this machine.
const WHISPER_CONTAINER_NAME = "scheduler-whisper";
const WHISPER_HOST_PORT = 8090;
const WHISPER_CONTAINER_PORT = 8080;
const WHISPER_MODEL_DIR = fileURLToPath(new URL("../../../data/voice/whisper", import.meta.url));
const DEFAULT_WHISPER_MODEL = "base.en";

function parseArgs(argv) {
  const out = {
    modelPath: null,
    stop: false,
    whisperModel: DEFAULT_WHISPER_MODEL,
    whisperOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stop") out.stop = true;
    else if (a === "--model") out.modelPath = argv[++i];
    else if (a === "--whisper-model") out.whisperModel = argv[++i];
    // S57-a: not part of the ordinary `npm run voice:serve` path -- for
    // standing up just the whisper container by hand (a second lane already
    // owns `scheduler-voice`, e.g. while testing this file's whisper half
    // without disturbing it).
    else if (a === "--whisper-only") out.whisperOnly = true;
    else if (!out.modelPath && !a.startsWith("--")) out.modelPath = a;
    else throw new Error(`serve.mjs: unknown argument "${a}"`);
  }
  return out;
}

function resolveModelPath(cliPath) {
  if (cliPath) return resolve(cliPath);
  if (process.env.VOICE_MODEL) return resolve(process.env.VOICE_MODEL);
  return DEFAULT_MODEL_PATH;
}

// Forward slashes even on Windows -- Docker Desktop's Linux VM (this
// machine runs linux/arm64 containers) rejects a `C:\...` bind-mount
// source with backslashes; `docker run -v` wants POSIX-style paths on
// every platform it runs on.
function toDockerBindPath(winPath) {
  const resolved = resolve(winPath).replace(/\\/g, "/");
  // `C:/…` -> `/c/…` is Docker Desktop's usual WSL2-backed convention, but
  // plain `docker run -v` on Windows also accepts the drive-letter form
  // (`C:/…`) directly -- kept as the drive-letter form here since that is
  // what `docker run -v <path>:/dest` actually documents accepting on
  // Windows, and it is what this machine's Docker Desktop (linux/arm64)
  // resolves correctly.
  return resolved;
}

function stopContainer(name) {
  console.log(`stopping container "${name}" (if running) ...`);
  try {
    execFileSync("docker", ["stop", name], { stdio: "inherit" });
  } catch {
    // not running, or already gone -- `--stop` stopping both containers
    // should not fail just because only one of them was up.
  }
}

function imageExistsLocally(tag) {
  try {
    execFileSync("docker", ["image", "inspect", tag], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(url, { timeoutMs = 120_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet, or still pulling the image
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** S57-a: starts `scheduler-whisper` if its model file and its docker image
 *  are both on this machine; otherwise prints one line saying why not and
 *  returns `null` -- the model service above is unaffected either way.
 *  `entrypoint` is `["bash","-c"]` on the image this builds against
 *  (whisper.cpp's own `.devops/main.Dockerfile`), which takes its command as
 *  ONE string argument, not an argv array -- extra `docker run` positional
 *  args after the image name become `bash -c`'s `$0 $1 ...`, silently
 *  dropped rather than passed to the program (found by hand while proving
 *  §0: the container started and even loaded a model -- the one baked into
 *  the image's own `/app/models`, not the mounted one -- while `--host`/
 *  `--port` stayed at their `127.0.0.1:8080` defaults, unreachable through
 *  the published port). Joining the whole command into one string avoids it. */
function startWhisper(whisperModelName) {
  const modelPath = resolve(WHISPER_MODEL_DIR, `ggml-${whisperModelName}.bin`);
  if (!existsSync(modelPath)) {
    console.log(
      `local recogniser not started: ${modelPath} is missing -- run ` +
        `"npm run voice:whisper:fetch${whisperModelName === DEFAULT_WHISPER_MODEL ? "" : ` -- ${whisperModelName}`}" first.`,
    );
    return null;
  }
  if (!imageExistsLocally(WHISPER_IMAGE_TAG)) {
    console.log(
      `local recogniser not started: docker image "${WHISPER_IMAGE_TAG}" is not built on this ` +
        `machine -- run "npm run voice:whisper:build" first (scripts/voice/serve/build-whisper-image.mjs).`,
    );
    return null;
  }

  const bindDir = toDockerBindPath(WHISPER_MODEL_DIR);
  const whisperUrl = `http://127.0.0.1:${WHISPER_HOST_PORT}`;
  const command = [
    "/app/build/bin/whisper-server",
    "-m",
    `/models/ggml-${whisperModelName}.bin`,
    "--host",
    "0.0.0.0",
    "--port",
    String(WHISPER_CONTAINER_PORT),
    "-l",
    "en",
  ].join(" ");

  console.log(`model: ${modelPath} (${(statSync(modelPath).size / 1e6).toFixed(1)} MB)`);
  console.log(
    `starting "${WHISPER_CONTAINER_NAME}" -- ${whisperUrl} -> container :${WHISPER_CONTAINER_PORT}`,
  );

  const dockerArgs = [
    "run",
    "--rm",
    "--name",
    WHISPER_CONTAINER_NAME,
    "-p",
    `127.0.0.1:${WHISPER_HOST_PORT}:${WHISPER_CONTAINER_PORT}`,
    "-v",
    `${bindDir}:/models:ro`,
    WHISPER_IMAGE_TAG,
    command,
  ];
  const child = spawn("docker", dockerArgs, { stdio: "inherit" });

  waitForHealth(`${whisperUrl}/health`).then((healthy) => {
    if (healthy) {
      console.log(`${whisperUrl} -- healthy (GET /health OK)`);
    } else {
      console.log(
        `${whisperUrl}/health did not answer within the wait -- check the container output above.`,
      );
    }
  });

  return child;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.stop) {
    stopContainer(CONTAINER_NAME);
    stopContainer(WHISPER_CONTAINER_NAME);
    return;
  }

  if (args.whisperOnly) {
    const whisperChild = startWhisper(args.whisperModel);
    if (!whisperChild) process.exit(1);
    whisperChild.on("exit", (code) => process.exit(code ?? 0));
    process.on("SIGINT", () => {
      try {
        execFileSync("docker", ["stop", WHISPER_CONTAINER_NAME], { stdio: "ignore" });
      } catch {
        // already stopping, or already gone
      }
    });
    return;
  }

  const modelPath = resolveModelPath(args.modelPath);
  // Review finding: this used to `process.exit(1)` right here when the
  // model file was missing, before `startWhisper` below was ever called --
  // so a machine set up for whisper only (its model file and image present,
  // the fine-tuned `.gguf` not yet copied in) lost BOTH services on `npm run
  // voice:serve`, contradicting this file's own header comment and
  // design-plan §19.102 D131 §4 ("Whichever piece ... is missing on this
  // machine, the OTHER service still starts -- a machine mid-setup for one
  // never loses the other"). Only print-and-skip the model here; still try
  // `startWhisper` below, and exit non-zero only if NEITHER could start.
  const modelPresent = existsSync(modelPath);
  let child = null;
  let url = null;
  if (!modelPresent) {
    console.log(
      `The voice model file is not at ${modelPath}. Copy the fine-tuned GGUF from S43 there ` +
        `(for example data/voice/runs/third-run/model-q4_k_m.gguf) -- or pass its path as the ` +
        `first argument to this script, or set VOICE_MODEL to it -- then run this again. ` +
        `The model service was not started; the local recogniser (below) starts on its own.`,
    );
  } else {
    const modelDir = dirname(modelPath);
    const modelFile = basename(modelPath);
    const bindDir = toDockerBindPath(modelDir);

    url = `http://127.0.0.1:${HOST_PORT}`;
    console.log(`model: ${modelPath} (${(statSync(modelPath).size / 1e9).toFixed(2)} GB)`);
    console.log(`starting "${CONTAINER_NAME}" -- ${url} -> container :${CONTAINER_PORT}`);
    console.log("first start pulls the image; that can take a few minutes.");

    const dockerArgs = [
      "run",
      "--rm",
      "--name",
      CONTAINER_NAME,
      "-p",
      `${HOST_PORT}:${CONTAINER_PORT}`,
      "-v",
      `${bindDir}:/models:ro`,
      IMAGE,
      "-m",
      `/models/${modelFile}`,
      "--host",
      "0.0.0.0",
      "--port",
      String(CONTAINER_PORT),
      "--jinja",
      "-c",
      "2048",
      "-np",
      "1",
      "--reasoning-budget",
      "0",
      "--cache-reuse",
      "256",
    ];

    child = spawn("docker", dockerArgs, { stdio: "inherit" });

    waitForHealth(`${url}/health`).then((healthy) => {
      if (healthy) {
        console.log(`${url}  -- healthy (GET /health OK)`);
        console.log(`probe it: npm run voice:probe -- "put Ana Silva on Housing A tomorrow"`);
      } else {
        console.log(
          `${url}/health did not answer within the wait -- check the container output above.`,
        );
      }
    });
  }

  const whisperChild = startWhisper(args.whisperModel);

  if (!child && !whisperChild) {
    console.log("Neither service could be started. Docker was not started.");
    process.exit(1);
  }

  let exiting = false;
  function exitOnce(code) {
    if (exiting) return;
    exiting = true;
    process.exit(code ?? 0);
  }
  if (child) child.on("exit", (code) => exitOnce(code));
  if (whisperChild) whisperChild.on("exit", (code) => exitOnce(code));

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      // Ctrl+C: `--rm` cleans the container(s) up once `docker run`'s own
      // SIGINT handling stops them; nothing else to do here but let the
      // child's exit propagate above.
      if (child) {
        try {
          execFileSync("docker", ["stop", CONTAINER_NAME], { stdio: "ignore" });
        } catch {
          // already stopping, or already gone
        }
      }
      if (whisperChild) {
        try {
          execFileSync("docker", ["stop", WHISPER_CONTAINER_NAME], { stdio: "ignore" });
        } catch {
          // already stopping, or already gone
        }
      }
    });
  }
}

main();
