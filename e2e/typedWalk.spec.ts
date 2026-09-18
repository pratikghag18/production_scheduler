import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON } from "./env";
import { buildSentences, type Sentence } from "./walk/sentences";
import {
  signedInClient,
  loadPlantANodes,
  operatorId,
  productId,
  clearWindow,
  waitForAssignment,
  waitForAssignmentGone,
  assignmentsStartingInWindow,
  parseTimerange,
  PASSWORD,
  PLANT_A_ADMIN,
} from "./walk/db";
import { todayInPlantA, addDaysToIso, clockMsInZone, PLANT_A_ZONE } from "./walk/time";

const isoPlusDays = addDaysToIso;
const chicagoWallMs = (iso: string, hh: number, mm: number): number =>
  clockMsInZone(iso, PLANT_A_ZONE, hh, mm);

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

const TODAY = todayInPlantA();
const TOMORROW = isoPlusDays(TODAY, 1);
// Within the setup/teardown window (today-1 .. today+8) but past the
// board's own default 3-day window (today, tomorrow, today+2) -- so it is
// guaranteed off-board for entry 19's own "Show that day" case, and still
// cleaned up by afterAll.
const FAR = isoPlusDays(TODAY, 7);

const CLEAN_FROM_MS = chicagoWallMs(isoPlusDays(TODAY, -1), 0, 0);
const CLEAN_TO_MS = chicagoWallMs(isoPlusDays(TODAY, 8), 0, 0);
const TODAY_START_MS = chicagoWallMs(TODAY, 0, 0);
const TODAY_END_MS = chicagoWallMs(TOMORROW, 0, 0);

const SENTENCES = buildSentences({ today: TODAY, tomorrow: TOMORROW, far: FAR });
const [
  clearEmptyCell,
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
  dayLessToday,
  clearArea1,
  clearArea2,
] = SENTENCES;

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

/** Signs in as Dana, waits for the board, opens the corner launcher (S48-a:
 *  the bar lives behind it), and lands on today's window. */
