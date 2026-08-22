import { defineConfig, devices } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Minimal .env.local loader (no dotenv dependency — this brief's stack doesn't
// include one). Falls back to dummy Supabase values so the app boots without
// a real project; HealthPill going "unreachable" against the dummy URL is
// expected and must not fail the smoke test.
function loadDotEnvLocal(): Record<string, string> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.join(dir, ".env.local");
  const parsed: Record<string, string> = {};
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      parsed[key] = value;
    }
  }
  return parsed;
}

const dotEnvLocal = loadDotEnvLocal();

const supabaseUrl = dotEnvLocal.VITE_SUPABASE_URL ?? "https://example.supabase.co";
const supabaseAnonKey = dotEnvLocal.VITE_SUPABASE_ANON_KEY ?? "dummy-anon-key";

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
