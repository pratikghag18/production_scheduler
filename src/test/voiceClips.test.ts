/**
 * S71-c (brief docs/agent-briefs/s71-c-clip-harness-brief.md §1.G, R-453):
 * pins the pure half of the clip scorer alone -- the normaliser (am/pm,
 * spelled numbers, ordinal dates), word error rate, and name hits --
 * imported straight from the `.mjs` lib the same way `voiceData.test.ts`
 * imports `scripts/voice/lib/score.mjs`. `scripts/voice/clips/score.mjs`
 * itself is all I/O (a whisper.cpp POST and two file writes) and is proved
 * by hand against the running container instead (brief §2).
 */
import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Buffer } from "node:buffer";
import { normalizeText, wordErrorRate, nameHits } from "../../scripts/voice/clips/lib/score.mjs";
import {
  peakAmplitude,
  peakNormalizeGain,
  applyGain,
} from "../../scripts/voice/clips/lib/wavGain.mjs";
import {
  handleClipRequest,
  MAX_CLIPS,
  type ClipRequestLike,
  type ClipResponseLike,
} from "@/lib/voice/clipServer";

describe("VCLIP: scripts/voice/clips/lib/score.mjs (S71-c brief §1.G)", () => {
  it("VCLIP-1: a.m., dotted, normalises to am", () => {
    expect(normalizeText("Assign at 8 a.m. today")).toBe("assign at 8 am today");
  });

  it("VCLIP-2: a m, spaced, normalises to am", () => {
    expect(normalizeText("meet at 8 a m today")).toBe("meet at 8 am today");
  });

  it("VCLIP-3: p.m., dotted, and pm glued to a digit, both normalise to a spaced pm", () => {
    expect(normalizeText("end at 2 p.m.")).toBe("end at 2 pm");
    // Reviewer finding: "2pm" is one run of word characters (digits and
    // letters are both \w), so no \b ever sat between them -- the dotted
    // rule above never fired and "2pm" was left glued, scoring a WER of
    // 2.0 against "2 p.m.". It must split and normalise the same way.
    expect(normalizeText("end at 2pm")).toBe("end at 2 pm");
  });

  it("VCLIP-4: spelled numbers one..twelve become digits", () => {
    expect(normalizeText("book three people on cell two for eleven hours")).toBe(
      "book 3 people on cell 2 for 11 hours",
    );
  });

  it("VCLIP-5: a hyphenated ordinal word (twenty-eighth) becomes a digit", () => {
    expect(normalizeText("on September twenty-eighth")).toBe("on september 28");
  });

  it("VCLIP-6: a digit ordinal (28th) drops its suffix", () => {
    expect(normalizeText("move it to the 28th")).toBe("move it to the 28");
  });

  it("VCLIP-7: WER of an exact match is 0", () => {
    expect(wordErrorRate("clear Cell 4 today", "clear Cell 4 today")).toBe(0);
  });

  it("VCLIP-8: WER of an empty hypothesis against a non-empty reference is 1", () => {
    expect(wordErrorRate("clear Cell 4 today", "")).toBe(1);
  });

  it("VCLIP-9: WER counts one deleted word out of the reference's length", () => {
    expect(wordErrorRate("the quick brown fox", "the quick fox")).toBeCloseTo(0.25);
  });

  it("VCLIP-10: name hits count only names present in the reference, missing one misheard", () => {
    const reference = "Assign Sam Patel to Housing A. End John Kim's block at 2pm.";
    const hypothesis = "Assign Sam Patel to Housing A. End Jon Kim's block at 2pm.";
    const result = nameHits(reference, hypothesis, ["Sam Patel", "John Kim"]);
    expect(result).toEqual({ hits: 1, total: 2, missed: ["John Kim"] });
  });

  it("VCLIP-11: 8am, 8 a.m., 8 AM and eight am all normalise the same", () => {
    const forms = ["8am", "8 a.m.", "8 AM", "eight am"];
    for (const form of forms) expect(normalizeText(form)).toBe("8 am");
    for (const form of forms) expect(wordErrorRate("8am", form)).toBe(0);
  });

  it("VCLIP-12: 12pm and 12 p.m. normalise the same", () => {
    expect(normalizeText("12pm")).toBe("12 pm");
    expect(normalizeText("12 p.m.")).toBe("12 pm");
    expect(wordErrorRate("12pm", "12 p.m.")).toBe(0);
  });

  it("VCLIP-13: Sam Patel's and Sam Patels normalise the same (no dangling word)", () => {
    expect(normalizeText("Sam Patel's")).toBe("sam patels");
    expect(normalizeText("Sam Patels")).toBe("sam patels");
    expect(wordErrorRate("Sam Patel's", "Sam Patels")).toBe(0);
  });
});

