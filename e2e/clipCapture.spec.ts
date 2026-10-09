/**
 * S71-f / R-453 (session 190, 23 Sept 2026): a clip the bar posts to Whisper is
 * kept under data/voice/trace/clips with its numbers -- proved in a real
 * browser against the running dev server, because the unit pins hand the bar
 * a bare recogniser and the board hands it one wrapped by `withFallback`,
 * which dropped the clip event (F-208) through two walks while every pin
 * stayed green.
 *
 * The microphone is a synthetic tone: `getUserMedia` is replaced before the
 * page loads with a stream from an oscillator that plays for three seconds,
 * so the recogniser hears "speech", ends the clip on the silence after it,
 * posts the WAV to Whisper and, through the fixed wrapper, to `/__clip`.
 *
 * Skipped without the local stack, and skipped when the dev server's Whisper
 * proxy has nothing behind it (`npm run voice:serve` not running): the bar
 * only posts a clip when a recogniser answers. The spec removes its own clip
 * and manifest line afterwards so the maintainer's folder is left as found.
 */
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON, e2eBaseUrl } from "./env";
import { PASSWORD, PLANT_A_ADMIN } from "./walk/db";

const MANIFEST = path.resolve("data/voice/trace/clips/manifest.jsonl");
const CLIPS_DIR = path.resolve("data/voice/trace/clips");

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`/sign-in?redirect=${encodeURIComponent("/")}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });
}

async function manifestLines(): Promise<string[]> {
  try {
    const raw = await readFile(MANIFEST, "utf8");
    return raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

async function whisperIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${e2eBaseUrl}/whisper/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

test("CC-1: a spoken clip is kept under data/voice/trace/clips with its numbers (S71-f, F-208)", async ({
  page,
}) => {
  test.skip(!hasRealBackend, NO_BACKEND_REASON);
  test.skip(!(await whisperIsUp()), "no Whisper behind the dev server's /whisper proxy");
  // Whisper on this machine can take half a minute for a short clip when the
  // CPU is busy; the clip only reaches /__clip after Whisper has answered.
  test.setTimeout(240_000);

  const before = await manifestLines();
  const startedAt = Date.now();

  await page.addInitScript(() => {
    const fake = async (): Promise<MediaStream> => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.3;
      const dest = ctx.createMediaStreamDestination();
      osc.frequency.value = 220;
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      osc.stop(ctx.currentTime + 3);
      await ctx.resume();
      return dest.stream;
    };
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: fake, enumerateDevices: async () => [] },
      configurable: true,
    });
  });

  let clipPosted = false;
  page.on("response", (res) => {
    if (res.url().includes("/__clip") && res.status() === 204) clipPosted = true;
  });

  await signIn(page, PLANT_A_ADMIN);
  await expect(page.getByRole("button", { name: "Tell the board" })).toBeVisible({
    timeout: 20_000,
  });
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  // R-451: Ctrl+M opens the bar and presses the mic.
  await page.keyboard.press("Control+m");
  await expect(page.getByRole("dialog", { name: "Tell the board" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "Speak a sentence" })).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 10_000 },
  );

  await expect.poll(() => clipPosted, { timeout: 200_000, intervals: [1000] }).toBe(true);
  await expect
    .poll(async () => (await manifestLines()).length, { timeout: 20_000, intervals: [500] })
    .toBeGreaterThan(before.length);

  const after = await manifestLines();
  const added = after.slice(before.length).map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(added.length).toBeGreaterThanOrEqual(1);
  const line = added[0];
  expect(Date.parse(String(line.at))).toBeGreaterThanOrEqual(startedAt - 1000);
  // Three seconds of tone ended by the silence rule: a whole clip, speech
  // detected, well above the loudness floor.
  expect(line.endedBy).toBe("silence");
  expect(line.speechStarted).toBe(true);
  expect(Number(line.durationMs)).toBeGreaterThan(2500);
  expect(Number(line.peakRms)).toBeGreaterThan(0.08);

  // Leave the maintainer's folder as it was.
  for (const l of added) {
    try {
      await unlink(path.join(CLIPS_DIR, String(l.file)));
    } catch {
      /* already gone */
    }
  }
  await writeFile(MANIFEST, before.length ? before.join("\n") + "\n" : "");
});
