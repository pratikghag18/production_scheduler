# Supabase Edge Functions

This project's server-side functions (Deno). The first is `invite` (P1-6c, S24).

## `invite`

`POST /functions/v1/invite` with the caller's bearer token and
`{ email, nodeId, role }`. It invites a person by email (the one call the
browser cannot make, because it needs the service-role key), creates their
`user_profiles` row for the caller's org, and grants them `role` on `nodeId`
**as the caller**, so `set_site_member`'s rules are the only authority. See the
header of `invite/index.ts` for the full contract and the responses.

`supabase/config.toml` sets `[functions.invite] verify_jwt = true`, so GoTrue
rejects an unauthenticated caller before the function runs.

### Running it locally

The function reads its secrets from `supabase/functions/.env`, which is
**gitignored** (never commit it). Create it from the running stack's own keys:

```sh
# 1. Read the local stack's keys (the stack must be up: `supabase start`).
npx supabase status
```

`supabase status` prints `API URL`, `anon key` and `service_role key`. Put them
into `supabase/functions/.env` (these are the local stack's standard localhost
values, they unlock nothing remote, but they still do not belong in the repo):

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<anon key from `supabase status`>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from `supabase status`>
SITE_URL=http://localhost:5173
```

`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are also
injected by the Edge runtime when deployed, so the `.env` matters mainly for the
local `serve`. `SITE_URL` is the allow-listed origin the invite email may redirect
to; `http://localhost:5173` (the dev server) is always allowed as well.

```sh
# 2. Serve the function in its own terminal.
npx supabase functions serve invite --env-file supabase/functions/.env
```

The invite email lands in the local mail catcher at
<http://127.0.0.1:54324>. The link's `redirectTo` is `<origin>/reset-password`,
where the app reads a `type=invite` hash as "Set your password".

### In CI

`scripts/ci-e2e.sh` starts a throwaway stack, writes this `.env` from
`supabase status`, and runs `npx supabase functions serve invite` in the
background behind the same "did this script start the stack" guard, so
`e2e/invite.spec.ts` runs against a live function. If the function is not being
served, that spec skips with a named reason (a skip is not a pass).