/**
 * S71-k (brief docs/agent-briefs/s71-k-clip-file-collision-and-gain-brief.md,
 * F-210/R-453): `lib/wavGain.mjs`'s pure sample maths, driven against tiny
 * hand-built WAV buffers -- the same canonical RIFF/WAVE/fmt/data header
 * `record.mjs`'s own `encodeWav16k` writes (16-bit PCM, mono), plus
 * (reviewer finding) buffers with a non-canonical layout `wavGain.mjs` must
 * still read correctly or refuse clearly: an extra chunk before "data", and
 * a header naming a bit depth or channel count it does not support.
 */
function buildWav(samples: number[], sampleRate = 16000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buffer;
}

function readInt16Samples(buffer: Buffer): number[] {
  const dataSize = buffer.readUInt32LE(40);
  const count = dataSize / 2;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(buffer.readInt16LE(44 + i * 2));
  return out;
}

/** Builds a WAV with a caller-chosen `fmt ` (channels, bit depth) and,
 *  optionally, one extra chunk inserted BEFORE "data" (e.g. a `LIST`/`INFO`
 *  chunk some encoders add) -- reviewer finding: `wavGain.mjs` must locate
 *  "data" by walking chunks, not by assuming it always starts at byte 44.
 *  Independent of `buildWav`/`readInt16Samples` above (which both still
 *  assume the canonical fixed layout) on purpose -- this is what proves the
 *  real chunk walk, not the fixed-offset shortcut. */
function buildWavCustom(opts: {
  numChannels?: number;
  bitsPerSample?: number;
  sampleRate?: number;
  samples?: number[]; // 16-bit LE samples; ignored if `dataBytes` given instead
  dataBytes?: number; // a filler data chunk of this many zero bytes
  extraChunk?: { id: string; body: Buffer };
}): Buffer {
  const numChannels = opts.numChannels ?? 1;
  const bitsPerSample = opts.bitsPerSample ?? 16;
  const sampleRate = opts.sampleRate ?? 16000;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;

  let dataBuf: Buffer;
  if (opts.samples) {
    dataBuf = Buffer.alloc(opts.samples.length * 2);
    for (let i = 0; i < opts.samples.length; i++) dataBuf.writeInt16LE(opts.samples[i], i * 2);
  } else {
    dataBuf = Buffer.alloc(opts.dataBytes ?? 8);
  }

  const fmtChunk = Buffer.alloc(8 + 16);
  fmtChunk.write("fmt ", 0, "ascii");
  fmtChunk.writeUInt32LE(16, 4);
  fmtChunk.writeUInt16LE(1, 8); // audioFormat: PCM
  fmtChunk.writeUInt16LE(numChannels, 10);
  fmtChunk.writeUInt32LE(sampleRate, 12);
  fmtChunk.writeUInt32LE(byteRate, 16);
  fmtChunk.writeUInt16LE(blockAlign, 20);
  fmtChunk.writeUInt16LE(bitsPerSample, 22);

  let extraChunkBuf = Buffer.alloc(0);
  if (opts.extraChunk) {
    const { id, body } = opts.extraChunk;
    const pad = body.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
    const sizeField = Buffer.alloc(4);
    sizeField.writeUInt32LE(body.length, 0);
    extraChunkBuf = Buffer.concat([Buffer.from(id, "ascii"), sizeField, body, pad]);
  }

  const dataChunkHeader = Buffer.alloc(8);
  dataChunkHeader.write("data", 0, "ascii");
  dataChunkHeader.writeUInt32LE(dataBuf.length, 4);

  const body = Buffer.concat([fmtChunk, extraChunkBuf, dataChunkHeader, dataBuf]);
  const riffHeader = Buffer.alloc(12);
  riffHeader.write("RIFF", 0, "ascii");
  riffHeader.writeUInt32LE(4 + body.length, 4);
  riffHeader.write("WAVE", 8, "ascii");

  return Buffer.concat([riffHeader, body]);
}

