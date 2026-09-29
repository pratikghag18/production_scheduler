import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON } from "./env";
import { buildSentences, type Sentence } from "./walk/sentences";
import { buildSentences2 } from "./walk/sentences2";
import {
  signedInClient,
  loadPlantANodes,
  operatorId,
  productId,
  clearWindow,
  waitForAssignment,
  waitForAssignmentGone,
  assignmentsStartingInWindow,
  runsStartingInWindow,
  parseTimerange,
  plantAAssignments,
  plantARuns,
  clearAbsencesSince,
  waitForAbsence,
  PASSWORD,
  PLANT_A_ADMIN,
  plantZone,
  type Db,
} from "./walk/db";
import { walkDayInZone, addDaysToIso, clockMsInZone } from "./walk/time";
import { fillWindowStart } from "./boardWindow";

const isoPlusDays = addDaysToIso;

/**
 * S61-c (docs/agent-briefs/s61-c-typed-walk-spec-brief.md) -- the typed half
 * of a walk as a Playwright spec: drives the REAL bar on the REAL board and
 * asserts each answer, so the maintainer is handed only what this has
 * already passed. `e2e/walk/sentences.ts` is the ordered sentence list (the
 * data); this file is the runner, the setup/teardown door, and the
 * database/trace assertions.
 *
 * Skips without a backend, same shape as every other signed-in spec here.
 */
test.skip(!hasRealBackend, NO_BACKEND_REASON);

const ADMIN = PLANT_A_ADMIN;

/**
 * S71-n (docs/agent-briefs/s71-n-second-walk-list-brief.md): a SECOND
 * sentence list, `e2e/walk/sentences2.ts`, proved by this SAME spec rather
 * than a copy of it. Read once at module top, default 1 (the first list,
 * unchanged). `WALK_SET=2 npx playwright test e2e/typedWalk.spec.ts`
 * (PowerShell: `$env:WALK_SET="2";` first) selects the second.
 */
const WALK_SET = process.env.WALK_SET === "2" ? 2 : 1;

// F-182: the walk runs on a day of its own -- the Monday of NEXT week on
// Plant A's clock -- never on the day the board opens on. Its last two
// sentences clear every block on that day, and until 22 Sept that day was
// today: every run emptied the maintainer's own board, their morning's
// overtime block included. Every sentence that names a day now says this
// date (entry 19's own shape); the board is moved here before the first
// sentence; and nothing before this day is ever read or cleared.
//
// F-190: every day and instant below is built from the PLANT'S zone, read
// from the server at setup (`plantZone`, the same resolver the app and
// `board_window` use) -- the walk carried America/Chicago as a constant from
// its brief, the 21 Sept reset left the demo plant with no zone at all (UTC,
// `board_window`'s own default), and every block the walk wrote landed five
// hours off. A premise about the world is read from the database (F-181).
// `initWalkDays` fills these before the first sentence; nothing reads them
// earlier.
let ZONE = "UTC";
let WALK_DAY = "";
let TOMORROW = "";
// Within the setup/teardown window (walk day .. walk day + 8) but past the
// board's own default 3-day window (walk day, +1, +2) -- so it is
// guaranteed off-board for entry 19's own day-off-board move (R-455, no
// button since 24 Sept), and still cleaned up at the end.
let FAR = "";
let CLEAN_FROM_MS = 0;
let CLEAN_TO_MS = 0;
let WALK_DAY_START_MS = 0;
let WALK_DAY_END_MS = 0;
let SENTENCES: Sentence[] = [];

/** `hh:mm` on `iso` in the plant's own zone, as epoch ms -- what
 *  `assignments.timerange` stores a sentence's clock time as. */
const wallMs = (iso: string, hh: number, mm: number): number => clockMsInZone(iso, ZONE, hh, mm);

function initWalkDays(zone: string): void {
  ZONE = zone;
  WALK_DAY = walkDayInZone(zone);
  TOMORROW = isoPlusDays(WALK_DAY, 1);
  FAR = isoPlusDays(WALK_DAY, 7);
  CLEAN_FROM_MS = wallMs(WALK_DAY, 0, 0);
  CLEAN_TO_MS = wallMs(isoPlusDays(WALK_DAY, 9), 0, 0);
  WALK_DAY_START_MS = wallMs(WALK_DAY, 0, 0);
  WALK_DAY_END_MS = wallMs(TOMORROW, 0, 0);
  SENTENCES =
    WALK_SET === 2
      ? buildSentences2({ day: WALK_DAY, tomorrow: TOMORROW, far: FAR })
      : buildSentences({ day: WALK_DAY, tomorrow: TOMORROW, far: FAR });
}

async function signIn(page: Page, email: string, path_ = "/"): Promise<void> {
  await page.goto(`/sign-in?redirect=${encodeURIComponent(path_)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(path_, { timeout: 15_000 });
}

function statusLine(page: Page): Locator {
  return page.locator('p[aria-live="polite"]');
}

/**
 * DEF-0042 (S194-C fix): R-452 (23 Sept, 1d8d82c) seeds every block inside
 * its OWN OPERATOR'S home band, and Shift 3 is 22:00-06:00 -- so the demo
 * seed's own Sunday night block, on the last day of "the current week" the
 * seed anchors on, runs from Sunday 22:00 to Monday 06:00, and the walk's
 * own day is, by construction (`walkDayInZone`), the very next Monday. The
 * walk's first sentence expects Cell 4 already empty and instead finds
 * Priya Shah's spilled-over block; the same spill inflated the "what the
 * walk left on the walk day" count from 10 to 14 (DEF-0042's own repro).
 *
 * `clearWindow` above only DELETES rows whose range STARTS inside [walk day,
 * walk day + 9) -- deliberately: nothing before the walk day is ever read or
 * cleared (F-182), because that earlier day may be one a person is using
 * right now. A spillover row's range STARTS the day before that window, so
 * `clearWindow` never sees it, and deleting it anyway would be wrong besides
 * -- Sunday's 22:00-24:00 part is real, seeded, in-band time nobody asked to
 * remove. So this TRIMS instead: every assignment and run on the walk's own
 * places whose range starts before the walk day's midnight and ends after it
 * has its UPPER bound moved back to exactly that midnight. Sunday keeps its
 * 22:00-24:00; the walk's Monday starts empty; nothing before midnight is
 * touched at all -- the same three database tables (`assignments`, `runs`)
 * and the same authenticated `dana` door the rest of this file's setup uses,
 * never a second copy of "what counts as this plant's own places."
 *
 * Read migration 20260911000079 before worrying this refuses: "a run can
 * legitimately be shrunk with its crew left outside it ... so 'inside its
 * run' is NOT an invariant of the table today" -- trimming a run's own upper
 * bound independently of its assignments' is an accepted shape already, not
 * a new one. `assignments_resize_guard` (0082) re-asks `supervisor_shift_
 * allows`, `check_eligibility` and `absence_overlap` on any authenticated
 * UPDATE that moves a `timerange` -- `supervisor_shift_allows` returns true
 * unconditionally for an admin grant (no `plans_shift_id`, `app_planning_
 * grant_for`), and the demo's own `eligibility_policy` is `warn` (silent,
 * never refused) for the other two, so this shrink-only write goes through
 * for `dana` (`PLANT_A_ADMIN`) exactly as `clearWindow`'s own deletes do.
 */
async function trimSpillIntoWalkDay(
  dana: Db,
  nodeIds: string[],
  walkDayStartMs: number,
): Promise<{ assignments: number; runs: number }> {
  const walkDayStartIso = new Date(walkDayStartMs).toISOString();
  const spills = <T extends { timerange: string }>(rows: T[]): T[] =>
    rows.filter((r) => {
      const { startMs, endMs } = parseTimerange(r.timerange);
      return startMs < walkDayStartMs && endMs > walkDayStartMs;
    });

  const spillingAssignments = spills(await plantAAssignments(dana, nodeIds));
  for (const a of spillingAssignments) {
    const { startMs } = parseTimerange(a.timerange);
    const { error } = await dana
      .from("assignments")
      .update({ timerange: `[${new Date(startMs).toISOString()},${walkDayStartIso})` })
      .eq("id", a.id);
    if (error) {
      throw new Error(
        `DEF-0042: trimming spilled assignment ${a.id} at the walk day's midnight: ${error.message}`,
      );
    }
  }

  const spillingRuns = spills(await plantARuns(dana, nodeIds));
  for (const r of spillingRuns) {
    const { startMs } = parseTimerange(r.timerange);
    const { error } = await dana
      .from("runs")
      .update({ timerange: `[${new Date(startMs).toISOString()},${walkDayStartIso})` })
      .eq("id", r.id);
    if (error) {
      throw new Error(
        `DEF-0042: trimming spilled run ${r.id} at the walk day's midnight: ${error.message}`,
      );
    }
  }

  return { assignments: spillingAssignments.length, runs: spillingRuns.length };
}

/**
 * S63-a review fix (CP-5, the maintainer's own screenshot review, 17 Sept):
 * once a turn is filed (`commandConversation.ts`'s own `fileTurn`), the live
 * status line goes back to empty the SAME tick the write settles -- for a
 * REAL write against the local stack that can be fast enough that this
 * spec's own poll never catches the readout live at all. The answer is just
 * as real read from the thread's own last turn instead (its own `asked`
 * bubble for a plain readout the resolver worded itself -- `nothing_to_do`
 * -- and its own result bubble, `Written: <readout>`, for an ordinary write,
 * prefix stripped since no regex here was ever written to expect it), so
 * `expectAnswered` below checks both in one poll rather than the live line
 * alone.
 *
 * Reviewer fix (S63 review): a bare "last turn" read has no proof it BELONGS
 * to the sentence just submitted -- a slow write racing a fast subsequent
 * poll could still be reading the PREVIOUS turn's own result and pass for
 * the wrong reason. `expectAnswered` below takes a `ThreadSnapshot` (the
 * turn count) from BEFORE the sentence was submitted and only trusts the
 * thread once that count has actually grown AND the new last turn's own
 * `heard` bubble is the exact sentence just typed -- otherwise it keeps
 * polling the live line alone.
 */
