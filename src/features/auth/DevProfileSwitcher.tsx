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
// ⭐ EVERY ONE OF THESE LIVES IN `supabase/dev_demo.sql`, NOT IN `seed.sql`,
// AND THE WHOLE DEMO WORLD DOES TOO (D112). The seed is the TEST FIXTURE — one
// plant, one structure — because about eighteen cases across eight files rest
// on org 1 holding exactly one structure. `dev_demo.sql` clears that and builds
// Plant A, Plant B and Plant C over the top, which is what the app shows.
// Picking somebody here before that file has run fails to sign in, which is the
// honest outcome rather than a hidden option.
//
// ⭐⭐ THE ORDER IS DELIBERATE: WIDEST REACH FIRST, NARROWEST LAST. Reading
// down the list is reading the permission model from the outside in, and the
// last two are the ones worth signing in as. A site admin runs one plant and is
// refused on the other two. **Ana is granted a LINE, not a plant** — so she is
// the person who shows that D107's read rule runs in BOTH directions: she still
// sees Plant A's plant-wide parts, because their owner is ABOVE her grant, and
// she does NOT see the part owned by Area 2, because that branch and hers never
// meet. Nothing else in the cast can tell those two answers apart.
const DEV_PROFILES = [
  { label: "Admin (company — all three plants)", email: "admin@example.test" },
  { label: "Dana (site admin, Plant A)", email: "dana@example.test" },
  { label: "Quinn (site admin, Plant B)", email: "quinn@example.test" },
  { label: "Rosa (site admin, Plant C)", email: "rosa@example.test" },
  { label: "Marco (supervisor, Plant B / Area 1)", email: "marco@example.test" },
  { label: "Ana (supervisor, Plant A / Line 1 only)", email: "ana@example.test" },
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
