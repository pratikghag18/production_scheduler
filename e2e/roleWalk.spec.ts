import { test, expect, type Page, type Browser, type Locator } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON, e2eBaseUrl } from "./env";
import { fillWindowStart } from "./boardWindow";
import { signedInClient, loadPlantANodes, PLANT_A_ADMIN } from "./walk/db";

/**
 * THE NET FOR THE "RESOLVED THROUGH THE CALLER'S OWN VIEW" CLASS OF DEFECT.
 *
 * DEF-0016 and DEF-0017 were both found by driving the board as a LINE
 * SUPERVISOR after the developer's reviewer had passed the feature as the
 * plant admin. Facts that must be the SAME for both people differed, because
 * something the plant owns above the supervisor's grant was resolved through
 * the caller's own read scope instead of the node's org:
 *
 *   DEF-0016 (R-039) -- a line supervisor's board draws no break band, no
 *   shift boundary and offers no shift chips, because resolve_shift_template
 *   walks the ancestry under her session and the plant's node and its template
 *   attachment are both filtered away. Line 1 inherits Plant A's template, so
 *   Ana's board must draw the same shift pattern as Dana's does for Line 1.
 *
 *   DEF-0017 (R-333) -- a line supervisor's board shows the company date format
 *   while the server says her line uses the plant's, because the client reads
 *   the ROOT node's own override instead of asking a server resolver upward. A
 *   board of one plant's one line uses that plant's value, exactly as the plant
 *   admin's board does.
 *
 * The maintainer's words: "This has to stop." This file is the standing proof
 * that it has: it walks EVERY person the dev switcher offers, records the
 * plant-wide facts each one's board shows, and then asserts the facts that must
 * AGREE across people -- so a future feature that resolves a plant-wide thing
 * through the caller's grant again goes red here the moment a supervisor opens
 * the board, not weeks later in a tester's browser pass.
 *
 * SHAPE. Same as signedIn.spec.ts / linePeople.spec.ts: it skips without a
 * backend rather than failing, signs in through the real form, and asserts what
 * is on the screen against the real server, the real grants and the real demo
 * world. A skip is not a pass.
 *
 * HONEST ABOUT THE RULE, NOT TODAY'S CODE. Two lanes are fixing DEF-0016 and
 * DEF-0017 in parallel; the cross-person comparisons state the rule the fix
 * must satisfy, so they FAIL on this build (the developer note in the run
 * report says which ones and why) and PASS once both fixes land.
 */

test.skip(!hasRealBackend, NO_BACKEND_REASON);

const PASSWORD = "devpassword";
// newContext() does not inherit use.baseURL from the config, so the manually
// created contexts in this file carry it themselves. R-366: this is
// `e2eBaseUrl` from e2e/env.ts, the same value the config's webServer url
// uses, so a tester run on its own port (5174) does not silently point these
// contexts back at the developer's 5173.
const BASE_URL = e2eBaseUrl;

type Kind = "company-admin" | "site-admin" | "supervisor" | "viewer";

interface Person {
  email: string;
  label: string;
  kind: Kind;
  /** The server's can_place answer this person's board is built with. */
  canPlace: boolean;
  /** Which plant this person belongs to, for the same-plant comparisons. */
  plant: "A" | "B" | "C" | "all";
}

/** The dev switcher's own cast (src/features/auth/DevProfileSwitcher.tsx),
 *  widest reach first, exactly as the switcher orders them. */
