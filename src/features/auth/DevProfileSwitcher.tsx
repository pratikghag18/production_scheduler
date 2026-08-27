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
  { label: "Admin (company)", email: "admin@example.test" },
  { label: "Ana (supervisor)", email: "ana@example.test" },
  { label: "Marco (supervisor)", email: "marco@example.test" },
  // ⭐ THE TWO SITE ADMINS, AND THEY ONLY EXIST AFTER `supabase/dev_demo.sql`
  // HAS BEEN RUN — see that file's header for why they are not in `seed.sql`
  // (measured: a second plant in the seed turns 8 test files red, and several
  // of those cases exist BECAUSE org 1 holds exactly one structure).
  //
  // They are what makes migrations 0019-0021 visible at all: every seeded
  // person is either the company admin, for whom no rule applies, or a
  // supervisor, who cannot open the admin screen. Signing in as one of these
  // is the only way to see a site admin run one plant and be refused on the
  // other. Picking one before running the script fails to sign in, which is
  // the honest outcome rather than a hidden option.
  { label: "Dana (site admin, Plant 1)", email: "dana@example.test" },
  { label: "Quinn (site admin, Plant 2)", email: "quinn@example.test" },
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
