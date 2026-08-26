#!/usr/bin/env python3
"""
scripts/mutate-migration.py — deliberately break a migration and find out what
notices.

WHY THIS EXISTS. A green suite proves the code passes the tests. It says nothing
about whether the tests would catch the code being WRONG. On this project the
mutation run has found a hole in the CASE LIST rather than a bug in the code
five times running -- P1-5g's M2, P1-5j's U3, 0017's X8, 0018's Y4, and three
separate escapes in 0019. It is not optional; a migration is not verified until
its mutation table is written down.

HOW IT WORKS. For each mutation it builds a COMPLETE scratch database from
scratch (harness + every migration, with the one under test replaced by its
mutated copy + seed), then runs EVERY numbered test file plus every upgrade
check. Rebuilding per mutation is the only honest way once a migration contains
ALTER TABLE or DROP POLICY, which cannot simply be re-applied over themselves.

READ THE VERDICTS PROPERLY:
  caught      something failed. Good -- that is the case list doing its job.
  NOT CAUGHT  either a missing case, or the mutation is INERT (masked by a
              stronger branch, or genuinely unreachable). Decide which, and
              WRITE DOWN WHICH. "Not caught" with no explanation is a hole.
  CRASHED(n)  the case COUNT changed, so a file died rather than reporting.
              Usually a broken mutation, occasionally a real discovery.
  ANCHOR xN   the old text was not found exactly once. Your mutation never ran.

USAGE
  python3 scripts/mutate-migration.py <migration.sql> <mutations.json>

mutations.json is a list of [name, old_text, new_text]; old_text must appear
EXACTLY ONCE in the migration.
"""
import io, json, os, re, subprocess, sys, glob

PGBIN = "/usr/lib/postgresql/16/bin"
PGSOCK = "/tmp/pgsock"
PGUSER = "ubuntu"
DB = "mut_probe"
TMP_MIG = "/tmp/mutant_migration.sql"

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIGRATIONS = sorted(glob.glob(os.path.join(REPO, "supabase/migrations/*.sql")))
TESTS = sorted(glob.glob(os.path.join(REPO, "supabase/tests/[1-9]*.sql")))
UPGRADES = sorted(glob.glob(os.path.join(REPO, "supabase/tests/upgrade_*.sql")))
HARNESS = os.path.join(REPO, "supabase/tests/00_harness.sql")
SEED = os.path.join(REPO, "supabase/seed.sql")


def psql(db, args, stop_on_error=False):
    return subprocess.run(
        ["runuser", "-u", PGUSER, "--", PGBIN + "/psql", "-h", PGSOCK, "-U", PGUSER,
         "-d", db, "-q", "-v", "ON_ERROR_STOP=%d" % (1 if stop_on_error else 0)] + args,
        capture_output=True, text=True, cwd=REPO)


def recreate(db):
    subprocess.run(["runuser", "-u", PGUSER, "--", PGBIN + "/dropdb", "-h", PGSOCK,
                    "--if-exists", db], capture_output=True, text=True)
    subprocess.run(["runuser", "-u", PGUSER, "--", PGBIN + "/createdb", "-h", PGSOCK,
                    "--encoding=UTF8", "--locale=C.utf8", "--template=template0", db],
                   capture_output=True, text=True)


def build(target_mig, replacement_path):
    """Full database: harness + every migration (target swapped) + seed."""
    recreate(DB)
    if psql(DB, ["-f", HARNESS], True).returncode != 0:
        return False
    for m in MIGRATIONS:
        f = replacement_path if os.path.basename(m) == os.path.basename(target_mig) else m
        if psql(DB, ["-f", f], True).returncode != 0:
            return False
    return psql(DB, ["-f", SEED], True).returncode == 0


def build_upto(db, stop_at_basename):
    recreate(db)
    if psql(db, ["-f", HARNESS], True).returncode != 0:
        return False
    for m in MIGRATIONS:
        if os.path.basename(m) == stop_at_basename:
            return True
        if psql(db, ["-f", m], True).returncode != 0:
            return False
    return True


def run_all(target_mig, replacement_path):
    """Every numbered test, plus every upgrade check. Returns (count, failures)."""
    total, failed = 0, []
    for t in TESTS:
        out = psql(DB, ["-f", t])
        text = out.stdout + out.stderr
        total += len(re.findall(r"NOTICE:\s+(PASS|FAIL)", text))
        failed += re.findall(r"NOTICE:\s+FAIL (\w+)", text)
        if "ERROR:" in text and not re.search(r"NOTICE:\s+FAIL", text):
            failed.append(os.path.basename(t).split("_")[0] + "!ERROR")

    for u in UPGRADES:
        # Each upgrade file names the migration it upgrades THROUGH, as :mig.
        # Derive which migration to stop at from the filename: upgrade_0019_*.sql
        m = re.match(r"upgrade_(\d{4})_", os.path.basename(u))
        if not m:
            continue
        stop = next((os.path.basename(p) for p in MIGRATIONS
                     if re.search(r"0*%s_" % m.group(1), os.path.basename(p))), None)
        if stop is None:
            continue
        mig_path = (replacement_path
                    if stop == os.path.basename(target_mig)
                    else os.path.join(REPO, "supabase/migrations", stop))
        updb = "mut_upg"
        if not build_upto(updb, stop):
            failed.append("UPG!BUILD"); continue
        out = psql(updb, ["-v", "mig=" + mig_path, "-f", u])
        text = out.stdout + out.stderr
        total += len(re.findall(r"NOTICE:\s+(PASS|FAIL)", text))
        failed += re.findall(r"NOTICE:\s+FAIL (\w+)", text)
    return total, failed


def main():
    if len(sys.argv) != 3:
        print(__doc__); sys.exit(2)
    mig_path, mut_path = sys.argv[1], sys.argv[2]
    base = io.open(mig_path, encoding="utf-8").read()
    muts = json.load(io.open(mut_path, encoding="utf-8"))

    io.open(TMP_MIG, "w", encoding="utf-8").write(base)
    if not build(mig_path, TMP_MIG):
        print("BASELINE BUILD FAILED — fix that before mutating anything."); sys.exit(1)
    baseline, base_fail = run_all(mig_path, TMP_MIG)
    print("baseline: %d cases reported, %d failed %s" % (baseline, len(base_fail), base_fail or ""))
    if base_fail:
        print("BASELINE IS NOT GREEN — every verdict below would be meaningless."); sys.exit(1)
    print()

    print("%-64s %-13s %s" % ("MUTATION", "VERDICT", "caught by"))
    print("-" * 118)
    for name, old, new in muts:
        n = base.count(old)
        if n != 1:
            print("%-64s ANCHOR x%d" % (name, n)); continue
        io.open(TMP_MIG, "w", encoding="utf-8").write(base.replace(old, new))
        if not build(mig_path, TMP_MIG):
            print("%-64s %-13s" % (name, "BUILD FAIL")); continue
        rep, fail = run_all(mig_path, TMP_MIG)
        verdict = ("CRASHED(%d)" % rep if rep != baseline
                   else ("caught" if fail else "NOT CAUGHT"))
        print("%-64s %-13s %s" % (name, verdict, ", ".join(sorted(set(fail)))[:44]))

    io.open(TMP_MIG, "w", encoding="utf-8").write(base)
    build(mig_path, TMP_MIG)
    rep, fail = run_all(mig_path, TMP_MIG)
    print("-" * 118)
    print("restored: %d reported, %d failed %s" % (rep, len(fail), fail or ""))


if __name__ == "__main__":
    main()
