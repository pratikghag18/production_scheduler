#!/usr/bin/env node
// scripts/voice/serve/serve.mjs — S44-a: starts the llama.cpp server
// container beside the database, serving the fine-tuned voice model on
// http://127.0.0.1:8089 (R-393, design §19.92 / D121). Runs in the
// foreground like `npm run dev` -- Ctrl+C stops the container the same way
// stopping the dev server stops Vite. `--stop` is the other half: it stops
// a container left running from a previous foreground run without needing
// the same terminal.
//
// `npm run voice:serve [-- --model <path-to-gguf> | <path-to-gguf>] [--stop]`
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

const CONTAINER_NAME = "scheduler-voice";
const HOST_PORT = 8089;
const CONTAINER_PORT = 8080;
const IMAGE = "ghcr.io/ggml-org/llama.cpp:server";
const DEFAULT_MODEL_PATH = fileURLToPath(
  new URL("../../../data/voice/model/scheduler-voice.gguf", import.meta.url),
);

function parseArgs(argv) {
  const out = { modelPath: null, stop: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stop") out.stop = true;
    else if (a === "--model") out.modelPath = argv[++i];
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

function stopContainer() {
  console.log(`stopping container "${CONTAINER_NAME}" ...`);
  const result = spawn("docker", ["stop", CONTAINER_NAME], { stdio: "inherit" });
  result.on("exit", (code) => process.exit(code ?? 0));
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

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.stop) {
    stopContainer();
    return;
  }

  const modelPath = resolveModelPath(args.modelPath);
  if (!existsSync(modelPath)) {
    console.log(
      `The voice model file is not at ${modelPath}. Copy the fine-tuned GGUF from S43 there ` +
        `(for example data/voice/runs/third-run/model-q4_k_m.gguf) -- or pass its path as the ` +
        `first argument to this script, or set VOICE_MODEL to it -- then run this again. ` +
        `Docker was not started.`,
    );
    process.exit(1);
  }

  const modelDir = dirname(modelPath);
  const modelFile = basename(modelPath);
  const bindDir = toDockerBindPath(modelDir);

  const url = `http://127.0.0.1:${HOST_PORT}`;
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

  const child = spawn("docker", dockerArgs, { stdio: "inherit" });

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

  child.on("exit", (code) => process.exit(code ?? 0));

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      // Ctrl+C: `--rm` cleans the container up once `docker run`'s own
      // SIGINT handling stops it; nothing else to do here but let the
      // child's exit propagate above.
      try {
        execFileSync("docker", ["stop", CONTAINER_NAME], { stdio: "ignore" });
      } catch {
        // already stopping, or already gone
      }
    });
  }
}

main();
