import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { hasRealBackend, NO_BACKEND_REASON, supabaseUrl, supabaseAnonKey } from "./env";

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
 *
 * ⛔ WITH ONE EXCEPTION, AND IT IS THE PART OF THIS FILE THAT IS NOT A
 * MEASUREMENT AT ALL (DEF-0025, R-364). The drag below is a real release, and a
 * real release WRITES -- it detaches a chip from its run and moves it an hour.
 * So what it moves it puts back, and the putting back is PROVED rather than
 * believed: the person's rows are read out of the DATABASE before the drag and
 * again after it, anything that moved is restored, and the restore is read back
 * a third time. Those checks are allowed to fail the run. A measurement that
 * quietly leaves a developer's board an hour out is worse than a red one.
 *
 * ⚠️ WHAT IT DOES NOT PUT BACK, AND WILL NOT. A committed write leaves an
 * `assignments_audit` row and a bumped `updated_at` behind it, and the restore
 * leaves a second pair. Those are the RECORD of a change, not the change; a
 * measurement that reached into the audit log to tidy itself away would be a
 * worse thing than the trace it removed. R-364 is met in the sense that matters:
 * nobody's board moves.
 *
 * ⛔ AND DEF-0025's OWN ACCOUNT WAS WRONG ABOUT THE DAMAGE, WHICH MATTERS
 * BECAUSE THE TRUTH IS WORSE. It reported that every run shifted a real
 * assignment and never put it back. It never did: `.first()` was picking a chip
 * scrolled off the left edge (box at x = -574), so the release landed on nothing
 * at all -- no drag, no request, no write. Six sessions of "drag on the big
 * board: 14-37 ms" were the cost of releasing a mouse button over empty space.
 * See the comment on the drag itself.
 */
test.skip(!hasRealBackend, NO_BACKEND_REASON);

const ADMIN = "admin@example.test";
const PASSWORD = "devpassword";

/*
 * Where one assignment sits -- and it is FOUR columns, not two.
 *
 * ⛔ THE FIRST VERSION OF THIS CARRIED `node_id` AND `timerange` ONLY, AND THAT
 * WAS A HOLE THE SIZE OF THE DEFECT IT WAS FIXING. Pushing a chip past the end
 * of its own run does not merely move it: `useDragGesture` looks for a run that
 * contains the new window, finds none, and DETACHES -- `run_id` to null and
 * `product_id` to the run's product, in the same patch. A restore that put the
 * hours back and not the run reported "put back and read back" over a row that
 * was still detached, which is the same lie in a different column. Measured, not
 * reasoned: one run of the earlier version left `detached = 1` behind.
 */
type Placement = {
  node_id: string;
  timerange: string;
  run_id: string | null;
  product_id: string | null;
};

/*
 * ⚠️ UNTYPED ON PURPOSE, AND THE ROWS ARE CAST WHERE THEY ARRIVE. The generated
 * `Database` type lives under `src/`, which `tsconfig.node.json` does not list
 * -- importing it from a spec is the TS6307 its own comment warns about. Three
 * columns of two tables are named here instead, right where they are read.
 */
type Db = SupabaseClient;

/** The columns this file reads, named once so the select and the restore agree. */
type AssignmentRow = { id: string } & Placement;

/** The one list, so the read and the write can never drift apart. */
const PLACEMENT_COLUMNS = "id, node_id, timerange, run_id, product_id";

/**
 * Every assignment the named person holds, read from the DATABASE and not from
 * the board. The board is the thing under measurement here; asking it whether
 * the drag was undone would be asking the optimistic patch, which says yes the
 * instant the mouse comes up and keeps saying it while the server refuses.
 */
