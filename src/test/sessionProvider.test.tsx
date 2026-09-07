import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider } from "@/features/auth/SessionProvider";
import { useSession, __resetSessionIdentityForTests } from "@/features/auth/useSession";

/**
 * ⭐⭐ ONE SESSION, RESOLVED ONCE AT THE ROOT (R-349) — the cure the finding
 * F-094 / requirement R-337 asked for. The old `useSession` was a hook that
 * ran its own `useEffect` at every call site: its own `getSession()`, its own
 * `user_profiles` read, its own `fetchAdminAnywhere()` and its own
 * `onAuthStateChange` listener, and each held its own `loading` and `profile`.
 * Two copies could disagree about who you are for one round trip, which is how
 * a company admin saw a supervisor's three-tab rail for a beat.
 *
 * This suite pins the observable contract that must NOT change as the effect
 * moves into `SessionProvider`, and then proves the point of the move: however
 * many consumers read `useSession`, there is exactly ONE round trip per fact.
 *
 * The mocks stop at the network boundary: a recording fake `supabase.auth` and
 * `.from("user_profiles")`, and a counted `fetchAdminAnywhere`. `decideSessionUpdate`
 * and `advanceSessionIdentity` run for real — the decisions are what is frozen.
 */

interface FakeSession {
  user: { id: string };
}

const sb = vi.hoisted(() => {
  let onChange: ((event: string, session: FakeSession | null) => void) | null = null;
  const state = {
    /** What `getSession()` resolves to. */
    initialSession: null as FakeSession | null,
    /** Hold `getSession()` unresolved, to observe the starting `loading` state. */
    pendGetSession: false,
    /** The `user_profiles` row the read resolves to, or an error. */
    profileRow: null as Record<string, unknown> | null,
    profileError: null as unknown,
    /** What `fetchAdminAnywhere()` resolves to. */
    adminAnywhere: false,
  };
  const counts = { getSession: 0, subscribe: 0, unsubscribe: 0, profileRead: 0 };

  const client = {
    auth: {
      getSession() {
        counts.getSession += 1;
        if (state.pendGetSession) return new Promise(() => {});
        return Promise.resolve({ data: { session: state.initialSession } });
      },
      onAuthStateChange(cb: (event: string, session: FakeSession | null) => void) {
        counts.subscribe += 1;
        onChange = cb;
        return {
          data: {
            subscription: {
              unsubscribe() {
                counts.unsubscribe += 1;
              },
            },
          },
        };
      },
    },
    from(_table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => {
          counts.profileRead += 1;
          return Promise.resolve({ data: state.profileRow, error: state.profileError });
        },
      };
      return builder;
    },
  };

  return {
    state,
    counts,
    client,
    /** Fire an `onAuthStateChange` event the way supabase-js would. */
    emit(session: FakeSession | null, event = "TOKEN_REFRESHED") {
      onChange?.(event, session);
    },
    reset() {
      state.initialSession = null;
      state.pendGetSession = false;
      state.profileRow = null;
      state.profileError = null;
      state.adminAnywhere = false;
      counts.getSession = 0;
      counts.subscribe = 0;
      counts.unsubscribe = 0;
      counts.profileRead = 0;
      onChange = null;
    },
  };
});

const adminSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase", () => ({ supabase: sb.client }));
vi.mock("@/lib/api", () => ({
  fetchAdminAnywhere: () => {
    adminSpy();
    return Promise.resolve(sb.state.adminAnywhere);
  },
}));

const PROFILE_ROW = {
  id: "p1",
  org_id: "org-1",
  user_id: "u1",
  role: "supervisor",
  default_create_mode: "run",
};

/** A consumer that reads the one session object and prints what it sees. */
function Probe({ label = "probe" }: { label?: string }) {
  const { loading, profile, session, recovery } = useSession();
  return (
    <div data-testid={label}>
      {loading ? "loading" : "ready"}|{profile ? profile.role : "no-profile"}|
      {session ? "signed-in" : "signed-out"}|{recovery ? "recovery" : "plain"}
    </div>
  );
}

function mount(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const resetSpy = vi.spyOn(queryClient, "resetQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>{children}</SessionProvider>
    </QueryClientProvider>,
  );
  return { resetSpy };
}

