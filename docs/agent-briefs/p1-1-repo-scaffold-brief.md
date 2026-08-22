# Agent Brief P1-1 — Repo Scaffold, Supabase Wiring, CI

**Executor:** a fresh Sonnet agent (no prior context). **Phase:** 1, first build task.
**Rules:** no design decisions of your own — everything you need is decided below. Note assumptions in your report; do not ask questions mid-run. Build and validate in the cloud container, then deliver the tree onto the user's device repo (§7).

## 0. Study first (in this order)

1. `docs/roadmap.md` — Phase 1 list, this is item 2.
2. `docs/design-plan.md` §5 (stack + realtime), §9 (roles), §10 (UI architecture), §11 (cost posture).
3. `docs/mockups/model-hybrid.html` — **only** for its CSS custom properties in the `:root` block and the product colors. You are not porting the board in this brief.

Those files live on the user's device at `C:\Users\prati\OneDrive\Documents\GitHub\production_scheduler`. Stage them with `device_stage_files` (they land under `/mnt/user-data/uploads/`), or read them on the device with `device_bash` under `$HOME/mnt/production_scheduler`.

## 1. What this brief produces

An empty-but-real application shell: it builds, typechecks, lints, tests, runs in CI, connects to Supabase, and shows a health pill proving the connection. **No board, no schema, no admin screens.** The database is brief P1-2; the board is a later brief. Resist scope creep — an unused component you add now is a component the next brief has to argue with.

## 2. Decided stack (do not substitute)

| Concern | Choice |
|---|---|
| Build tool | Vite, latest stable, `react-ts` template |
| Framework | React 19 + TypeScript, `strict: true` |
| Package manager | **npm** (the user is on Windows; no pnpm/yarn/bun) |
| Node | 20 LTS — write `.nvmrc` with `20` and set the same in CI |
| Routing | `react-router-dom` v7, `createBrowserRouter` |
| Server state | `@tanstack/react-query` v5 |
| Client/UI state | `zustand` (board zoom, selection, viewing-as profile — later briefs) |
| Backend client | `@supabase/supabase-js` v2 |
| Styling | **plain CSS + CSS Modules.** Global tokens in `src/styles/tokens.css`. No Tailwind, no CSS-in-JS, no component library. The board is a hand-built grid; a utility framework would fight it. |
| Lint | ESLint 9 flat config + `typescript-eslint` + `eslint-plugin-react-hooks` + `eslint-config-prettier` |
| Format | Prettier, default config except `"singleQuote": false`, `"printWidth": 100` |
| Unit test | Vitest + `@testing-library/react` + `jsdom` |
| E2E | Playwright (`@playwright/test`), Chromium only |
| Supabase tooling | `supabase` CLI as a **devDependency** (not global) |

Install whatever versions npm resolves as latest stable on the day you run. Pin the exact resolved versions in `package.json` (no `^` ranges — replace them after install) and **list the resolved versions in your final report**, so the next agent knows what it is working against.

Set `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` and do **not** run `playwright install` — Chromium is preinstalled in this container.

## 3. Exact file tree to produce

```
production_scheduler/
├─ .github/workflows/ci.yml
├─ .gitignore
├─ .nvmrc
├─ .prettierrc
├─ .env.example
├─ README.md
├─ index.html
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ tsconfig.node.json
├─ vite.config.ts
├─ vitest.config.ts
├─ eslint.config.js
├─ playwright.config.ts
├─ docs/                      ← ALREADY EXISTS. Do not modify anything in it
│                               except roadmap.md in §8.
├─ supabase/
│  ├─ config.toml
│  ├─ migrations/.gitkeep     ← P1-2 fills this
│  └─ seed.sql                ← placeholder: a single SQL comment
├─ e2e/
│  └─ smoke.spec.ts
└─ src/
   ├─ main.tsx
   ├─ App.tsx
   ├─ routes.tsx
   ├─ env.ts
   ├─ vite-env.d.ts
   ├─ styles/
   │  ├─ tokens.css
   │  └─ global.css
   ├─ lib/
   │  ├─ supabase.ts
   │  ├─ queryClient.ts
   │  └─ database.types.ts
   ├─ components/
   │  ├─ AppShell.tsx + AppShell.module.css
   │  └─ HealthPill.tsx + HealthPill.module.css
   ├─ features/
   │  ├─ board/BoardPage.tsx
   │  └─ admin/AdminPage.tsx
   ├─ hooks/.gitkeep
   ├─ types/.gitkeep
   └─ test/
      ├─ setup.ts
      └─ env.test.ts
```