/**
 * The FILED turns only. The bar draws the turn still in flight inside the
 * same thread body with the same `.turn` class (so its two bubbles space the
 * way a filed turn's do), and that live turn is the one with the
 * `aria-live` status paragraph in it -- so it is excluded here, or a
 * snapshot taken while a previous turn's live line still stood counted one
 * too many and the thread was never trusted (session 178, the typed walk
 * failing on the first sentence after a lot).
 */
function threadTurns(page: Page): Locator {
  return page.locator('[class*="threadBody"] > [class*="turn"]:not(:has([aria-live]))');
}

interface ThreadSnapshot {
  count: number;
}

async function snapshotThread(page: Page): Promise<ThreadSnapshot> {
  return { count: await threadTurns(page).count() };
}

/**
 * The text of `loc` if it is on the page NOW, else null -- never a wait.
 *
 * Session 178 (the developer, after the walk failed twice on the same two
 * readouts): a filed turn does not always carry every bubble. A plain
 * readout such as "Cell 4 has nobody on it …" has an `asked` bubble and NO
 * result bubble (`turnResultLine` is "" for it, and the bar renders none),
 * so `locator.textContent()` on the missing one waited with no timeout
 * inside `expectAnswered`'s poll until the whole entry's budget was gone,
 * and the walk reported the bar had said "" -- while the trace file showed
 * the right answer filed within ten seconds. `count()` does not wait.
 */
async function textIfPresent(loc: Locator): Promise<string | null> {
  if ((await loc.count()) === 0) return null;
  return loc
    .first()
    .textContent({ timeout: ACTION_TIMEOUT_MS })
    .catch(() => null);
}

async function heardTextOfLastTurn(page: Page): Promise<string | null> {
  const turn = threadTurns(page).last();
  if ((await turn.count()) === 0) return null;
  return textIfPresent(turn.locator('[data-side="you"]'));
}

async function lastFiledTexts(page: Page): Promise<string[]> {
  const turn = threadTurns(page).last();
  if ((await turn.count()) === 0) return [];
  const asked = await textIfPresent(turn.locator('[class*="turnBoard"]'));
  const result = await textIfPresent(turn.locator('[class*="turnResult"]'));
  const out: string[] = [];
  if (asked) out.push(asked);
  if (result) out.push(result.startsWith("Written: ") ? result.slice("Written: ".length) : result);
  return out;
}

/**
 * Replaces a bare `expect(statusLine(page)).toHaveText(pattern, ...)` for a
 * plain readout/`nothing_to_do` regex -- the ONE shape CP-5 can file (and
 * clear the live line for) before this spec's own poll runs again. A
 * standing QUESTION never auto-files (nothing has answered it yet), so
 * `entry.expect.question` above this function's own two call sites keeps
 * using `statusLine` directly -- there is nothing for it to have moved to.
 *
 * `before` and `heard` are the STALE-TURN guard: the thread is only ever
 * trusted once `threadTurns(page).count()` exceeds `before.count` (a NEW
 * turn actually landed, not the one that already stood there) AND that new
 * turn's own `heard` bubble equals `heard` (the sentence THIS call is
 * waiting on, never a leftover from the entry before it).
 */
async function expectAnswered(
  page: Page,
  pattern: RegExp,
  before: ThreadSnapshot,
  heard: string,
): Promise<void> {
  await expect(async () => {
    const live = await currentStatusText(page);
    if (pattern.test(live)) return;
    const afterCount = await threadTurns(page).count();
    if (afterCount > before.count) {
      const lastHeard = await heardTextOfLastTurn(page);
      if (lastHeard === heard) {
        const filed = await lastFiledTexts(page);
        if (filed.some((text) => pattern.test(text))) return;
      }
    }
    throw new Error(
      `neither the live status ("${live}") nor a new thread turn for ${JSON.stringify(heard)} matched ${pattern}`,
    );
  }).toPass({ timeout: ENTRY_TIMEOUT_MS, intervals: [250] });
}

/** The bar's own candidate-button strip (`CommandBar.tsx`: a `div` whose
 *  CSS-Modules class carries "candidates", rendered right after the status
 *  line) -- scoped so a near-miss/"Which part?" button lookup by product
 *  name (e.g. "Housing A") can never match an unrelated board element whose
 *  own accessible name happens to CONTAIN that product name too (an
 *  existing assignment chip reads "<person> direct assignment on Housing A,
 *  08:00 to 12:00", a substring match away from ambiguity). Same
 *  `[class*="..."]` convention `roleWalk.spec.ts` uses for the shift layer's
 *  own local class names. */
function candidateButtons(page: Page): Locator {
  return page.locator('[class*="candidates"]').getByRole("button");
}

/** Signs in as Dana, waits for the board, moves it to the walk's own day
 *  (F-182: never today), and opens the corner launcher (S48-a: the bar lives
 *  behind it). */
async function openBoard(page: Page): Promise<void> {
  await signIn(page, ADMIN, "/");
  const firstTrack = page.getByLabel(/press Enter to create/).first();
  await expect(firstTrack).toBeVisible({ timeout: 20_000 });
  await fillWindowStart(page, WALK_DAY);
  await expect(firstTrack).toBeVisible({ timeout: 20_000 });
  await ensureBarOpen(page);
}

/**
 * Every Playwright ACTION in this spec carries this explicitly. The project
 * config sets no `actionTimeout`, and Playwright's own default for one is 0
 * -- "wait forever" -- so a `fill`/`press` against a bar that is not there
 * any more (the launcher closed, the board remounted) hangs until the whole
 * test's budget runs out with nothing said about where it stopped. That is
 * exactly how a run of this spec stalled for a quarter of an hour on the
 * twelfth sentence. A bounded action fails where it happens instead.
 */
const ACTION_TIMEOUT_MS = 30_000;

/**
 * The board's own launcher (S48-a) -- the bar lives behind it. Called ONLY
 * where the panel may genuinely have closed: once to open it, and after an
 * Escape (`CommandLauncher.tsx`: "Esc closes", and `CommandBar`'s own third
 * Escape calls `onEscapeIdle`, which is that same `close`).
 *
 * NOT called before an ordinary `submit`. `isVisible()` does not wait, so
 * during a board re-render it can answer "no" about a panel that is open --
 * and the launcher button TOGGLES, so "re-opening" then shuts the panel and
 * the very next keystroke has nowhere to land. That is not a hypothetical:
 * putting this call in `submit` cost a run on its second sentence, where
 * `fill` found the input and `press` a moment later did not.
 */
