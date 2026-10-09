import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { queryClient } from "@/lib/queryClient";
import { router } from "@/routes";
import { SessionProvider } from "@/features/auth/SessionProvider";

export default function App() {
  return (
    // ⭐ SessionProvider resolves who is signed in ONCE, at the root (R-349).
    // It sits INSIDE QueryClientProvider (it needs `useQueryClient` for the
    // identity-change reset) and OUTSIDE RouterProvider so every route reads
    // the one session object. Before it, each `useSession()` call site ran its
    // own round trip and two could disagree about who you are (F-094 / R-337).
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  );
}
