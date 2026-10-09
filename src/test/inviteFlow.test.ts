import { describe, expect, it } from "vitest";
import {
  buildInviteBody,
  canOfferInvite,
  describeInviteRefusal,
  inviteRoles,
  inviteSuccessMessage,
  looksLikeEmail,
  normaliseEmail,
  readInvitedPending,
} from "@/features/admin/lib/invite";

/**
 * The PURE half of invitations (P1-6c). Everything the Access panel decides
 * about offering and describing an invite, with no network and no browser --
 * the sibling of `siteAccess.test.ts`. The wire round trip is `access.ts` and
 * the Edge Function; the on-screen behaviour is `siteAccessInvite.test.tsx`;
 * the loop end to end is `e2e/invite.spec.ts`.
 */

describe("invite.ts: looksLikeEmail", () => {
  it("L1: a plain address with a dotted domain looks like an email", () => {
    expect(looksLikeEmail("sam@example.test")).toBe(true);
    expect(looksLikeEmail("  Sam.Jones@team.example.co  ")).toBe(true);
  });

  it("L2: a bare name, a lone @, or a domain with no dot does not", () => {
    expect(looksLikeEmail("sam")).toBe(false);
    expect(looksLikeEmail("sam@")).toBe(false);
    expect(looksLikeEmail("@example.test")).toBe(false);
    expect(looksLikeEmail("sam@localhost")).toBe(false);
    expect(looksLikeEmail("")).toBe(false);
  });
});

describe("invite.ts: inviteRoles reuses siteAccess's menu", () => {
  it("R1: at a plant root, all three roles, admin first", () => {
    expect(inviteRoles(true)).toEqual(["admin", "supervisor", "viewer"]);
  });

  it("R2: below a plant root, admin is not offered (0053 / R-340)", () => {
    expect(inviteRoles(false)).toEqual(["supervisor", "viewer"]);
  });
});

describe("invite.ts: canOfferInvite — only when nobody in the company matches", () => {
  const base = {
    query: "new@example.test",
    memberMatches: 0,
    candidateMatches: 0,
    canGrantHere: true,
  };

  it("O1: an email that matches nobody, where the caller may grant, is offered", () => {
    expect(canOfferInvite(base)).toBe(true);
  });

  it("O2: NOT offered when a member matches the search", () => {
    expect(canOfferInvite({ ...base, memberMatches: 1 })).toBe(false);
  });

  it("O3: NOT offered when a candidate already in the company matches", () => {
    expect(canOfferInvite({ ...base, candidateMatches: 1 })).toBe(false);
  });

  it("O4: NOT offered for a query that is not an email (a name search)", () => {
    expect(canOfferInvite({ ...base, query: "sam" })).toBe(false);
  });

  it("O5: NOT offered when the caller may not grant here (a supervisor)", () => {
    expect(canOfferInvite({ ...base, canGrantHere: false })).toBe(false);
  });
});

describe("invite.ts: buildInviteBody normalises the address", () => {
  it("B1: trims and lower-cases the email, carries nodeId and role verbatim", () => {
    expect(buildInviteBody("  Sam@Example.Test ", "node-1", "viewer")).toEqual({
      email: "sam@example.test",
      nodeId: "node-1",
      role: "viewer",
    });
  });

  it("B2: normaliseEmail tolerates a non-string", () => {
    expect(normaliseEmail(undefined as unknown as string)).toBe("");
  });
});

describe("invite.ts: the outcome sentences", () => {
  it("S1: a fresh invite says an email is on its way", () => {
    expect(inviteSuccessMessage("sam@example.test", true)).toMatch(
      /Invitation sent to sam@example.test/,
    );
  });

  it("S2: an already-member says they now have access, no email", () => {
    const msg = inviteSuccessMessage("sam@example.test", false);
    expect(msg).toMatch(/already has an account/);
    expect(msg).not.toMatch(/Invitation sent/);
  });

  it("E1: not_admin and other_org have their own copy; other_org says nothing about the other org", () => {
    expect(describeInviteRefusal("not_admin")).toBe("You can't invite people to this place.");
    const other = describeInviteRefusal("other_org");
    expect(other).toBe("That email address can't be added here.");
    expect(other).not.toMatch(/other|company|org/i);
  });

  it("E2: invalid and grant_refused defer to describeSchedulerError (null here)", () => {
    expect(describeInviteRefusal("invalid")).toBeNull();
    expect(describeInviteRefusal("grant_refused")).toBeNull();
  });
});

describe("invite.ts: readInvitedPending", () => {
  it("P1: collects profile ids whose invitedPending is exactly true", () => {
    const payload = {
      people: [
        { profileId: "a", invitedPending: true },
        { profileId: "b", invitedPending: false },
        { profileId: "c" }, // absent -> not pending
        { profileId: "d", invitedPending: "true" }, // non-boolean -> not pending
      ],
    };
    const set = readInvitedPending(payload);
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(false);
    expect(set.has("c")).toBe(false);
    expect(set.has("d")).toBe(false);
  });

  it("P2: never throws for junk input, returns an empty set", () => {
    expect(readInvitedPending(null).size).toBe(0);
    expect(readInvitedPending(undefined).size).toBe(0);
    expect(readInvitedPending({ people: "nope" }).size).toBe(0);
    expect(readInvitedPending(42).size).toBe(0);
  });
});
