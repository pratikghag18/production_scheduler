import { test, expect } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON } from "./env";

/**
 * ⭐⭐ THE HALF OF LOAD SANITY A DATABASE CANNOT ANSWER (F-124, session 107).
 *
 * `scripts/load-sanity.sh` measures the SERVER: a plant-sized `board_window` is
 * 2.1-2.7s and 7.3 MB, four fifths of it row-level security asked once per row.
 * It also measures the pure client work on that payload -- JSON.parse 30ms,
 * parseBoardWindow 25ms, buildBoardIndex 64ms. What neither can reach is what a
 * person actually waits for: React rendering 384 tracks, and `computeFitScale`
 * measuring and re-measuring real element heights to fit the window. jsdom
 * reports every height as 0, so that last one cannot be faked -- it needs a
 * browser, which is what this is.
 *
 * ⛔ IT NEEDS THE VOLUME FIXTURE IN THE DATABASE THE APP IS POINTED AT, which is
 * the developer's own. `scripts/load/fixture.sql` adds a plant called "Load
 * Plant" and 420 `LOAD-%` operators and touches nothing else;
 * `scripts/load/teardown.sql` removes exactly those. This spec SKIPS when the
 * fixture is absent rather than failing, because it is a measurement rather than
 * a promise -- and because leaving 11,520 rows in a dev database permanently, so
 * a test can stay green, would be the wrong trade.
 *
 * ⚠️ IT ASSERTS ALMOST NOTHING, ON PURPOSE. "Fast enough" is a judgement nobody
 * has made yet (F-124's own decision), and a threshold picked here would become
 * a flaky test on somebody else's laptop. It prints numbers and checks only that
 * the board renders AT ALL, which is the one thing that is not a matter of taste.
 */
test.skip(!hasRealBackend, NO_BACKEND_REASON);

const ADMIN = "admin@example.test";
const PASSWORD = "devpassword";

test("how long a plant-sized board takes to draw, and a drag on it", async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(ADMIN);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/", { timeout: 30_000 });

  const picker = page.getByRole("combobox", { name: "Which place to show" });
  await expect(picker).toBeVisible({ timeout: 30_000 });

  const options = await picker
    .locator("option")
    .evaluateAll((els) =>
      els.map((e) => ({ value: (e as HTMLOptionElement).value, text: e.textContent ?? "" })),
    );
  const load = options.find((o) => o.value === "load_plant");
  if (load === undefined) {
    console.log(
      "\n  SKIPPED: the volume fixture is not in this database.\n" +
        "  Apply it with scripts/load/fixture.sql, re-run, then remove it with\n" +
        "  scripts/load/teardown.sql.\n",
    );
    test.skip();
    return;
  }

  /*
   * ⛔ WAIT FOR A TRACK OF THE PLANT BEING SWITCHED TO, NOT FOR "any track".
   * The first version waited on `getByLabel(/press Enter to create/)`, which is
   * still on screen from the PREVIOUS board while the new one loads -- so the
   * assertion passed instantly and the measurement reported the 384-cell plant
   * as 192ms and the small one as 908ms, i.e. the big board arriving five times
   * faster than the small one while the server alone takes over two seconds for
   * it. A number that is not merely wrong but backwards. Each board is now
   * identified by a cell name only it has.
   */
  const trackNamed = (cell: string) => page.getByLabel(new RegExp(`^${cell} track`)).first();

  /*
   * ⛔ AND A FRESH PAGE EACH TIME, WHICH THE SECOND VERSION ALSO GOT WRONG. It
   * switched AWAY to the other plant and back, so the timed switch was served
   * out of react-query's cache and the 384-cell plant reported 234ms against
   * the small one's 876ms -- backwards again, for a different reason. A reload
   * empties that cache, so each number is a real fetch.
   */
  async function timeCold(value: string, cell: string) {
    await page.goto("/");
    await expect(picker).toBeVisible({ timeout: 60_000 });
    if ((await picker.inputValue()) === value) {
      // Already there: step off so the timed selection is a change.
      const other = options.find((o) => o.value !== value)!;
      await picker.selectOption(other.value);
      await page.goto("/");
      await expect(picker).toBeVisible({ timeout: 60_000 });
    }
    const t0 = Date.now();
    await picker.selectOption(value);
    await expect(trackNamed(cell)).toBeVisible({ timeout: 180_000 });
    return Date.now() - t0;
  }

  const small = options.find((o) => o.value !== "load_plant")!;
  // Plant A's first cell is "Cell 1"; the fixture's is "Cell 1-1-1". `^Cell 1 `
  // cannot match "Cell 1-1-1", so the two are genuinely distinguishable.
  const smallMs = await timeCold(small.value, "Cell 1");
  const bigMs = await timeCold("load_plant", "Cell 1-1-1");

  // The drag: pick the first block on the big board and move it one hour right.
  // Measured from mouse-up to the board settling, which is what a person feels.
  let dragMs = -1;
  // The chip's own label is "<person> on <product>, HH:MM to HH:MM"; the
  // fixture's people are all called "Load Op N", so this cannot pick up a chip
  // from another plant left over on screen.
  const block = page.getByLabel(/^Load Op \d+ on /).first();
  if ((await block.count()) > 0) {
    const box = await block.boundingBox();
    if (box !== null) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 8 });
      const t0 = Date.now();
      await page.mouse.up();
      await page.waitForTimeout(0);
      await expect(trackNamed("Cell 1-1-1")).toBeVisible({ timeout: 60_000 });
      dragMs = Date.now() - t0;
    }
  }

  console.log(
    [
      "",
      `  ${small.text.trim()} (small)      ${smallMs} ms to first track`,
      `  Load Plant (384 cells)          ${bigMs} ms to first track`,
      dragMs >= 0
        ? `  drag on the big board           ${dragMs} ms from mouse-up to settled`
        : "  drag                            no block found to drag",
      "",
    ].join("\n"),
  );

  // The only thing that is not a matter of taste: it renders.
  expect(bigMs).toBeGreaterThan(0);
});