beforeEach(() => {
  sb.reset();
  adminSpy.mockClear();
  __resetSessionIdentityForTests();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SessionProvider: the frozen contract", () => {
  it("S1: loading starts true, before the session resolves", () => {
    sb.state.pendGetSession = true;
    mount(<Probe />);
    expect(screen.getByTestId("probe").textContent).toContain("loading");
  });

  it("S2: a signed-out initial load clears loading, gives no profile, and never calls the RPC", async () => {
    sb.state.initialSession = null;
    mount(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("ready");
    });
    expect(screen.getByTestId("probe").textContent).toContain("no-profile");
    expect(screen.getByTestId("probe").textContent).toContain("signed-out");
    expect(sb.counts.profileRead).toBe(0);
    expect(adminSpy).not.toHaveBeenCalled();
  });

  it("S3: a signed-in initial load resolves the profile and asks the RPC once", async () => {
    sb.state.initialSession = { user: { id: "u1" } };
    sb.state.profileRow = PROFILE_ROW;
    sb.state.adminAnywhere = true;
    mount(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("supervisor");
    });
    expect(screen.getByTestId("probe").textContent).toContain("ready");
    expect(sb.counts.profileRead).toBe(1);
    expect(adminSpy).toHaveBeenCalledTimes(1);
  });

  it("S4: a token refresh resets nothing, spins no loading, and refetches nothing", async () => {
    sb.state.initialSession = { user: { id: "u1" } };
    sb.state.profileRow = PROFILE_ROW;
    const { resetSpy } = mount(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("supervisor");
    });
    // The initial sign-in (null -> u1) is a genuine identity change and resets
    // once; everything below must NOT add to that.
    const resetsAfterSignIn = resetSpy.mock.calls.length;
    const readsAfterSignIn = sb.counts.profileRead;
    const rpcAfterSignIn = adminSpy.mock.calls.length;

    // Same person, same id: exactly what supabase-js fires roughly hourly.
    sb.emit({ user: { id: "u1" } });
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByTestId("probe").textContent).toContain("ready");
    expect(resetSpy.mock.calls.length).toBe(resetsAfterSignIn);
    expect(sb.counts.profileRead).toBe(readsAfterSignIn);
    expect(adminSpy.mock.calls.length).toBe(rpcAfterSignIn);
  });

  it("S5: a genuine identity change resets the query cache exactly once", async () => {
    sb.state.initialSession = { user: { id: "u1" } };
    sb.state.profileRow = PROFILE_ROW;
    const { resetSpy } = mount(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("supervisor");
    });
    resetSpy.mockClear();

    // A different person signs in on the same tab.
    sb.emit({ user: { id: "u2" } });
    await waitFor(() => {
      expect(resetSpy).toHaveBeenCalledTimes(1);
    });
    // Not twice, not zero — exactly once for one identity change.
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });

  it("S6: a failed profile read gives a null profile and never calls the RPC", async () => {
    sb.state.initialSession = { user: { id: "u1" } };
    sb.state.profileRow = null;
    sb.state.profileError = { message: "boom" };
    mount(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("ready");
    });
    expect(screen.getByTestId("probe").textContent).toContain("no-profile");
    expect(sb.counts.profileRead).toBe(1);
    // The early return on a failed profile means the RPC is never fired.
    expect(adminSpy).not.toHaveBeenCalled();
  });

  it("S7: useSession() outside the provider throws, naming the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/SessionProvider/);
    spy.mockRestore();
  });

  it("S8: many consumers share ONE round trip per fact", async () => {
    sb.state.initialSession = { user: { id: "u1" } };
    sb.state.profileRow = PROFILE_ROW;
    sb.state.adminAnywhere = true;
    mount(
      <>
        <Probe label="a" />
        <Probe label="b" />
        <Probe label="c" />
        <Probe label="d" />
        <Probe label="e" />
      </>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("a").textContent).toContain("supervisor");
    });
    // Every consumer read the same object.
    for (const label of ["a", "b", "c", "d", "e"]) {
      expect(screen.getByTestId(label).textContent).toContain("supervisor");
    }
    // ...paid for with exactly one of each round trip, not one per consumer.
    expect(sb.counts.getSession).toBe(1);
    expect(sb.counts.subscribe).toBe(1);
    expect(sb.counts.profileRead).toBe(1);
    expect(adminSpy).toHaveBeenCalledTimes(1);
  });
  it("S9 (F-106): a reset link's PASSWORD_RECOVERY raises `recovery`, and USER_UPDATED clears it", async () => {
    sb.state.initialSession = { user: { id: "u1" } };
    sb.state.profileRow = PROFILE_ROW;
    mount(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("supervisor");
    });
    expect(screen.getByTestId("probe").textContent).toContain("plain");

    sb.emit({ user: { id: "u1" } }, "PASSWORD_RECOVERY");
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("recovery");
    });

    // The same person, same id: no reset, no loading, only the flag moves.
    sb.emit({ user: { id: "u1" } }, "USER_UPDATED");
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("plain");
    });
    expect(screen.getByTestId("probe").textContent).toContain("ready");
  });
  it("S10 (F-106): the landing hash seeds `recovery` before any event fires", async () => {
    window.history.replaceState(null, "", "/#access_token=a&refresh_token=b&type=recovery");
    sb.state.initialSession = { user: { id: "u1" } };
    sb.state.profileRow = PROFILE_ROW;
    mount(<Probe />);
    // Read synchronously: no event has been emitted yet.
    expect(screen.getByTestId("probe").textContent).toContain("recovery");
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("supervisor");
    });
    // And it is written down for the tab, so a reload after the hash is
    // consumed still finds it.
    expect(window.sessionStorage.getItem("scheduler.passwordRecovery")).toBe("1");
  });

  it("S11 (F-106): the tab's memory keeps `recovery` across a reload, and USER_UPDATED forgets it", async () => {
    window.sessionStorage.setItem("scheduler.passwordRecovery", "1");
    sb.state.initialSession = { user: { id: "u1" } };
    sb.state.profileRow = PROFILE_ROW;
    mount(<Probe />);
    expect(screen.getByTestId("probe").textContent).toContain("recovery");
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("supervisor");
    });
    sb.emit({ user: { id: "u1" } }, "USER_UPDATED");
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("plain");
    });
    expect(window.sessionStorage.getItem("scheduler.passwordRecovery")).toBeNull();
  });

  it("S12 (R-349): INITIAL_SESSION arriving before getSession resolves does not read the profile twice", async () => {
    sb.state.initialSession = { user: { id: "u1" } };
    sb.state.profileRow = PROFILE_ROW;
    mount(<Probe />);
    // supabase-js fires this from its own start-up, before `getSession()`'s
    // promise has resolved -- the order the reviewer measured in the browser.
    sb.emit({ user: { id: "u1" } }, "INITIAL_SESSION");
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toContain("supervisor");
    });
    expect(sb.counts.profileRead).toBe(1);
    expect(adminSpy).toHaveBeenCalledTimes(1);
  });
});