const PEOPLE: readonly Person[] = [
  {
    email: "admin@example.test",
    label: "Admin (company)",
    kind: "company-admin",
    canPlace: true,
    plant: "all",
  },
  {
    email: "dana@example.test",
    label: "Dana (site admin, Plant A)",
    kind: "site-admin",
    canPlace: true,
    plant: "A",
  },
  {
    email: "quinn@example.test",
    label: "Quinn (site admin, Plant B)",
    kind: "site-admin",
    canPlace: true,
    plant: "B",
  },
  {
    email: "rosa@example.test",
    label: "Rosa (site admin, Plant C)",
    kind: "site-admin",
    canPlace: true,
    plant: "C",
  },
  {
    email: "ana@example.test",
    label: "Ana (supervisor, Plant A / Line 1)",
    kind: "supervisor",
    canPlace: true,
    plant: "A",
  },
  {
    email: "marco@example.test",
    label: "Marco (supervisor, Plant B / Area 1)",
    kind: "supervisor",
    canPlace: true,
    plant: "B",
  },
  {
    email: "viva@example.test",
    label: "Viva (viewer, Plant A)",
    kind: "viewer",
    canPlace: false,
    plant: "A",
  },
  {
    email: "vito@example.test",
    label: "Vito (viewer, Plant B)",
    kind: "viewer",
    canPlace: false,
    plant: "B",
  },
  {
    email: "vina@example.test",
    label: "Vina (viewer, Plant C)",
    kind: "viewer",
    canPlace: false,
    plant: "C",
  },
];

const byEmail = (email: string): Person => {
  const p = PEOPLE.find((x) => x.email === email);
  if (!p) throw new Error(`no such dev person: ${email}`);
  return p;
};

/** `YYYY-MM-DD` of the Monday of the current UTC week -- linePeople.spec.ts's. */
function mondayOfThisWeek(): string {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = new Date(today).getUTCDay();
  const sinceMonday = day === 0 ? 6 : day - 1;
  const monday = today - sinceMonday * 86_400_000;
  return new Date(monday).toISOString().slice(0, 10);
}

/** Sign in through the real form and wait for the redirect to be followed.
 *  Waits on the URL, not a heading: which screen a role lands on differs. */
