import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RequireAdmin } from "@/features/auth/RequireAdmin";

/**
 * THE GUARD, NOT THE PREDICATE (R-079, and the gap DEF-0001 named).
 *
 * `session.test.ts` A1-A11 pins `adminAccess` — granted / pending / denied for
 * every role and loading state — and it is a good suite. But it is about the
 * FUNCTION. R-079's claim is about the SCREEN: "the nav link and the route
 * guard use the same predicate ... a pending state shows neither the screen nor
 * a refusal". Nothing pinned that `RequireAdmin` actually asks the predicate,
 * or that it renders the refusal rather than, say, the children with a banner.
 *
 * ⭐ WHY IT IS WRITTEN NOW. DEF-0001's own lead saw it coming: once the smoke
 * test's signed-out cases assert the sign-in redirect (which they must — the
 * app redirects), no e2e reaches D97's refusal at all, because reaching it
 * needs a SIGNED-IN non-admin and the smoke run has no backend to hold a
 * session. The honest answer is not to fake a session in Playwright; it is to
 * cover the guard where it can be covered for real, and to say plainly which
 * half is left. This is that cover, and R-321 carries the note.
 *
 * ⚠️ WHAT THIS DOES NOT PROVE. "A non-admin never downloads the admin chunk" is
 * a claim about `routes.tsx` putting the guard OUTSIDE the `Suspense`/`lazy`
 * boundary, and a component test cannot see a network fetch that a bundler
 * arranges. What it can prove is the half underneath: the guarded children are
 * never rendered on a refusal, so nothing below the guard runs. The route-tree
 * shape stays a matter for the file's own comment and a reader's eye.
 */

const h = vi.hoisted(() => ({
  state: {
    role: "admin" as string | null,
    adminAnywhere: false as boolean | null,
    loading: false,
  },
}));

// Stopped at the session boundary, and `adminAccess` runs for real — mocking it
// would pin that the guard CALLS something, which is the shape of assertion
// that passes while the screen is wrong.
vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: h.state.loading ? null : { user: { id: "u1" } },
    profile: h.state.loading
      ? null
      : {
          id: "p1",
          userId: "u1",
          orgId: "org",
          role: h.state.role,
          adminAnywhere: h.state.adminAnywhere,
        },
    loading: h.state.loading,
  }),
}));

function show(role: string | null, adminAnywhere: boolean | null, loading = false): void {
  h.state.role = role;
  h.state.adminAnywhere = adminAnywhere;
  h.state.loading = loading;
  render(
    <MemoryRouter>
      <RequireAdmin>
        <h1>Hierarchy</h1>
      </RequireAdmin>
    </MemoryRouter>,
  );
}

describe("R-079: the admin route guard refuses in place", () => {
  it("G1: a system admin is let through to the screen", () => {
    show("admin", false);
    expect(screen.getByRole("heading", { level: 1, name: "Hierarchy" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Not available" })).toBe(null);
  });

  it("G2: an admin somewhere is let through too, whatever their role reads", () => {
    show("supervisor", true);
    expect(screen.getByRole("heading", { level: 1, name: "Hierarchy" })).toBeTruthy();
  });

  it("G3: ⭐ a viewer is refused IN PLACE, and told where to go instead", () => {
    show("viewer", false);
    expect(screen.getByRole("heading", { level: 1, name: "Not available" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Board" })).toBeTruthy();
    // ⚠️ THE CHILDREN ARE ABSENT, NOT HIDDEN. A guard that rendered them behind
    // a message would leak the whole screen to anyone with a devtools panel,
    // and it is what "the refusal costs no download" rests on one layer up.
    expect(screen.queryByRole("heading", { name: "Hierarchy" })).toBe(null);
  });

  it("G3b: ⚠️ a SUPERVISOR is admitted on purpose, and this case exists to say so", () => {
    // ⭐ THE OBVIOUS-LOOKING ASSERTION HERE IS THE WRONG ONE, and it was written
    // first: R-079's own words are "a supervisor ... has no access to the admin
    // page", which stopped being true at D114. 0032 made a supervisor's grant
    // enough to keep a training record — *"the supervisor will be the one who
    // enters or uploads the training information"* — and `adminAccess` was
    // changed to match, because the database had already said yes while the
    // screen still turned them away at the door.
    //
    // What they SEE inside is `adminSectionsFor`'s three sections, not the
    // whole rail; that is a different question, owned by
    // `adminNoGrants.test.tsx` N6/N7. This one pins the door, so that a reader
    // who meets R-079's older sentence does not "fix" the guard back to a
    // refusal the server would contradict.
    //
    // ⛔ THAT POINTER USED TO READ "and has its own cases", WHICH WAS A PLAN
    // AND READ LIKE A RECORD (DEF-0008). There were none: the narrowed rail had
    // no case anywhere in the suite, and this sentence is a good part of why
    // nobody went looking. A file and a case number can be checked; "has its
    // own cases" cannot.
    show("supervisor", false);
    expect(screen.getByRole("heading", { level: 1, name: "Hierarchy" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Not available" })).toBe(null);
  });

  it("G4: an unknown role is refused, not admitted by accident", () => {
    show("something-new", false);
    expect(screen.getByRole("heading", { level: 1, name: "Not available" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Hierarchy" })).toBe(null);
  });

  it("G5: while the session is still loading, NEITHER the screen nor the refusal", () => {
    // R-079's own words. A flash of "Not available" before an admin's profile
    // lands is the failure this branch exists to prevent, and it reads as a
    // permission bug to the person it happens to.
    show(null, null, true);
    expect(screen.queryByRole("heading", { name: "Not available" })).toBe(null);
    expect(screen.queryByRole("heading", { name: "Hierarchy" })).toBe(null);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });
});
