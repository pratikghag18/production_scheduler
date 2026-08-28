# Security Policy

## Status

This project is under active development and is **not yet hardened for production use**.
It has no sign-in screen of its own, and several parts of the permission model are still
being built out. Do not run it against real production data.

## Where the security boundary is

Authorization in this project lives almost entirely in the database, as Postgres
row-level-security policies under `supabase/migrations/`. The client is a convenience
layer: it hides controls the current user should not press, but it is never the thing
that stops a write. If you find a place where the client is the only guard, that is a
bug worth reporting.

The policies are covered by the SQL suite in `supabase/tests/`, which is written to be
read as documentation of what the rules actually are.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting: go to the **Security** tab of this
repository and choose **Report a vulnerability**. That opens a private thread visible
only to the maintainer.

Useful things to include:

- Which policy, migration or RPC you think is at fault
- The role and site scope you were acting as
- A minimal reproduction — ideally a SQL snippet in the shape of the cases in
  `supabase/tests/`

I will acknowledge reports as quickly as I can. This is a personal project, not a
staffed product, so please size your expectations accordingly.
