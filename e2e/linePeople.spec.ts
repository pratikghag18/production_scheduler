import { test, expect, type Page } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON } from "./env";

/**
 * R-346, ON THE SCREEN, AS THE PERSON IT BROKE FOR.
 *
 * Ana is a supervisor granted LINE 1 of Plant A and nothing else, so the board
 * she opens starts at that line. The maintainer, 6 Sept: *"The operators are
 * assigned at different hierarchy levels, why would they not be visible now?
 * ... Ana can't see any operators on the left panel. What am I missing?
 * Something is definitely wrong."*
 *
 * ⭐⭐ WHY THIS CASE CANNOT BE A UNIT CASE. Everything the unit suite can reach
 * takes the split as an INPUT: `peoplePicker.test.tsx` hands the components a
 * `hereOperatorIds` set and judges what they draw with it. What broke was the
 * chain BEFORE that — Ana's grant narrows what `board_window` returns, the
 * people are homed above her grant, and the client used to derive the pool from
 * the nodes it could see. Only the real server, the real grant and the real
 * demo data add up to that, and only in a browser. Same argument
 * `signedIn.spec.ts` makes for the admin rail, and this file is its shape.
 *
 * ⚠️ SO A GREEN RUN HERE MEANS 0058 IS APPLIED. If the migration is not on the
 * database this run points at, `board_window` sends the old operator array with
 * no `site_path`, the parser refuses the whole payload as a shape it does not
 * understand, and the panel is empty — which is what the first assertion
 * reports. That is the intended failure, not a flake.
 *
 * ⚠️ AND IT SKIPS WITHOUT A BACKEND rather than failing, exactly as the other
 * signed-in specs do. ⛔ A skip is not a pass.
 */

test.skip(!hasRealBackend, NO_BACKEND_REASON);

const PASSWORD = "devpassword";
/** role 'supervisor', a grant on Plant A's Line 1 and nothing else. */
const SUPERVISOR = "ana@example.test";

/** Plant A's six people, as `dev_demo.sql` names them. */
const PLANT_A_PEOPLE = [
  "Operator A1",
  "Operator A2",
  "Operator A3",
  "Operator A4",
  "Operator A5",
  "Operator A6",
];

async function signIn(page: Page, email: string, path = "/"): Promise<void> {
  await page.goto(`/sign-in?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

/** `YYYY-MM-DD` of the Monday of the current UTC week — `copyWeek.spec.ts`'s. */
function mondayPlusWeeks(weeks: number): string {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = new Date(today).getUTCDay();
  const sinceMonday = day === 0 ? 6 : day - 1;
  const monday = today - sinceMonday * 86_400_000 + weeks * 7 * 86_400_000;
  return new Date(monday).toISOString().slice(0, 10);
}

test("a line supervisor sees the whole plant's people, with nothing behind a click", async ({
  page,
}) => {
  await signIn(page, SUPERVISOR, "/");
  // The demo's runs sit in the current week; the window opens wherever it last
  // was, so it is put somewhere with data before anything is read off it.
  await page.locator("#board-window-start").fill(mondayPlusWeeks(0));

  const panel = page.getByRole("complementary", { name: "Operators" });
  await expect(panel).toBeVisible({ timeout: 15_000 });

  /**
   * ⭐⭐ ALL SIX, AND THAT IS THE WHOLE REQUIREMENT. `dev_demo.sql` homes
   * Operator A1 inside Area 1 and A2-A6 at Plant A — every one of them at or
   * ABOVE Ana's line, so every one of them is a default offer under the
   * maintainer's rule. Before 0058 she saw none of them.
   */
  for (const name of PLANT_A_PEOPLE) {
    await expect(panel.getByText(name, { exact: true })).toBeVisible({ timeout: 15_000 });
  }

  /**
   * ⭐ AND NO CONTROL, because there is nobody behind it: Plant A's people are
   * all homed at or above this line, so `elsewhere` is empty. A control here
   * would mean the split had put somebody in the wrong half — the failure that
   * asks a supervisor for a reason the server does not want.
   */
  await expect(panel.getByRole("button", { name: /other people in this plant/ })).toHaveCount(0);

  /**
   * ⚠️ NOBODY FROM ANOTHER PLANT (R-345/R-342). Plant B's people are named the
   * same way with a B, and one of them appearing here would be the older defect
   * back — cheap to assert while the panel is open.
   */
  await expect(panel.getByText(/Operator [BC]\d/)).toHaveCount(0);
});

test("the cell pop-up offers the same six, none of them marked", async ({ page }) => {
  await signIn(page, SUPERVISOR, "/");
  await page.locator("#board-window-start").fill(mondayPlusWeeks(0));

  /**
   * ⚠️ ANY CELL TRACK ON HER BOARD, NOT A NAMED ONE. Ana's grant is Line 1, so
   * her board carries Cells 1 and 2; `dev_demo.sql` puts Cell 3 under Line 2,
   * which she cannot read. Naming a cell here would be asserting the demo's
   * shape rather than the requirement, and would go red the day the fixture
   * moves a cell. The first schedulable track is what a person would click.
   */
  // ⚠️ `getByLabel`, NOT `getByRole("button")`: a track is a focusable div with
  // an `aria-label` and deliberately NO button role, because it CONTAINS
  // role="button" blocks and ARIA forbids nesting those (TrackRow says so at
  // the element).
  const track = page.getByLabel(/Cell \d+ track/).first();
  await expect(track).toBeVisible({ timeout: 15_000 });
  await track.press("Enter");

  const pop = page.getByRole("dialog");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  // The create pop-up opens on whichever tab was last used; the person picker
  // is on the direct-assignment one.
  const direct = pop.getByRole("button", { name: "Direct assignment" });
  if (await direct.isVisible()) await direct.click();

  const person = pop.getByLabel("Operator");
  await expect(person).toBeVisible();
  const labels = await person.locator("option").allTextContents();

  /**
   * ⚠️ THE NAMES, WITH ANY SUFFIX STRIPPED, AND THAT IS DELIBERATE RATHER THAN
   * LOOSE. An option reads `"<name> — <suffix>"`, and the suffixes answer TWO
   * unrelated questions: F-087's certification one ("Never trained for this
   * (override)" -- Line 1 carries a `Line 1 Cert` requirement that not all six
   * hold) and D113's area one. Comparing the raw text to the bare names asserts
   * both at once, so this case would go red the day somebody's certificate
   * lapsed in the demo data -- reporting an area failure for a training fact.
   * The name half is checked here; the area half is the negative below.
   */
  const names = labels.map((t) => t.trim().split(" — ")[0]).sort();
  expect(names).toEqual([...PLANT_A_PEOPLE].sort());

  // ⭐ NONE MARKED FOR THE AREA: every one of them is homed at or above this
  // cell, so asking any of them for an area reason would be the screen refusing
  // what the server takes without one.
  expect(labels.join(" ")).not.toContain("not from this area");
  await expect(pop.getByRole("button", { name: /other people in this plant/ })).toHaveCount(0);
});
