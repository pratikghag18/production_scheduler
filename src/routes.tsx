import { lazy, Suspense } from "react";
import { createBrowserRouter, Link } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { RequireAdmin } from "@/features/auth/RequireAdmin";
import { RequireAuth } from "@/features/auth/RequireAuth";
import SignInPage from "@/features/auth/SignInPage";
import ForgotPasswordPage from "@/features/auth/ForgotPasswordPage";
import ResetPasswordPage from "@/features/auth/ResetPasswordPage";
import ChangePasswordPage from "@/features/auth/ChangePasswordPage";
import BoardPage from "@/features/board/BoardPage";

/**
 * `/admin` grows substantially in P1-5d (hierarchy level + node tree
 * editors, and three more sections queued behind it) -- the natural first
 * `React.lazy` split; the roadmap has named this the plan since Aug 24.
 * `AdminPage` is still the file's default export (brief §7.1) so this
 * `lazy(() => import(...))` needs no `.then` reshaping.
 */
const AdminPage = lazy(() => import("@/features/admin/AdminPage"));

function NotFoundPage() {
  return (
    <>
      <h1>Not found</h1>
      <p>
        <Link to="/">Back to Board</Link>
      </p>
    </>
  );
}

export const router = createBrowserRouter([
  // P1-6b: the production sign-in screen lives OUTSIDE the shell and OUTSIDE
  // the auth gate — it must stay reachable while signed out, and it carries no
  // rail/nav of its own.
  { path: "/sign-in", element: <SignInPage /> },
  // P1-6d (S24): the forgotten-password request screen and the set-a-new-
  // password screen the reset email lands on BOTH live outside the shell and
  // outside the auth gate, beside /sign-in. The reset link establishes a real
  // recovery SESSION, so if `/reset-password` sat inside `RequireAuth` the gate
  // would bounce the arriving person to the board before they set the password.
  { path: "/forgot-password", element: <ForgotPasswordPage /> },
  { path: "/reset-password", element: <ResetPasswordPage /> },
  {
    // P1-6b: the auth gate wraps the whole shell. A signed-out visitor to any
    // route below is redirected to /sign-in (remembering where they were
    // going); a signed-in user with no profile in this org gets the no-access
    // dead-end; only a signed-in user WITH a profile reaches the shell.
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: "/", element: <BoardPage /> },
          // P1-6d (S24): change-your-own-password sits INSIDE the shell — it is
          // for a signed-in person and reached from the header.
          { path: "/change-password", element: <ChangePasswordPage /> },
          {
            path: "/admin",
            // D97 (§19.38): the guard wraps the Suspense boundary, not the
            // other way round, so a non-admin never triggers the lazy chunk
            // fetch at all -- the refusal costs no download.
            element: (
              <RequireAdmin>
                <Suspense fallback={<p>Loading…</p>}>
                  <AdminPage />
                </Suspense>
              </RequireAdmin>
            ),
          },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
