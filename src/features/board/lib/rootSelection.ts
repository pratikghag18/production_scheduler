/**
 * WHERE THE BOARD OPENS.
 *
 * ⭐ THE WHOLE MODULE EXISTS BECAUSE `useRootPath` RETURNED A CONSTANT.
 * `const ORG_ROOT_PATH = "plant_1";` — every user, every session, since
 * P1-4a, and its own comment admitted it was "not derived from the
 * session/profile in any way yet". Migration 0026 made that visible: the
 * Plant 2 admin's board asks for Plant 1 and the server correctly hands back
 * nothing, so she gets an EMPTY board rather than SOMEBODY ELSE'S.
 *
 * ⚠️ THE ANSWER IS NOT "your roots". `visible_board_roots()` returns the top
 * of the caller's VISIBLE FOREST — every node they can read whose parent they
 * cannot — because a supervisor's grant sits on a department and they can
 * never see the root above it. Measured before this was written: for Ana,
 * "roots" is the empty set and "top of my forest" is Assembly. See migration
 * 0027's header.
 *
 * This file is the pure half: given what the server said and what the person
 * last chose, which path does the board load? No React, no fetching — so the
 * rule can be tested without either.
 */

export interface BoardRoot {
  id: string;
  name: string;
  path: string;
}

/**
 * The path the board should load, or `null` when this person has nowhere to
 * open — which is a real state (an org member with no grants at all, pinned by
 * case V8) and must be a screen rather than a crash on `roots[0]`.
 *
 * ⚠️ A REMEMBERED CHOICE IS NOT AUTOMATICALLY A VALID ONE. The selection lives
 * in a client store that OUTLIVES the identity: the dev switcher goes from
 * Dana to Quinn without a reload, and React Query resets its cache on that
 * change while this store does not. If the remembered path is not in the list
 * the server just returned, it is silently dropped — otherwise switching
 * identity reproduces the exact defect this module was written to remove, one
 * layer up.
 */
export function resolveRootPath(
  selected: string | null,
  roots: readonly BoardRoot[],
): string | null {
  if (roots.length === 0) return null;
  if (selected !== null && roots.some((r) => r.path === selected)) return selected;
  return roots[0].path;
}

/**
 * Whether to offer a chooser at all. One place to open is not a choice, and a
 * disabled control that can never become enabled is worse than no control —
 * so the picker is absent rather than greyed for the overwhelmingly common
 * case of a person who administers one site.
 */
export function shouldOfferRootPicker(roots: readonly BoardRoot[]): boolean {
  return roots.length > 1;
}

/**
 * What to tell someone with nowhere to open. ⚠️ NOT "no data" and not a
 * spinner: both of those describe the app, and the honest sentence describes
 * THEM — they are in the company and hold access to no place in it, which only
 * an administrator can change. D96's rule about refusals naming the way out.
 */
export const NO_PLACES_MESSAGE =
  "You don't have access to any part of the site structure yet, so there's no board to show. An administrator can give you access to a plant, department or line.";