### Folder conventions (write these into `docs/conventions.md` as well)

- **Feature-first.** Everything owned by one screen lives under `src/features/<feature>/`. A feature may import from `src/lib`, `src/components`, `src/hooks`, `src/types`, and `src/styles` — **never from another feature**. Shared code moves *up* into `components/` or `lib/`, never sideways.
- `src/lib` = non-React modules (clients, pure helpers, generated types). `src/components` = cross-feature presentational React. `src/hooks` = cross-feature hooks.
- One CSS Module per component, colocated, named `<Component>.module.css`. Only `tokens.css` and `global.css` are global.
- Path alias `@/` → `src/`, configured in **both** `tsconfig.json` (`paths`) and `vite.config.ts` (`resolve.alias`), and in `vitest.config.ts`.
- Files: components `PascalCase.tsx`, everything else `camelCase.ts`. One React component per file, default-exported only for route-level pages; everything else named exports.
- Migrations are append-only (see P1-2). Never edit a migration that has run.

## 4. File contents that are decided (implement exactly)

### `src/env.ts`

Fail loudly and readably at module load, not at first query:

```ts
type Env = { supabaseUrl: string; supabaseAnonKey: string };

function read(name: string): string {
  const value = import.meta.env[name as keyof ImportMetaEnv] as string | undefined;
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env.local and fill in your Supabase project values.`
    );
  }
  return value;
}

export const env: Env = {
  supabaseUrl: read("VITE_SUPABASE_URL"),
  supabaseAnonKey: read("VITE_SUPABASE_ANON_KEY"),
};
```

Declare both vars in `src/vite-env.d.ts` on `ImportMetaEnv`.

### `.env.example`

```
# Supabase project settings → API
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

`.gitignore` must cover `.env`, `.env.local`, `.env.*.local`, `node_modules`, `dist`, `coverage`, `playwright-report`, `test-results`, `.supabase/`, and `_delivery/`. **Never commit a real key.**

### `src/lib/supabase.ts`

Single shared client, created once:

```ts
import { createClient } from "@supabase/supabase-js";
import { env } from "@/env";
import type { Database } from "@/lib/database.types";

export const supabase = createClient<Database>(env.supabaseUrl, env.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 20 } },
});
```

### `src/lib/database.types.ts`

Placeholder until P1-2 lands:

```ts
// Generated by `npm run db:types` once migrations exist (brief P1-2).
// Placeholder so the typed Supabase client compiles before the schema exists.
export type Database = Record<string, never>;
```

### `src/styles/tokens.css`

Port the `:root` custom properties from `docs/mockups/model-hybrid.html` verbatim (names and values), then append the four product colors as tokens:

```css
--product-1: #2a78d6;  /* Widget X */
--product-2: #eb6834;  /* Widget Y */
--product-3: #1baf7a;  /* Gadget Z */
--product-4: #eda100;  /* Rework   */
```

Also carry over the mockup's semantic signals as named tokens: `--signal-warn` (amber — understaffed / override), `--signal-conflict` (red), `--break-hatch` (the neutral hatch fill used for breaks). Take the actual values from the mockup; do not invent new ones. If the mockup defines a token you cannot classify, copy it across unchanged and list it in your report.

### `src/components/HealthPill.tsx`

