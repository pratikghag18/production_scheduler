import type { Page } from "@playwright/test";

/**
 * S67-b (R-445 corrected, 18 Sept): the board's From date and Days fields
 * live inside the toolbar's range dropdown now (`BoardToolbar.tsx`, the
 * button whose `aria-controls` is the pop-over's id), not in the row. Every
 * spec that used to `fill` `#board-window-start` directly opens the dropdown
 * first through this helper and closes it again with Escape, so the pop-over
 * never sits over the board a later step clicks.
 */
export async function fillWindowStart(page: Page, iso: string): Promise<void> {
  const button = page.locator('button[aria-controls="board-toolbar-range"]');
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  const start = page.locator("#board-window-start");
  await start.fill(iso);
  // The date change refetches on change; leave the pop-over closed so the
  // board underneath is clickable again. Escape returns focus to the button.
  await start.press("Escape");
}
