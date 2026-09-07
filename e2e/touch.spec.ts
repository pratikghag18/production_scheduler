/// <reference lib="dom" />
import { test, expect, type Page, type CDPSession } from "@playwright/test";
import { hasRealBackend, NO_BACKEND_REASON } from "./env";

/**
 * THE TOUCH ACCEPTANCE PASS ON BOTH DRAGS (wave 2, lane C).
 *
 * The queue's own words: "Drags use pointer events but have never been tried on
 * a tablet. Verified on a touch screen, fixes as found." There is no tablet on
 * the developer's machine, so this file IS "verified on a touch screen": it runs
 * ONLY under the `touch` Playwright project (a Chromium `Galaxy Tab S4 landscape`
 * profile, `hasTouch: true`), drives every drag with real touch events via the
 * CDP `Input.dispatchTouchEvent` command — the Chromium way to get a pointer
 * type of `touch` and have `touch-action` decide scroll-vs-drag as it does on a
 * real tablet — and asserts each gesture, keeping the check with the rest of the
 * browser suite.
 *
 * WHY CDP AND NOT `page.touchscreen`. `page.touchscreen` only taps; a drag needs
 * touchStart/touchMove.../touchEnd with a real touch pointer, which only
 * `Input.dispatchTouchEvent` produces. `page.evaluate`'d synthetic
 * `PointerEvent`s are deliberately NOT used as the primary path — they bypass
 * `touch-action` and so prove nothing about whether a surface scrolls.
 *
 * SHAPE. Same as signedIn.spec.ts: skips without a backend rather than failing,
 * signs in through the real form as the dev world's own people, asserts what is
 * on the screen. A skip is not a pass.
 *
 * LEAVES THE DEMO WORLD AS IT FINDS IT. The cases that could write (a block
 * move, a tree/level reorder) abort the gesture before it commits — a block
 * drag is reverted with Escape, a grip drag is released over empty space where
 * there is no drop target — so `roleWalk.spec.ts`, which reads the demo week,
 * still passes after this run. The two cases that DO open something (a create
 * pop-up, a panel drop) only ever open it and Cancel; opening a create pop-up
 * writes nothing.
 */

test.skip(!hasRealBackend, NO_BACKEND_REASON);

const PASSWORD = "devpassword";
const SUPERVISOR = "ana@example.test"; // supervisor, Plant A / Line 1, can place
const VIEWER = "viva@example.test"; // viewer, Plant A, cannot place
const SITE_ADMIN = "dana@example.test"; // site admin, Plant A — reaches the admin tree

