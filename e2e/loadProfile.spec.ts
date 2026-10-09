import { mkdirSync, writeFileSync } from "node:fs";
import { test, expect, type CDPSession } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON } from "./env";

/**
 * ⭐⭐ THE PROFILER, NOT A FOURTH GUESS (F-125, session 117).
 *
 * `loadSanity.spec.ts` measures HOW LONG a plant-sized board takes to arrive
 * (~17s, of which under a second is the server) and says nothing about WHY.
 * Two guesses about the why were wrong in one day (F-124's policy resolver;
 * "the client is innocent"), so this spec asks Chrome instead: a sampling CPU
 * profile over the plant switch, and the renderer's own layout/style counters
 * before and after. It prints the functions that own the time, by self time
 * and by inclusive time, and the split between script, layout and style --- and
 * writes the raw `.cpuprofile` beside the report so a person can open it in
 * DevTools (Performance panel > load profile) and look for themselves.
 *
 * ⛔ SAME FIXTURE RULE AS loadSanity.spec.ts: needs `scripts/load/fixture.sql`
 * in the database this run is pointed at, and SKIPS honestly when it is absent.
 * It reads only; nothing here writes a row, so there is nothing to put back.
 *
 * ⚠️ IT ASSERTS NOTHING ABOUT SPEED. It is an instrument. The one assertion is
 * that the board rendered, so a profile of a board that never arrived cannot be
 * mistaken for a profile of one that did.
 */
test.skip(!hasRealBackend, NO_BACKEND_REASON);

const ADMIN = "admin@example.test";
const PASSWORD = "devpassword";

/** The shape `Profiler.stop` returns, narrowed to what the aggregation reads. */
type CpuProfile = {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
    children?: number[];
  }[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
};

type Row = { key: string; selfMs: number; totalMs: number };

/**
 * Self time per node from the samples, inclusive time by walking children,
 * then both folded by (function, file:line) so the same function reached by
 * different paths is one row. Times in ms.
 */
function aggregate(profile: CpuProfile): { rows: Row[]; totalMs: number } {
  const selfUs = new Map<number, number>();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const totalUs = new Map<number, number>();
  const inclusive = (id: number): number => {
    const known = totalUs.get(id);
    if (known !== undefined) return known;
    const n = byId.get(id);
    let t = selfUs.get(id) ?? 0;
    for (const c of n?.children ?? []) t += inclusive(c);
    totalUs.set(id, t);
    return t;
  };
  const rows = new Map<string, Row>();
  for (const n of profile.nodes) {
    const f = n.callFrame;
    const file = f.url === "" ? "" : ` ${shortUrl(f.url)}:${f.lineNumber + 1}`;
    const key = `${f.functionName || "(anonymous)"}${file}`;
    const row = rows.get(key) ?? { key, selfMs: 0, totalMs: 0 };
    row.selfMs += (selfUs.get(n.id) ?? 0) / 1000;
    // Inclusive time double-counts recursion (a function under itself); for a
    // "who owns the wait" reading that is the honest answer, not a bug.
    row.totalMs += inclusive(n.id) / 1000;
    rows.set(key, row);
  }
  const totalMs = [...selfUs.values()].reduce((a, b) => a + b, 0) / 1000;
  return { rows: [...rows.values()], totalMs };
}

function shortUrl(url: string): string {
  // "http://localhost:5174/src/features/board/lib/geometry.ts?t=123" -> "src/features/board/lib/geometry.ts"
  // "http://localhost:5174/node_modules/.vite/deps/react-dom_client.js?v=abc" -> "node_modules/.vite/deps/react-dom_client.js"
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return url;
  }
}

function fmt(ms: number): string {
  return ms.toFixed(0).padStart(7);
}

function table(title: string, rows: Row[], pick: (r: Row) => number, totalMs: number, n = 25) {
  const top = [...rows].sort((a, b) => pick(b) - pick(a)).slice(0, n);
  const lines = [`  ${title}`, `  ${"ms".padStart(7)}   ${"%".padStart(5)}   function  file:line`];
  for (const r of top) {
    const ms = pick(r);
    lines.push(`  ${fmt(ms)}   ${((100 * ms) / totalMs).toFixed(1).padStart(5)}   ${r.key}`);
  }
  return lines.join("\n");
}

