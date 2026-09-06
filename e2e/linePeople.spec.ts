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

/**
 * ⚠️ THE SPLIT IS READ OFF THE SCREEN, NOT ASSUMED FROM THE FIXTURE. This runs
 * against the maintainer's live demo database, and the maintainer re-homes
 * people from the Admin rail to try the rule out (on 6 Sept, A5 and A6 were
 * moved from Plant A into Area 2 minutes after this case was first written,
 * and a case that had assumed "all six by default" went red for the right
 * behaviour). So the case asserts the RULE: the default list plus the list
 * behind the click is exactly the plant's six people, nobody appears in both
 * halves, and nobody from another plant appears anywhere. Which six are on
 * which side is the data's business.
 */
async function readSplit(scope: import("@playwright/test").Locator, nameOf: (t: string) => string) {
  const control = scope.getByRole("button", { name: /other people in this plant/ });
  const before = (await scope.getByText(/^Operator A\d/).allTextContents()).map(nameOf);
  let behind: string[] = [];
  if ((await control.count()) > 0) {
    const label = (await control.textContent()) ?? "";
    const n = Number(/\((\d+)\)/.exec(label)?.[1] ?? "0");
    await control.click();
    const after = (await scope.getByText(/^Operator A\d/).allTextContents()).map(nameOf);
    behind = after.filter((name) => !before.includes(name));
    expect(behind.length, "the control's count is the number it reveals").toBe(n);
  }
  return { here: before, behind };
}

test("a line supervisor sees the whole plant's people: the default list plus the click", async ({
  page,
}) => {
  await signIn(page, SUPERVISOR, "/");
  await page.locator("#board-window-start").fill(mondayPlusWeeks(0));

  const panel = page.getByRole("complementary", { name: "Operators" });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText(/^Operator A\d/).first()).toBeVisible({ timeout: 15_000 });

  const { here, behind } = await readSplit(panel, (t) =>
    t.trim().split(/\s/).slice(0, 2).join(" "),
  );
  expect([...here, ...behind].sort()).toEqual([...PLANT_A_PEOPLE].sort());
  expect(here.filter((name) => behind.includes(name))).toEqual([]);
  // Before 0058 she saw nobody at all; at least the people homed at the plant
  // and the area above her line are hers by default.
  expect(here.length).toBeGreaterThan(0);

  // ⚠️ NOBODY FROM ANOTHER PLANT (R-345/R-342).
  await expect(panel.getByText(/Operator [BCD]\d/)).toHaveCount(0);
});

test("the cell pop-up splits the same six the same way, marking only the ones behind the click", async ({
  page,
}) => {
  await signIn(page, SUPERVISOR, "/");
  await page.locator("#board-window-start").fill(mondayPlusWeeks(0));

  // Any cell track on her board, not a named one: her grant is Line 1 and the
  // demo may move cells; a track is a focusable div with an aria-label and no
  // button role (TrackRow says why at the element).
  const track = page.getByLabel(/Cell \d+ track/).first();
  await expect(track).toBeVisible({ timeout: 15_000 });
  await track.press("Enter");

  const pop = page.getByRole("dialog");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  const direct = pop.getByRole("button", { name: "Direct assignment" });
  if (await direct.isVisible()) await direct.click();

  const person = pop.getByLabel("Operator");
  await expect(person).toBeVisible();
  // The name half only: suffixes answer two unrelated questions (F-087's
  // training one and D113's area one), and this case is about the area.
  const nameOf = (t: string) => t.trim().split(" — ")[0];
  const defaults = (await person.locator("option").allTextContents()).map(nameOf);
  expect(defaults.join(" ")).not.toContain("not from this area");

  const control = pop.getByRole("button", { name: /other people in this plant/ });
  let behind: string[] = [];
  if ((await control.count()) > 0) {
    await control.click();
    const all = await person.locator("option").allTextContents();
    behind = all.map(nameOf).filter((name) => !defaults.includes(name));
    // Every revealed person is marked, and only they are.
    for (const raw of all) {
      const marked = raw.includes("not from this area");
      expect(marked, raw).toBe(behind.includes(nameOf(raw)));
    }
  }
  expect([...defaults, ...behind].sort()).toEqual([...PLANT_A_PEOPLE].sort());
});
