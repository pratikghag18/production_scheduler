import { beforeEach, describe, expect, it, vi } from "vitest";

describe("env", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("throws a message containing .env.local when a var is missing", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "some-anon-key");

    await expect(import("@/env")).rejects.toThrow(/\.env\.local/);
  });

  it("returns values when present", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "some-anon-key");

    const { env } = await import("@/env");

    expect(env.supabaseUrl).toBe("https://example.supabase.co");
    expect(env.supabaseAnonKey).toBe("some-anon-key");
  });
});