async function signIn(page: Page, email: string, path = "/"): Promise<void> {
  await page.goto(`/sign-in?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

const collapseWhitespace = (t: string): string => t.replace(/\s+/g, " ").trim();
// An operator option reads "Name -- suffix" with an em dash (U+2014); the name
// half is the first segment. Same split linePeople.spec.ts uses.
const operatorName = (t: string): string => t.split("—")[0].trim();

/**
 * Everything one person's board shows that a plant-wide fact could differ on.
 * Pure observation -- it opens and reads, it does not judge; the judging is in
 * the tests, so one person failing to render never hides a cross-person red.
 */
interface BoardFacts {
  email: string;
  label: string;
  /** The name in the board header -- a plant for an admin, the grant node
   *  (a line, an area) for a supervisor. Recorded, not compared across roles. */
  rootName: string;
  /** The header's date range string, e.g. "Mon 2026/08/31 - Wed 2026/09/02".
   *  Its SHAPE is the date format the header shows (DEF-0017). */
  headerDate: string;
  /** The first few hour-tick clock labels on the header axis (e.g.
   *  "00:00,01:00,02:00"). Its VALUES are the plant-local time the axis renders
   *  in (R-353 / D88a): a supervisor's board must draw the SAME axis as the
   *  admin's, resolved from the plant's zone on the server. */
  headerClock: string;
  /** Break bands the shift layer draws on the first track (DEF-0016). Coupled to
   *  scroll position and track viewport (the layer draws only what is in view),
   *  so it is compared as PRESENCE, not to the unit; recorded for the walk log. */
  breaksFirstTrack: number;
  /** Dashed shift-boundary lines the shift layer draws on the first track. */
  boundsFirstTrack: number;
  /** The shift chips the create form offers on the first track (DEF-0016).
   *  Empty for a viewer (no create form) and, today, for a supervisor. */
  shiftChips: string[];
  /** The people the create form offers by default on the first track. */
  people: string[];
  /** Whether the left operator panel is present (R-346: a viewer gets none). */
  panelPresent: boolean;
  /** P1-7a: whether the typed command bar is present -- gated on the same
   *  `canPlace` the panel and the create pop-up are (R-378/§9), so a viewer
   *  must never see a bar whose pop-up cannot open. */
  commandBarPresent: boolean;
  /** role="alert" nodes on the board -- must be zero for everyone. */
  alertCount: number;
  /** Whether the board's catch-all "Something went wrong" copy is showing. */
  sawSomethingWrong: boolean;
  canPlace: boolean;
}

/** The board header: the one <header> that carries the "Board" heading. */
function boardHeader(page: Page): Locator {
  return page.locator("header").filter({ has: page.getByRole("heading", { name: "Board" }) });
}

async function observeBoard(page: Page, person: Person): Promise<BoardFacts> {
  await signIn(page, person.email, "/");

  const header = boardHeader(page);
  await expect(header).toBeVisible({ timeout: 20_000 });

  // Let the board's INITIAL window finish loading before changing the date --
  // filling the input the instant the app mounts races the first board_window
  // fetch, and a window change mid-flight can settle the query on an error. A
  // track on screen is the signal the first load is done. The demo seeds the
  // current week, so the default window already draws tracks.
  const firstTrack = page.getByLabel(/press Enter to create/).first();
  await expect(firstTrack).toBeVisible({ timeout: 20_000 });

  await fillWindowStart(page, mondayOfThisWeek());
  // The date change refetches; wait for the board to settle on a track again.
  await expect(firstTrack).toBeVisible({ timeout: 20_000 });

  const alertCount = await page.getByRole("alert").count();
  const sawSomethingWrong = (await page.getByText(/Something went wrong/).count()) > 0;

  // The header shows a picker when there is a choice of plant, a bare label
  // when there is one place (BoardToolbar: shouldOfferRootPicker).
  const picker = page.getByRole("combobox", { name: "Which place to show" });
  let rootName = "";
  if ((await picker.count()) > 0) {
    // The DOM's selectedOptions is not reachable from the e2e project's node
    // lib, so read the selected value (the root path) and match its option by
    // that value to get the plant name it shows.
    const value = await picker.inputValue();
    const selected = picker.locator(`option[value="${value}"]`);
    rootName =
      (await selected.count()) > 0 ? collapseWhitespace((await selected.textContent()) ?? "") : "";
  } else {
    const label = header.getByText(/^(Plant|Area|Line|Cell)\b/).first();
    rootName =
      (await label.count()) > 0 ? collapseWhitespace((await label.textContent()) ?? "") : "";
  }

  // The date range span always renders "start - end" with an en dash (U+2013),
  // whatever the format; its text IS the format the header shows.
  const dateSpan = header.getByText(/\d.*–.*\d/).first();
  const headerDate =
    (await dateSpan.count()) > 0 ? collapseWhitespace((await dateSpan.textContent()) ?? "") : "";

  // Anchor the horizontal view at the window START before counting the shift
  // layer. The layer only draws what is horizontally visible, and the board
  // auto-scrolls to "now" on load, so an unanchored count would depend on the
  // time of day the run happened. A wheel to the far left clamps scrollLeft at
  // 0, so two people with the same window, zoom and track viewport then draw the
  // same number of break bands -- which is the fact the comparisons rest on.
  await firstTrack.hover();
  await page.mouse.wheel(-200_000, 0);
  await page.waitForTimeout(300);

  // The shift layer's break bands and boundary lines are direct children of the
  // track div; CSS Modules keep the local class name in the generated one, so a
  // substring match on class finds them and nothing else draws them (RunBand /
  // AssignmentChip carry no shift layer of their own).
  const breaksFirstTrack = await firstTrack.locator('[class*="shiftBreak"]').count();
  const boundsFirstTrack = await firstTrack.locator('[class*="shiftbound"]').count();

  // R-353 / D88a: the header's hour-tick clock labels, from the left of the
  // window. Their VALUES are the plant-local time the axis draws in; both people
  // are on Plant A, so a supervisor whose board fell back to a different zone
  // than the admin's would show a different first tick here. Read after the
  // left-anchor above, so the same leading ticks are on screen for everyone.
  const headerClock = (await page.locator('[class*="hourTick"]').allTextContents())
    .map(collapseWhitespace)
    .filter((t) => /^\d{2}:\d{2}$/.test(t))
    .slice(0, 6)
    .join(",");

  const panelPresent = (await page.getByRole("complementary", { name: "Operators" }).count()) > 0;
  // P1-7a: same fact as `panelPresent`, for the typed command bar. S48-a:
  // the bar now lives behind the corner launcher button -- open the panel
  // first if the button is there at all; a viewer has no launcher (same
  // guard as the bar had), so the textbox stays absent for them either way.
  const launcherButton = page.getByRole("button", { name: "Tell the board" });
  if ((await launcherButton.count()) > 0) {
    await launcherButton.click();
  }
  const commandBarPresent =
    (await page.getByRole("textbox", { name: "Tell the board" }).count()) > 0;

  let shiftChips: string[] = [];
  let people: string[] = [];
  if (person.canPlace) {
    await firstTrack.press("Enter");
    const dialog = page.getByRole("dialog", { name: "New" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // Chips render in both modes, before the mode branch.
    shiftChips = (await dialog.getByRole("button", { name: /^Shift \d/ }).allTextContents()).map(
      collapseWhitespace,
    );

    // Only the direct-assignment tab chooses a person.
    const direct = dialog.getByRole("button", { name: "Direct assignment" });
    if ((await direct.count()) > 0) await direct.click();
    const operator = dialog.getByLabel("Operator");
    if ((await operator.count()) > 0) {
      people = (await operator.locator("option").allTextContents()).map(operatorName);
    }
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }

  return {
    email: person.email,
    label: person.label,
    rootName,
    headerDate,
    headerClock,
    breaksFirstTrack,
    boundsFirstTrack,
    shiftChips,
    people,
    panelPresent,
    commandBarPresent,
    alertCount,
    sawSomethingWrong,
    canPlace: person.canPlace,
  };
}

/** Observe one person in a fresh, isolated context (signed out to start). */
async function observeFresh(browser: Browser, person: Person): Promise<BoardFacts> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    return await observeBoard(await context.newPage(), person);
  } finally {
    await context.close();
  }
}

/** Every section button in the admin rail, in render order (signedIn.spec.ts). */
async function railTabs(page: Page): Promise<string[]> {
  const nav = page.getByRole("navigation", { name: "Admin sections" });
  await expect(nav).toBeVisible({ timeout: 15_000 });
  const labels = await nav.getByRole("button").allTextContents();
  // The collapse control is icon-only (no text); every section button labels
  // itself. Same filter adminNoGrants.test.tsx uses.
  return labels.map((t) => t.trim()).filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// The walk: every person's board renders, cleanly.
// ---------------------------------------------------------------------------

test("every dev person signs in and gets a board with no alert and no failure copy", async ({
  browser,
}) => {
  // Nine people, one board load each, in fresh contexts one after another.
  test.setTimeout(240_000);
  for (const person of PEOPLE) {
    let facts: BoardFacts;
    try {
      facts = await observeFresh(browser, person);
    } catch (err) {
      expect
        .soft(false, `${person.label}: board walk threw before it could be read: ${String(err)}`)
        .toBe(true);
      continue;
    }
    // A record for the reader, so a failure below can be reproduced by hand.
    console.log(
      `WALK ${person.label} :: root="${facts.rootName}" date="${facts.headerDate}" ` +
        `breaks=${facts.breaksFirstTrack} bounds=${facts.boundsFirstTrack} ` +
        `panel=${facts.panelPresent} canPlace=${facts.canPlace} ` +
        `chips=[${facts.shiftChips.join(" | ")}] people=[${facts.people.join(", ")}]`,
    );
    expect.soft(facts.alertCount, `${person.label}: the board shows no role=alert`).toBe(0);
    expect
      .soft(facts.sawSomethingWrong, `${person.label}: the board shows no "Something went wrong"`)
      .toBe(false);
    // R-346: a viewer gets no operator panel; everyone who can place gets one.
    expect
      .soft(facts.panelPresent, `${person.label}: operator panel present iff the person can place`)
      .toBe(person.canPlace);
  }
});

test("every admin and supervisor opens each admin rail tab with no alert", async ({ browser }) => {
  test.setTimeout(180_000);
  const railPeople = PEOPLE.filter((p) => p.kind !== "viewer");
  for (const person of railPeople) {
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await signIn(page, person.email, "/admin");
      const tabs = await railTabs(page);
      expect
        .soft(tabs.length, `${person.label}: the admin rail offers at least one tab`)
        .toBeGreaterThan(0);
      for (const tab of tabs) {
        await page
          .getByRole("navigation", { name: "Admin sections" })
          .getByRole("button", { name: tab })
          .click();
        await expect
          .soft(page.getByRole("alert"), `${person.label}: the "${tab}" tab shows no role=alert`)
          .toHaveCount(0);
      }
    } finally {
      await context.close();
    }
  }
});

// ---------------------------------------------------------------------------
// The facts that must agree across people. These state the rule the two
// in-flight fixes must satisfy, so they are RED on a build without them.
// ---------------------------------------------------------------------------

test("Ana (Plant A / Line 1) and Dana (Plant A): the same shift pattern and the same date format", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ana = await observeFresh(browser, byEmail("ana@example.test"));
  const dana = await observeFresh(browser, byEmail("dana@example.test"));

  // DEF-0016. Line 1 has no template of its own and inherits Plant A's, which
  // is attached at the plant and applies to every cell under it. So a Line 1
  // cell on Ana's board draws the plant's shift pattern -- the break bands and
  // shift boundaries the defect stripped to nothing. Presence is asserted, not
  // an exact tally: the shift layer only draws what is horizontally in view, and
  // two boards that auto-scroll to "now" seconds apart do not share scrollLeft to
  // the pixel, so a raw DOM count is a viewport measure, recorded in the walk log
  // rather than compared. The EXACT per-shift agreement is the chips, below.
  expect
    .soft(
      ana.breaksFirstTrack,
      `DEF-0016: Ana's Line 1 board must draw the plant's break bands, as Dana's Plant A board does ` +
        `(Ana=${ana.breaksFirstTrack}, Dana=${dana.breaksFirstTrack})`,
    )
    .toBeGreaterThan(0);
  expect
    .soft(ana.boundsFirstTrack, `DEF-0016: Ana's Line 1 board must draw shift boundaries at all`)
    .toBeGreaterThan(0);

  // DEF-0016. The create form on a Line 1 cell must offer the same shift chips
  // for Ana as it does for Dana -- the deterministic, view-independent proof
  // that Ana's board resolved the same template Dana's did.
  expect
    .soft(
      ana.shiftChips,
      `DEF-0016: Ana's create form must offer the same shift chips as Dana's ` +
        `(Ana=[${ana.shiftChips.join(" | ")}], Dana=[${dana.shiftChips.join(" | ")}])`,
    )
    .toEqual(dana.shiftChips);
  // ...and the admin's own chips are non-empty, so the equality above is not two
  // empty lists agreeing.
  expect
    .soft(dana.shiftChips.length, `Dana's Plant A create form offers shift chips`)
    .toBeGreaterThan(0);

  // DEF-0017. Ana's board is one line of one plant, so its date format is that
  // plant's -- the same format Dana's Plant A board shows.
  expect
    .soft(
      formatShapeOf(ana.headerDate),
      `DEF-0017: Ana's header must show the same date format as Dana's ` +
        `(Ana="${ana.headerDate}", Dana="${dana.headerDate}")`,
    )
    .toBe(formatShapeOf(dana.headerDate));

  // R-353 / D88a. And now the AXIS too: Ana's board is one line inside Plant A,
  // so the zone it draws in is the plant's, resolved on the server -- the same
  // axis Dana's Plant A board shows. A supervisor whose board fell back to a
  // different zone than the admin's would show a different first hour tick.
  expect
    .soft(
      ana.headerClock,
      `R-353: Ana's board axis must render in the same zone as Dana's ` +
        `(Ana="${ana.headerClock}", Dana="${dana.headerClock}")`,
    )
    .toBe(dana.headerClock);
  expect
    .soft(dana.headerClock.length, `Dana's Plant A board draws hour-tick labels`)
    .toBeGreaterThan(0);
});

