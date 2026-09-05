import { defineConfig, devices } from "@playwright/test";
import { supabaseUrl, supabaseAnonKey } from "./e2e/env";

/*
 * ⚠️ THE CREDENTIALS AND THE "IS THERE A BACKEND" VERDICT LIVE IN `e2e/env.ts`,
 * not here. Both this file and the signed-in specs need that answer, and a
 * second copy of it would drift — the config would hand the dev server real
 * values while a spec still believed it was on the dummies, or the reverse.
 * The .env.local loader that used to sit inline here moved there whole.
 *
 * HealthPill going "unreachable" against the dummy URL is expected and must not
 * fail the smoke test.
 */

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_SUPABASE_URL: supabaseUrl,
      VITE_SUPABASE_ANON_KEY: supabaseAnonKey,
    },
  },
});
