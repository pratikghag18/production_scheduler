import { createBrowserRouter, Link } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import BoardPage from "@/features/board/BoardPage";
import AdminPage from "@/features/admin/AdminPage";

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
      { path: "/admin", element: <AdminPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
