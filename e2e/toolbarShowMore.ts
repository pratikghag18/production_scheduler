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
 * A no-op when the band is already open (`textContent` reads "Show less"),
 * so a spec that opens it once and then reaches for a second Week-plan
 * button later in the same test does not toggle it shut again.
 */
export async function openShowMoreIfNeeded(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: /^Show (more|less)$/ });
  await toggle.waitFor({ state: "visible", timeout: 15_000 });
  if ((await toggle.textContent()) === "Show more") {
    await toggle.click();
  }
}
