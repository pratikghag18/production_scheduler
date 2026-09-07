import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RequireAuth } from "@/features/auth/RequireAuth";

/**
 * F-106 -- the route gate sends a password-recovery session to the reset
 * screen wherever GoTrue dropped its tokens.
 *
 * A reset-email link makes a FULL session the moment supabase-js reads the
 * tokens from the URL, and the local stack drops them on `/` (its `site_url`
 * is `127.0.0.1` while the dev server is `localhost`, so the redirect path is
 * stripped). Before this gate the person landed on the board, signed in with
 * a password they never chose, and the reset form never appeared.
 *
 * `useSession` is mocked the way every admin suite mocks it; the one field
 * under test is `recovery`.
 */

const sessionState = vi.hoisted(() => ({
  recovery: false,
  profile: null as null | { role: string },
}));

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: { user: { id: "u1" } },
    profile: sessionState.profile,
    loading: false,
    recovery: sessionState.recovery,
  }),
}));

vi.mock("@/features/auth/SignOutButton", () => ({
  SignOutButton: () => <button type="button">Sign out</button>,
}));

function mountAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/reset-password" element={<p>RESET SCREEN</p>} />
        <Route element={<RequireAuth />}>
          <Route path="/" element={<p>THE BOARD</p>} />
          <Route path="/admin" element={<p>THE ADMIN SCREEN</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  sessionState.recovery = false;
  sessionState.profile = null;
});

describe("RequireAuth: a recovery session owes a password first (F-106)", () => {
  it("G1: with the flag up, landing on / goes to the reset screen, not the board", () => {
    sessionState.recovery = true;
    sessionState.profile = { role: "viewer" };
    mountAt("/");
    expect(screen.getByText("RESET SCREEN")).toBeTruthy();
    expect(screen.queryByText("THE BOARD")).toBeNull();
  });

  it("G2: with the flag up and NO profile, the reset screen still comes before the dead-end", () => {
    sessionState.recovery = true;
    sessionState.profile = null;
    mountAt("/admin");
    expect(screen.getByText("RESET SCREEN")).toBeTruthy();
    expect(screen.queryByText("No access in this workspace")).toBeNull();
  });

  it("G3: with the flag down, the same person reaches the board", () => {
    sessionState.recovery = false;
    sessionState.profile = { role: "viewer" };
    mountAt("/");
    expect(screen.getByText("THE BOARD")).toBeTruthy();
  });

  it("G4: with the flag down and no profile, the dead-end is unchanged", () => {
    sessionState.recovery = false;
    sessionState.profile = null;
    mountAt("/");
    expect(screen.getByText("No access in this workspace")).toBeTruthy();
  });
});