async function placementsOf(db: Db, person: string): Promise<Map<string, Placement>> {
  const found = await db.from("operators").select("id").eq("display_name", person);
  expect(found.error, found.error?.message).toBeNull();
  const people = (found.data ?? []) as unknown as { id: string }[];
  const id = people[0]?.id;
  // Not a matter of taste either: the fixture is present (the picker offered
  // "load_plant" or this spec would have skipped), so a `Load Op N` the board
  // just drew and the database will not name is a broken assumption, not a
  // reason to carry on and print a number.
  expect(id, `${person} is on the board, so the database should name them`).toBeTruthy();
  const rows = await db.from("assignments").select(PLACEMENT_COLUMNS).eq("operator_id", id);
  expect(rows.error, rows.error?.message).toBeNull();
  const held = (rows.data ?? []) as unknown as AssignmentRow[];
  return new Map(
    held.map((r) => [
      r.id,
      {
        node_id: r.node_id,
        timerange: r.timerange,
        run_id: r.run_id,
        product_id: r.product_id,
      },
    ]),
  );
}

/**
 * Undo whatever the drag committed, and prove it.
 *
 * ⛔ THE ROW COUNT IS THE POINT (CLAUDE.md section 4). `assignments_update` is an
 * RLS policy: an UPDATE the policy filters out removes zero rows, raises
 * nothing, and reports success. `.select()` makes PostgREST return the rows it
 * actually touched, so "exactly one" is asserted rather than assumed -- and then
 * the person's whole set is read a third time and compared with what was there
 * before the drag, which is the claim this function is really making.
 */
