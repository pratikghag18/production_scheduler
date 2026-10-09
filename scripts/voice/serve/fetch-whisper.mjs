#!/usr/bin/env node
// scripts/voice/serve/fetch-whisper.mjs — S57-a (brief
// docs/agent-briefs/s57-a-whisper-brief.md §0, design-plan §19.102 / D131):
// downloads whisper.cpp's own English model into `data/voice/whisper/`
// (gitignored), so the README's step for it is one command, the same shape
// as `npm run voice:serve` for the fine-tuned model.
//
//   npm run voice:whisper:fetch [-- small.en]
//
// The bare positional argument names the model (`base.en`, `small.en`, ...);
// default `base.en`, the one `npm run voice:serve` expects unless
// `--whisper-model` says otherwise. A plain `fetch` to a file, a printed
// progress line, and a size check against the server's own `content-length`
// -- no external download tool, matching whisper.cpp's own published names
// (`ggml-<model>.bin`) under https://huggingface.co/ggerganov/whisper.cpp.
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const MODEL_DIR = fileURLToPath(new URL("../../../data/voice/whisper", import.meta.url));
const BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const DEFAULT_MODEL = "base.en";

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  return { model: positional[0] ?? DEFAULT_MODEL };
}

function formatMB(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

async function fetchModel(model) {
  const fileName = `ggml-${model}.bin`;
  const url = `${BASE_URL}/${fileName}`;
  const dest = `${MODEL_DIR}/${fileName}`;

  mkdirSync(MODEL_DIR, { recursive: true });
  if (existsSync(dest)) {
    console.log(`${dest} already exists (${formatMB(statSync(dest).size)}) -- not re-downloading.`);
    console.log(`Delete it first to fetch again.`);
    return;
  }

  console.log(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    // Drain/cancel the body before throwing -- an unread response stream
    // left dangling on process exit crashes Node's libuv on Windows here
    // (an assertion in async.c), not just leaks a handle.
    await res.body?.cancel();
    throw new Error(`fetch-whisper.mjs: ${url} -> ${res.status} ${res.statusText}`);
  }
  const contentLength = Number(res.headers.get("content-length") ?? 0);
  if (contentLength > 0) console.log(`size: ${formatMB(contentLength)}`);

  const tmpDest = `${dest}.part`;
  const out = createWriteStream(tmpDest);
  let downloaded = 0;
  let lastPrintedAt = Date.now();

  const reader = Readable.fromWeb(res.body);
  reader.on("data", (chunk) => {
    downloaded += chunk.length;
    const now = Date.now();
    if (now - lastPrintedAt >= 1000) {
      lastPrintedAt = now;
      const pct = contentLength > 0 ? ` (${((downloaded / contentLength) * 100).toFixed(0)}%)` : "";
      console.log(`  ${formatMB(downloaded)}${pct}`);
    }
  });

  try {
    await finished(reader.pipe(out));
  } catch (err) {
    unlinkSync(tmpDest);
    throw err;
  }

  const finalSize = statSync(tmpDest).size;
  if (contentLength > 0 && finalSize !== contentLength) {
    unlinkSync(tmpDest);
    throw new Error(
      `fetch-whisper.mjs: downloaded ${finalSize} bytes but the server said ${contentLength} -- ` +
        `deleted the partial file; try again.`,
    );
  }

  renameSync(tmpDest, dest);
  console.log(`done: ${dest} (${formatMB(finalSize)})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fetchModel(args.model);
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  // Not `process.exit(1)`: an abrupt exit right after a `fetch()` call
  // crashes libuv on this machine's Node build (Windows on Snapdragon,
  // v24.16.0) -- "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" --
  // while a keep-alive socket handle is still closing. `exitCode` lets the
  // event loop drain first and still exits non-zero.
  process.exitCode = 1;
});