A small pill in the app shell header that reports Supabase reachability. Use React Query (`queryKey: ["health"]`, `staleTime: 30_000`) calling `supabase.auth.getSession()` — this succeeds against any live project without requiring a schema, which matters because the schema does not exist yet. Three states: `checking` (neutral), `connected` (green dot + "Supabase connected"), `unreachable` (red dot + the error message, `title` attribute carries the full text). Style from tokens only.

### `src/routes.tsx` / pages

- `/` → `BoardPage` — renders an `<h1>Board</h1>` and a `<p>` reading `Timeline board arrives in a later brief.` Nothing else.
- `/admin` → `AdminPage` — `<h1>Admin</h1>` and `<p>Hierarchy, shifts, operators, and products editors arrive in a later brief.`
- `*` → a not-found element with a link back to `/`.
- `AppShell` wraps both: header with the product name "Production Scheduler", nav links to Board and Admin, and the `HealthPill` right-aligned. `<Outlet />` below.

`main.tsx` mounts `StrictMode` → `QueryClientProvider` (client from `src/lib/queryClient.ts`, defaults `retry: 1`, `refetchOnWindowFocus: false`) → `RouterProvider`.

### `package.json` scripts (exact names — later briefs and CI call these)

```json
{
  "dev": "vite",
  "build": "tsc -b && vite build",
  "preview": "vite preview",
  "typecheck": "tsc -b --noEmit",
  "lint": "eslint .",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "test": "vitest run",
  "test:watch": "vitest",
  "e2e": "playwright test",
  "db:start": "supabase start",
  "db:stop": "supabase stop",
  "db:reset": "supabase db reset",
  "db:diff": "supabase db diff",
  "db:push": "supabase db push",
  "db:types": "supabase gen types typescript --local > src/lib/database.types.ts"
}
```

### `supabase/config.toml`

Generate it with `npx supabase init` (which writes a current-format config), then set `project_id = "production_scheduler"`. Do not hand-write this file. `npx supabase init` may also create `supabase/.gitignore` and seed files — keep what it creates, add `migrations/.gitkeep`, and make `supabase/seed.sql` contain only `-- Seed data is generated by brief P1-2.` if init did not already create it.

**Do not run `supabase start`** — it needs Docker, which this container does not provide. The CLI is wired for the user's machine, not for you.

### Tests

- `src/test/env.test.ts` — a Vitest unit test proving `env.ts` throws a message containing `.env.local` when a var is missing, and returns values when present. Use `vi.stubEnv`.
- `e2e/smoke.spec.ts` — Playwright: start the dev server via `playwright.config.ts`'s `webServer` block (`npm run dev`, port 5173, `reuseExistingServer: !process.env.CI`), visit `/`, assert `<h1>` reads "Board", click the Admin nav link, assert `<h1>` reads "Admin". The e2e run needs env vars present, so `playwright.config.ts` must load `.env.local` if it exists and otherwise fall back to dummy values (`https://example.supabase.co` / `dummy-anon-key`) so the app boots — the health pill going `unreachable` against a dummy URL is expected and must not fail the smoke test.

### `.github/workflows/ci.yml`

Triggers: `push` to `main`, and `pull_request`. One `ubuntu-latest` job:

1. `actions/checkout@v4`
2. `actions/setup-node@v4` with `node-version-file: .nvmrc` and `cache: npm`
3. `npm ci`
4. `npm run typecheck`
5. `npm run lint`
6. `npm run format:check`
7. `npm run test`
8. `npm run build`
9. `npx playwright install --with-deps chromium`
10. `npm run e2e`
11. `actions/upload-artifact@v4` on failure with `playwright-report/`

Set job-level `env:` with the dummy Supabase values above so the build and e2e run without secrets. Add a comment in the file noting that real values arrive later as repository secrets when a deploy job is added.

### `README.md`

Short and practical: what the project is (one paragraph, lifted from design plan §1), prerequisites (Node 20, npm, Docker Desktop for local Supabase), quickstart (`npm ci` → copy `.env.example` → `npm run db:start` → `npm run db:reset` → `npm run dev`), the script table, the folder conventions in three bullets with a pointer to `docs/conventions.md`, and a "Where the design lives" section pointing at `docs/design-plan.md` (decisions) and `docs/roadmap.md` (state).