async function ensureBarOpen(page: Page): Promise<void> {
  const input = page.locator("#command-bar-input");
  try {
    await expect(input).toBeVisible({ timeout: 5_000 });
    return;
  } catch {
    // Genuinely closed -- only now is the toggle safe to press.
  }
  // The board itself first: a dev-server full reload drops the page back on
  // "/" with nothing mounted, and clicking a launcher that is not there yet
  // is a thirty-second wait that says nothing useful.
  await expect(page.getByLabel(/press Enter to create/).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Tell the board" }).click({ timeout: ACTION_TIMEOUT_MS });
  await expect(input).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
}

/**
 * Types `text` into the bar and presses Enter.
 *
 * The Enter goes through `page.keyboard`, NOT `locator.press`, and that is
 * the whole point of this helper. `locator.press` runs Playwright's
 * actionability checks first, and one of them is STABILITY -- the element's
 * box must be unchanged across two animation frames. The board behind this
 * panel re-renders continuously while a lot is writing ("Working…"), so the
 * input is attached, visible, enabled and focused and still never "stable",
 * and the press waits out its whole budget. That is not a guess: a run died
 * on the fifteenth sentence with Playwright's own log reading `locator
 * resolved to <input … value="yes" id="command-bar-input">` and a timeout
 * underneath it. `keyboard.press` sends the key to whatever has focus and
 * asks no such question, which is exactly the right question to not ask
 * about a keystroke.
 */
async function submit(page: Page, text: string): Promise<void> {
  const input = page.locator("#command-bar-input");
  await input.fill(text, { timeout: ACTION_TIMEOUT_MS });
  await input.focus({ timeout: ACTION_TIMEOUT_MS });
  await page.keyboard.press("Enter");
}

async function currentStatusText(page: Page): Promise<string> {
  // Bounded for the same reason every action below is: the status paragraph
  // only exists while the bar is mounted, and an unbounded `textContent`
  // against a closed panel waits for the whole test's budget in silence.
  return ((await statusLine(page).textContent({ timeout: ACTION_TIMEOUT_MS })) ?? "").trim();
}

/**
 * How long one sentence may take on the bar before the spec calls it a
 * failure. Deliberately generous: this walk drives the REAL local model
 * container, which answers a sentence in roughly 15-20 seconds on this
 * machine, and `readSentence.ts`'s own `DEFAULT_TIMEOUT_MS` (20s) only
 * starts the fall-back to the rules AFTER that -- so a single sentence can
 * legitimately sit on "Reading…" for the better part of a minute when the
 * container is queuing an aborted request behind the live one. A 30s budget
 * timed out mid-walk on the sixth sentence for exactly that reason, and a
 * 120s one on the third, the run where the bar reported "read by the rules
 * (the model service is off)" -- a container hiccup, a fact about the
 * machine, not about the bar.
 */
const ENTRY_TIMEOUT_MS = 180_000;

interface EntryResult {
  say: string;
  barSaid: string;
  written: string;
  note?: string;
  /** Set when the bar answered this sentence with something `expect` does
   *  not match -- the finding itself, carried to the end of the run. */
  unpredicted?: string;
  /** For a `{ button, then }` entry: what the bar showed once the button had
   *  been pressed and before any typed answer -- the lot's own listing, for
   *  an entry that then declines it. */
  listing?: string;
}

/**
 * A status-line expectation that FAILS is a finding about the bar, not a
 * reason to abandon the other twenty sentences: the brief's whole point is
 * that the maintainer is handed a list every entry of which has been run, so
 * a truncated walk is worth very little. So a mismatch here is recorded
 * verbatim (`unpredicted`) and the walk carries on to the next sentence --
 * and the test FAILS at the end on every row that carries one, with the full
 * table already printed. Nothing is weakened by this: every `expect` stands
 * exactly as written, and every DATABASE assertion in the walk below is
 * still hard and still throws on the spot, so a sentence that claimed a
 * write it did not make still stops the run where it stands.
 *
 * Escape (the bar's own cancel, `CommandBar.tsx`'s keydown handler) closes
 * the standing question so the NEXT sentence starts clean, and closes the
 * open trace entry as a cancel (`answered: "escape"`) rather than leaving it
 * for the next `startTrace` to flush with a null -- which would turn one
 * finding into two.
 */
async function recordMismatch(page: Page, entry: Sentence, what: string): Promise<EntryResult> {
  const barSaid = await currentStatusText(page);
  // What the bar was actually OFFERING when it disagreed -- a question whose
  // buttons are not the ones expected reads as "no button came" otherwise,
  // and the finding is then unanswerable without another whole run.
  const offered = await candidateButtons(page)
    .allTextContents()
    .catch(() => [] as string[]);
  await page.locator("#command-bar-input").focus({ timeout: ACTION_TIMEOUT_MS });
  await page.keyboard.press("Escape");
  await ensureBarOpen(page);
  return {
    say: entry.say,
    barSaid,
    written: barSaid,
    note: entry.note,
    unpredicted: `${what}\n  expected: ${String(
      typeof entry.expect === "object" && "button" in entry.expect
        ? (entry.expect.question ?? `a candidate button labelled "${entry.expect.button}"`)
        : entry.expect,
    )}\n  the bar said: ${JSON.stringify(barSaid)}\n  buttons offered: ${JSON.stringify(offered)}`,
  };
}

/** Drives one sentence: types it, waits for the bar to settle on `expect`,
 *  then either presses the named button (and waits for `.then`) or, if
 *  `answer` is set, types it as a second turn. Returns what the bar showed
 *  right after `say` (`barSaid`, the table's own middle column) and
 *  whatever it showed once the turn is fully over (`written`). */
async function runEntry(page: Page, entry: Sentence): Promise<EntryResult> {
  // Progress, timestamped: a walk this long that stops somewhere must say
  // WHICH sentence it stopped on without waiting for the table at the end.
  console.log(`[${new Date().toISOString()}] SAY: ${entry.say}`);
  // Reviewer fix (S63 review): taken BEFORE the sentence is even submitted,
  // so `expectAnswered` below can tell a genuinely NEW turn (this sentence's
  // own) apart from a stale one already sitting in the thread.
  const before = await snapshotThread(page);
  await submit(page, entry.say);
  if (typeof entry.expect === "object" && "button" in entry.expect) {
    const button = candidateButtons(page).filter({ hasText: entry.expect.button }).first();
    // `orDirect`: the bar may skip the question (entry 10's model gap comes
    // and goes between runs). If the direct readout lands first, the turn is
    // over here, and the table says so in its middle column.
    if (entry.expect.orDirect !== undefined) {
      const direct = entry.expect.orDirect;
      let landedDirect = false;
      try {
        await expect(async () => {
          if (direct.test(await currentStatusText(page))) {
            landedDirect = true;
            return;
          }
          if (await button.isVisible()) return;
          throw new Error("neither the question nor the direct readout yet");
        }).toPass({ timeout: ENTRY_TIMEOUT_MS, intervals: [300] });
      } catch {
        return recordMismatch(
          page,
          entry,
          "neither the question this sentence should have raised nor its direct readout came",
        );
      }
      if (landedDirect) {
        const barSaid = await currentStatusText(page);
        const written = await answerIfAny(page, entry, barSaid);
        return {
          say: entry.say,
          barSaid,
          written,
          note: `${entry.note ?? ""} [direct, no question]`,
        };
      }
    }
    try {
      await expect(button).toBeVisible({ timeout: ENTRY_TIMEOUT_MS });
      if (entry.expect.question !== undefined) {
        await expect(statusLine(page)).toHaveText(entry.expect.question, {
          timeout: ENTRY_TIMEOUT_MS,
        });
      }
    } catch {
      return recordMismatch(
        page,
        entry,
        "the question this sentence should have raised never came",
      );
    }
    const barSaid = await currentStatusText(page);
    // Same stability problem `submit` describes, one step further on: a
    // plain click waits for the button's box to stop moving, and the board
    // behind the panel does not always oblige. The button has just been
    // asserted visible, so falling back to a forced click (which skips the
    // actionability checks, not the element lookup) is safe here.
    await button.click({ timeout: ACTION_TIMEOUT_MS }).catch(async () => {
      await button.click({ timeout: ACTION_TIMEOUT_MS, force: true });
    });
    try {
      await expectAnswered(page, entry.expect.then, before, entry.say);
    } catch {
      const after = await recordMismatch(page, entry, `after pressing "${entry.expect.button}"`);
      return { ...after, barSaid };
    }
    // A button-form entry may still take a typed answer: the second list's
    // "split Tom Baker's block" goes through a Did-you-mean button to reach
    // its own lot, then answers it "yes". (No day_off_board entry does this
    // any more -- R-455 moves and reruns with no button at all, so those are
    // plain `RegExp` entries now, handled by the non-button branch below.)
    const listing = await currentStatusText(page);
    const written = await answerIfAny(page, entry, listing);
    return { say: entry.say, barSaid, written, note: entry.note, listing };
  }
  try {
    await expectAnswered(page, entry.expect, before, entry.say);
  } catch {
    return recordMismatch(page, entry, "the bar answered this sentence with something else");
  }
  const liveBarSaid = await currentStatusText(page);
  const written = await answerIfAny(page, entry, liveBarSaid);
  // S194-C follow-up (28 Sept): CP-5/S63-a's own doc on `expectAnswered`
  // above says the live status line "goes back to empty the SAME tick the
  // write settles" for a plain readout with no further `answer` -- exactly
  // this branch's own no-`answer` shape (S47's "runs on its own readout, no
  // yes", and every `nothing_to_do`). `expectAnswered` already proved the
  // answer through the FILED thread turn in that case, never the live line.
  // An empty `barSaid` here does NOT mean the bar said nothing (R-434/R-459:
  // the bar always answers); it means the walk's own report asked the wrong
  // place. Falls back to the same filed text `expectAnswered` itself already
  // trusted -- only when there is no `answer` to wait on, since an entry
  // THAT has one is waiting on a STANDING question, which never auto-files
  // (nothing has answered it yet) and so is never empty here for that
  // reason. `answerIfAny` above already ran on the RAW live value, unchanged,
  // so this fallback affects only what is reported, never the wait logic.
  const barSaid =
    liveBarSaid !== "" || entry.answer !== undefined
      ? liveBarSaid
      : ((await lastFiledTexts(page)).at(-1) ?? liveBarSaid);
  return {
    say: entry.say,
    barSaid,
    written: entry.answer === undefined ? barSaid : written,
    note: entry.note,
  };
}

/** Types `entry.answer`, if it has one, and waits for the turn to be over.
 *  The turn is over when the status has moved off `standing` AND is not one
 *  of the bar's own two in-progress words: "Working…" stands for the whole
 *  of a lot's run (`CommandBar.tsx`'s own comments on `runLotNow`), so
 *  returning the moment the text merely CHANGED handed the next sentence a
 *  lot that was still writing -- and the database read after it raced the
 *  rows it was checking for. Returns what the bar shows once it is over. */
async function answerIfAny(page: Page, entry: Sentence, standing: string): Promise<string> {
  if (entry.answer === undefined) return standing;
  await submit(page, entry.answer);
  await expect(async () => {
    const now = await currentStatusText(page);
    expect(now).not.toBe(standing);
    expect(now).not.toBe("Working…");
    expect(now).not.toBe("Reading…");
  }).toPass({ timeout: ENTRY_TIMEOUT_MS, intervals: [300] });
  return currentStatusText(page);
}

test.describe.serial("the typed command bar walks the real board (S61-c)", () => {
  test("every sentence in the catalogue runs on the real bar, its writes prove out in the database, and the trace records it", async ({
    page,
  }) => {
    // Around two dozen sentences (26 for WALK_SET 1 since the R-461 proof
    // pair, S194-C follow-up, added four), each a real round trip to the
    // local model container at roughly 15-20s a turn, plus the database
    // polls between them: the walk's own floor is about ten minutes on this
    // machine and a single slow turn (`ENTRY_TIMEOUT_MS`) can add two more.
    // 540s was under the floor and timed the test out mid-walk; the four new
    // entries add well under two more minutes, still comfortably inside the
    // existing ceiling below.
    test.setTimeout(2_400_000);

    // ------------------------------------------------------------------
    // Setup, through the database (brief §1) -- the same authenticated
    // supabase-js door `invite.spec.ts` builds, reused via `e2e/walk/db.ts`.
    // ------------------------------------------------------------------
    const dana = await signedInClient(ADMIN);
    const nodes = await loadPlantANodes(dana);
    // The plant's zone first (F-190): every day and instant below hangs off it.
    initWalkDays(await plantZone(dana, nodes.plantId));
    console.log(`walk day ${WALK_DAY} in ${ZONE} (today's board is never touched: F-182)`);
    const cellId = (name: string): string => {
      const id = nodes.cellIdByName.get(name);
      if (!id) throw new Error(`no such cell in Plant A: ${name}`);
      return id;
    };
    const allCellIds = [...nodes.cellIdByName.values()];

    await clearWindow(dana, nodes.allNodeIds, CLEAN_FROM_MS, CLEAN_TO_MS);
    // DEF-0042: the seed's own Sunday-night block (Shift 3, 22:00-06:00) can
    // run into the walk's own Monday -- trimmed here, not deleted, and never
    // reaching before the walk day's own midnight (see the function's own
    // comment for why `clearWindow`'s delete-only window cannot do this).
    const spillTrim = await trimSpillIntoWalkDay(dana, nodes.allNodeIds, WALK_DAY_START_MS);
    console.log(
      `trimmed ${spillTrim.assignments} assignment(s) and ${spillTrim.runs} run(s) that spilled ` +
        `from before ${WALK_DAY} into it (DEF-0042)`,
    );

    const opId = {
      sam: await operatorId(dana, "Sam Patel"),
      maria: await operatorId(dana, "Maria Lopez"),
      john: await operatorId(dana, "John Kim"),
      priya: await operatorId(dana, "Priya Shah"),
      tom: await operatorId(dana, "Tom Baker"),
      lena: await operatorId(dana, "Lena Novak"),
    };
    // S194-C follow-up (28 Sept): "<person> is off <day>" now RECORDS the
    // absence (R-409 amended); a leftover row from a previous run (this one
    // died mid-way, or simply finished) would make the SAME sentence answer
    // `absence_overlap` ("already has an absence recorded") on the next run
    // instead of recording cleanly -- breaking R-433's own "green twice over
    // the same data." Cleared here, before any sentence runs, the same
    // reason `clearWindow` runs first; and again in the teardown below.
    await clearAbsencesSince(dana, Object.values(opId), WALK_DAY);
    const prodId = {
      housingA: await productId(dana, "Housing A"),
      bracketA: await productId(dana, "Bracket A"),
      commonFastener: await productId(dana, "Common Fastener"),
      line1SubA: await productId(dana, "Line 1 Subassembly A"),
      area2FrameA: await productId(dana, "Area 2 Frame A"),
    };
    void prodId; // read for clarity/documentation of the fixture; ids matched by name in the checks below

    const table: EntryResult[] = [];
    const surprises: string[] = [];
    // S71-n: entries whose trace line is EXPECTED to carry a null
    // `answered` -- discovered live on the second list's own first green
    // run (24 Sept), a swap's `inLot: true` certificate refusal (entry 13
    // here: "swap Lena Novak and Priya Shah"), which offers NO candidate and
    // NO yes/no of its own to answer at all -- unlike a plain `nothing_to_do`
    // refusal (entry 1, both lists), whose own single turn is filed as its
    // own answer. Set inside whichever WALK_SET branch below applies; the
    // trace loop at the end reads this set instead of a single block-scoped
    // name so it works for either list.
    //
    // The first list's own entry 20 (`lenaShortBlock` below) used to belong
    // here too (F-182: declined by silence, a standing day_off_board
    // QUESTION with no button pressed and no text typed). R-455 (24 Sept,
    // lane S72-b, d5a8829) changed `day_off_board` itself into a READOUT
    // (`status.moving`), and a readout fills in `answered: "auto"` the
    // instant it is set (`traceQuestionStatus`, CommandBar.tsx) whether or
    // not a person ever presses anything -- so EVERY entry that crosses a
    // day_off_board move now got a real `answered` value, that entry
    // included (repointed, S72-d review, off the real "today" write F-182
    // itself was about). It is no longer added to this set.
    //
    // R-463 (29 Sept) moved entry 20 again: it now names its own day
    // explicitly (`sentences.ts`'s own long comment on the entry) and never
    // crosses a day_off_board move at all any more -- it is an ordinary
    // single-sentence write like entry 2, proven by the DB read just below
    // its `runEntry` call, same shape as entries 18/19.
    const answerlessEntries = new Set<Sentence>();

    try {
      // ------------------------------------------------------------------
      await openBoard(page);

      if (WALK_SET === 1) {
        const [
          clearEmptyCell,
          nightSetupKeep,
          nightClearKeep,
          nightSetupRemove,
          nightClearRemove,
          assignWithPart,
          pluralNearMiss,
          realNearMiss,
          noPart,
          bookingHeadcount,
          endOfShiftAmbiguous,
          tomSetup,
          adjustEnd,
          swapRefused,
          split,
          adjustExtend,
          headcountForm,
          lenaSetup,
          swapSuccess,
          copyToTomorrow,
          everyWeekdayNo,
          tomOverride,
          dayOffBoardFar,
          lenaShortBlock,
          clearArea1,
          clearArea2,
        ] = SENTENCES;
        // `lenaShortBlock` (entry 20) no longer belongs in
        // `answerlessEntries` -- see that Set's own comment above (R-455
        // gives it a real `answered`; R-463 later turned it into an
        // ordinary dated write with no day_off_board move at all).

        // 1. Clear of an empty cell.
        table.push(await runEntry(page, clearEmptyCell));

        // 1b-1e. R-461's own end-to-end proof (28 Sept, S194-C follow-up):
        // Cell 5 and Cell 6 are still wholly untouched here (entries 8/14
        // below are the first to reach them, both daytime hours that never
        // overlap a 10 pm-6 am block or its day-after remnant), so each
        // setup+clear pair is a lot of exactly one change -- the other_day_
        // part question's own Yes/No answer runs it directly (S47), no
        // second "Ready to do N things" to wait on.
        //
        // 1b. Setup: Priya's own Shift 3 block, Cell 5.
        table.push(await runEntry(page, nightSetupKeep));
        await waitForAssignment(dana, {
          operatorId: opId.priya,
          nodeId: cellId("Cell 5"),
          startMs: wallMs(WALK_DAY, 22, 0),
          endMs: wallMs(TOMORROW, 6, 0),
        });

        // 1c. Answered No: the block survives, TRIMMED to the day-after's
        // own part -- its new range starts exactly at that day's midnight
        // (R-461's `keep_after` fate, an edge move never a delete). Proves
        // the OTHER day's part (10 pm to midnight) was the one cleared.
        table.push(await runEntry(page, nightClearKeep));
        await waitForAssignment(dana, {
          operatorId: opId.priya,
          nodeId: cellId("Cell 5"),
          startMs: wallMs(TOMORROW, 0, 0),
          endMs: wallMs(TOMORROW, 6, 0),
        });

        // 1d. Setup: Maria's own Shift 3 block, Cell 6 -- the symmetric
        // case, answered the other way next.
        table.push(await runEntry(page, nightSetupRemove));
        await waitForAssignment(dana, {
          operatorId: opId.maria,
          nodeId: cellId("Cell 6"),
          startMs: wallMs(WALK_DAY, 22, 0),
          endMs: wallMs(TOMORROW, 6, 0),
        });

        // 1e. Answered Yes: the other day's part is cleared TOO, so the
        // whole crossing block is gone -- both days' worth, not trimmed.
        table.push(await runEntry(page, nightClearRemove));
        await waitForAssignmentGone(dana, {
          operatorId: opId.maria,
          nodeId: cellId("Cell 6"),
          startMs: wallMs(WALK_DAY, 22, 0),
          endMs: wallMs(TOMORROW, 6, 0),
        });

        // 2. Assign with a part.
        table.push(await runEntry(page, assignWithPart));
        await waitForAssignment(dana, {
          operatorId: opId.john,
          nodeId: cellId("Cell 3"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 12, 0),
        });

        // 3. Plural near-miss.
        table.push(await runEntry(page, pluralNearMiss));
        await waitForAssignment(dana, {
          operatorId: opId.priya,
          nodeId: cellId("Cell 4"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 12, 0),
        });

        // 4. Real near-miss ("Housing Pay" -> Housing A).
        table.push(await runEntry(page, realNearMiss));
        await waitForAssignment(dana, {
          operatorId: opId.maria,
          nodeId: cellId("Cell 4"),
          startMs: wallMs(WALK_DAY, 13, 0),
          endMs: wallMs(WALK_DAY, 15, 0),
        });

        // 5. No part named ("Which part?").
        table.push(await runEntry(page, noPart));
        await waitForAssignment(dana, {
          operatorId: opId.sam,
          nodeId: cellId("Cell 1"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 16, 0),
        });

        // 6. A booking with headcount -- a run, not an assignment.
        table.push(await runEntry(page, bookingHeadcount));
        {
          const { data, error } = await dana
            .from("runs")
            .select("id, planned_headcount, timerange")
            .eq("node_id", cellId("Cell 3"));
          expect(error, error?.message).toBeNull();
          const rows = (data ?? []) as {
            id: string;
            planned_headcount: number | null;
            timerange: string;
          }[];
          const hit = rows.find((r) => {
            const { startMs, endMs } = parseTimerange(r.timerange);
            return startMs === wallMs(WALK_DAY, 13, 0) && endMs === wallMs(WALK_DAY, 17, 0);
          });
          expect(hit, "the booked Bracket A run on Cell 3, 13:00-17:00, should exist").toBeTruthy();
          expect(hit!.planned_headcount).toBe(3);
        }

        // 7. "from 2 until end of shift" -- the model-gap case.
        const shiftResult = await runEntry(page, endOfShiftAmbiguous);
        table.push(shiftResult);
        {
          const literalReading = /02:00–06:00/.test(shiftResult.written);
          const branch = literalReading
            ? "02:00-06:00 (literal)"
            : "14:00-22:00 (the rules' own reading)";
          if (literalReading) {
            surprises.push(
              `"${endOfShiftAmbiguous.say}" was read literally as 02:00, not the rules' 14:00 -- ${branch}.`,
            );
          }
          const [startH, endH] = literalReading ? [2, 6] : [14, 22];
          await waitForAssignment(dana, {
            operatorId: opId.priya,
            nodeId: cellId("Cell 2"),
            startMs: wallMs(WALK_DAY, startH, 0),
            endMs: wallMs(WALK_DAY, endH, 0),
          });
        }

        // 8. Tom Baker's own setup block (off Line 1 -- no certification
        // needed), plumbing for the swap-refusal case.
        table.push(await runEntry(page, tomSetup));
        await waitForAssignment(dana, {
          operatorId: opId.tom,
          nodeId: cellId("Cell 6"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 14, 0),
        });

        // 9. Adjust: "end" shortens Sam's own Cell 1 block.
        table.push(await runEntry(page, adjustEnd));
        await waitForAssignment(dana, {
          operatorId: opId.sam,
          nodeId: cellId("Cell 1"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 14, 0),
        });

        // 10. The uncertified swap -- refused before the yes; nothing changes.
        table.push(await runEntry(page, swapRefused));
        await waitForAssignment(dana, {
          operatorId: opId.sam,
          nodeId: cellId("Cell 1"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 14, 0),
        });
        await waitForAssignment(dana, {
          operatorId: opId.tom,
          nodeId: cellId("Cell 6"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 14, 0),
        });

        // 11. A split.
        table.push(await runEntry(page, split));
        await waitForAssignmentGone(dana, {
          operatorId: opId.sam,
          nodeId: cellId("Cell 1"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 14, 0),
        });
        await waitForAssignment(dana, {
          operatorId: opId.sam,
          nodeId: cellId("Cell 1"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 13, 0),
        });
        await waitForAssignment(dana, {
          operatorId: opId.sam,
          nodeId: cellId("Cell 1"),
          startMs: wallMs(WALK_DAY, 13, 0),
          endMs: wallMs(WALK_DAY, 14, 0),
        });

        // 12. Adjust: "extend" John Kim's own Cell 3 block.
        table.push(await runEntry(page, adjustExtend));
        await waitForAssignment(dana, {
          operatorId: opId.john,
          nodeId: cellId("Cell 3"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 13, 0),
        });

        // 13. The headcount form, on the run booked in entry 6.
        table.push(await runEntry(page, headcountForm));
        {
          // Polled, like every other database check here: the readout lands
          // before the row does (22 Sept: a single read right after it saw the
          // old count once, on a run where the model timed out and the rules
          // wrote late).
          const readHeadcount = async (): Promise<number | null | undefined> => {
            const { data, error } = await dana
              .from("runs")
              .select("planned_headcount, timerange")
              .eq("node_id", cellId("Cell 3"));
            expect(error, error?.message).toBeNull();
            const rows = (data ?? []) as { planned_headcount: number | null; timerange: string }[];
            const hit = rows.find((r) => {
              const { startMs, endMs } = parseTimerange(r.timerange);
              return startMs === wallMs(WALK_DAY, 13, 0) && endMs === wallMs(WALK_DAY, 17, 0);
            });
            expect(hit, "the Bracket A run on Cell 3 should still be there").toBeTruthy();
            return hit!.planned_headcount;
          };
          const deadline = Date.now() + 45_000;
          let headcount = await readHeadcount();
          while (headcount !== 4 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 300));
            headcount = await readHeadcount();
          }
          expect(headcount).toBe(4);
        }

        // 14. Lena Novak's own setup block, plumbing for the swap next.
        table.push(await runEntry(page, lenaSetup));
        await waitForAssignment(dana, {
          operatorId: opId.lena,
          nodeId: cellId("Cell 5"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 13, 0),
        });

        // 15. A swap -- crosses Lena's and John Kim's own blocks.
        table.push(await runEntry(page, swapSuccess));
        await waitForAssignmentGone(dana, {
          operatorId: opId.lena,
          nodeId: cellId("Cell 5"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 13, 0),
        });
        await waitForAssignmentGone(dana, {
          operatorId: opId.john,
          nodeId: cellId("Cell 3"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 13, 0),
        });
        await waitForAssignment(dana, {
          operatorId: opId.lena,
          nodeId: cellId("Cell 3"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 13, 0),
        });
        await waitForAssignment(dana, {
          operatorId: opId.john,
          nodeId: cellId("Cell 5"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 13, 0),
        });

        // 16. A copy to tomorrow -- Cell 3's own blocks, one day forward.
        table.push(await runEntry(page, copyToTomorrow));
        await waitForAssignment(dana, {
          operatorId: opId.lena,
          nodeId: cellId("Cell 3"),
          startMs: wallMs(TOMORROW, 8, 0),
          endMs: wallMs(TOMORROW, 13, 0),
        });

        // 17. A repeat day answered no -- the listing counts five (Monday to
        // Friday, `expandRepeatDay`'s own `slice(0, 5)`), and nothing is
        // written anywhere in that week.
        const weekdayResult = await runEntry(page, everyWeekdayNo);
        table.push(weekdayResult);
        {
          // Only when the bar actually produced the listing: a status the
          // catalogue did not predict is already recorded as the finding
          // (`unpredicted`), and asserting its shape here as well would stop
          // the walk on the spot and cost every sentence after it -- the very
          // thing `recordMismatch` exists to prevent.
          if (weekdayResult.unpredicted === undefined) {
            // R-455: `everyWeekdayNo`'s `expect` is a plain RegExp now (no
            // button left to press), so `runEntry`'s non-button branch never
            // sets `.listing` -- the lot text is `barSaid` itself, same
            // fallback `listedCount` (entry 21, below) already uses.
            const listing = weekdayResult.listing ?? weekdayResult.barSaid ?? "";
            expect(
              listing.match(/^Ready to do (\d+) things/)?.[1],
              `the repeat day's own listing should count five: "${listing}"`,
            ).toBe("5");
            // F-158: Monday to Friday of the walk day's own week -- the five
            // days the repeat names, read off the sentence's own week, never
            // hand-summed. Every readout in the listing carries its day label,
            // so each of the five must appear by name.
            const monday = isoPlusDays(
              WALK_DAY,
              -((new Date(`${WALK_DAY}T00:00:00Z`).getUTCDay() + 6) % 7),
            );
            for (let i = 0; i < 5; i++) {
              const iso = isoPlusDays(monday, i);
              // The board's own day label shape, "Wed Sep 16" -- some ICU
              // builds put a comma after the weekday, the board's formatter
              // does not, so the comma is stripped rather than depended on.
              const label = new Intl.DateTimeFormat("en-US", {
                timeZone: "UTC",
                weekday: "short",
                month: "short",
                day: "numeric",
              })
                .format(new Date(`${iso}T00:00:00Z`))
                .replace(/,/g, "");
              expect(listing, `the listing should name ${label}`).toContain(label);
            }
          }
          // Monday of the week the walk day falls in, and the seven days after it --
          // "no" must have left every one of them empty on that cell.
          const monday = isoPlusDays(
            WALK_DAY,
            -((new Date(`${WALK_DAY}T00:00:00Z`).getUTCDay() + 6) % 7),
          );
          const rows = await assignmentsStartingInWindow(
            dana,
            [cellId("Cell 4")],
            wallMs(monday, 0, 0),
            wallMs(isoPlusDays(monday, 7), 0, 0),
          );
          const lenaRows = rows.filter((r) => r.operator_id === opId.lena);
          expect(lenaRows, '"no" to the lot should have written nothing this week').toHaveLength(0);
        }
        // R-455's own move (no button since 24 Sept) widened the window to
        // the walk day's week here; entry 19 below moves it to the far
        // Monday, and entry 21 moves it back to the walk day, both without a
        // press. Entry 20 (R-463, 29 Sept) no longer moves the window at all
        // -- it names its own day explicitly now, see its own comment below.

        // 18. An uncertified person on Cell 1, under warn -- a typed reason
        // runs it anyway.
        table.push(await runEntry(page, tomOverride));
        {
          const row = await waitForAssignment(dana, {
            operatorId: opId.tom,
            nodeId: cellId("Cell 1"),
            startMs: wallMs(WALK_DAY, 15, 0),
            endMs: wallMs(WALK_DAY, 17, 0),
          });
          expect(row.eligibility_override, "eligibility_override should be true").toBe(true);
          expect(row.override_reason).toBe(tomOverride.answer);
        }

        // 19. A day past the board's own window -- R-455's own move (no
        // press) moves it.
        table.push(await runEntry(page, dayOffBoardFar));
        await waitForAssignment(dana, {
          operatorId: opId.maria,
          nodeId: cellId("Cell 3"),
          startMs: wallMs(FAR, 8, 0),
          endMs: wallMs(FAR, 12, 0),
        });

        // 20. R-463 (29 Sept): a 5-minute block, Lena Novak on Cell 1's one
        // free slot that afternoon (2pm-2:05pm -- Sam Patel's own two blocks
        // from entries 9/11 fill 8am-2pm, Tom Baker's from entry 18 starts
        // at 3pm). No longer day-less (see `sentences.ts`'s own long comment
        // on this entry for why): it names the walk's own day explicitly.
        // FOUND LIVE (this lane's own first run): Lena Novak is not
        // certified for Cell 1 (Welding) -- the same not_certified refusal
        // entry 18 already proves for Tom Baker on this cell, so this entry
        // answers it the same way (a typed override reason) and the write
        // is proven the same way entry 18's is, eligibility_override
        // included, not just the row's existence.
        table.push(await runEntry(page, lenaShortBlock));
        {
          const row = await waitForAssignment(dana, {
            operatorId: opId.lena,
            nodeId: cellId("Cell 1"),
            startMs: wallMs(WALK_DAY, 14, 0),
            endMs: wallMs(WALK_DAY, 14, 5),
          });
          expect(row.eligibility_override, "eligibility_override should be true").toBe(true);
          expect(row.override_reason).toBe(lenaShortBlock.answer);
        }
        // FOUND LIVE (S194-F's own second consecutive run, same database,
        // R-433) and FIXED (F-233, this lane): entry 20 is the only create
        // in this whole walk with no entry between it and a lot that
        // immediately removes the very row it just made -- `clear Area 1`
        // (entry 21) used to be able to read a still-optimistic
        // `optimistic-<uuid>` id off the board index and send it to the
        // server (`invalid input syntax for type uuid`), a genuine,
        // pre-existing race in the mutation hooks' own optimistic-update
        // pattern that R-463 merely exposed for the first time. F-233 closes
        // it at the source (`commandAssignments.ts`/`BoardPage.tsx`'s own
        // `runs` list never hand a placeholder row to the resolver at all,
        // and `CommandBar.tsx`'s own `hasPendingCreate` wait holds a
        // sentence until the real row lands) -- this walk needs no workaround
        // of its own any more; removing the one-second wait a prior run of
        // this lane added here IS the proof.

        // 21 and 22. The clear of the walk day, one sentence per area (R-407: a
        // place above the cells clears every cell under it). Between them the
        // two listings must name EVERY block AND EVERY JOB this walk left on
        // that day (R-436, S70-d: "clear means clearing everything" -- the job
        // rows join the lot) -- counted against an independent database read
        // taken before either runs, never a hand-summed number.
        const beforeClearBlocks = await assignmentsStartingInWindow(
          dana,
          allCellIds,
          WALK_DAY_START_MS,
          WALK_DAY_END_MS,
        );
        const beforeClearJobs = await runsStartingInWindow(
          dana,
          allCellIds,
          WALK_DAY_START_MS,
          WALK_DAY_END_MS,
        );
        const beforeClear = beforeClearBlocks.length + beforeClearJobs.length;
        const listedCount = (result: EntryResult): number => {
          // Entry 21's `expect` is a plain RegExp now (R-455: no button left
          // to press), so `runEntry`'s non-button branch never sets
          // `.listing` at all -- the lot text is `barSaid` itself, which is
          // exactly what this falls back to.
          const match = (result.listing ?? result.barSaid).match(/^Ready to do (\d+) things/);
          if (match === null) return Number.NaN; // already recorded as the finding
          return Number(match[1]);
        };
        const area1Result = await runEntry(page, clearArea1);
        table.push(area1Result);
        const area1Listed = listedCount(area1Result);
        const area2Result = await runEntry(page, clearArea2);
        table.push(area2Result);
        const area2Listed = listedCount(area2Result);
        if (area1Result.unpredicted === undefined && area2Result.unpredicted === undefined) {
          expect(
            area1Listed + area2Listed,
            "the two areas' listings together should name every block and every job the walk left on the walk day",
          ).toBe(beforeClear);
        }
        const afterClear = await (async () => {
          // waitForAssignmentGone needs one specific row; here we want ALL of
          // them gone, so poll the whole-window count down to zero instead.
          const deadline = Date.now() + 45_000;
          for (;;) {
            const rows = [
              ...(await assignmentsStartingInWindow(
                dana,
                allCellIds,
                WALK_DAY_START_MS,
                WALK_DAY_END_MS,
              )),
              ...(await runsStartingInWindow(dana, allCellIds, WALK_DAY_START_MS, WALK_DAY_END_MS)),
            ];
            if (rows.length === 0) return rows;
            if (Date.now() > deadline) return rows;
            await new Promise((r) => setTimeout(r, 300));
          }
        })();
        expect(
          afterClear,
          "every block and every job on the walk day should be gone after the two areas' own yeses",
        ).toHaveLength(0);
      } else {
        // ====================================================================
        // WALK_SET 2 (S71-n, docs/agent-briefs/s71-n-second-walk-list-brief.md)
        // -- `e2e/walk/sentences2.ts`'s own 22 entries, different people,
        // cells, hours and days from the first list. Same door as above
        // (`runEntry`, each entry's own `expect`), and the same standard
        // CLAUDE.md §4 holds the first list to: a database read after every
        // write, never trust the status line alone.
        // ====================================================================
        const [
          clearEmptyCell2,
          priyaAssign2,
          mariaAssign2,
          lenaOverride2,
          johnAssign2,
          samMisheard2,
          tomNoPart2,
          bookHeadcount2,
          endJohn2,
          shortenLena2,
          extendSam2,
          splitTom2,
          swapRefused2,
          swapWrites2,
          headcountChange2,
          endOfShiftJohn2,
          copyToFriday2,
          everyWeekdayNo2,
          absenceMaria2,
          coverSam2,
          clearLine2_2,
          clearArea2_2,
        ] = SENTENCES;
        // entry 13's own `inLot: true` certificate refusal offers no
        // candidate and no yes/no -- see this file's own header doc on
        // `answerlessEntries` above.
        answerlessEntries.add(swapRefused2);

        // 1. Clear of an empty cell.
        table.push(await runEntry(page, clearEmptyCell2));

        // 2. Priya Shah -> Cell 1 (certified, Welding).
        table.push(await runEntry(page, priyaAssign2));
        await waitForAssignment(dana, {
          operatorId: opId.priya,
          nodeId: cellId("Cell 1"),
          startMs: wallMs(WALK_DAY, 6, 0),
          endMs: wallMs(WALK_DAY, 14, 0),
        });

        // 3. Maria Lopez -> Cell 6.
        table.push(await runEntry(page, mariaAssign2));
        await waitForAssignment(dana, {
          operatorId: opId.maria,
          nodeId: cellId("Cell 6"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 12, 0),
        });

        // 4. Lena Novak -> Cell 2, NOT certified -- typed reason, override.
        table.push(await runEntry(page, lenaOverride2));
        {
          const row = await waitForAssignment(dana, {
            operatorId: opId.lena,
            nodeId: cellId("Cell 2"),
            startMs: wallMs(WALK_DAY, 8, 0),
            endMs: wallMs(WALK_DAY, 12, 0),
          });
          expect(row.eligibility_override, "eligibility_override should be true").toBe(true);
          expect(row.override_reason).toBe(lenaOverride2.answer);
        }

        // 5. John Kim -> Cell 5.
        table.push(await runEntry(page, johnAssign2));
        await waitForAssignment(dana, {
          operatorId: opId.john,
          nodeId: cellId("Cell 5"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 12, 0),
        });

        // 6. Sam Patel -> Cell 2 (Line 1 -- the area gate's own boundary),
        // misheard part ("Bracket Pay" -> Bracket A).
        table.push(await runEntry(page, samMisheard2));
        await waitForAssignment(dana, {
          operatorId: opId.sam,
          nodeId: cellId("Cell 2"),
          startMs: wallMs(WALK_DAY, 15, 0),
          endMs: wallMs(WALK_DAY, 19, 0),
        });

        // 7. Tom Baker -> Cell 3, no part named ("Which part?").
        table.push(await runEntry(page, tomNoPart2));
        await waitForAssignment(dana, {
          operatorId: opId.tom,
          nodeId: cellId("Cell 3"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 12, 0),
        });

        // 8. A booking with headcount -- a run, not an assignment.
        table.push(await runEntry(page, bookHeadcount2));
        {
          const { data, error } = await dana
            .from("runs")
            .select("id, planned_headcount, timerange")
            .eq("node_id", cellId("Cell 6"));
          expect(error, error?.message).toBeNull();
          const rows = (data ?? []) as {
            id: string;
            planned_headcount: number | null;
            timerange: string;
          }[];
          const hit = rows.find((r) => {
            const { startMs, endMs } = parseTimerange(r.timerange);
            return startMs === wallMs(WALK_DAY, 13, 0) && endMs === wallMs(WALK_DAY, 17, 0);
          });
          expect(
            hit,
            "the booked Common Fastener run on Cell 6, 13:00-17:00, should exist",
          ).toBeTruthy();
          expect(hit!.planned_headcount).toBe(2);
        }

        // 9. "end" -- John Kim's own Cell 5 block shortens to 08:00-10:00.
        table.push(await runEntry(page, endJohn2));
        await waitForAssignment(dana, {
          operatorId: opId.john,
          nodeId: cellId("Cell 5"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 10, 0),
        });

        // 10. "shorten" -- Lena Novak's own Cell 2 block, by 30 minutes.
        table.push(await runEntry(page, shortenLena2));
        await waitForAssignment(dana, {
          operatorId: opId.lena,
          nodeId: cellId("Cell 2"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 11, 30),
        });

        // 11. "extend" -- Sam Patel's own Cell 2 block ("assignment" spelling).
        table.push(await runEntry(page, extendSam2));
        await waitForAssignment(dana, {
          operatorId: opId.sam,
          nodeId: cellId("Cell 2"),
          startMs: wallMs(WALK_DAY, 15, 0),
          endMs: wallMs(WALK_DAY, 20, 0),
        });

        // 12. "split" -- Tom Baker's own Cell 3 block.
        table.push(await runEntry(page, splitTom2));
        await waitForAssignmentGone(dana, {
          operatorId: opId.tom,
          nodeId: cellId("Cell 3"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 12, 0),
        });
        await waitForAssignment(dana, {
          operatorId: opId.tom,
          nodeId: cellId("Cell 3"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 10, 0),
        });
        await waitForAssignment(dana, {
          operatorId: opId.tom,
          nodeId: cellId("Cell 3"),
          startMs: wallMs(WALK_DAY, 10, 0),
          endMs: wallMs(WALK_DAY, 12, 0),
        });

        // 13. The uncertified swap -- refused before the yes; nothing changes.
        table.push(await runEntry(page, swapRefused2));
        await waitForAssignment(dana, {
          operatorId: opId.lena,
          nodeId: cellId("Cell 2"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 11, 30),
        });
        await waitForAssignment(dana, {
          operatorId: opId.priya,
          nodeId: cellId("Cell 1"),
          startMs: wallMs(WALK_DAY, 6, 0),
          endMs: wallMs(WALK_DAY, 14, 0),
        });

        // 14. A swap that writes -- crosses Maria's and John Kim's own blocks.
        table.push(await runEntry(page, swapWrites2));
        await waitForAssignmentGone(dana, {
          operatorId: opId.maria,
          nodeId: cellId("Cell 6"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 12, 0),
        });
        await waitForAssignmentGone(dana, {
          operatorId: opId.john,
          nodeId: cellId("Cell 5"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 10, 0),
        });
        await waitForAssignment(dana, {
          operatorId: opId.maria,
          nodeId: cellId("Cell 5"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 10, 0),
        });
        await waitForAssignment(dana, {
          operatorId: opId.john,
          nodeId: cellId("Cell 6"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 12, 0),
        });

        // 15. The headcount form, on the run booked in entry 8 -- deliberately
        // not run right after entry 8 (see sentences2.ts's own comment on this
        // entry: a back-to-back book-then-headcount-change raced the client's
        // own realtime sync on the first try here).
        table.push(await runEntry(page, headcountChange2));
        {
          const readHeadcount = async (): Promise<number | null | undefined> => {
            const { data, error } = await dana
              .from("runs")
              .select("planned_headcount, timerange")
              .eq("node_id", cellId("Cell 6"));
            expect(error, error?.message).toBeNull();
            const rows = (data ?? []) as { planned_headcount: number | null; timerange: string }[];
            const hit = rows.find((r) => {
              const { startMs, endMs } = parseTimerange(r.timerange);
              return startMs === wallMs(WALK_DAY, 13, 0) && endMs === wallMs(WALK_DAY, 17, 0);
            });
            expect(hit, "the Common Fastener run on Cell 6 should still be there").toBeTruthy();
            return hit!.planned_headcount;
          };
          const deadline = Date.now() + 45_000;
          let headcount = await readHeadcount();
          while (headcount !== 5 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 300));
            headcount = await readHeadcount();
          }
          expect(headcount).toBe(5);
        }

        // 16. "from 4 until end of shift" -- the model-gap case, John Kim's
        // second Cell 6 block.
        const shiftResult2 = await runEntry(page, endOfShiftJohn2);
        table.push(shiftResult2);
        {
          const literalReading = /04:00–06:00/.test(shiftResult2.written);
          const branch = literalReading
            ? "04:00-06:00 (literal)"
            : "16:00-22:00 (the rules' own reading)";
          if (literalReading) {
            surprises.push(
              `"${endOfShiftJohn2.say}" was read literally as 04:00, not the rules' 16:00 -- ${branch}.`,
            );
          }
          const [startH, endH] = literalReading ? [4, 6] : [16, 22];
          await waitForAssignment(dana, {
            operatorId: opId.john,
            nodeId: cellId("Cell 6"),
            startMs: wallMs(WALK_DAY, startH, 0),
            endMs: wallMs(WALK_DAY, endH, 0),
          });
        }

        // 17. A copy to tomorrow -- Cell 5 currently holds Maria's own block
        // (crossed to her by entry 14's swap). Copying exactly one block
        // auto-runs (S47), so this is a plain single-write DB check, the same
        // shape as an ordinary assign.
        table.push(await runEntry(page, copyToFriday2));
        await waitForAssignment(dana, {
          operatorId: opId.maria,
          nodeId: cellId("Cell 5"),
          startMs: wallMs(TOMORROW, 8, 0),
          endMs: wallMs(TOMORROW, 10, 0),
        });

        // 18. A repeat day answered no -- next week, five commands, nothing
        // written.
        table.push(await runEntry(page, everyWeekdayNo2));

        // 19. An absence (R-409 amended, S194-C follow-up) -- Maria Lopez's
        // own Cell 5 block is removed AND an absence is recorded for her,
        // one lot, one yes. Both halves proved: the block gone, and the
        // absence row present, covering exactly this day.
        table.push(await runEntry(page, absenceMaria2));
        await waitForAssignmentGone(dana, {
          operatorId: opId.maria,
          nodeId: cellId("Cell 5"),
          startMs: wallMs(WALK_DAY, 8, 0),
          endMs: wallMs(WALK_DAY, 10, 0),
        });
        await waitForAbsence(dana, { operatorId: opId.maria, iso: WALK_DAY });

        // 20. A cover -- Priya Shah's own Cell 1 block becomes Sam Patel's.
        table.push(await runEntry(page, coverSam2));
        await waitForAssignmentGone(dana, {
          operatorId: opId.priya,
          nodeId: cellId("Cell 1"),
          startMs: wallMs(WALK_DAY, 6, 0),
          endMs: wallMs(WALK_DAY, 14, 0),
        });
        await waitForAssignment(dana, {
          operatorId: opId.sam,
          nodeId: cellId("Cell 1"),
          startMs: wallMs(WALK_DAY, 6, 0),
          endMs: wallMs(WALK_DAY, 14, 0),
        });

        // 21 and 22. Clear Line 2, then Area 2 -- a DIFFERENT pair of places
        // than the first list's Area 1/Area 2 (brief §1 item 16). Cell 1 and
        // Cell 2 (Line 1) are deliberately left for the walk's own teardown
        // (sentences2.ts's own header doc) -- counted here over Cell 3-6 only.
        const line2AndArea2CellIds = [
          cellId("Cell 3"),
          cellId("Cell 4"),
          cellId("Cell 5"),
          cellId("Cell 6"),
        ];
        const beforeClearBlocks2 = await assignmentsStartingInWindow(
          dana,
          line2AndArea2CellIds,
          WALK_DAY_START_MS,
          WALK_DAY_END_MS,
        );
        const beforeClearJobs2 = await runsStartingInWindow(
          dana,
          line2AndArea2CellIds,
          WALK_DAY_START_MS,
          WALK_DAY_END_MS,
        );
        const beforeClear2 = beforeClearBlocks2.length + beforeClearJobs2.length;
        const listedCount2 = (result: EntryResult): number => {
          const match = (result.listing ?? result.barSaid).match(/^Ready to do (\d+) things/);
          if (match === null) return Number.NaN;
          return Number(match[1]);
        };
        const line2Result = await runEntry(page, clearLine2_2);
        table.push(line2Result);
        const line2Listed = listedCount2(line2Result);
        const area2Result2 = await runEntry(page, clearArea2_2);
        table.push(area2Result2);
        const area2Listed2 = listedCount2(area2Result2);
        if (line2Result.unpredicted === undefined && area2Result2.unpredicted === undefined) {
          expect(
            line2Listed + area2Listed2,
            "Line 2's and Area 2's listings together should name every block and every job the walk left there",
          ).toBe(beforeClear2);
        }
        const afterClear2 = await (async () => {
          const deadline = Date.now() + 45_000;
          for (;;) {
            const rows = [
              ...(await assignmentsStartingInWindow(
                dana,
                line2AndArea2CellIds,
                WALK_DAY_START_MS,
                WALK_DAY_END_MS,
              )),
              ...(await runsStartingInWindow(
                dana,
                line2AndArea2CellIds,
                WALK_DAY_START_MS,
                WALK_DAY_END_MS,
              )),
            ];
            if (rows.length === 0) return rows;
            if (Date.now() > deadline) return rows;
            await new Promise((r) => setTimeout(r, 300));
          }
        })();
        expect(
          afterClear2,
          "every block and every job on Line 2/Area 2 should be gone after the two clears",
        ).toHaveLength(0);
      }

      // ------------------------------------------------------------------
      // The trace (brief §4).
      // ------------------------------------------------------------------
      const traceFile = path.resolve(process.cwd(), "data/voice/trace/bar.jsonl");
      const nonVoice = SENTENCES.filter((s) => s.voice !== true);
      const lastSay = nonVoice[nonVoice.length - 1].say;
      // `postTrace` is fire-and-forget (`CommandBar.tsx`'s own comment), so
      // the final sentence's line can still be in flight when the database
      // reads above have already settled. Poll the file until its last line
      // IS that sentence rather than racing it.
      const allLines = await (async () => {
        const deadline = Date.now() + 20_000;
        for (;;) {
          const raw = await readFile(traceFile, "utf-8").catch(() => "");
          // Only the spec's own door: every sentence here is TYPED, so a
          // spoken turn from a person using the bar at the same time (22
          // Sept: three spoken clips landed between the walk's own lines and
          // shifted the slice by one) is not this walk's to judge.
          const lines = raw
            .split("\n")
            .filter((l) => l.trim() !== "")
            .filter((l) => {
              try {
                return (JSON.parse(l) as { by?: string }).by === "typed";
              } catch {
                return false;
              }
            });
          const last = lines[lines.length - 1];
          if (last !== undefined && (JSON.parse(last) as { heard?: string }).heard === lastSay) {
            return lines;
          }
          if (Date.now() > deadline) return lines;
          await new Promise((r) => setTimeout(r, 300));
        }
      })();
      // S194-C follow-up (28 Sept): an entry that needs a SECOND interaction
      // -- a typed `answer`, or a pressed candidate button -- posts TWO
      // trace lines, same `heard`, the second one carrying `revises: true`
      // (`trace.ts`'s own doc, quoted on `readBarByAt` in
      // `scripts/voice/clips/score.mjs`: "a write that lands after the
      // person has already said something else posts a SECOND line, same
      // `at`, correcting the first"). A plain `allLines.slice(-nonVoice.
      // length)` counts LINES, not SENTENCES, so any walk with enough
      // two-line entries (this list has nine: 1c, 1e, the split, both
      // swaps, the copy, the declined repeat, Tom's override, both area
      // clears) drops that many lines off the FRONT of the run's own tail --
      // proved live (28 Sept): with a 26-sentence run and 9 revised entries
      // (35 lines), `slice(-26)` started at this run's own 10th sentence,
      // not its first, and "trace line 1" was entry 10's "book Bracket A
      // ...", never entry 1's "clear Cell 4 ...". This collapses each
      // consecutive same-`heard` `revises: true` line INTO the line it
      // revises first, so the walk asserts one settled trace ENTRY per
      // SENTENCE, the fact `nonVoice.length` actually counts.
      //
      // F-233 (29 Sept): collapsed BY `at`, the entry's own key, the way
      // `readBarByAt` reads the file, no longer by "the line before has the
      // same `heard`". A sentence is posted when the bar asks or holds it and
      // corrected at its outcome, and the correction can land after the NEXT
      // sentence's first line, so a sentence's lines are not always next to
      // each other. The last line for an `at` is the entry; the entry keeps
      // the place its first line took.
      const collapsed: Record<string, unknown>[] = [];
      const placeOfAt = new Map<unknown, number>();
      for (const raw of allLines) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const place = placeOfAt.get(parsed.at);
        if (place !== undefined) {
          collapsed[place] = parsed;
        } else {
          placeOfAt.set(parsed.at, collapsed.length);
          collapsed.push(parsed);
        }
      }
      const parsedTrace = collapsed.slice(-nonVoice.length);
      expect(
        parsedTrace.length,
        `expected at least ${nonVoice.length} settled trace entries (collapsed) in ${traceFile}`,
      ).toBe(nonVoice.length);
      for (let i = 0; i < nonVoice.length; i++) {
        const entry = parsedTrace[i];
        expect(entry.heard, `trace line ${i + 1}'s heard`).toBe(nonVoice[i].say);
        expect(entry.asked, `trace line ${i + 1}'s asked`).not.toBeNull();
        // R-455 (24 Sept): a day_off_board move is a READOUT now, which
        // fills in `answered: "auto"` the instant it fires -- entry 20 no
        // longer belongs in `answerlessEntries` (see that Set's own
        // comment). R-463 (29 Sept) later took entry 20 off the
        // day_off_board path entirely (it names its own day now), so its
        // `answered` comes from the plain single-sentence readout path
        // instead (S47) -- still real, still not in this set. What is still
        // genuinely answerless: an `inLot`
        // certificate refusal with no candidate and no yes/no of its own
        // (entry 13, second list), and an entry that landed on its direct
        // readout (orDirect) without ever raising a question at all.
        const landedDirect = table[i]?.note?.includes("[direct, no question]") ?? false;
        if (!answerlessEntries.has(nonVoice[i]) && !landedDirect) {
          expect(entry.answered, `trace line ${i + 1}'s answered`).not.toBeNull();
        }
      }

      // ------------------------------------------------------------------
      // The findings (brief: "any sentence whose answer surprised you ... is
      // a finding for the developer, not something to work around"). Every
      // `expect` above stood as written; this is where a sentence the bar
      // answered differently turns the run red, AFTER the table has been
      // printed, so the finding arrives with the whole walk around it.
      // ------------------------------------------------------------------
      const unpredicted = table.filter((r) => r.unpredicted !== undefined);
      expect(
        unpredicted.map((r) => `${r.say}\n  ${r.unpredicted}`).join("\n\n"),
        "sentences the bar answered with something the catalogue did not predict",
      ).toBe("");
    } finally {
      // ------------------------------------------------------------------
      // Output for the maintainer (brief §5) -- printed whatever happened,
      // so a walk that stopped early still hands over every sentence it did
      // reach.
      // ------------------------------------------------------------------
      console.log("\n=== typed walk: sentence -> what the bar said -> what was written ===");
      for (const row of table) {
        console.log(`SAY:     ${row.say}`);
        console.log(`BAR:     ${row.barSaid}`);
        // The lot a button led to, before the entry answered it -- without
        // this, an entry whose question came from a real button (a
        // Did-you-mean, "Which part?") and then declined it prints as
        // though nothing happened. (Not day_off_board any more -- R-455
        // moves and reruns with no button, so `.listing` stays undefined
        // for those and `listedCount` above falls back to `barSaid`.)
        if (row.listing !== undefined && row.listing !== row.barSaid) {
          console.log(`LISTING: ${row.listing}`);
        }
        if (row.written !== row.barSaid) console.log(`WRITTEN: ${row.written}`);
        if (row.note) console.log(`NOTE:    ${row.note}`);
        if (row.unpredicted) console.log(`!! UNPREDICTED: ${row.unpredicted}`);
        console.log("");
      }
      if (surprises.length > 0) {
        console.log("=== surprises ===");
        for (const s of surprises) console.log(`- ${s}`);
      }
      // afterAll deletes the same again (brief §1) -- done here, in the same
      // try/finally, since this whole walk is one test.
      await clearWindow(dana, nodes.allNodeIds, CLEAN_FROM_MS, CLEAN_TO_MS);
      // S194-C follow-up: the same reason as the setup's own call -- an
      // absence THIS run recorded must not still be there for the next one.
      await clearAbsencesSince(dana, Object.values(opId), WALK_DAY);
    }
  });
});