/** Reads samples back by walking chunks itself (mirrors `wavGain.mjs`'s own
 *  walk, independently -- deliberately NOT calling into the module under
 *  test) so VCLIP-18 proves the samples landed in the right place, not just
 *  that some peak number moved. */
function readInt16SamplesAnyLayout(buffer: Buffer): number[] {
  let offset = 12;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    offset = offset + 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error("test helper: no data chunk found");
  const count = Math.floor(dataSize / 2);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(buffer.readInt16LE(dataOffset + i * 2));
  return out;
}

describe("wavGain: scripts/voice/clips/lib/wavGain.mjs (S71-k, F-210, R-453)", () => {
  it("VCLIP-14: a factor of 2 doubles every sample (well under the clipping ceiling)", () => {
    const wav = buildWav([1000, -1000, 2000, -3000]);
    const gained = applyGain(wav, 2);
    expect(readInt16Samples(gained)).toEqual([2000, -2000, 4000, -6000]);
  });

  it("VCLIP-15: peak-normalise lands the clip's own peak on the target", () => {
    const wav = buildWav([8192, -4000, 2000]); // peak is the 8192 sample
    const target = 0.5;
    const factor = peakNormalizeGain(wav, target);
    const gained = applyGain(wav, factor);
    expect(peakAmplitude(gained)).toBeCloseTo(target, 3);
  });

  it("VCLIP-16: a factor large enough to overdrive clips at the +-1 ceiling, never past it", () => {
    const wav = buildWav([5000, -5000, 100]);
    const gained = applyGain(wav, 100);
    expect(peakAmplitude(gained)).toBe(1);
    const samples = readInt16Samples(gained);
    expect(samples[0]).toBe(32767); // the true positive int16 extreme
    expect(samples[1]).toBe(-32768); // the true negative int16 extreme
  });

  it("VCLIP-17: a silent clip is unchanged -- peak-normalise gain is 1, applyGain leaves every sample 0", () => {
    const wav = buildWav([0, 0, 0, 0]);
    expect(peakNormalizeGain(wav, 0.5)).toBe(1);
    const gained = applyGain(wav, 3);
    expect(readInt16Samples(gained)).toEqual([0, 0, 0, 0]);
    expect(peakAmplitude(gained)).toBe(0);
  });

  // Reviewer finding: a fixed 44-byte offset assumed the exact chunk layout
  // `encodeWav16k` happens to write. A `LIST`/`INFO` chunk before "data" is
  // ordinary in WAVs from other encoders/editors -- `wavGain.mjs` must walk
  // chunks to find "data" wherever it actually is.
  it("VCLIP-18: a WAV with an extra chunk before data is scaled correctly", () => {
    const wav = buildWavCustom({
      samples: [1000, -1000, 2000, -3000],
      extraChunk: { id: "LIST", body: Buffer.from("INFOsome junk metadata here", "ascii") },
    });
    const gained = applyGain(wav, 2);
    expect(readInt16SamplesAnyLayout(gained)).toEqual([2000, -2000, 4000, -6000]);
  });

  // Reviewer finding: anything not 16-bit PCM mono must be refused with a
  // clear message naming what was wrong, not silently misread as if it
  // were.
  it("VCLIP-19: a 24-bit or stereo header is refused with a message naming what was wrong", () => {
    const wav24 = buildWavCustom({ bitsPerSample: 24, dataBytes: 12 });
    expect(() => peakAmplitude(wav24)).toThrow(/only 16-bit PCM WAV is supported, got 24-bit/);
    expect(() => applyGain(wav24, 2)).toThrow(/only 16-bit PCM WAV is supported, got 24-bit/);

    const wavStereo = buildWavCustom({ numChannels: 2, dataBytes: 8 });
    expect(() => peakAmplitude(wavStereo)).toThrow(/only mono WAV is supported, got 2 channel/);
    expect(() => applyGain(wavStereo, 2)).toThrow(/only mono WAV is supported, got 2 channel/);
  });
});

/**
 * S71-f (brief docs/agent-briefs/s71-f-clip-capture-brief.md §1.C/§1.E,
 * R-453/R-434): `src/lib/voice/clipServer.ts`'s own handler, driven with a
 * fake request and response (no Vite, no real HTTP) -- the same pattern
 * `traceServer.test.ts` uses for `handleTraceRequest`, except the body here
 * is raw binary (a WAV clip), not a JSON string.
 */