test("Marco (Plant B / Area 1) and Quinn (Plant B): the same shift pattern", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const marco = await observeFresh(browser, byEmail("marco@example.test"));
  const quinn = await observeFresh(browser, byEmail("quinn@example.test"));

  // DEF-0016, the same rule for Plant B: Area 1 inherits Plant B's template, so
  // Marco's board draws the plant's shift pattern (present, not the defect's
  // nothing) and offers exactly the shift chips Quinn's plant board does.
  expect
    .soft(
      marco.breaksFirstTrack,
      `DEF-0016: Marco's Area 1 board must draw the plant's break bands, as Quinn's Plant B board does ` +
        `(Marco=${marco.breaksFirstTrack}, Quinn=${quinn.breaksFirstTrack})`,
    )
    .toBeGreaterThan(0);
  expect
    .soft(
      marco.boundsFirstTrack,
      `DEF-0016: Marco's Area 1 board must draw shift boundaries at all`,
    )
    .toBeGreaterThan(0);
  expect
    .soft(
      marco.shiftChips,
      `DEF-0016: Marco's create form must offer the same shift chips as Quinn's ` +
        `(Marco=[${marco.shiftChips.join(" | ")}], Quinn=[${quinn.shiftChips.join(" | ")}])`,
    )
    .toEqual(quinn.shiftChips);
  expect
    .soft(quinn.shiftChips.length, `Quinn's Plant B create form offers shift chips`)
    .toBeGreaterThan(0);
});

