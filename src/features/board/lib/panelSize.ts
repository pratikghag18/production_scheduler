/**
 * S63-a (R-429): THE PANEL'S REMEMBERED SIZE.
 *
 * The launcher's panel (`CommandLauncher.tsx`) is anchored bottom-right and
 * grows from its top and left edges, so "the panel's size" is just a width
 * and a height -- and the maintainer wants it kept per person, the same way
 * the thread itself is (`commandConversation.ts`'s `historyStorageKey`).
 * This module is that store's own shape, over `localStorage`, and nothing
 * else: no React, no store, no knowledge of the panel's DOM. `CommandLauncher`
 * is the only caller.
 *
 * Storage is best-effort throughout, same reasoning as
 * `commandConversation.ts`'s own doc: a private window, a full quota, or a
 * browser with site data blocked must never break the panel, only cost it
 * the memory.
 */

export interface PanelSize {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** R-429: the floor -- small enough to still show the input, too small to
 *  hide the thread entirely. */
export const MIN_PANEL_WIDTH = 320;
export const MIN_PANEL_HEIGHT = 240;

/** R-429: the panel never grows past the viewport minus an 18px margin on
 *  every side it could touch -- the same 18px `CommandLauncher.module.css`
 *  already keeps between the button/panel and the screen edge. */
const VIEWPORT_MARGIN = 18;

/**
 * CR-3 (reviewer fix, S63 review): `CommandLauncher.module.css`'s `.panel`
 * is anchored `bottom: 76px`, not `bottom: 18px` -- there is room kept below
 * it for the launcher button. Growing height uses this offset on the
 * bottom/anchored side and `VIEWPORT_MARGIN` on the top/growing side (the
 * same `calc(100% - 94px)` the CSS's own `max-height` already encodes,
 * belt-and-braces, right next to this constant's own name). Before this
 * fix `clampPanelSize` clamped height to `viewport.height - 36` (treating
 * both edges as the 18px margin, copying the WIDTH math for a panel that
 * is not symmetric top/bottom) -- up to 58px taller than the panel can
 * actually occupy without its top edge going off-screen. The CSS
 * `max-height` masked the visual overflow, but the stored/remembered
 * `size.height` still carried the too-tall number, so a drag that hit the
 * real (CSS) ceiling read back as "not yet at the limit" and needed an
 * extra ~58px of upward drag before the panel visibly moved again.
 */
const PANEL_BOTTOM_OFFSET = 76;

/** Where one person's panel size for one board lives. Prefixed rather than
 *  reusing `key` bare so the two stores (the thread, the size) never collide
 *  in `localStorage` even though both are keyed off the same `historyKey`. */
function storageKey(key: string): string {
  return `commandLauncher.panelSize.${key}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPanelSize(value: unknown): value is PanelSize {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.width) && isFiniteNumber(v.height);
}

/**
 * Clamps `size` to the app's floor (`MIN_PANEL_WIDTH`/`MIN_PANEL_HEIGHT`) and
 * to `viewport` minus the margin on both sides -- both ways, so a size that
 * is too SMALL (a corrupt or hand-edited value) and one that is too LARGE (a
 * size remembered from a bigger screen, reopened on a smaller one) both come
 * back sane. When the viewport itself is smaller than the floor, the floor
 * wins -- a panel that cannot fit is still better than one clamped to
 * nothing.
 */
export function clampPanelSize(size: PanelSize, viewport: Viewport): PanelSize {
  const maxWidth = Math.max(MIN_PANEL_WIDTH, viewport.width - VIEWPORT_MARGIN * 2);
  const maxHeight = Math.max(
    MIN_PANEL_HEIGHT,
    viewport.height - VIEWPORT_MARGIN - PANEL_BOTTOM_OFFSET,
  );
  return {
    width: Math.min(Math.max(size.width, MIN_PANEL_WIDTH), maxWidth),
    height: Math.min(Math.max(size.height, MIN_PANEL_HEIGHT), maxHeight),
  };
}

/**
 * `key === null` means the board does not yet know both the person and the
 * plant (`CommandLauncher`'s own `historyKey` doc) -- nothing has ever been
 * written under it, so this returns `null` without touching storage at all.
 * A stored value that is missing, unparseable, or the wrong shape is treated
 * the same way: `null`, never thrown, never repaired (storage is untrusted
 * input, same rule `commandConversation.ts`'s `isHistoryTurn` follows).
 */
export function readPanelSize(key: string | null): PanelSize | null {
  if (key === null) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(key));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPanelSize(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `key === null`: not persisted (the session still gets a size -- the
 *  caller keeps it in memory -- it is simply never written to storage). */
export function writePanelSize(key: string | null, size: PanelSize): void {
  if (key === null) return;
  try {
    window.localStorage.setItem(storageKey(key), JSON.stringify(size));
  } catch {
    // Best effort -- see the module doc.
  }
}
