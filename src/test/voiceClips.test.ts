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
): { req: ClipRequestLike; res: ClipResponseLike & { ended: boolean } } {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = { data: [], end: [] };
  const reqImpl = {
    method,
    url,
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

function clipUrl(at: string, over: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    at,
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
      file: "2026-09-23T00-00-00.000Z.wav",
      durationMs: 1500,
      recordedMs: 1500,
      endedBy: "silence",
      speechStarted: true,
      peakRms: 0.31,
      meanRms: 0.09,
      framesAboveFloor: 4,
      heard: null,
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

  it("CS-4: the 501st clip evicts the oldest -- the directory and the manifest agree at MAX_CLIPS", async () => {
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
  }, 20000);

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