/** Chromium's renderer counters, the ones that split "script" from "layout". */
async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

test("where a plant-sized board spends its seconds arriving", async ({ page }, testInfo) => {
  test.setTimeout(240_000);

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(ADMIN);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 30_000 });

  const picker = page.getByRole("combobox", { name: "Which place to show" });
  await expect(picker).toBeVisible({ timeout: 30_000 });
  const options = await picker
    .locator("option")
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  if (!options.includes("load_plant")) {
    console.log(
      "\n  SKIPPED: the volume fixture is not in this database.\n" +
        "  Apply it with scripts/load/fixture.sql (on a stack of your own -- R-366), re-run,\n" +
        "  then remove it with scripts/load/teardown.sql.\n",
    );
    test.skip();
    return;
  }

  // A fresh page, and NOT already on the big plant, so the switch below is a
  // real cold arrival rather than a cache hit (loadSanity.spec.ts learned both
  // of these the hard way).
  await page.goto("/");
  await expect(picker).toBeVisible({ timeout: 60_000 });
  if ((await picker.inputValue()) === "load_plant") {
    await picker.selectOption(options.find((o) => o !== "load_plant")!);
    await page.goto("/");
    await expect(picker).toBeVisible({ timeout: 60_000 });
  }

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Profiler.enable");
  // 500us: fine enough that a 17-second wait yields ~30k samples, coarse
  // enough that the sampler itself does not become the thing measured.
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 });

  const before = await metrics(cdp);
  await cdp.send("Profiler.start");
  const t0 = Date.now();
  const responded = page
    .waitForResponse((r) => r.url().includes("board_window"), { timeout: 180_000 })
    .then(() => Date.now() - t0)
    .catch(() => -1);
  await picker.selectOption("load_plant");
  const rpcMs = await responded;
  await expect(page.getByLabel(/^Cell 1-1-1 track/).first()).toBeVisible({ timeout: 180_000 });
  const wallMs = Date.now() - t0;
  const { profile } = await cdp.send("Profiler.stop");
  const after = await metrics(cdp);

  const prof = profile as unknown as CpuProfile;
  const { rows, totalMs } = aggregate(prof);
  const d = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
  const sec = (k: string) => `${(d(k) * 1000).toFixed(0)} ms`;

  const outDir = testInfo.outputDir;
  mkdirSync(outDir, { recursive: true });
  const profilePath = `${outDir}/plant-arrival.cpuprofile`;
  writeFileSync(profilePath, JSON.stringify(profile));

  // Where the sampled time went, by file, so "is it the app or the framework"
  // is answered before any function is named.
  const byFile = new Map<string, number>();
  for (const r of rows) {
    const file = r.key.includes(" ")
      ? r.key.slice(r.key.indexOf(" ") + 1).replace(/:\d+$/, "")
      : "(native/program)";
    byFile.set(file, (byFile.get(file) ?? 0) + r.selfMs);
  }
  const fileRows: Row[] = [...byFile].map(([key, selfMs]) => ({ key, selfMs, totalMs: selfMs }));

  console.log(
    [
      "",
      `  plant arrival                   ${wallMs} ms wall, of which ${rpcMs} ms was the board_window RPC`,
      `  sampled CPU on the main thread  ${totalMs.toFixed(0)} ms across ${prof.samples.length} samples`,
      `  renderer counters (delta)       script ${sec("ScriptDuration")} · layout ${sec("LayoutDuration")} in ${d("LayoutCount")} layouts · style ${sec("RecalcStyleDuration")} in ${d("RecalcStyleCount")} recalcs · tasks ${sec("TaskDuration")}`,
      `  DOM nodes now                   ${after.Nodes ?? "?"} (was ${before.Nodes ?? "?"})`,
      `  raw profile                     ${profilePath}`,
      "",
      table("BY FILE, self time", fileRows, (r) => r.selfMs, totalMs, 15),
      "",
      table("BY FUNCTION, self time (where the CPU actually was)", rows, (r) => r.selfMs, totalMs),
      "",
      table(
        "BY FUNCTION, inclusive time (who owns the wait; recursion double-counts)",
        rows,
        (r) => r.totalMs,
        totalMs,
      ),
      "",
    ].join("\n"),
  );

  // The only thing that is not a matter of taste: it rendered.
  expect(wallMs).toBeGreaterThan(0);
});