function fakeClipReqRes(
  method: string,
  url: string,
  body: Buffer,
  headers: Record<string, string> = {},
): { req: ClipRequestLike; res: ClipResponseLike & { ended: boolean } } {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = { data: [], end: [] };
  const reqImpl = {
    method,
    url,
    headers,
    on(event: "data" | "end", listener: (...args: unknown[]) => void) {
      listeners[event].push(listener);
      if (event === "end") {
        for (const dataListener of listeners.data) dataListener(body);
        for (const endListener of listeners.end) endListener();
      }
      return reqImpl;
    },
  };
  const req = reqImpl as unknown as ClipRequestLike;
  const res: ClipResponseLike & { ended: boolean } = {
    statusCode: 200,
    ended: false,
    end() {
      this.ended = true;
    },
  };
  return { req, res };
}

// S71-k (F-209, R-453): `postedAt` defaults to `at` so every pre-existing
// call site below (a single clip, one POST) keeps naming its file exactly
// as it did before this change -- only a test that needs two DISTINCT
// clips sharing one `at` (CS-12) passes its own `postedAt` via `over`.
function clipUrl(at: string, over: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    at,
    postedAt: at,
    durationMs: "1500",
    recordedMs: "1500",
    endedBy: "silence",
    speechStarted: "true",
    peakRms: "0.31",
    meanRms: "0.09",
    framesAboveFloor: "4",
    ...over,
  });
  return `/__clip?${params.toString()}`;
}

