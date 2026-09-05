import { test, expect, type Page } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON } from "./env";

/**
 * The signed-in half of the app, driven in a real browser as real people.
 *
 * ⭐⭐ THIS IS THE GAP `smoke.spec.ts` NAMED AND COULD NOT CLOSE. Its header
 * says, of the signed-in screens: *"unreachable here and are not faked ...
 * named as a gap on R-321 rather than papered over with a mocked session."*
 * That was right, and it was right about CI, which has no database. It was
 * never true LOCALLY: `.env.local` points at the running stack, and both
 * `seed.sql` and `dev_demo.sql` have set `encrypted_password` to a known value
 * on every demo account since they were written. The door was open the whole
 * time and nobody tried it.
 *
 * ⚠️ SO THIS FILE SKIPS WITHOUT A BACKEND RATHER THAN FAILING, and that is the
 * only reason it can exist before CI has a database. `hasRealBackend` decides
 * (see `env.ts`), keyed on the URL rather than on `process.env.CI` so a
 * developer with no `.env.local` gets the same honest skip. ⛔ A skip is not a
 * pass: until CI can stand a database up, these cases prove nothing on a push,
 * and the CI half of that work is the other half of the queue's e2e item.
 *
 * ⭐⭐ WHY THESE THREE CASES FIRST, OUT OF EVERYTHING THE APP DOES. Because the
 * app's own history says the admin rail is where it goes wrong, twice in two
 * days, and both times in a way the unit suite could not see:
 *
 *   DEF-0007 — a plant admin was refused the Settings tab the server would have
 *   let her use. 2103 unit cases green; the tester found it by signing in as
 *   Dana and reading the rail.
 *   DEF-0008 — after that fix, `adminSectionsFor` was the only lock left on that
 *   tab and nothing exercised its narrowed branch. Widening it to offer a
 *   supervisor Import, Products and Settings passed all 2103 cases.
 *
 * Both now have unit cases (`auditAccess.test.tsx`, `adminNoGrants.test.tsx`
 * N6/N7). Those mount `AdminPage` with a mocked session and a stubbed tree,
 * which is the right level for the DECISION and cannot see the thing that
 * actually broke: whether the real server, the real profile read and the real
 * grants add up to the same rail on the screen. That is this file's job, and it
 * is the only file in the repo that can do it.
 *
 * The three people are the dev switcher's own, so a reader can reproduce any
 * failure by hand in ten seconds.
 */

test.skip(!hasRealBackend, NO_BACKEND_REASON);

const PASSWORD = "devpassword";

/** The dev world's people, by the authority each one is here to demonstrate. */
const COMPANY_ADMIN = "admin@example.test"; // user_profiles.role = 'admin'
const SITE_ADMIN = "dana@example.test"; // role 'viewer' + an admin GRANT on Plant A
const SUPERVISOR = "ana@example.test"; // role 'supervisor', no admin grant anywhere

/**
 * Sign in through the real form and wait for the redirect to be FOLLOWED.
 *
 * ⚠️ IT WAITS ON THE URL, NOT ON A HEADING. Which screen you land on differs by
 * role — that is half of what this file tests — so waiting for any particular
 * heading here would bake one role's answer into the helper every other case
 * uses.
 */
async function signIn(page: Page, email: string, path = "/"): Promise<void> {
  await page.goto(`/sign-in?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

/** Every section button in the admin rail, in the order the rail renders them. */
async function rail(page: Page): Promise<string[]> {
  const nav = page.getByRole("navigation", { name: "Admin sections" });
  await expect(nav).toBeVisible({ timeout: 15_000 });
  const labels = await nav.getByRole("button").allTextContents();
  // The rail's collapse control is icon-only and has no text; every section
  // button carries its label. Same filter `adminNoGrants.test.tsx` uses.
  return labels.map((t) => t.trim()).filter((t) => t.length > 0);
}

test("a company admin signs in and gets the whole admin rail", async ({ page }) => {
  await signIn(page, COMPANY_ADMIN, "/admin");
  expect(await rail(page)).toEqual([
    "Hierarchy",
    "Access",
    "Shifts",
    "Operators",
    "Trainings",
    "Matrix",
    "Products",
    "Cycle times",
    "Import",
    "Settings",
    "Activity",
  ]);
});

/**
 * ⭐⭐ DEF-0007, ON THE SCREEN. Dana administers Plant A and her org-wide role is
 * `viewer`, so `app_is_admin()` is false for her and `app_is_admin_for(node)` is
 * true. `set_node_setting` is gated on `app_is_admin() OR app_is_admin_for(node)`
 * and takes her writes on her own plant; `audit_log_select` is
 * `app_is_admin() and org_id = ...` and hands her zero rows rather than a
 * refusal. So the two tabs must answer DIFFERENTLY for this one person, and
 * asserting both in one case is what stops them being re-coupled.
 */
test("a site admin is offered Settings and not Activity", async ({ page }) => {
  await signIn(page, SITE_ADMIN, "/admin");
  const tabs = await rail(page);
  expect(tabs).toContain("Settings");
  expect(tabs).not.toContain("Activity");
});

/**
 * ⭐⭐ DEF-0008, ON THE SCREEN. Ana holds no admin grant anywhere, so
 * `adminSectionsFor` narrows her to three sections — and since DEF-0007 removed
 * `companyAdminOnly` from the Settings row, that helper is the ONLY thing
 * keeping Settings away from her. The whole list is asserted rather than three
 * presence checks, because a list cannot be widened quietly.
 */
test("a supervisor with no admin grant gets exactly three tabs", async ({ page }) => {
  await signIn(page, SUPERVISOR, "/admin");
  expect(await rail(page)).toEqual(["Operators", "Trainings", "Matrix"]);
});