async function putBack(db: Db, person: string, before: Map<string, Placement>): Promise<string> {
  const after = await placementsOf(db, person);
  const same = (a?: Placement, b?: Placement) =>
    a?.node_id === b?.node_id &&
    a?.timerange === b?.timerange &&
    a?.run_id === b?.run_id &&
    a?.product_id === b?.product_id;
  const moved = [...before].filter(([id, was]) => !same(after.get(id), was));

  if (moved.length === 0) {
    // Worth printing rather than swallowing: it means the release committed
    // nothing, so the number beside it timed a no-op and is not the "what a
    // person waits for after letting go" that F-125 reads it as.
    return "committed nothing, so the number above timed a release that did not write";
  }

  for (const [id, was] of moved) {
    const back = await db
      .from("assignments")
      // All four in ONE update: `assignments_run_consistency` requires the row
      // to fit its run, so putting the run back in a second write -- before the
      // hours it has to contain -- is refused.
      .update({
        node_id: was.node_id,
        timerange: was.timerange,
        run_id: was.run_id,
        product_id: was.product_id,
      })
      .eq("id", id)
      .select("id");
    expect(back.error, `putting ${id} back: ${back.error?.message ?? ""}`).toBeNull();
    expect(
      back.data ?? [],
      `putting ${id} back should touch exactly one row -- zero means the policy filtered the UPDATE and said nothing`,
    ).toHaveLength(1);
  }

  const restored = await placementsOf(db, person);
  expect(
    Object.fromEntries(restored),
    `${person}'s assignments should be exactly where the fixture left them`,
  ).toEqual(Object.fromEntries(before));
  return `${moved.length} row(s) moved, put back and read back`;
}

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
    // Split the wait: how long the SERVER+NETWORK take (the board_window RPC
    // answering) against how long the CLIENT then takes to put a track on
    // screen. Without the split, "9.6 seconds" says nothing about which half to
    // look at -- and the DOM census shows the board virtualises to ~11 tracks,
    // so "it is drawing 5,760 chips" is already ruled out.
    const t0 = Date.now();
    const responded = page
      .waitForResponse((r) => r.url().includes("board_window"), { timeout: 180_000 })
      .then(() => Date.now() - t0)
      .catch(() => -1);
    await picker.selectOption(value);
    const rpcMs = await responded;
    await expect(trackNamed(cell)).toBeVisible({ timeout: 180_000 });
    return { total: Date.now() - t0, rpc: rpcMs };
  }

  const small = options.find((o) => o.value !== "load_plant")!;
  // Plant A's first cell is "Cell 1"; the fixture's is "Cell 1-1-1". `^Cell 1 `
  // cannot match "Cell 1-1-1", so the two are genuinely distinguishable.
  const smallT = await timeCold(small.value, "Cell 1");
  const bigT = await timeCold("load_plant", "Cell 1-1-1");
  const smallMs = smallT.total;
  const bigMs = bigT.total;

  /*
   * How much DOM the big board actually builds. The point is to tell "384 track
   * rows are expensive" apart from "5,760 chips are expensive", which decides
   * whether the answer is virtualisation, fewer chips, or neither.
   */
  const dom = await page.evaluate(() => ({
    total: document.querySelectorAll("*").length,
    tracks: document.querySelectorAll('[aria-label$="press Enter to create"]').length,
    chips: document.querySelectorAll('[aria-label*=" on "]').length,
  }));

  /*
   * The drag: take a block on the big board, push it an hour right, and time
   * the release. Measured from mouse-up to the board settling, which is what a
   * person feels.
   *
   * ⛔⛔ FOR SIX SESSIONS THIS MEASURED NOTHING AT ALL, AND SAID SO IN A COLUMN
   * OF NUMBERS THAT LOOKED FINE. `.first()` picks the first chip in DOM order,
   * not the first chip a person can see: on this board its box came back at
   * x = -574, scrolled off the left edge. `page.mouse.move` to a negative
   * coordinate lands on nothing, so no drag ever began -- no `.dragging` class,
   * no request, no write -- and "32 ms from mouse-up to settled" was the cost of
   * releasing a mouse button over empty space. F-125 reads that column as "a
   * drag once there is 14-37ms, so this is a cost of arriving at a big board
   * rather than of using one"; that reading rests on this line, so this line now
   * proves it dragged before it prints a number.
   *
   * ⛔ AND WHAT IT MOVES IT PUTS BACK (DEF-0025). The narrow fix for that defect
   * was `touch.spec.ts` T2's -- press Escape before the release so nothing is
   * written. That is the wrong trade HERE, and only here: a release that writes
   * nothing is the very thing that made these numbers meaningless. So the write
   * stays and `putBack` undoes it, provably.
   *
   * ⚠️ R-365: THE RELEASE NOW ASKS BEFORE IT WRITES. The fixture's chips exactly
   * fill their runs, so an hour's push always detaches -- `commitBlockDrag`
   * asks Continue/Cancel rather than committing on mouse-up. The timed window
   * moves to the CLICK: it is the answer to the prompt, not the mouse coming
   * up, that a person is actually waiting on the settle from.
   */
  let dragMs = -1;
  let dragRpcMs = -1;
  let dragNote = "";
  let patches = 0;
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes("/rest/v1/assignments")) patches += 1;
  });

  // The chip's own label is "<person> on <product>, HH:MM to HH:MM"; the
  // fixture's people are all called "Load Op N", so this cannot pick up a chip
  // from another plant left over on screen.
  const block = page.getByLabel(/^Load Op \d+ on /).first();
  if ((await block.count()) > 0) {
    // Read the person's name off the chip that is about to be dragged: the drag
    // moves an assignment of THEIRS, so their rows are the set that has to come
    // back unchanged. Signed in a second time, as a client rather than a
    // browser, because the board cannot be asked what the server actually holds
    // -- the optimistic patch says "moved" the instant the mouse comes up and
    // keeps saying it while the server refuses.
    const label = (await block.getAttribute("aria-label")) ?? "";
    const person = /^Load Op \d+/.exec(label)?.[0] ?? "";
    expect(person, `the chip's label should name the person: ${label}`).not.toBe("");
    const db = createClient(supabaseUrl, supabaseAnonKey);
    const signedIn = await db.auth.signInWithPassword({ email: ADMIN, password: PASSWORD });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const before = await placementsOf(db, person);

    await block.scrollIntoViewIfNeeded();
    const box = await block.boundingBox();
    if (box !== null) {
      /*
       * Grab a point that is inside the chip AND inside the window, with 60px
       * of room to the right of it. A fixture chip is eight hours wide, so its
       * own centre is routinely off-screen even once it has been scrolled to.
       */
      const view = page.viewportSize() ?? { width: 1280, height: 720 };
      const left = Math.max(box.x + 6, 6);
      const right = Math.min(box.x + box.width - 6, view.width - 70);
      expect(right, "the chip needs 60px of visible width to be dragged by").toBeGreaterThan(left);
      const grabX = (left + right) / 2;
      const grabY = Math.min(Math.max(box.y + box.height / 2, 6), view.height - 6);

      await page.mouse.move(grabX, grabY);
      await page.mouse.down();
      await page.mouse.move(grabX + 60, grabY, { steps: 8 });

      /*
       * ⭐ THE ASSERTION THAT WOULD HAVE CAUGHT THE SIX SESSIONS. A block that
       * is being dragged marks itself `.dragging`, and only while the gesture
       * is live (`touch.spec.ts` T2 leans on the same class for the same
       * reason). Below `DRAG_THRESHOLD_PX` -- or on nothing at all -- the class
       * never appears and the release opens the read-only pop-up instead. This
       * is a measurement spec and asserts almost nothing on purpose, but "the
       * thing being measured happened" is not a matter of taste.
       */
      await expect(page.locator('[role="button"][class*="dragging"]').first()).toBeVisible({
        timeout: 5_000,
      });

      // R-365: the release opens the confirm popover instead of committing --
      // the fixture chip exactly fills its run, so an hour's push always
      // detaches it. Continue has to be clicked before there is anything to
      // settle or refetch.
      await page.mouse.up();

      /*
       * Split the settle the same way the two cold loads above are split: a
       * committed drag invalidates the board, so part of the wait is the
       * `board_window` RPC answering again and the rest is the client drawing
       * what came back. Armed right before the Continue click, because the
       * refetch starts on the same tick the mutation succeeds.
       */
      // Declared before the listener that closes over it: the listener only
      // reads it once the click has stamped it.
      let tUp = 0;
      const refetched = page
        .waitForResponse((r) => r.url().includes("board_window"), { timeout: 60_000 })
        .then(() => Date.now() - tUp)
        .catch(() => -1);

      await page.getByRole("button", { name: "Continue" }).click();
      tUp = Date.now();
      await page.waitForTimeout(0);
      await expect(trackNamed("Cell 1-1-1")).toBeVisible({ timeout: 60_000 });
      dragMs = Date.now() - tUp;
      // The settle has already happened, so a refetch that was going to come has
      // come. The short race is what stops a release that refetches NOTHING from
      // sitting here for the full timeout.
      dragRpcMs = await Promise.race([
        refetched,
        new Promise<number>((resolve) => setTimeout(() => resolve(-1), 500)),
      ]);
    }

    // Unconditional on the box: if the gesture never started there is nothing
    // to undo and this says so, and if it started and committed this is the
    // only thing that undoes it.
    dragNote = await putBack(db, person, before);
  }

  console.log(
    [
      "",
      `  ${small.text.trim()} (small)      ${smallMs} ms total, of which ${smallT.rpc} ms was the board_window RPC`,
      `  Load Plant (384 cells)          ${bigMs} ms total, of which ${bigT.rpc} ms was the board_window RPC`,
      `                                  so the client half is ~${bigMs - Math.max(bigT.rpc, 0)} ms on the big board`,
      `  DOM on the big board            ${dom.total} elements, ${dom.tracks} tracks, ${dom.chips} chips`,
      dragMs >= 0
        ? dragRpcMs >= 0
          ? `  drag on the big board           ${dragMs} ms from Continue to settled, of which ${dragRpcMs} ms was the board_window RPC answering again`
          : `  drag on the big board           ${dragMs} ms from Continue to settled, and NO board_window answered in that window -- all of it is client work on the optimistic patch`
        : "  drag                            no block found to drag",
      `  what the release wrote          ${patches} PATCH to assignments; ${dragNote === "" ? "no drag happened" : dragNote}`,
      "",
    ].join("\n"),
  );

  // The only thing that is not a matter of taste: it renders.
  expect(bigMs).toBeGreaterThan(0);
});