## 5. Deliberately NOT in this brief

Auth UI and session handling · any table, type, or query touching the schema · the board grid, virtualization, or drag logic · realtime subscriptions · deployment config (Vercel/Cloudflare) · Storybook · Docker. If you believe one of these is required to make the acceptance checklist pass, it is not — re-read the checklist.

## 6. Acceptance checklist

Run every one of these in the container and paste the results into your report.

1. `npm ci` clean from `package-lock.json` (delete `node_modules` first and re-run to prove the lockfile is complete).
2. `npm run typecheck` — zero errors.
3. `npm run lint` — zero errors, zero warnings.
4. `npm run format:check` — clean.
5. `npm run test` — passes, including `env.test.ts`.
6. `npm run build` — succeeds; `dist/` produced.
7. `npm run e2e` — smoke spec passes headless against dummy env values.
8. `npm run dev` + a Playwright screenshot of `/` at 1440×900 showing the shell, nav, and the health pill in its `unreachable` state (dummy URL). Save as `scaffold-shell.png`; read it back yourself and confirm the layout is not broken before you report.
9. `grep -r "supabase.co" src/ .github/` returns only the dummy placeholder — no real project ref, no real key anywhere in the tree.
10. `src/features/board/` contains no import from `src/features/admin/` and vice versa.
11. Every path in the §3 tree exists; nothing outside it was created (aside from `node_modules`, `dist`, and Playwright output, which are gitignored).

## 7. Delivering the tree to the user's device

Everything above is built in the container. The user's repo is the real home. Deliver like this:

1. In the container, from the project root, create a tarball of the tracked tree only:
   `tar --exclude=node_modules --exclude=dist --exclude=.git --exclude=coverage --exclude=playwright-report --exclude=test-results --exclude=docs -czf ~/scaffold.tar.gz .`
   (`docs/` is excluded because it already exists on the device and you must not overwrite it. Handle `docs/conventions.md` and the roadmap edit separately, in step 4.)
2. `SendUserFile` on `~/scaffold.tar.gz` to get a `file_uuid`, then `device_commit_files` with `devicePath` = `C:\Users\prati\OneDrive\Documents\GitHub\production_scheduler\_delivery\scaffold.tar.gz`.
3. `device_bash`: `cd "$HOME/mnt/production_scheduler" && tar -xzf _delivery/scaffold.tar.gz && ls -la`. Verify the tree landed by listing it.
4. Write `docs/conventions.md` and the roadmap edit (§8) directly with `device_bash` heredocs, so `docs/` is only ever added to, never replaced.
5. `device_bash`: `cd "$HOME/mnt/production_scheduler" && git status --short` and include the output in your report.
6. **Do not `git commit`, do not `git push`, do not create branches.** The user reviews and commits. `device_bash` also cannot delete files — leave `_delivery/` in place (it is gitignored) and tell the user in your report that they can delete that folder.

If `device_commit_files` refuses the path or the tarball exceeds its limits, fall back to writing the files individually via `device_bash` heredocs and say so in your report. Do not retry a refused path.

## 8. Required final step

Edit `docs/roadmap.md` on the device:

- Tick `- [ ] Repo scaffold + CI` → `- [x] **Repo scaffold + CI** — Vite/React-TS + Supabase client + CI (agent-built, Aug 2026)`.
- Update **Last updated** and set **Current phase** to `1 — Core product`.
- Add to the artifact index: a row `| App scaffold | repo root (`src/`, `supabase/`, `.github/`) | v1 |` and a row for `docs/conventions.md`.
- Add `p1-1` to the agent-briefs artifact row.

## 9. Report format

Report back with: the resolved dependency versions; each acceptance item with pass/fail and the command output that proves it; the screenshot filename; the `git status --short` output; every assumption you made where this brief was silent; and anything you deliberately left out. If an acceptance item failed, say so plainly rather than describing the intent — a red checklist you report honestly is more useful than a green one you argued into place.