test("Viewer Viva (Plant A) and admin Dana (Plant A): the same shift bands, and the viewer has no panel", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const viva = await observeFresh(browser, byEmail("viva@example.test"));
  const dana = await observeFresh(browser, byEmail("dana@example.test"));

  // A viewer is granted the plant root, so the shift resolver walks no further
  // than the plant and finds its template -- the viewer's board draws the plant's
  // shift pattern, the same one the admin's board shows for that plant. A viewer
  // has no operator panel, so its track viewport is WIDER than the admin's and
  // its raw band count is not the admin's to the unit; the fact that agrees is
  // that the pattern is present for both, and that the admin's is non-empty too.
  expect
    .soft(
      viva.breaksFirstTrack,
      `Viva (viewer, Plant A) must see the plant's shift pattern, as Dana (admin, Plant A) does ` +
        `(Viva=${viva.breaksFirstTrack}, Dana=${dana.breaksFirstTrack})`,
    )
    .toBeGreaterThan(0);
  expect
    .soft(dana.breaksFirstTrack, `Dana (admin, Plant A) draws the plant's shift pattern`)
    .toBeGreaterThan(0);

  // R-346: a viewer's board is the board and nothing else -- no operator panel.
  expect.soft(viva.panelPresent, `Viva (viewer, Plant A) gets no operator panel`).toBe(false);
  expect
    .soft(viva.canPlace, `Viva (viewer, Plant A) cannot place, so opens no create form`)
    .toBe(false);

  // P1-7a: the typed command bar is gated on the same `canPlace` flag as the
  // panel and the create pop-up -- a viewer must never see a bar whose pop-up
  // cannot open.
  expect
    .soft(dana.commandBarPresent, `Dana (admin, Plant A) sees the "Tell the board" bar`)
    .toBe(true);
  expect
    .soft(viva.commandBarPresent, `Viva (viewer, Plant A) gets no "Tell the board" bar`)
    .toBe(false);
});

