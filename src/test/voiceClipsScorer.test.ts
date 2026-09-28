/**
 * S194-C follow-up (DEF-0050, both halves; reviewer, 28 Sept): no vitest file
 * exercised `scripts/voice/clips/score.mjs`'s own input and output before
 * this -- `voiceClips.test.ts` tests only the pure helpers
 * (`normalizeText`/`wordErrorRate`/`nameHits`, `lib/score.mjs`) and says so
 * in its own header comment ("score.mjs itself is ... proved by hand
 * against the running container"). That gap is exactly how DEF-0050's other
 * half shipped: `--from-trace` printed "1 clip(s) scored across 2 entries"
 * over a run that had a 500 in it and exited 0, and nothing caught it.
 *
 * This runs the REAL script, both paths, against a fake Whisper server on a
 * loopback port -- never the project's `data/voice/`, always a scratch
 * directory under the OS temp dir (`mkdtempSync`, the same pattern
 * `voiceTrain.test.ts`'s VT2 already uses for a predictions file).
 *
 * WHY IN-PROCESS, NOT A CHILD PROCESS. `voiceTrain.test.ts`'s VT2 spawns
 * `scripts/voice/score.mjs` for real with `execFileSync` -- but that CLI
 * never opens a socket; it only reads two files. This one has to reach a
 * fake Whisper server over `fetch`, and in THIS sandbox (confirmed with a
 * minimal two-process repro before writing this file: a server in a parent
 * process, a client `fetch` in a `spawnSync`'d child, both on loopback,
 * consistently timed out at the child's own `AbortSignal`, from both the
 * Bash tool and PowerShell) a spawned child cannot reach a socket its
 * parent process opened. So this imports the script directly instead --
 * `score.mjs`'s own top-level `main().catch(...)` is exactly what a shell
 * invocation triggers, so setting `process.argv` first and dynamic-
 * `import()`-ing the file (a CACHE-BUSTED specifier per run -- `?run=...` --
 * since Node's ESM cache would otherwise skip re-running `main()` on a
 * second import of the identical specifier) is the same trigger, one
 * process boundary closer.
 *
 * TWO PIECES OF PROCESS-WIDE STATE THIS FILE OWNS AND CLEANS UP EVERY TIME,
 * IN A `finally`, SO A DELIBERATELY-FAILING CASE HERE NEVER LEAKS INTO
 * VITEST'S OWN RESULT:
 *   - `process.exitCode` -- `score.mjs`'s own `main()` sets it as a side
 *     effect; read into a local return value and reset to `undefined`
 *     (Node's own "no code set" state, which exits 0) right after every run.
 *   - `process.cwd()` -- `--from-trace` reads `data/voice/trace/clips/
 *     manifest.jsonl` and `data/voice/trace/bar.jsonl` off HARD-CODED
 *     relative paths with no flag to point them elsewhere (unlike the
 *     recorded-set path's own `--clips`), so exercising it at all means
 *     `process.chdir()`ing into a scratch directory for exactly the one
 *     `import()` plus its own async tail, and chdir'ing back before this
 *     function returns, success or failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.cwd();
const SCORE_MJS = join(REPO_ROOT, "scripts/voice/clips/score.mjs");
const ORIGINAL_CWD = process.cwd();

function makeWav16kMono(seconds: number): Buffer {
  const sampleRate = 16000;
  const numSamples = Math.floor(seconds * sampleRate);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const v = Math.round(1000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

interface FakeWhisperOpts {
  failOnRequestNumber?: number | null;
  hangOnRequestNumber?: number | null;
}

function startFakeWhisper(opts: FakeWhisperOpts = {}): Promise<Server> {
  const { failOnRequestNumber = null, hangOnRequestNumber = null } = opts;
  let requestCount = 0;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
      return;
    }
    if (req.method === "POST" && req.url === "/inference") {
      requestCount++;
      const n = requestCount;
      if (hangOnRequestNumber !== null && n === hangOnRequestNumber) return; // never respond
      if (failOnRequestNumber !== null && n === failOnRequestNumber) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("internal error");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: `fake transcript for request ${n}` }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise(server));
  });
}

function whisperUrlOf(server: Server): string {
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  return `http://127.0.0.1:${addr.port}`;
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 50));
}

/** Runs the real score.mjs in-process (see the file header for why), waits
 *  for `resultsPath` to exist (the run's own completion signal -- every
 *  case here passes `--label`), and returns its exit code and every
 *  `console.log` line it printed. Cleans up `process.exitCode` always. */
async function runScoreInProcess(
  argv: string[],
  resultsPath: string,
  label: string,
): Promise<{ exitCode: number; lines: string[] }> {
  process.argv = [process.execPath, SCORE_MJS, ...argv];
  process.exitCode = undefined;
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  });
  try {
    await import(`${pathToFileURL(SCORE_MJS).href}?run=${label}-${Date.now()}-${Math.random()}`);
    await waitForFile(resultsPath, 20_000);
  } finally {
    spy.mockRestore();
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = undefined; // never let a deliberate failure case leak into vitest's own exit
  return { exitCode, lines };
}

