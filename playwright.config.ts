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
      // The touch acceptance pass (`touch.spec.ts`, wave 2 lane C) drives real
      // finger input through CDP and needs a `hasTouch` tablet context, so it
      // runs ONLY under the `touch` project below. Ignoring it here is what
      // stops it double-running: every other spec runs under `chromium`, this
      // one runs under `touch`, so `npx playwright test` (what `scripts/ci-e2e.sh`
      // calls) still runs each file exactly once.
      testIgnore: /touch\.spec\.ts/,
    },
    {
      // A Chromium tablet profile: `hasTouch: true` and `isMobile: true` so
      // `touch-action` and a pointer type of `touch` behave as on a real
      // tablet, and Chromium so `Input.dispatchTouchEvent` (CDP, Chromium-only)
      // can drive the drags. Landscape (1138x712) so the board keeps its
      // desktop layout — the operator panel and the full track are on screen,
      // which the panel-drag and create cases need.
      name: "touch",
      use: { ...devices["Galaxy Tab S4 landscape"] },
      testMatch: /touch\.spec\.ts/,
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