/**
 * R-465 (DEF-0053, the screen half): a person busy on a line the viewer cannot
 * read is BOOKED on the viewer's rail, with the place and the hours, and the
 * plant admin's rail says `booked` for the same person. The tester, with the
 * clock frozen at 10 am: Ana's rail read "Priya Shah ... free" while Dana's read
 * "booked". Priya Shah is on Cell 4 (Line 2) from 6 am to 2 pm every day of the
 * seeded week (supabase/dev_demo.sql); Ana supervises Line 1 and cannot read
 * Line 2. R-465 (the maintainer, 30 Sept): the supervisor is told the place and
 * the hours, never the product or the job.
 *
 * The browser clock is frozen at 10 am PLANT time (America/Chicago, Plant A's
 * zone) today, so "Shift 1 is on now" and the read is the same on any machine
 * at any hour.
 */
const PLANT_ZONE = "America/Chicago";

/** The instant that is 10:00 today on the plant's wall clock -- found by asking the
 *  zone, never by assuming an offset (CDT or CST, whichever applies today). */
function tenAmInPlantZone(): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: PLANT_ZONE }).format(new Date());
  const [y, m, d] = ymd.split("-").map(Number);
  const hourIn = (t: Date): string =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: PLANT_ZONE,
      hour: "2-digit",
      hour12: false,
    }).format(t);
  for (const utcHour of [15, 16]) {
    const t = new Date(Date.UTC(y, m - 1, d, utcHour));
    if (hourIn(t) === "10") return t;
  }
  throw new Error(`no instant is 10 am in ${PLANT_ZONE} on ${ymd}`);
}