/**
 * F-233 (S194-G), proving it item 3: "throttle the create's response in the
 * browser... place, clear at once, and read the database." A standalone
 * spec, not a 23rd entry in the big walk -- the walk's own back-to-back
 * timing on a fast local stack is what found the race in the first place
 * (S194-F); this widens the SAME race deliberately, by holding the
 * `create_assignment` RPC's own response for two full seconds with
 * Playwright's `page.route`, so "say the clear before the create has
 * answered" is no longer a matter of who happens to win a race on a given
 * run -- it is guaranteed, every time this runs.
 *
 * Runs after the main walk (file order, `workers: 1`) so the day it uses is
 * already empty; cleans up its own row regardless, before and after, so it
 * is safe to run alone too.
 */
// S194-G2 (the reviewer's own repro, "the bar answering 'Cell 1 has nobody
// on it' over a block just placed"): the delay is an env knob, not always
// 2000ms -- the brief's own proving step runs this spec ten times at
// 2000ms AND ten times at 200ms (`F233_THROTTLE_MS=200`), since a SHORTER
// throttle is what actually exercised the cache-derived signal's own gaps
// (Finding 1: the placeholder enters the cache only after `onMutate`'s
// awaited `cancelQueries`, and the bar's write settles before the
// invalidated refetch lands) -- both gaps are proportionally narrower, and
// more likely to be missed by a flaky fix, the shorter this delay is.
// Default unchanged at 2000ms for a plain `npm run e2e` run.
const F233_THROTTLE_MS = Number(process.env.F233_THROTTLE_MS ?? 2000);

