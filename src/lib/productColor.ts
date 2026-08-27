/**
 * productColor.ts — the ONE place that turns a stored product colour into a CSS
 * value.
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ WHY THIS FILE EXISTS, AND IT IS D100's LESSON ARRIVING A SECOND TIME.
 *
 * `products.color_token` holds either a palette token (`product-1`, rendered
 * through `var()` so it follows `tokens.css`) or — since 0025 §2 — a literal
 * lower-case hex, rendered as written. That is a two-branch rule, and it was
 * written out THREE times: in `features/admin/lib/products.ts`, in
 * `BoardGrid.tsx` and in `BoardToolbar.tsx`. The board's two copies even
 * carried a comment saying they were "kept in step with" the admin one — which
 * is the definition of a rule that is a habit rather than a default.
 *
 * D100 measured what happens next: two admin surfaces implementing one gesture
 * had drifted in five places, **every declaration in both files correct, and
 * the defect was that there were two of them.** Adding a third branch to a rule
 * that lives in three files is how a hand-set colour ends up right on one
 * screen and wrong on another.
 *
 * ⚠️ IT LIVES IN `src/lib/` BECAUSE A BOARD FEATURE MAY NOT IMPORT FROM ADMIN
 * (docs/conventions.md), which is exactly why the copies existed. This module
 * imports nothing, so every feature may have it.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ THE FALLBACK IS NOT DECORATION. A token outside the four — `product-5`
 * from a widened palette, which 0023 §3 records actually shipping — is
 * well-formed, passes the database CHECK, and resolves to NO COLOUR AT ALL.
 * A product drawn in nothing reads as a design choice rather than as a bug.
 * Anything unrecognised falls back to the first palette entry instead.
 */

/** The palette `tokens.css` actually defines. Widening it is a four-file change. */
const PALETTE_SHAPE = /^product-[1-4]$/;

/** The one spelling `products_color_token_shape` accepts for a literal colour. */
const HEX_SHAPE = /^#[0-9a-f]{6}$/;

/** What `tokens.css` names its first product colour. */
export const FALLBACK_COLOR_CSS = "var(--product-1)";

/** A literal colour rather than a palette token. ANCHORED — see 0025's mutation S8. */
export function isHexColorToken(token: string | null | undefined): token is string {
  return typeof token === "string" && HEX_SHAPE.test(token);
}

/** A token this stylesheet defines. */
export function isPaletteColorToken(token: string | null | undefined): token is string {
  return typeof token === "string" && PALETTE_SHAPE.test(token);
}

/**
 * The CSS value for a stored colour. Never returns an empty or invalid value.
 *
 * @param token `products.color_token` as stored — a palette token, a hex, or
 *   anything at all, including `null` and a token from a widened palette.
 */
export function productColorCss(token: string | null | undefined): string {
  if (isHexColorToken(token)) return token;
  if (isPaletteColorToken(token)) return `var(--${token})`;
  return FALLBACK_COLOR_CSS;
}
