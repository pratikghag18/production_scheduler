import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { useSession } from "./useSession";
import styles from "./DevProfileSwitcher.module.css";

/**
 * Dev-only sign-in (brief P1-3b §7). RLS means the app can read nothing
 * signed out, and the seed's three `auth.users` rows had no usable
 * password until this brief's `supabase/seed.sql` amendment gave them one
 * (`devpassword`, local dev only — see the seed comment). Mirrors the
 * mockup's "Viewing as" dropdown (docs/mockups/model-hybrid.html — a
 * `<label>` + `<select>` pair, `.vas`/`.scope-note` styling) closely enough
 * to be recognisable, without pulling in board-scope logic this component
 * has no business owning.
 *
 * Rendered ONLY when `import.meta.env.DEV` is true, so it cannot ship in a
 * production build (self-review §9 item 7) — the guard is the early
 * `return null` in the outer `DevProfileSwitcher`, before the inner
 * component (which is the only thing that touches auth state) ever runs.
 *
 * Real auth (a proper sign-in page, password reset, invitations) is a
 * later brief; this is the minimum that makes RLS-gated data visible while
 * developing.
 */
const DEV_PROFILES = [
  { label: "Admin", email: "admin@example.test" },
  { label: "Ana", email: "ana@example.test" },
  { label: "Marco", email: "marco@example.test" },
] as const;

const DEV_PASSWORD = "devpassword";

export function DevProfileSwitcher() {
  if (!import.meta.env.DEV) return null;
  return <DevProfileSwitcherInner />;
}

function DevProfileSwitcherInner() {
  const { session, profile, loading } = useSession();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(email: string) {
    setSwitching(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password: DEV_PASSWORD,
    });
    if (signInError) setError(signInError.message);
    setSwitching(false);
  }

  async function signOut() {
    setSwitching(true);
    setError(null);
    await supabase.auth.signOut();
    setSwitching(false);
  }

  const currentEmail = session?.user.email ?? "";

  return (
    <div className={styles.vas}>
      <label htmlFor="dev-viewing-as" className={styles.label}>
        Viewing as:
      </label>
      <select
        id="dev-viewing-as"
        className={styles.select}
        value={DEV_PROFILES.some((p) => p.email === currentEmail) ? currentEmail : ""}
        disabled={switching || loading}
        onChange={(event) => {
          const email = event.target.value;
          if (email) void signIn(email);
        }}
      >
        <option value="">Signed out</option>
        {DEV_PROFILES.map((p) => (
          <option key={p.email} value={p.email}>
            {p.label}
          </option>
        ))}
      </select>
      {session && (
        <span className={styles.scopeNote}>
          {profile ? profile.role : "…"}
          <button
            type="button"
            className={styles.signOut}
            onClick={() => void signOut()}
            disabled={switching}
          >
            Sign out
          </button>
        </span>
      )}
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}