test(`F-233: a create held back (${F233_THROTTLE_MS}ms), then cleared at once, still ends with the row gone (no placeholder id ever reaches the server)`, async ({
  page,
}) => {
  test.skip(!hasRealBackend, NO_BACKEND_REASON);
  test.setTimeout(60_000);

  const dana = await signedInClient(ADMIN);
  const nodes = await loadPlantANodes(dana);
  initWalkDays(await plantZone(dana, nodes.plantId));
  const cell1 = nodes.cellIdByName.get("Cell 1");
  if (!cell1) throw new Error("no such cell in Plant A: Cell 1");
  const sam = await operatorId(dana, "Sam Patel");
  const startMs = wallMs(WALK_DAY, 5, 0);
  const endMs = wallMs(WALK_DAY, 6, 0);

  // Belt and braces: a leftover row from an earlier failed run of THIS spec
  // must not make "the row is gone at the end" trivially true for the wrong
  // reason.
  await clearWindow(dana, [cell1], startMs, endMs);

  try {
    // Hold every `create_assignment` RPC response back two seconds --
    // `supabase.rpc(...)` (mutations.ts) POSTs to exactly this path.
    await page.route("**/rest/v1/rpc/create_assignment", async (route) => {
      await new Promise((r) => setTimeout(r, F233_THROTTLE_MS));
      await route.continue();
    });

    await signIn(page, ADMIN, "/");
    const firstTrack = page.getByLabel(/press Enter to create/).first();
    await expect(firstTrack).toBeVisible({ timeout: 20_000 });
    await fillWindowStart(page, WALK_DAY);
    await expect(firstTrack).toBeVisible({ timeout: 20_000 });
    await ensureBarOpen(page);

    // Place Sam Patel, then say the clear -- but not before the FIRST
    // sentence's own reading has actually finished (S194-G3: a second Enter
    // aborts an in-flight READING, `readingAbortRef.current?.abort()`,
    // `CommandBar.tsx` -- a documented, deliberate design decision (S44-b)
    // this lane proves but does not change, docs/agent-briefs/
    // s194-g3-the-hold-regressed-brief.md). Racing that abort here would
    // make this spec prove the WRONG thing -- a sentence silently dropped
    // before it ever became a write, nothing to do with F-233's own
    // mechanism at all. So this waits for the first sentence's own
    // "Written: …" line before saying the second, WITHOUT weakening what
    // this spec proves: the throttle is on the CREATE's own network
    // response, and the bar only shows "Written: …" once that response has
    // actually landed (`CreatePopover`'s own `submitDirect`, awaited all
    // the way through) -- so the race this spec exists to prove, "say the
    // clear before the board has caught up with the write," is STILL real
    // and STILL exercised: what remains is the narrower, but genuine, gap
    // between the write landing and the refetch that follows it actually
    // reaching `ctx` (`awaitingRowIdRef`, `CommandBar.tsx`'s own third-pass
    // mechanism) -- "clear Cell 1" said the instant "Written: …" appears
    // still lands inside THAT window every time, since the refetch's own
    // round trip is never instant either.
    await submit(
      page,
      `Assign Sam Patel to Housing A on Cell 1 in Line 1 from 5am to 6am ${WALK_DAY}`,
    );
    await expect(page.getByText(/^Written:/)).toBeVisible({ timeout: 10_000 });
    await submit(page, `clear Cell 1 ${WALK_DAY}`);

    // Nothing here ever crashed the bar with a raw database error -- the
    // create lands (held two seconds), the held clear reruns once it does,
    // and asks its own ordinary yes/no exactly as it would with no race at
    // all.
    await expect(async () => {
      const text = await currentStatusText(page);
      expect(
        text.length > 0 || (await page.getByRole("button", { name: /Do all|Remove/ }).count()) > 0,
      ).toBe(true);
    }).toPass({ timeout: 10_000, intervals: [300] });

    // Answer whatever question the clear raised (a single removal's own
    // "Remove it", or a lot's "Do all N") -- either way, say yes.
    const removeIt = page.getByRole("button", { name: "Remove it" });
    const doAll = page.getByRole("button", { name: /^Do all/ });
    if (await removeIt.isVisible().catch(() => false)) {
      await removeIt.click();
    } else if (await doAll.isVisible().catch(() => false)) {
      await doAll.click();
    }

    // The database is the proof (CLAUDE.md §4): the row Sam Patel was
    // placed into, then cleared, is gone -- never left behind by a clear
    // that silently failed on a placeholder id, and never a real id sent
    // to a writer while it was still a placeholder (the fault this lane
    // fixes: an `invalid input syntax for type uuid` from Postgres, which
    // `docker logs supabase_db_production_scheduler_tester` would show if
    // it happened).
    await waitForAssignmentGone(dana, { operatorId: sam, nodeId: cell1, startMs, endMs }, 15_000);
  } finally {
    await clearWindow(dana, [cell1], startMs, endMs);
  }
});
