import { lazy, Suspense } from "react";
import { createBrowserRouter, Link } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
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
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <BoardPage /> },
      {
        path: "/admin",
        element: (
          <Suspense fallback={<p>Loading…</p>}>
            <AdminPage />
          </Suspense>
        ),
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