interface RailReading {
  /** The chip's own text, whitespace collapsed: name, tags, words, brackets. */
  text: string;
  /** The chip's hover title, or "" when it has none. */
  title: string;
}

/** Sign in with the browser clock frozen at 10 am plant time and read Priya Shah's
 *  chip on the operator rail. `railWidth`: drag the rail's edge by that many px
 *  first (negative = narrower) to read it at another width. */
async function priyaOnTheRail(
  browser: Browser,
  email: string,
  railDragPx = 0,
): Promise<RailReading> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const page = await context.newPage();
    await page.clock.install({ time: tenAmInPlantZone() });
    // The rail says what it said before R-465 until the elsewhere read lands
    // (never "booked" on a guess), so the reading waits for that answer.
    const elsewhereAnswered = page.waitForResponse(
      (r) => r.url().includes("operator_blocks_elsewhere") && r.request().method() === "POST",
      { timeout: 30_000 },
    );
    await signIn(page, email, "/");
    await expect(page.getByLabel(/press Enter to create/).first()).toBeVisible({ timeout: 20_000 });
    const rail = page.getByRole("complementary", { name: "Operators" });
    await expect(rail).toBeVisible({ timeout: 15_000 });
    // "Show other people" is not pressed: Priya is on Shift 1, which is on at 10 am.
    const name = rail.getByText("Priya Shah", { exact: true });
    await expect(name).toBeVisible({ timeout: 15_000 });
    if (railDragPx !== 0) {
      const handle = rail.getByRole("separator", { name: "Resize operators panel" });
      const box = await handle.boundingBox();
      if (!box) throw new Error("the rail has no resize handle to drag");
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + railDragPx, y, { steps: 8 });
      await page.mouse.up();
    }
    const chip = rail
      .locator("div")
      .filter({ has: page.getByText("Priya Shah", { exact: true }) })
      .last();
    // The booked word settles once the window AND the elsewhere read have landed.
    await expect(chip).toContainText(/booked|free/, { timeout: 15_000 });
    await elsewhereAnswered;
    // Two animation frames: the answer has been painted into the chip.
    await chip.evaluate(
      () =>
        new Promise<void>((done) => {
          requestAnimationFrame(() => requestAnimationFrame(() => done()));
        }),
    );
    const text = collapseWhitespace((await chip.innerText()) ?? "");
    const title = (await chip.getAttribute("title")) ?? "";
    console.log(
      `RAIL ${email} width${railDragPx >= 0 ? "+" : ""}${railDragPx} :: "${text}" title="${title.replace(/\n/g, " / ")}"`,
    );
    return { text, title };
  } finally {
    await context.close();
  }
}

test("R-465: Ana's rail says Priya Shah is booked on Cell 4, as the plant admin's says booked, at 10 am", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ana = await priyaOnTheRail(browser, "ana@example.test");
  const dana = await priyaOnTheRail(browser, "dana@example.test");

  // The plant admin reads the whole plant: nothing is elsewhere for her, and the rail
  // reads exactly as it always did.
  expect(dana.text, "the plant admin's rail says booked").toMatch(/\bbooked\b/);
  expect(dana.text, "the plant admin's rail has no brackets").not.toMatch(/\(/);

  // Ana cannot read Line 2, and is told the place and the hours -- not free, and not the job.
  expect(ana.text, "Ana's rail says booked, as the admin's does").toMatch(/\bbooked\b/);
  expect(ana.text, "and names the cell and the hours").toContain("(Cell 4, 6 am to 2 pm)");
  expect(ana.text, "never the parent line or the product").not.toMatch(/Line 2|Housing/);
  expect(ana.title, "the hover sentence says it in full").toContain(
    "Priya Shah is on Cell 4 in Line 2 today from 6 am to 2 pm.",
  );
});