describe("clipServer: handleClipRequest (S71-f, R-453, R-434)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-server-test-"));
  const clipsDir = path.join(tmpDir, "clips");
  const manifestPath = path.join(clipsDir, "manifest.jsonl");

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it("CS-1: POST writes the wav file and appends the manifest line, heard always null, and answers 204", async () => {
    const wav = Buffer.from([1, 2, 3, 4]);
    const { req, res } = fakeClipReqRes("POST", clipUrl("2026-09-23T00:00:00.000Z"), wav);
    await handleClipRequest(req, res, clipsDir, manifestPath);

    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    const written = fs.readFileSync(path.join(clipsDir, "2026-09-23T00-00-00.000Z.wav"));
    expect(Buffer.compare(written, wav)).toBe(0);

    const lines = fs
      .readFileSync(manifestPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toEqual({
      at: "2026-09-23T00:00:00.000Z",
      postedAt: "2026-09-23T00:00:00.000Z",
      file: "2026-09-23T00-00-00.000Z.wav",
      durationMs: 1500,
      recordedMs: 1500,
      endedBy: "silence",
      speechStarted: true,
      peakRms: 0.31,
      meanRms: 0.09,
      framesAboveFloor: 4,
      heard: null,
      hint: null,
    });
  });

  it("CS-2: anything but POST answers 405 and writes nothing", async () => {
    const { req, res } = fakeClipReqRes(
      "GET",
      clipUrl("2026-09-23T00:00:00.000Z"),
      Buffer.alloc(0),
    );
    await handleClipRequest(req, res, clipsDir, manifestPath);
    expect(res.statusCode).toBe(405);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it("CS-3: a POST with no ?at answers 400 and writes nothing", async () => {
    const { req, res } = fakeClipReqRes("POST", "/__clip", Buffer.from([9]));
    await handleClipRequest(req, res, clipsDir, manifestPath);
    expect(res.statusCode).toBe(400);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  // F-217 (24 Sept): five hundred and one file writes take 20 s on a busy machine,
  // past the runner's default budget; this case carries its own minute.
  it(
    "CS-4: the 501st clip evicts the oldest -- the directory and the manifest agree at MAX_CLIPS",
    { timeout: 60_000 },
    async () => {
      expect(MAX_CLIPS).toBe(500);
      for (let i = 0; i < MAX_CLIPS; i++) {
        // S71-f review fix: `at` must be a valid ISO-8601 UTC instant now
        // (`ISO_AT_RE`) -- minutes/seconds roll over properly rather than
        // letting the seconds field run past two digits (i >= 100 used to
        // produce a 3-digit seconds field, which the new validation, quite
        // correctly, now refuses).
        const minutes = Math.floor(i / 60);
        const seconds = i % 60;
        const at = `2026-01-01T00:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.000Z`;
        const { req, res } = fakeClipReqRes("POST", clipUrl(at), Buffer.from([i % 256]));
        await handleClipRequest(req, res, clipsDir, manifestPath);
        expect(res.statusCode).toBe(204);
      }
      let lines = fs
        .readFileSync(manifestPath, "utf8")
        .split("\n")
        .filter((l) => l !== "");
      expect(lines).toHaveLength(MAX_CLIPS);
      const firstEntry = JSON.parse(lines[0]);
      expect(firstEntry.at).toBe("2026-01-01T00:00:00.000Z");
      expect(fs.existsSync(path.join(clipsDir, firstEntry.file))).toBe(true);

      // The 501st clip: the oldest (index 0) is evicted -- both its manifest
      // line and its .wav file.
      const at501 = "2026-01-01T00:08:20.500Z";
      const { req, res } = fakeClipReqRes("POST", clipUrl(at501), Buffer.from([9]));
      await handleClipRequest(req, res, clipsDir, manifestPath);
      expect(res.statusCode).toBe(204);

      lines = fs
        .readFileSync(manifestPath, "utf8")
        .split("\n")
        .filter((l) => l !== "");
      expect(lines).toHaveLength(MAX_CLIPS);
      const ats = lines.map((l) => JSON.parse(l).at);
      expect(ats).not.toContain("2026-01-01T00:00:00.000Z");
      expect(ats).toContain(at501);
      expect(fs.existsSync(path.join(clipsDir, firstEntry.file))).toBe(false);
    },
    20000,
  );

  // S71-f review fix (path traversal): `at` used to reach `join(dir, file)`
  // with only its colons replaced -- a traversal segment survived straight
  // through to the filesystem, writing (and answering 204 for) a file
  // outside `clipsDir`. `at` is now checked against a strict ISO-8601 UTC
  // shape before anything is built from it; CS-5/6/7 are the reviewer's own
  // three shapes, CS-8 the write-failure/500 half of the same fix.

  it("CS-5: an at containing ../ is refused with 400, nothing written (path traversal)", async () => {
    const { req, res } = fakeClipReqRes("POST", clipUrl("../../evil"), Buffer.from([1]));
    await handleClipRequest(req, res, clipsDir, manifestPath);
    expect(res.statusCode).toBe(400);
    expect(fs.existsSync(manifestPath)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "evil.wav"))).toBe(false);
  });

  it("CS-6: an otherwise-ISO at with a trailing traversal segment is refused with 400, nothing written", async () => {
    const at = "2026-09-23T00:00:00.000Z/../../evil2";
    const { req, res } = fakeClipReqRes("POST", clipUrl(at), Buffer.from([1]));
    await handleClipRequest(req, res, clipsDir, manifestPath);
    expect(res.statusCode).toBe(400);
    expect(fs.existsSync(manifestPath)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "evil2.wav"))).toBe(false);
  });

  it("CS-7: an oversized (300-char) at is refused with 400, nothing written", async () => {
    const at = "2".repeat(300);
    const { req, res } = fakeClipReqRes("POST", clipUrl(at), Buffer.from([1]));
    await handleClipRequest(req, res, clipsDir, manifestPath);
    expect(res.statusCode).toBe(400);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it("CS-8: a genuine write failure answers 500, not 204", async () => {
    // Forces `mkdir(dir, { recursive: true })` to fail -- `dir` walks
    // through a REGULAR FILE, not a directory (ENOTDIR), not merely an
    // already-existing one.
    const blockerFile = path.join(tmpDir, "blocked-file");
    fs.writeFileSync(blockerFile, "not a directory");
    const blockedDir = path.join(blockerFile, "clips");
    const blockedManifest = path.join(blockedDir, "manifest.jsonl");

    const { req, res } = fakeClipReqRes(
      "POST",
      clipUrl("2026-09-23T00:00:00.000Z"),
      Buffer.from([1]),
    );
    await handleClipRequest(req, res, blockedDir, blockedManifest);
    expect(res.statusCode).toBe(500);
  });

  // S71-h (R-453, brief docs/agent-briefs/s71-h-replay-uses-the-apps-hint-
  // brief.md §2): the hint travels as the `x-clip-hint` header, URL-encoded
  // (`postClip`'s own doing) -- decoded back and written into the manifest
  // line, or `null` when the header was never sent at all.
  it("CS-9: a POST with the x-clip-hint header writes the decoded hint in the manifest", async () => {
    const wav = Buffer.from([1, 2, 3, 4]);
    const encoded = encodeURIComponent("assign, cell, put on, Sam Patel, café");
    const { req, res } = fakeClipReqRes("POST", clipUrl("2026-09-23T00:00:00.000Z"), wav, {
      "x-clip-hint": encoded,
    });
    await handleClipRequest(req, res, clipsDir, manifestPath);
    expect(res.statusCode).toBe(204);

    const lines = fs
      .readFileSync(manifestPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const entry = JSON.parse(lines[0]);
    expect(entry.hint).toBe("assign, cell, put on, Sam Patel, café");
  });

  it("CS-9b: a POST with no x-clip-hint header writes hint: null", async () => {
    const wav = Buffer.from([1, 2, 3, 4]);
    const { req, res } = fakeClipReqRes("POST", clipUrl("2026-09-23T00:00:01.000Z"), wav);
    await handleClipRequest(req, res, clipsDir, manifestPath);
    expect(res.statusCode).toBe(204);

    const lines = fs
      .readFileSync(manifestPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.hint).toBeNull();
  });

  // S71-h review: "the hint must never cost the clip" -- a bad hint header
  // no longer 400s the whole request; the clip is written exactly as normal
  // and the manifest line says the hint was dropped instead.
  it("CS-10: an over-long x-clip-hint header (over 16 KB) writes the clip normally, hint null, hintDropped true", async () => {
    const wav = Buffer.from([1, 2, 3, 4]);
    const overLong = "a".repeat(16385);
    const { req, res } = fakeClipReqRes("POST", clipUrl("2026-09-23T00:00:02.000Z"), wav, {
      "x-clip-hint": overLong,
    });
    await handleClipRequest(req, res, clipsDir, manifestPath);
    expect(res.statusCode).toBe(204);

    const written = fs.readFileSync(path.join(clipsDir, "2026-09-23T00-00-02.000Z.wav"));
    expect(Buffer.compare(written, wav)).toBe(0);
    const lines = fs
      .readFileSync(manifestPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.hint).toBeNull();
    expect(entry.hintDropped).toBe(true);
  });

  it("CS-10b: a malformed percent-encoded x-clip-hint header writes the clip normally, hint null, hintDropped true", async () => {
    const wav = Buffer.from([1, 2, 3, 4]);
    const { req, res } = fakeClipReqRes("POST", clipUrl("2026-09-23T00:00:03.000Z"), wav, {
      "x-clip-hint": "%E0%A4%A",
    });
    await handleClipRequest(req, res, clipsDir, manifestPath);
    expect(res.statusCode).toBe(204);

    const written = fs.readFileSync(path.join(clipsDir, "2026-09-23T00-00-03.000Z.wav"));
    expect(Buffer.compare(written, wav)).toBe(0);
    const lines = fs
      .readFileSync(manifestPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.hint).toBeNull();
    expect(entry.hintDropped).toBe(true);
  });

  it("CS-11: a 200-word space-free hint (single-token entries, well under the 16 KB cap) round-trips intact", async () => {
    const words = Array.from(
      { length: 200 },
      (_, i) => `CODE-${String(i).padStart(3, "0")}-STATION`,
    );
    const hint = words.join(" ");
    expect(hint.split(/\s+/).filter(Boolean)).toHaveLength(200);
    const encoded = encodeURIComponent(hint);
    expect(encoded.length).toBeLessThanOrEqual(16384);

    const wav = Buffer.from([1, 2, 3, 4]);
    const { req, res } = fakeClipReqRes("POST", clipUrl("2026-09-23T00:00:04.000Z"), wav, {
      "x-clip-hint": encoded,
    });
    await handleClipRequest(req, res, clipsDir, manifestPath);
    expect(res.statusCode).toBe(204);

    const lines = fs
      .readFileSync(manifestPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.hint).toBe(hint);
    expect(entry.hintDropped).toBeUndefined();
  });

  // S71-k (F-209, R-453): an answer continues its sentence's trace entry
  // rather than opening a new one (`CommandBar.tsx`), so two POSTs can share
  // one `at` -- the sentence's own clip and the "yes"/"no" that answered
  // its question. Naming the file from `at` let the second POST silently
  // overwrite the first's .wav on disk (two manifest lines, one file). The
  // fix names the file from `postedAt` -- each POST's own instant -- instead.
  it("CS-12: two POSTs sharing one at (a sentence, then the answer that continued it) write two files and two manifest lines, both readable", async () => {
    const at = "2026-09-23T20:41:41.045Z";
    const sentencePostedAt = "2026-09-23T20:41:28.525Z";
    const answerPostedAt = "2026-09-23T20:41:41.045Z";
    const wavSentence = Buffer.from([1, 1, 1, 1]);
    const wavAnswer = Buffer.from([2, 2, 2, 2]);

    const { req: req1, res: res1 } = fakeClipReqRes(
      "POST",
      clipUrl(at, { postedAt: sentencePostedAt }),
      wavSentence,
    );
    await handleClipRequest(req1, res1, clipsDir, manifestPath);
    expect(res1.statusCode).toBe(204);

    const { req: req2, res: res2 } = fakeClipReqRes(
      "POST",
      clipUrl(at, { postedAt: answerPostedAt }),
      wavAnswer,
    );
    await handleClipRequest(req2, res2, clipsDir, manifestPath);
    expect(res2.statusCode).toBe(204);

    const sentenceFile = fs.readFileSync(path.join(clipsDir, "2026-09-23T20-41-28.525Z.wav"));
    const answerFile = fs.readFileSync(path.join(clipsDir, "2026-09-23T20-41-41.045Z.wav"));
    expect(Buffer.compare(sentenceFile, wavSentence)).toBe(0);
    expect(Buffer.compare(answerFile, wavAnswer)).toBe(0);

    const lines = fs
      .readFileSync(manifestPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    const entries = lines.map((l) => JSON.parse(l));
    expect(entries.every((e) => e.at === at)).toBe(true);
    expect(entries[0].file).not.toBe(entries[1].file);
    expect(entries[0].postedAt).toBe(sentencePostedAt);
    expect(entries[1].postedAt).toBe(answerPostedAt);
  });

  it("CS-13: postedAt is present in the manifest line and ISO, and a malformed postedAt is refused with 400", async () => {
    const wav = Buffer.from([1, 2, 3]);
    const { req, res } = fakeClipReqRes("POST", clipUrl("2026-09-23T00:00:05.000Z"), wav);
    await handleClipRequest(req, res, clipsDir, manifestPath);
    expect(res.statusCode).toBe(204);
    const lines = fs
      .readFileSync(manifestPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.postedAt).toBe("2026-09-23T00:00:05.000Z");
    expect(entry.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const before = fs
      .readFileSync(manifestPath, "utf8")
      .split("\n")
      .filter((l) => l !== "").length;
    const { req: badReq, res: badRes } = fakeClipReqRes(
      "POST",
      clipUrl("2026-09-23T00:00:06.000Z", { postedAt: "not-a-date" }),
      wav,
    );
    await handleClipRequest(badReq, badRes, clipsDir, manifestPath);
    expect(badRes.statusCode).toBe(400);
    const after = fs
      .readFileSync(manifestPath, "utf8")
      .split("\n")
      .filter((l) => l !== "").length;
    expect(after).toBe(before); // the bad postedAt refused the request; nothing written
  });
});

describe("S71-f review", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-server-review-"));
  const clipsDir = path.join(tmpDir, "clips");
  const manifestPath = path.join(clipsDir, "manifest.jsonl");

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it("review-4: a non-ISO at is refused or safely contained", async () => {
    const wav = Buffer.from([2]);
    const { req, res } = fakeClipReqRes("POST", clipUrl("not-a-date"), wav);
    await handleClipRequest(req, res, clipsDir, manifestPath);
    if (res.statusCode === 204) {
      const files = fs.readdirSync(clipsDir).filter((f) => f.endsWith(".wav"));
      expect(files).toContain("not-a-date.wav");
    }
  });
});

describe("S71-h review", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-server-s71h-review-"));
  const clipsDir = path.join(tmpDir, "clips");
  const manifestPath = path.join(clipsDir, "manifest.jsonl");

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  // review-1: `buildRecognizerHint`'s own 200-word cap (recognizerHint.ts
  // `capAtWords`) counts whitespace-separated TOKENS, not characters -- a
  // single board entry with no internal space (a cell/part/station code,
  // common in manufacturing: "LINE-3-CELL-07-STATION") counts as ONE word
  // no matter how long it is. A plant with ~150 such codes around 20-25
  // characters each -- entirely ordinary, not adversarial -- produces a
  // legitimate 200-word hint whose URL-encoded form exceeds the OLD
  // 4096-char header cap, so `handleClipRequest` used to 400 a real clip
  // from a real board over it. This reproduces the break through the real
  // production hint builder and the real server handler, not a synthetic
  // string -- kept as the regression pin, expectation flipped to the fix:
  // the raised 16384-char cap comfortably covers this realistic worst case
  // (encoded well under 16384, still over the old 4096), so it now round-
  // trips intact, hint present, nothing dropped, and -- per "the hint must
  // never cost the clip" -- even a hint that DID exceed the new cap would
  // still answer 204 with the clip written (CS-10 covers that shape).
  it("review-1: a realistic 200-word hint (single-token 20-25 char plant codes) round-trips intact under the raised 16384 cap", async () => {
    const { buildRecognizerHint } = await import("@/lib/voice/recognizerHint");
    const cells = Array.from(
      { length: 200 },
      (_, i) => `LINE-${(i % 9) + 1}-CELL-${String(i).padStart(2, "0")}-STATION`,
    );
    const hint = buildRecognizerHint({ cells, places: [], parts: [], people: [] });
    const wordCount = hint.split(/\s+/).filter(Boolean).length;
    expect(wordCount).toBeLessThanOrEqual(200); // the app's own documented cap held

    const encoded = encodeURIComponent(hint);
    // Still the realistic worst case the review found: past the OLD 4096
    // cap, comfortably under the NEW 16384 one.
    expect(encoded.length).toBeGreaterThan(4096);
    expect(encoded.length).toBeLessThanOrEqual(16384);

    const wav = Buffer.from([9]);
    const { req, res } = fakeClipReqRes("POST", clipUrl("2026-09-23T00:00:09.000Z"), wav, {
      "x-clip-hint": encoded,
    });
    await handleClipRequest(req, res, clipsDir, manifestPath);
    // The clip is written, and the app's own real hint survives intact.
    expect(res.statusCode).toBe(204);
    const lines = fs
      .readFileSync(manifestPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.hint).toBe(hint);
    expect(entry.hintDropped).toBeUndefined();
  });
});

describe("S71-k review", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-server-s71k-review-"));
  const clipsDir = path.join(tmpDir, "clips");
  const manifestPath = path.join(clipsDir, "manifest.jsonl");

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  // review-1 (fixed): two POSTs that happen to carry the SAME postedAt (a
  // fast answer landing in the same millisecond as its sentence's own clip,
  // or two concurrent posts) used to collide on one file -- `postedAt`
  // alone moved the collision from `at`, it did not remove it. Fix:
  // `uniqueFileName` (clipServer.ts) suffixes the stem with `-2`, `-3`, ...
  // until it finds a name nothing on disk has claimed yet, and that actual
  // name is what gets written into the manifest line -- so two files, two
  // manifest lines, both readable, neither overwriting the other.
  it("review-1: two POSTs with the same postedAt write two files, not one -- the second gets a -2 suffix", async () => {
    const at = "2026-09-23T20:41:41.045Z";
    const postedAt = "2026-09-23T20:41:41.045Z"; // identical on both requests
    const wavA = Buffer.from([1, 1, 1, 1]);
    const wavB = Buffer.from([2, 2, 2, 2]);

    const { req: req1, res: res1 } = fakeClipReqRes("POST", clipUrl(at, { postedAt }), wavA);
    await handleClipRequest(req1, res1, clipsDir, manifestPath);
    const { req: req2, res: res2 } = fakeClipReqRes("POST", clipUrl(at, { postedAt }), wavB);
    await handleClipRequest(req2, res2, clipsDir, manifestPath);

    expect(res1.statusCode).toBe(204);
    expect(res2.statusCode).toBe(204);

    const files = fs.readdirSync(clipsDir).filter((f) => f.endsWith(".wav"));
    expect(files).toHaveLength(2); // both POSTs kept their own file

    const lines = fs
      .readFileSync(manifestPath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    const entries = lines.map((l) => JSON.parse(l));
    expect(entries[0].file).not.toBe(entries[1].file); // two distinct names now
    expect(entries[1].file).toBe("2026-09-23T20-41-41.045Z-2.wav"); // the disambiguated one

    const onDiskA = fs.readFileSync(path.join(clipsDir, entries[0].file));
    const onDiskB = fs.readFileSync(path.join(clipsDir, entries[1].file));
    expect(Buffer.compare(onDiskA, wavA)).toBe(0); // A intact, never overwritten
    expect(Buffer.compare(onDiskB, wavB)).toBe(0); // B in its own -2 file
  });
});
