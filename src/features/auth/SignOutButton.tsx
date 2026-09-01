import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import styles from "./SignOutButton.module.css";

/**
 * The PRODUCTION sign-out control (roadmap P1-6b) — NOT `import.meta.env.DEV`
 * gated, unlike `DevProfileSwitcher`'s dev-only one.
 *
 * Signing out fires `onAuthStateChange`, which `useSession` picks up; the auth
 * gate (`RequireAuth`) then re-decides and would itself redirect a signed-out
 * visitor to `/sign-in`. The explicit `navigate` here just makes that
 * immediate and unambiguous rather than waiting a tick for the gate — and it
 * is what lets the no-access dead-end (which is NOT inside the gated shell)
 * offer a working Sign out too.
 *
 * `replace: true`: signing out should not leave the previous protected URL in
 * history for the Back button to return to.
 */
export function SignOutButton({ className }: { className?: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function onSignOut() {
    setBusy(true);
    await supabase.auth.signOut();
    navigate("/sign-in", { replace: true });
    // No setBusy(false): the button unmounts as the session clears.
  }

  return (
    <button
      type="button"
      className={className ?? styles.signOut}
      onClick={() => void onSignOut()}
      disabled={busy}
    >
      Sign out
    </button>
  );
}