function clipEntry(at: string, file: string, overrides: Record<string, unknown> = {}) {
  return {
    at,
    postedAt: at,
    file,
    durationMs: 900,
    recordedMs: 900,
    endedBy: "silence",
    speechStarted: true,
    peakRms: 0.09,
    meanRms: 0.03,
    framesAboveFloor: 12,
    heard: null,
    hint: null,
    ...overrides,
  };
}

const scratchDirs: string[] = [];
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  process.exitCode = undefined;
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("VCS: score.mjs, the recorded-set path (--clips)", () => {
  it("one scored, one missing, one failed clip -- summary counts, row status, non-zero exit", async () => {
    const clipsDir = scratchDir("voice-scorer-recorded-");
    writeFileSync(join(clipsDir, "01.wav"), makeWav16kMono(0.3));
    // 02.wav deliberately not written -- the missing clip.
    writeFileSync(join(clipsDir, "03.wav"), makeWav16kMono(0.3));
    writeFileSync(
      join(clipsDir, "manifest.json"),
      JSON.stringify({
        recordedAt: null,
        clips: [
          { n: 1, file: "01.wav", sentence: "clear cell four today" },
          { n: 2, file: "02.wav", sentence: "assign sam patel to cell one" },
          { n: 3, file: "03.wav", sentence: "swap john kim and priya shah" },
        ],
      }),
    );
    // Requests reach Whisper in clip order; 02 is missing so sends none --
    // request #1 is clip 01 (clean), request #2 is clip 03 (fails).
    const server = await startFakeWhisper({ failOnRequestNumber: 2 });
    try {
      const resultsPath = join(clipsDir, "results", "vcs-recorded-mixed.json");
      const { exitCode, lines } = await runScoreInProcess(
        [
          "--whisper",
          whisperUrlOf(server),
          "--no-prompt",
          "--clips",
          clipsDir,
          "--label",
          "vcs-recorded-mixed",
        ],
        resultsPath,
        "vcs-recorded-mixed",
      );

      expect(exitCode).toBe(1);
      const summaryLine = lines.find((l) => l.includes("of 3 scored"));
      expect(summaryLine, lines.join("\n")).toBeTruthy();
      expect(summaryLine).toContain("1 of 3 scored, 1 missing, 1 failed");
      expect(summaryLine).toContain("mean WER over scored clips");

      const results = JSON.parse(readFileSync(resultsPath, "utf8"));
      expect(results.summary).toEqual(
        expect.objectContaining({ listed: 3, scored: 1, missing: 1, failed: 1 }),
      );
      const byN = new Map(results.rows.map((r: { n: number }) => [r.n, r]));
      expect(byN.get(1)).toEqual(expect.objectContaining({ status: "scored" }));
      expect(byN.get(2)).toEqual(expect.objectContaining({ status: "missing" }));
      expect(byN.get(3)).toEqual(
        expect.objectContaining({ status: "failed", message: expect.stringContaining("500") }),
      );
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("an all-clean run scores every clip and exits 0", async () => {
    const clipsDir = scratchDir("voice-scorer-recorded-clean-");
    writeFileSync(join(clipsDir, "01.wav"), makeWav16kMono(0.3));
    writeFileSync(join(clipsDir, "02.wav"), makeWav16kMono(0.3));
    writeFileSync(
      join(clipsDir, "manifest.json"),
      JSON.stringify({
        recordedAt: null,
        clips: [
          { n: 1, file: "01.wav", sentence: "clear cell four today" },
          { n: 2, file: "02.wav", sentence: "assign sam patel to cell one" },
        ],
      }),
    );
    const server = await startFakeWhisper({});
    try {
      const resultsPath = join(clipsDir, "results", "vcs-recorded-clean.json");
      const { exitCode, lines } = await runScoreInProcess(
        [
          "--whisper",
          whisperUrlOf(server),
          "--no-prompt",
          "--clips",
          clipsDir,
          "--label",
          "vcs-recorded-clean",
        ],
        resultsPath,
        "vcs-recorded-clean",
      );
      expect(exitCode).toBe(0);
      expect(lines.find((l) => l.includes("of 2 scored"))).toContain(
        "2 of 2 scored, 0 missing, 0 failed",
      );
      const results = JSON.parse(readFileSync(resultsPath, "utf8"));
      expect(results.summary).toEqual(
        expect.objectContaining({ listed: 2, scored: 2, missing: 0, failed: 0 }),
      );
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("VCS: score.mjs, the --from-trace path", () => {
  function setupTraceCwd(
    prefix: string,
    entries: { entry: ReturnType<typeof clipEntry>; wav: Buffer | null }[],
  ): string {
    const cwd = scratchDir(prefix);
    const clipsDir = join(cwd, "data", "voice", "trace", "clips");
    mkdirSync(clipsDir, { recursive: true });
    for (const { entry, wav } of entries) {
      if (wav !== null) writeFileSync(join(clipsDir, entry.file as string), wav);
    }
    const manifestLines = entries.map(({ entry }) => JSON.stringify(entry)).join("\n");
    writeFileSync(join(clipsDir, "manifest.jsonl"), manifestLines + "\n");
    // No bar.jsonl -- readBarByAt's own doc says "missing entirely is an
    // empty Map, not an error", the ordinary state with no real bar running.
    return cwd;
  }

  // The --timeout 2 clip genuinely waits out its own 2s AbortSignal;
  // vitest's default 5s test timeout leaves too little room beside it, so
  // this case is given its own (the `15_000` at the end of the `it` call).
  it("one scored, one failed (500), one that times out, one missing -- DEF-0050's other half", async () => {
    const entries = [
      { entry: clipEntry("2026-09-28T10:00:00.000Z", "a.wav"), wav: makeWav16kMono(0.3) },
      { entry: clipEntry("2026-09-28T10:01:00.000Z", "b.wav"), wav: makeWav16kMono(0.3) },
      { entry: clipEntry("2026-09-28T10:02:00.000Z", "c.wav"), wav: makeWav16kMono(0.3) },
      { entry: clipEntry("2026-09-28T10:03:00.000Z", "d.wav"), wav: null },
    ];
    const cwd = setupTraceCwd("voice-scorer-trace-mixed-", entries);
    // `runFromTrace` processes newest-`at`-first (S71-k) -- d (missing) sends
    // no request; c is request #1 (clean), b is request #2 (500), a is
    // request #3 (hangs, bounded by --timeout 2).
    const server = await startFakeWhisper({ failOnRequestNumber: 2, hangOnRequestNumber: 3 });
    try {
      const resultsPath = join(
        cwd,
        "data",
        "voice",
        "trace",
        "clips",
        "results",
        "vcs-trace-mixed.json",
      );
      process.chdir(cwd);
      const { exitCode, lines } = await runScoreInProcess(
        [
          "--whisper",
          whisperUrlOf(server),
          "--from-trace",
          "--timeout",
          "2",
          "--label",
          "vcs-trace-mixed",
        ],
        resultsPath,
        "vcs-trace-mixed",
      );
      process.chdir(ORIGINAL_CWD);

      expect(exitCode).toBe(1);
      const summaryLine = lines.find((l) => l.includes("of 4 scored"));
      expect(summaryLine, lines.join("\n")).toBeTruthy();
      expect(summaryLine).toContain("1 of 4 scored, 1 missing, 2 failed");

      const results = JSON.parse(readFileSync(resultsPath, "utf8"));
      expect(results.summary).toEqual(
        expect.objectContaining({ listed: 4, scored: 1, missing: 1, failed: 2 }),
      );
      // `runFromTrace` groups by `at` in manifest order, then processes the
      // OUTER loop newest-first (`order.reverse()`, S71-k -- "entries
      // newest-first"), so the clips are POSTED to Whisper in reverse of
      // this array's own order: d (missing, no request at all), then c
      // (request #1), b (request #2), a (request #3) -- matching
      // failOnRequestNumber/hangOnRequestNumber above.
      const byAt = new Map(results.rows.map((r: { at: string }) => [r.at, r]));
      expect(byAt.get("2026-09-28T10:02:00.000Z")).toEqual(
        expect.objectContaining({ status: "scored" }),
      );
      expect(byAt.get("2026-09-28T10:01:00.000Z")).toEqual(
        expect.objectContaining({ status: "failed", message: expect.stringContaining("500") }),
      );
      expect(byAt.get("2026-09-28T10:00:00.000Z")).toEqual(
        expect.objectContaining({
          status: "failed",
          message: expect.stringContaining("no response within 2000ms"),
        }),
      );
      expect(byAt.get("2026-09-28T10:03:00.000Z")).toEqual(
        expect.objectContaining({ status: "missing" }),
      );
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, 15_000);

  it("an all-clean run exits 0", async () => {
    const entries = [
      { entry: clipEntry("2026-09-28T11:00:00.000Z", "e.wav"), wav: makeWav16kMono(0.3) },
      { entry: clipEntry("2026-09-28T11:01:00.000Z", "f.wav"), wav: makeWav16kMono(0.3) },
    ];
    const cwd = setupTraceCwd("voice-scorer-trace-clean-", entries);
    const server = await startFakeWhisper({});
    try {
      const resultsPath = join(
        cwd,
        "data",
        "voice",
        "trace",
        "clips",
        "results",
        "vcs-trace-clean.json",
      );
      process.chdir(cwd);
      const { exitCode, lines } = await runScoreInProcess(
        ["--whisper", whisperUrlOf(server), "--from-trace", "--label", "vcs-trace-clean"],
        resultsPath,
        "vcs-trace-clean",
      );
      process.chdir(ORIGINAL_CWD);

      expect(exitCode).toBe(0);
      expect(lines.find((l) => l.includes("of 2 scored"))).toContain(
        "2 of 2 scored, 0 missing, 0 failed",
      );
      const results = JSON.parse(readFileSync(resultsPath, "utf8"));
      expect(results.summary).toEqual(
        expect.objectContaining({ listed: 2, scored: 2, missing: 0, failed: 0 }),
      );
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
