/// <reference types="node" />
/**
 * R-008: "The migrations must not create assignments_archive, partitions, or
 * integration_connections." A negative, architectural claim -- proving it
 * means proving an ABSENCE, the shape this repo already uses in
 * apiReadPaging.test.ts, scaleAudit.test.ts and snapIsClientOnly.test.ts:
 * read the real migrations, and assert none of them does the forbidden thing.
 *
 * The row's original claim also named "Copy Week / template tables" as
 * forbidden -- that clause is dropped here, not tested: Copy Week (R-339)
 * and week templates (R-356) both shipped, on the maintainer's own later,
 * explicit word. This audit proves what is still true, not what the row
 * said before that later decision.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = process.cwd();
const MIGRATIONS_DIR = "supabase/migrations";

function migrationFiles(): string[] {
  return fs
    .readdirSync(path.join(repoRoot, MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function readMigration(file: string): string {
  return fs.readFileSync(path.join(repoRoot, MIGRATIONS_DIR, file), "utf8");
}

describe("R-008: no archive, partition, or connector tables exist", () => {
  const files = migrationFiles();
  it("has at least one migration to audit (guards against a bad path silently passing everything)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no migration creates assignments_archive", () => {
    const offenders = files.filter((f) =>
      /create\s+table[^;]*\bassignments_archive\b/i.test(readMigration(f)),
    );
    expect(offenders).toEqual([]);
  });

  it("no migration declares a PARTITION BY table", () => {
    const offenders = files.filter((f) => /partition\s+by/i.test(readMigration(f)));
    expect(offenders).toEqual([]);
  });

  it("no migration creates integration_connections", () => {
    const offenders = files.filter((f) =>
      /create\s+table[^;]*\bintegration_connections\b/i.test(readMigration(f)),
    );
    expect(offenders).toEqual([]);
  });
});
