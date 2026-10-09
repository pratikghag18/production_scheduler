/**
 * The PURE half of invitations (P1-6c, S24) — a sibling of `siteAccess.ts` and
 * built to the same contract: no React, no CSS, no `supabase`, no snake_case.
 * Everything the Access panel decides about offering and describing an invite
 * that can be settled from plain values lives here, unit-testable with no
 * network or browser.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AUTHORITATIVE. The DATABASE is, via the `invite` Edge Function and
 * the `set_site_member` it calls as the caller. This module computes PREVIEWS —
 * whether to OFFER the invite control, which roles it may offer, how to phrase
 * the outcome — so the screen never offers what the server will refuse. The
 * invariant is `siteAccess.ts`'s, one-way: anything the client hides, the
 * server must also refuse; never the converse.
 *
 * ⭐ THE ROLE MENU IS `siteAccess.ts`'s, NOT A SECOND COPY. Inviting grants a
 * role exactly as adding an existing person does, so the roles an invite may
 * offer are the same predicate the Add control uses — admin only at a plant
 * root (0053 / R-340). Reusing `GRANT_ROLES` / `ROLES_BELOW_ROOT` is what keeps
 * the two controls on one screen from disagreeing, which is the shape of
 * DEF-0010.
 */

import { GRANT_ROLES, ROLES_BELOW_ROOT, type GrantRole } from "./siteAccess";

/**
 * ⚠️ MIRRORS `src/lib/api/access.ts`'s `InviteRefusalReason`, deliberately, so
 * this pure module carries no runtime import of the api layer. A fourth reason
 * added there without one here falls through `describeInviteRefusal` to `null`,
 * which the panel already handles by deferring to `describeSchedulerError` —
 * safe, not silent.
 */
export type InviteRefusalReason = "not_admin" | "other_org" | "invalid" | "grant_refused";

/** The body the panel sends to the `invite` function. */
export interface InviteBody {
  email: string;
  nodeId: string;
  role: GrantRole;
}

/**
 * The set of profile ids the payload marks "invited, not yet signed in"
 * (`invitedPending`, from migration 0064's `site_people`).
 *
 * ⭐ READ HERE RATHER THAN IN `siteAccess.ts`'s `AccessRow`, on purpose. The
 * "invited" mark is a thin overlay the panel draws beside a person; folding it
 * into `AccessRow` would touch `buildAccessRows` (owned elsewhere) for one
 * boolean. This reads the same payload `buildAccessRows` does, NEVER THROWS for
 * any input, and skips what it cannot read — the list-guard discipline
 * `siteAccess.ts`'s header sets out. A row missing or non-boolean `invitedPending`
 * is simply not in the set (not pending), which is the safe direction: an
 * unmarked person reads as "in", never a false "invited".
 */
export function readInvitedPending(payload: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof payload !== "object" || payload === null) return out;
  const people = (payload as { people?: unknown }).people;
  if (!Array.isArray(people)) return out;
  for (const entry of people) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as { profileId?: unknown; invitedPending?: unknown };
    if (typeof rec.profileId === "string" && rec.invitedPending === true) {
      out.add(rec.profileId);
    }
  }
  return out;
}

/**
 * Does this query look enough like an email address to offer an invite for?
 *
 * Deliberately loose: one `@` with a non-empty local part and a dotted domain.
 * It is a gate on OFFERING a button, not a validator — the server (GoTrue) is
 * the authority on whether an address is real, and a too-strict client regex
 * would refuse addresses the server accepts, hiding a working action.
 */
export function looksLikeEmail(query: string): boolean {
  const q = typeof query === "string" ? query.trim() : "";
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q);
}

/**
 * The roles an invite may offer for this place. The same menu the Add control
 * uses (`siteAccess.ts`): every role at a plant root, supervisor and viewer
 * below one.
 */
export function inviteRoles(isPlantRoot: boolean): readonly GrantRole[] {
  return isPlantRoot ? GRANT_ROLES : ROLES_BELOW_ROOT;
}

/**
 * Whether the panel should offer to INVITE the searched address.
 *
 * ⭐ ONLY WHEN NOBODY IN THE COMPANY MATCHES. The Access panel already lists
 * members and, on a search, candidates already in the company. An invite is the
 * answer to "I searched for someone and they are not here at all" — so it is
 * offered only when the query looks like an email, nobody matched it in either
 * list, and the caller may grant here (the panel is scoped to a place they
 * administer, but a supervisor who somehow reaches it must not be offered it —
 * `canGrantHere` is that gate, and the function refuses her regardless).
 */
export function canOfferInvite(args: {
  query: string;
  memberMatches: number;
  candidateMatches: number;
  canGrantHere: boolean;
}): boolean {
  return (
    args.canGrantHere === true &&
    looksLikeEmail(args.query) &&
    args.memberMatches === 0 &&
    args.candidateMatches === 0
  );
}

/**
 * Build the request body, normalising the address the same way the server
 * does (trim, lower-case) so a client and server comparison cannot disagree on
 * case or padding.
 */
export function buildInviteBody(email: string, nodeId: string, role: GrantRole): InviteBody {
  return { email: normaliseEmail(email), nodeId, role };
}

export function normaliseEmail(email: string): string {
  return (typeof email === "string" ? email : "").trim().toLowerCase();
}

/**
 * The sentence for a SUCCESSFUL invite. `invited` is true for a fresh
 * invitation (an email is on its way) and false when the person already had an
 * account and was simply granted access here (already_member).
 */
export function inviteSuccessMessage(email: string, invited: boolean): string {
  const who = normaliseEmail(email) || "That person";
  return invited
    ? `Invitation sent to ${who}. They'll set a password from the email, then land here.`
    : `${who} already has an account — they now have access here.`;
}

/**
 * The sentence for a REFUSAL that has invite-specific copy, or `null` to defer
 * to `describeSchedulerError` (which owns the wording for a `set_site_member`
 * refusal and for an invalid argument).
 *
 * ⚠️ `other_org` SAYS NOTHING ABOUT THE OTHER ORG, matching the function: that
 * an address belongs to another company is not this admin's to learn.
 */
export function describeInviteRefusal(reason: InviteRefusalReason): string | null {
  if (reason === "not_admin") return "You can't invite people to this place.";
  if (reason === "other_org") return "That email address can't be added here.";
  // "invalid" and "grant_refused" carry a SchedulerError the panel describes.
  return null;
}