async function openBoard(page: Page): Promise<void> {
  await signIn(page, ADMIN, "/");
  await expect(page.getByLabel(/press Enter to create/).first()).toBeVisible({ timeout: 20_000 });
  const todayButton = page.getByRole("button", { name: "Today" });
  if ((await todayButton.count()) > 0) await todayButton.click({ timeout: ACTION_TIMEOUT_MS });
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
    // A button-form entry may still take a typed answer: entry 17 goes
    // through "Show that day" to REACH its lot, and then declines it.
    const listing = await currentStatusText(page);
    const written = await answerIfAny(page, entry, listing);
    return { say: entry.say, barSaid, written, note: entry.note, listing };
  }
  try {
    await expectAnswered(page, entry.expect, before, entry.say);
  } catch {
    return recordMismatch(page, entry, "the bar answered this sentence with something else");
  }
  const barSaid = await currentStatusText(page);
  const written = await answerIfAny(page, entry, barSaid);
  return { say: entry.say, barSaid, written, note: entry.note };
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
    // Twenty-one sentences, each a real round trip to the local model
    // container at roughly 15-20s a turn, plus the database polls between
    // them: the walk's own floor is about ten minutes on this machine and a
    // single slow turn (`ENTRY_TIMEOUT_MS`) can add two more. 540s was under
    // the floor and timed the test out mid-walk.
    test.setTimeout(2_400_000);

    // ------------------------------------------------------------------
    // Setup, through the database (brief §1) -- the same authenticated
    // supabase-js door `invite.spec.ts` builds, reused via `e2e/walk/db.ts`.
    // ------------------------------------------------------------------
    const dana = await signedInClient(ADMIN);
    const nodes = await loadPlantANodes(dana);
    const cellId = (name: string): string => {
      const id = nodes.cellIdByName.get(name);
      if (!id) throw new Error(`no such cell in Plant A: ${name}`);
      return id;
    };
    const allCellIds = [...nodes.cellIdByName.values()];

    await clearWindow(dana, nodes.allNodeIds, CLEAN_FROM_MS, CLEAN_TO_MS);

    const opId = {
      sam: await operatorId(dana, "Sam Patel"),
      maria: await operatorId(dana, "Maria Lopez"),
      john: await operatorId(dana, "John Kim"),
      priya: await operatorId(dana, "Priya Shah"),
      tom: await operatorId(dana, "Tom Baker"),
      lena: await operatorId(dana, "Lena Novak"),
    };
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

    try {
      // ------------------------------------------------------------------
      await openBoard(page);

      // 1. Clear of an empty cell.
      table.push(await runEntry(page, clearEmptyCell));

      // 2. Assign with a part.
      table.push(await runEntry(page, assignWithPart));
      await waitForAssignment(dana, {
        operatorId: opId.john,
        nodeId: cellId("Cell 3"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 12, 0),
      });

      // 3. Plural near-miss.
      table.push(await runEntry(page, pluralNearMiss));
      await waitForAssignment(dana, {
        operatorId: opId.priya,
        nodeId: cellId("Cell 4"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 12, 0),
      });

      // 4. Real near-miss ("Housing Pay" -> Housing A).
      table.push(await runEntry(page, realNearMiss));
      await waitForAssignment(dana, {
        operatorId: opId.maria,
        nodeId: cellId("Cell 4"),
        startMs: chicagoWallMs(TODAY, 13, 0),
        endMs: chicagoWallMs(TODAY, 15, 0),
      });

      // 5. No part named ("Which part?").
      table.push(await runEntry(page, noPart));
      await waitForAssignment(dana, {
        operatorId: opId.sam,
        nodeId: cellId("Cell 1"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 16, 0),
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
          return startMs === chicagoWallMs(TODAY, 13, 0) && endMs === chicagoWallMs(TODAY, 17, 0);
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
          startMs: chicagoWallMs(TODAY, startH, 0),
          endMs: chicagoWallMs(TODAY, endH, 0),
        });
      }

      // 8. Tom Baker's own setup block (off Line 1 -- no certification
      // needed), plumbing for the swap-refusal case.
      table.push(await runEntry(page, tomSetup));
      await waitForAssignment(dana, {
        operatorId: opId.tom,
        nodeId: cellId("Cell 6"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 14, 0),
      });

      // 9. Adjust: "end" shortens Sam's own Cell 1 block.
      table.push(await runEntry(page, adjustEnd));
      await waitForAssignment(dana, {
        operatorId: opId.sam,
        nodeId: cellId("Cell 1"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 14, 0),
      });

      // 10. The uncertified swap -- refused before the yes; nothing changes.
      table.push(await runEntry(page, swapRefused));
      await waitForAssignment(dana, {
        operatorId: opId.sam,
        nodeId: cellId("Cell 1"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 14, 0),
      });
      await waitForAssignment(dana, {
        operatorId: opId.tom,
        nodeId: cellId("Cell 6"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 14, 0),
      });

      // 11. A split.
      table.push(await runEntry(page, split));
      await waitForAssignmentGone(dana, {
        operatorId: opId.sam,
        nodeId: cellId("Cell 1"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 14, 0),
      });
      await waitForAssignment(dana, {
        operatorId: opId.sam,
        nodeId: cellId("Cell 1"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 13, 0),
      });
      await waitForAssignment(dana, {
        operatorId: opId.sam,
        nodeId: cellId("Cell 1"),
        startMs: chicagoWallMs(TODAY, 13, 0),
        endMs: chicagoWallMs(TODAY, 14, 0),
      });

      // 12. Adjust: "extend" John Kim's own Cell 3 block.
      table.push(await runEntry(page, adjustExtend));
      await waitForAssignment(dana, {
        operatorId: opId.john,
        nodeId: cellId("Cell 3"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 13, 0),
      });

      // 13. The headcount form, on the run booked in entry 6.
      table.push(await runEntry(page, headcountForm));
      {
        const { data, error } = await dana
          .from("runs")
          .select("planned_headcount, timerange")
          .eq("node_id", cellId("Cell 3"));
        expect(error, error?.message).toBeNull();
        const rows = (data ?? []) as { planned_headcount: number | null; timerange: string }[];
        const hit = rows.find((r) => {
          const { startMs, endMs } = parseTimerange(r.timerange);
          return startMs === chicagoWallMs(TODAY, 13, 0) && endMs === chicagoWallMs(TODAY, 17, 0);
        });
        expect(hit, "the Bracket A run on Cell 3 should still be there").toBeTruthy();
        expect(hit!.planned_headcount).toBe(4);
      }

      // 14. Lena Novak's own setup block, plumbing for the swap next.
      table.push(await runEntry(page, lenaSetup));
      await waitForAssignment(dana, {
        operatorId: opId.lena,
        nodeId: cellId("Cell 5"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 13, 0),
      });

      // 15. A swap -- crosses Lena's and John Kim's own blocks.
      table.push(await runEntry(page, swapSuccess));
      await waitForAssignmentGone(dana, {
        operatorId: opId.lena,
        nodeId: cellId("Cell 5"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 13, 0),
      });
      await waitForAssignmentGone(dana, {
        operatorId: opId.john,
        nodeId: cellId("Cell 3"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 13, 0),
      });
      await waitForAssignment(dana, {
        operatorId: opId.lena,
        nodeId: cellId("Cell 3"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 13, 0),
      });
      await waitForAssignment(dana, {
        operatorId: opId.john,
        nodeId: cellId("Cell 5"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 13, 0),
      });

      // 16. A copy to tomorrow -- Cell 3's own blocks, one day forward.
      table.push(await runEntry(page, copyToTomorrow));
      await waitForAssignment(dana, {
        operatorId: opId.lena,
        nodeId: cellId("Cell 3"),
        startMs: chicagoWallMs(TOMORROW, 8, 0),
        endMs: chicagoWallMs(TOMORROW, 13, 0),
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
          const listing = weekdayResult.listing ?? "";
          expect(
            listing.match(/^(\d+) commands? ready/)?.[1],
            `the repeat day's own listing should count five: "${listing}"`,
          ).toBe("5");
          // F-158: Monday to Friday of the week today falls in -- the five
          // days the repeat names, read off the sentence's own week, never
          // hand-summed. Every readout in the listing carries its day label,
          // so each of the five must appear by name.
          const monday = isoPlusDays(
            TODAY,
            -((new Date(`${TODAY}T00:00:00Z`).getUTCDay() + 6) % 7),
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
        // Monday of the week `today` falls in, and the seven days after it --
        // "no" must have left every one of them empty on that cell.
        const monday = isoPlusDays(TODAY, -((new Date(`${TODAY}T00:00:00Z`).getUTCDay() + 6) % 7));
        const rows = await assignmentsStartingInWindow(
          dana,
          [cellId("Cell 4")],
          chicagoWallMs(monday, 0, 0),
          chicagoWallMs(isoPlusDays(monday, 7), 0, 0),
        );
        const lenaRows = rows.filter((r) => r.operator_id === opId.lena);
        expect(lenaRows, '"no" to the lot should have written nothing this week').toHaveLength(0);
      }
      // The "Show that day" this entry went through moved the window off
      // today; entry 19 below moves it again and entry 20 brings it back,
      // so nothing between here and the clear depends on where it sits.

      // 18. An uncertified person on Cell 1, under warn -- a typed reason
      // runs it anyway.
      table.push(await runEntry(page, tomOverride));
      {
        const row = await waitForAssignment(dana, {
          operatorId: opId.tom,
          nodeId: cellId("Cell 1"),
          startMs: chicagoWallMs(TODAY, 15, 0),
          endMs: chicagoWallMs(TODAY, 17, 0),
        });
        expect(row.eligibility_override, "eligibility_override should be true").toBe(true);
        expect(row.override_reason).toBe(tomOverride.answer);
      }

      // 19. A day past the board's own window -- "Show that day" moves it.
      table.push(await runEntry(page, dayOffBoardFar));
      await waitForAssignment(dana, {
        operatorId: opId.maria,
        nodeId: cellId("Cell 3"),
        startMs: chicagoWallMs(FAR, 8, 0),
        endMs: chicagoWallMs(FAR, 12, 0),
      });

      // 20. A day-less sentence -- today is off the (moved) board now.
      table.push(await runEntry(page, dayLessToday));
      await waitForAssignment(dana, {
        operatorId: opId.maria,
        nodeId: cellId("Cell 3"),
        startMs: chicagoWallMs(TODAY, 8, 0),
        endMs: chicagoWallMs(TODAY, 12, 0),
      });

      // 21 and 22. The clear of today, one sentence per area (R-407: a place
      // above the cells clears every cell under it). Between them the two
      // listings must name EVERY block this walk left on today -- counted
      // against an independent database read taken before either runs, never
      // a hand-summed number.
      const beforeClear = await assignmentsStartingInWindow(
        dana,
        allCellIds,
        TODAY_START_MS,
        TODAY_END_MS,
      );
      const listedCount = (result: EntryResult): number => {
        const match = result.barSaid.match(/^(\d+) commands?/);
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
          "the two areas' listings together should name every block the walk left on today",
        ).toBe(beforeClear.length);
      }
      const afterClear = await (async () => {
        // waitForAssignmentGone needs one specific row; here we want ALL of
        // them gone, so poll the whole-window count down to zero instead.
        const deadline = Date.now() + 45_000;
        for (;;) {
          const rows = await assignmentsStartingInWindow(
            dana,
            allCellIds,
            TODAY_START_MS,
            TODAY_END_MS,
          );
          if (rows.length === 0) return rows;
          if (Date.now() > deadline) return rows;
          await new Promise((r) => setTimeout(r, 300));
        }
      })();
      expect(
        afterClear,
        "every block on today should be gone after the two areas' own yeses",
      ).toHaveLength(0);

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
          const lines = raw.split("\n").filter((l) => l.trim() !== "");
          const last = lines[lines.length - 1];
          if (last !== undefined && (JSON.parse(last) as { heard?: string }).heard === lastSay) {
            return lines;
          }
          if (Date.now() > deadline) return lines;
          await new Promise((r) => setTimeout(r, 300));
        }
      })();
      const traceLines = allLines.slice(-nonVoice.length);
      expect(
        traceLines.length,
        `expected at least ${nonVoice.length} trace lines in ${traceFile}`,
      ).toBe(nonVoice.length);
      const parsedTrace = traceLines.map((l) => JSON.parse(l) as Record<string, unknown>);
      for (let i = 0; i < nonVoice.length; i++) {
        const entry = parsedTrace[i];
        expect(entry.heard, `trace line ${i + 1}'s heard`).toBe(nonVoice[i].say);
        expect(entry.asked, `trace line ${i + 1}'s asked`).not.toBeNull();
        expect(entry.answered, `trace line ${i + 1}'s answered`).not.toBeNull();
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
        // this, an entry that reaches its listing through "Show that day"
        // and then declines it prints as though nothing happened.
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
    }
  });
});