/**
 * DEF-0069 (R-465, migration 0087): giving Ana MORE read access must not turn "booked" into
 * "free". With a read-only grant on Cell 4 (the place Priya is booked on, off Ana's Line 1
 * board) the rail used to read "Priya Shah ... free": the set of blocks elsewhere held only
 * places she CANNOT read and the board's window only the rows under Line 1. The server now
 * returns every block off the board's root, readable place or not, so the rail says the
 * same with the grant as without it. The grant is added and removed inside the case (the
 * tester suspected the 201t flake of this very read, under another spec's grant).
 */
test("R-465 / DEF-0069: Ana's rail says Priya Shah is booked (Cell 4, 6 am to 2 pm) with a read-only grant on Cell 4 exactly as without it", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const dana = await signedInClient(PLANT_A_ADMIN);
  const nodes = await loadPlantANodes(dana);
  const cell4 = nodes.cellIdByName.get("Cell 4");
  if (!cell4) throw new Error("no such cell in Plant A: Cell 4");
  const org = await dana.from("nodes").select("org_id").eq("id", cell4).single();
  if (org.error) throw new Error(`reading Cell 4's company: ${org.error.message}`);
  const ANA = "a0000000-0000-0000-0000-000000000002";
  const without = await priyaOnTheRail(browser, "ana@example.test");
  let withGrant: RailReading | null = null;
  try {
    const granted = await dana.from("profile_grants").insert({
      profile_id: ANA,
      node_id: cell4,
      org_id: String(org.data.org_id),
      role: "viewer",
    });
    if (granted.error) throw new Error(`giving Ana the viewer grant: ${granted.error.message}`);
    withGrant = await priyaOnTheRail(browser, "ana@example.test");
  } finally {
    const { error } = await dana
      .from("profile_grants")
      .delete()
      .eq("profile_id", ANA)
      .eq("node_id", cell4)
      .eq("role", "viewer");
    if (error) console.error(`TAKING ANA'S VIEWER GRANT BACK FAILED: ${error.message}`);
  }
  for (const [label, reading] of [
    ["without the grant", without],
    ["with the grant", withGrant],
  ] as const) {
    expect(reading?.text, `Ana's rail ${label} says booked`).toMatch(/\bbooked\b/);
    expect(reading?.text, `and never free ${label}`).not.toMatch(/\bfree\b/);
    expect(reading?.text, `and names the cell and the hours ${label}`).toContain(
      "(Cell 4, 6 am to 2 pm)",
    );
    expect(reading?.title, `the hover sentence says it in full ${label}`).toContain(
      "Priya Shah is on Cell 4 in Line 2 today from 6 am to 2 pm.",
    );
  }
  const left = await dana
    .from("profile_grants")
    .select("node_id")
    .eq("profile_id", ANA)
    .eq("node_id", cell4);
  expect(left.data ?? [], "Ana's viewer grant is gone").toEqual([]);
});

test("R-465: at the rail's narrowest Priya Shah's name and word stay readable and the brackets give way", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ana = await priyaOnTheRail(browser, "ana@example.test", -2000);
  expect(ana.text).toContain("Priya Shah");
  expect(ana.text).toMatch(/\bbooked\b/);
  expect(ana.title).toContain("Cell 4 in Line 2 today from 6 am to 2 pm.");
});

/**
 * The date FORMAT a header string is in, independent of the week it names.
 * Both people compared are pinned to the same Monday, so equal formats give
 * byte-equal strings; this reduces the comparison to the shape and keeps the
 * failure message about the format rather than the date.
 */
function formatShapeOf(headerDate: string): string {
  return headerDate.replace(/\d/g, "#");
}