async function signIn(page: Page, email: string, path = "/"): Promise<void> {
  await page.goto(`/sign-in?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

/** `YYYY-MM-DD` of the Monday of the current UTC week, where the demo's runs sit. */
function mondayOfThisWeek(): string {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = new Date(today).getUTCDay();
  const sinceMonday = day === 0 ? 6 : day - 1;
  return new Date(today - sinceMonday * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Real touch input, the CDP way. One finger, id 1, held across the sequence.
// ---------------------------------------------------------------------------

type Pt = { x: number; y: number };

async function touchStart(cdp: CDPSession, p: Pt): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: p.x, y: p.y, id: 1 }],
  });
}
async function touchMove(cdp: CDPSession, p: Pt): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: p.x, y: p.y, id: 1 }],
  });
}
async function touchEnd(cdp: CDPSession): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Step from `from` to `to` in `steps` touchMoves. The board's DRAG_THRESHOLD_PX
 *  is 4 and the tree/level surfaces start a drag only after that threshold, so a
 *  drag has to arrive as several small increments — one big jump is not what a
 *  finger produces and can skip the threshold logic under test. */
async function touchMoveTo(cdp: CDPSession, from: Pt, to: Pt, steps = 8): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    await touchMove(cdp, {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    });
  }
}

const center = (b: { x: number; y: number; width: number; height: number }): Pt => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
});

// ---------------------------------------------------------------------------
// The board's own horizontal scroll container: found from a track, so the
// tests never hard-code a class. Used to (a) park the view over empty track for
// the create/panel cases, and (b) read scrollLeft, the fact that separates "the
// block dragged" from "the container scrolled".
// ---------------------------------------------------------------------------

/** Park the view at the far end of the window (clear, unstaffed track) and hand
 *  back the scroll container's on-screen rectangle. */
async function scrollBoardToEnd(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await page.evaluate(() => {
    let el: HTMLElement | null = document.querySelector<HTMLElement>(
      '[aria-label*="press Enter to create"]',
    );
    while (el) {
      const s = getComputedStyle(el);
      if (
        el.scrollWidth > el.clientWidth + 1 &&
        (s.overflowX === "auto" || s.overflowX === "scroll")
      )
        break;
      el = el.parentElement;
    }
    if (!el) return null;
    el.scrollLeft = el.scrollWidth;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!rect) throw new Error("board scroll container not found");
  return rect;
}

async function boardScrollLeft(page: Page): Promise<number> {
  return page.evaluate(() => {
    let el: HTMLElement | null = document.querySelector<HTMLElement>(
      '[aria-label*="press Enter to create"]',
    );
    while (el) {
      const s = getComputedStyle(el);
      if (
        el.scrollWidth > el.clientWidth + 1 &&
        (s.overflowX === "auto" || s.overflowX === "scroll")
      )
        break;
      el = el.parentElement;
    }
    return el ? el.scrollLeft : -1;
  });
}

async function setBoardScrollLeft(page: Page, x: number): Promise<void> {
  await page.evaluate((left) => {
    let el: HTMLElement | null = document.querySelector<HTMLElement>(
      '[aria-label*="press Enter to create"]',
    );
    while (el) {
      const s = getComputedStyle(el);
      if (
        el.scrollWidth > el.clientWidth + 1 &&
        (s.overflowX === "auto" || s.overflowX === "scroll")
      )
        break;
      el = el.parentElement;
    }
    if (el) el.scrollLeft = left;
  }, x);
}

async function boardScrollMeta(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => {
    let el: HTMLElement | null = document.querySelector<HTMLElement>(
      '[aria-label*="press Enter to create"]',
    );
    while (el) {
      const s = getComputedStyle(el);
      if (
        el.scrollWidth > el.clientWidth + 1 &&
        (s.overflowX === "auto" || s.overflowX === "scroll")
      )
        break;
      el = el.parentElement;
    }
    return { scrollWidth: el ? el.scrollWidth : 0, clientWidth: el ? el.clientWidth : 0 };
  });
}

/** A block on the board — a run band, an assignment chip or a direct block; every
 *  one's accessible name ends in "HH:MM to HH:MM". */
const anyBlock = (page: Page) => page.getByRole("button", { name: /\d\d:\d\d to \d\d:\d\d/ });

/** Scan the window left→right until a block renders. The board only mounts the
 *  blocks in the horizontal range currently in view (§6), and the demo's runs
 *  need not be under wherever the board auto-scrolled to "now" — so a case that
 *  must grab a block first drives the container until one is on screen. */
async function revealBlock(page: Page): Promise<void> {
  if (
    await anyBlock(page)
      .first()
      .isVisible()
      .catch(() => false)
  )
    return;
  const { scrollWidth, clientWidth } = await boardScrollMeta(page);
  for (let x = 0; x <= scrollWidth; x += Math.max(200, Math.floor(clientWidth * 0.8))) {
    await setBoardScrollLeft(page, x);
    await page.waitForTimeout(120);
    if (
      await anyBlock(page)
        .first()
        .isVisible()
        .catch(() => false)
    )
      return;
  }
  throw new Error("no block found anywhere in the board window");
}

async function boardContainerRect(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await page.evaluate(() => {
    let el: HTMLElement | null = document.querySelector<HTMLElement>(
      '[aria-label*="press Enter to create"]',
    );
    while (el) {
      const s = getComputedStyle(el);
      if (
        el.scrollWidth > el.clientWidth + 1 &&
        (s.overflowX === "auto" || s.overflowX === "scroll")
      )
        break;
      el = el.parentElement;
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!rect) throw new Error("board scroll container not found");
  return rect;
}

/**
 * A touch point ON a block, in the part of it that is clear of the sticky rail
 * and inside the visible track. The rail (the node-name column) overlays the
 * left of every track — wide on the tablet's scaled UI — and a touch that lands
 * on it pans the board instead of hitting the block. A block can be very wide (a
 * run band spanning hours), so its CENTRE can fall under the rail while most of
 * it is perfectly touchable; this returns a point in the visible slice and how
 * much room there is to drag right from it, so the caller does not have to know
 * the geometry.
 */
async function grabBlockTouch(page: Page): Promise<{
  point: Pt;
  dragDx: number;
  box: { x: number; y: number; width: number; height: number };
}> {
  await revealBlock(page);
  const cont = await boardContainerRect(page);
  const railBox = await page
    .locator('[class*="cellLabel"]')
    .first()
    .boundingBox()
    .catch(() => null);
  const railW = railBox ? railBox.width : 200;
  const safeLeft = cont.x + railW + 12;
  const safeRight = cont.x + cont.width - 12;

  const blocks = anyBlock(page);
  const n = await blocks.count();
  // The block with the widest slice inside the clear track zone.
  let best: {
    visLeft: number;
    visRight: number;
    cy: number;
    box: { x: number; y: number; width: number; height: number };
  } | null = null;
  let bestSlice = 0;
  for (let i = 0; i < n; i++) {
    const bb = await blocks.nth(i).boundingBox();
    if (!bb || bb.width < 10) continue;
    const visLeft = Math.max(bb.x, safeLeft);
    const visRight = Math.min(bb.x + bb.width, safeRight);
    const slice = visRight - visLeft;
    if (slice > bestSlice) {
      bestSlice = slice;
      best = { visLeft, visRight, cy: bb.y + bb.height / 2, box: bb };
    }
  }
  if (!best || bestSlice < 70) {
    const dump: string[] = [];
    for (let i = 0; i < n; i++) {
      const bb = await blocks.nth(i).boundingBox();
      dump.push(bb ? `${Math.round(bb.x)},${Math.round(bb.width)}` : "null");
    }
    throw new Error(
      `no block with a touchable slice: cont.x=${Math.round(cont.x)} w=${Math.round(cont.width)} railW=${Math.round(railW)} safe=[${Math.round(safeLeft)},${Math.round(safeRight)}] n=${n} blocks(x,w)=[${dump.join(" | ")}]`,
    );
  }
  // Press near the left of the visible slice so there is room to drag right.
  const point = { x: best.visLeft + 12, y: best.cy };
  const dragDx = Math.min(120, best.visRight - point.x - 8);
  return { point, dragDx, box: best.box };
}

/** The first schedulable track row (its bare-track div, the create surface). */
async function firstTrack(page: Page) {
  const track = page.getByLabel(/press Enter to create/).first();
  await expect(track).toBeVisible({ timeout: 20_000 });
  return track;
}

async function openBoardAt(page: Page, email: string): Promise<void> {
  await signIn(page, email, "/");
  await firstTrack(page); // board's first window has drawn
  await page.locator("#board-window-start").fill(mondayOfThisWeek());
  await firstTrack(page); // the refetch has settled
}

// ===========================================================================
// The board — three on-track gestures plus the roster-chip drag, as a
// supervisor who can place (Ana).
// ===========================================================================

test("T1: a finger dragging on empty track opens the create pop-up (create, not scroll)", async ({
  page,
}) => {
  await openBoardAt(page, SUPERVISOR);
  const cdp = await page.context().newCDPSession(page);

  // Park over the end of the window: empty, unstaffed track whose only overlay
  // (the off-shift wash) is `pointer-events: none`, so a touch there lands on
  // the bare track and starts a CREATE gesture — not on a run band or a break.
  const container = await scrollBoardToEnd(page);
  const track = await firstTrack(page);
  const tb = (await track.boundingBox())!;
  const y = tb.y + tb.height / 2;
  const startX = container.x + container.width - 40;
  const from = { x: startX, y };
  const to = { x: startX - 160, y }; // 160px ≈ well over MIN_DURATION at any zoom

  const before = await boardScrollLeft(page);
  await touchStart(cdp, from);
  await touchMoveTo(cdp, from, to);
  await touchEnd(cdp);

  // The create gesture ran: its pop-up is up. And the container did NOT scroll
  // under the finger — the drag was the track's, not the board's.
  await expect(page.getByRole("dialog", { name: "New" })).toBeVisible({ timeout: 10_000 });
  expect(await boardScrollLeft(page)).toBe(before);

  await page.getByRole("dialog", { name: "New" }).getByRole("button", { name: "Cancel" }).click();
});

test("T2: a finger drags a block along its track (drag, not scroll), reverted before it commits", async ({
  page,
}) => {
  await openBoardAt(page, SUPERVISOR);
  const cdp = await page.context().newCDPSession(page);

  // A block's touchable slice (clear of the sticky rail), and the room to drag.
  const { point: start, dragDx, box: b0 } = await grabBlockTouch(page);
  const scrollBefore = await boardScrollLeft(page);

  // Press and drag right, in steps, WITHOUT lifting: the block follows the
  // finger because it carries `touch-action: none`, and the container cannot
  // pan for the same reason.
  await touchStart(cdp, start);
  await touchMoveTo(cdp, start, { x: start.x + dragDx, y: start.y }, 10);
  await page.waitForTimeout(60);

  // The dragged block marks itself `.dragging` (only while a drag is live), so
  // its presence proves the gesture STARTED and its box is where it now sits.
  const dragged = page.locator('[role="button"][class*="dragging"]').first();
  await expect(dragged).toBeVisible();
  const b1 = (await dragged.boundingBox())!;
  // The block moved along its track...
  expect(b1.x).toBeGreaterThan(b0.x + 20);
  // ...and the board did NOT scroll: this is a drag, not a scrolled container.
  expect(await boardScrollLeft(page)).toBe(scrollBefore);

  // Abort before the pointerup can commit anything: Escape clears the in-flight
  // drag, so the release writes nothing and the run keeps its seeded time.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await touchEnd(cdp);
});

test("T3: a finger drags a roster chip onto a track and the create pop-up opens (panel drag)", async ({
  page,
}) => {
  await openBoardAt(page, SUPERVISOR);
  const cdp = await page.context().newCDPSession(page);

  const panel = page.getByRole("complementary", { name: "Operators" });
  await expect(panel).toBeVisible({ timeout: 20_000 });
  // The first roster chip — a div carrying `touch-action: none` inline, wired to
  // beginPanelDrag on pointerdown.
  const chip = panel.locator('[class*="chip"]').first();
  await expect(chip).toBeVisible({ timeout: 20_000 });
  const cb = (await chip.boundingBox())!;

  // Drop onto clear track at the end of the window.
  const container = await scrollBoardToEnd(page);
  const track = await firstTrack(page);
  const tb = (await track.boundingBox())!;
  const drop = { x: container.x + container.width - 60, y: tb.y + tb.height / 2 };

  const from = center(cb);
  await touchStart(cdp, from);
  await touchMoveTo(cdp, from, drop, 12);
  await touchEnd(cdp);

  // A panel drop routes through the create pop-up (D65), pre-filled in direct
  // mode with the dropped operator — so its appearance is the panel drag working
  // under a finger.
  await expect(page.getByRole("dialog", { name: "New" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("dialog", { name: "New" }).getByRole("button", { name: "Cancel" }).click();
});

test("T4: a finger moves a pop-up by its title bar, and a tap on a button inside still works", async ({
  page,
}) => {
  await openBoardAt(page, SUPERVISOR);
  const cdp = await page.context().newCDPSession(page);

  // Open a create pop-up the same way T1 does.
  const container = await scrollBoardToEnd(page);
  const track = await firstTrack(page);
  const tb = (await track.boundingBox())!;
  const y = tb.y + tb.height / 2;
  const startX = container.x + container.width - 40;
  await touchStart(cdp, { x: startX, y });
  await touchMoveTo(cdp, { x: startX, y }, { x: startX - 160, y });
  await touchEnd(cdp);

  const dialog = page.getByRole("dialog", { name: "New" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const box0 = (await dialog.boundingBox())!;

  // The title (h3) is the drag handle, `touch-action: none`. Drag it and the
  // whole pop-up moves.
  const handle = dialog.getByRole("heading", { name: "New" });
  const hb = (await handle.boundingBox())!;
  const hStart = center(hb);
  await touchStart(cdp, hStart);
  await touchMoveTo(cdp, hStart, { x: hStart.x - 140, y: hStart.y + 90 }, 10);
  await touchEnd(cdp);

  const box1 = (await dialog.boundingBox())!;
  expect(Math.abs(box1.x - box0.x) + Math.abs(box1.y - box0.y)).toBeGreaterThan(30);

  // A tap on a control inside the (now moved) pop-up still works: Cancel closes it.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
});

// ===========================================================================
// The board as a viewer (Viva): a finger must not start a drag at all — and
// that is different from the container scrolling.
// ===========================================================================

test("T5: a viewer's finger neither drags a block nor creates on empty track (refused, not scrolled)", async ({
  page,
}) => {
  await openBoardAt(page, VIEWER);
  const cdp = await page.context().newCDPSession(page);

  // A block is on her board (read-only), centred clear of the rail. A finger
  // dragging it must not MOVE it: DEF-0015 gates the move/commit on canPlace, so
  // the block never follows the pointer and the release only opens its read-only
  // pop-up. (The block may take a transient "grabbed" style, but its position is
  // the fact that matters.)
  const { point: start, dragDx, box: c0 } = await grabBlockTouch(page);
  const scrollBefore = await boardScrollLeft(page);
  await touchStart(cdp, start);
  await touchMoveTo(cdp, start, { x: start.x + Math.max(dragDx, 60), y: start.y }, 10);
  await page.waitForTimeout(60);
  // The block did not move (the drag was refused)...
  const held = page.locator('[role="button"][class*="dragging"]').first();
  const c1 = (await held.boundingBox().catch(() => null)) ?? c0;
  expect(Math.abs(c1.x - c0.x)).toBeLessThan(6);
  // ...and the board did not scroll either (the block's `touch-action: none`
  // holds even for a refused drag) — so this is a refusal, not a scroll.
  expect(await boardScrollLeft(page)).toBe(scrollBefore);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await touchEnd(cdp);

  // A finger dragging empty track opens no create pop-up: a viewer cannot place.
  const container = await scrollBoardToEnd(page);
  const track = await firstTrack(page);
  const tb = (await track.boundingBox())!;
  const y = tb.y + tb.height / 2;
  const tx = container.x + container.width - 40;
  await touchStart(cdp, { x: tx, y });
  await touchMoveTo(cdp, { x: tx, y }, { x: tx - 160, y });
  await touchEnd(cdp);
  await page.waitForTimeout(300);
  await expect(page.getByRole("dialog", { name: "New" })).toHaveCount(0);
});

// ===========================================================================
// The admin tree and the level list (Dana): on touch, ONLY the ⠿ grip drags;
// the rest of the row stays for scrolling / text.
// ===========================================================================

async function openAdminHierarchy(page: Page): Promise<void> {
  await signIn(page, SITE_ADMIN, "/admin");
  // The hierarchy section is the default; the node tree draws its rows.
  await expect(page.locator("[data-node-id]").first()).toBeVisible({ timeout: 20_000 });
}

test("T6: a finger on a tree row BODY does not start a reorder (the row stays scrollable)", async ({
  page,
}) => {
  await openAdminHierarchy(page);
  const cdp = await page.context().newCDPSession(page);

  const rows = page.locator("[data-node-id]");
  const namesBefore = await rows.locator("> span").allTextContents();

  // Press on the node NAME (row body, not the grip) and drag past the
  // threshold. `rowIsDragSource("touch")` is false, so no drag begins.
  const row = rows.first();
  const name = row.locator("> span").first();
  const nb = (await name.boundingBox())!;
  const start = center(nb);
  await touchStart(cdp, start);
  await touchMoveTo(cdp, start, { x: start.x, y: start.y + 80 }, 10);
  await page.waitForTimeout(80);
  // No drag chip means no drag started (the floating label appears only once a
  // drag passes the threshold).
  await expect(page.locator('[class*="dragChip"]')).toHaveCount(0);
  await touchEnd(cdp);

  // And nothing reordered.
  expect(await rows.locator("> span").allTextContents()).toEqual(namesBefore);
});

test("T7: a finger on the tree ⠿ grip starts a drag (dropped over nothing, so no reorder)", async ({
  page,
}) => {
  await openAdminHierarchy(page);
  const cdp = await page.context().newCDPSession(page);

  const rows = page.locator("[data-node-id]");
  const namesBefore = await rows.locator("> span").allTextContents();

  // The tree grip is a button labelled exactly "Drag <name>" (the level list's
  // grip is "Drag <name> to reorder" — a different surface — so scope to a tree
  // row to be sure of the one under test).
  const grip = rows.first().getByRole("button", { name: /^Drag (?!.* to reorder$).*/ });
  await expect(grip).toBeVisible({ timeout: 20_000 });
  const gb = (await grip.boundingBox())!;
  const start = center(gb);

  await touchStart(cdp, start);
  // Past the threshold, staying over the tree so `live` (and the drag chip) is set.
  await touchMoveTo(cdp, start, { x: start.x, y: start.y + 60 }, 8);
  await page.waitForTimeout(80);
  await expect(page.locator('[class*="dragChip"]').first()).toBeVisible();

  // Release over empty space (top-left corner, off every row) so there is no
  // drop target and the drag commits nothing.
  await touchMoveTo(cdp, { x: start.x, y: start.y + 60 }, { x: 6, y: 6 }, 8);
  await touchEnd(cdp);
  await page.waitForTimeout(120);

  expect(await rows.locator("> span").allTextContents()).toEqual(namesBefore);
});

test("T8: a finger on the level list ⠿ grip starts a drag (dropped over nothing, so no reorder)", async ({
  page,
}) => {
  await openAdminHierarchy(page);
  const cdp = await page.context().newCDPSession(page);

  const levelRows = page.locator("[data-level-index]");
  await expect(levelRows.first()).toBeVisible({ timeout: 20_000 });
  const countBefore = await levelRows.count();
  // Need at least two levels so a downward grip move lands over a sibling row
  // (where the dragging state is live) before it is released over nothing.
  expect(countBefore).toBeGreaterThan(1);

  const firstBox = (await levelRows.first().boundingBox())!;
  const grip = page.getByRole("button", { name: /^Drag .* to reorder$/ }).first();
  await expect(grip).toBeVisible({ timeout: 20_000 });
  const gb = (await grip.boundingBox())!;
  const start = center(gb);

  await touchStart(cdp, start);
  // Down past the threshold, over the next level row, so the surface's dragging
  // state is live.
  await touchMoveTo(cdp, start, { x: start.x, y: firstBox.y + firstBox.height * 1.5 }, 8);
  await page.waitForTimeout(80);
  await expect(page.locator('[class*="rowDragging"], [class*="dragging"]').first()).toBeVisible();

  // Release over empty space so no reorder commits.
  await touchMoveTo(cdp, { x: start.x, y: firstBox.y + firstBox.height * 1.5 }, { x: 6, y: 6 }, 8);
  await touchEnd(cdp);
  await page.waitForTimeout(120);

  expect(await levelRows.count()).toBe(countBefore);
});
