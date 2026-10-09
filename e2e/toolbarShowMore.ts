import type { Page } from "@playwright/test";

/**
 * S67 (R-445) review finding (TR-3): "Copy week" / "Apply a template" /
 * "Save this week as a template" moved behind the toolbar's "Show more"
 * band. `copyWeek.spec.ts` and `weekTemplates.spec.ts` clicked those buttons
 * directly, in the row, which is where they lived before this session's
 * lane -- unmodified they time out waiting for a button the row no longer
 * renders. One helper, not a copy pasted into each spec (CLAUDE.md §4: a
 * list, or here a gesture, that appears twice is a bug with a delay on it).
 *
 * A no-op when the band is already open, so a spec that opens it once and
 * then reaches for a second Week-plan button later in the same test does
 * not toggle it shut again.
 *
 * S67-b (R-445 CORRECTED 18 Sept) briefly made the button's VISIBLE text a
 * constant "More" in both states, carrying open/closed only in
 * `aria-label` -- the maintainer withdrew that the same day ("Just more
 * button is meaningless"), so the visible text is `BoardToolbar.tsx`'s
 * "Show more"/"Show less" again. The read below still uses `aria-expanded`
 * rather than the text, which was already the more direct fact and needed
 * no change either way.
 */
export async function openShowMoreIfNeeded(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: /^Show (more|less)$/ });
  await toggle.waitFor({ state: "visible", timeout: 15_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
}
