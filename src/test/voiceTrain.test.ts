/**
 * S43-a (docs/agent-briefs/s43-a-first-model-brief.md §6) — the pure pieces
 * behind `scripts/voice/train/prepare.mjs`: the chat-row format (VT1), the
 * predictions-file round trip through the repo's own `score.mjs` CLI (VT2,
 * brief §2: "the predictions file is rows { id, form } keyed by held-out
 * id, exactly what score.mjs --predictions reads"), and the manifest's
 * sample (VT3, brief §2: "asserts its own serialisation against a sample in
 * the manifest").
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseCommand } from "@/lib/command/parse";
import type { Command } from "@/lib/command/parse";
import { canonical } from "../../scripts/voice/lib/form.mjs";
import { score } from "../../scripts/voice/lib/score.mjs";
import { generateTrainingRows } from "../../scripts/voice/lib/rows.mjs";
import type { VoiceRow } from "../../scripts/voice/lib/rows.mjs";
import {
  buildChatRow,
  buildChatRows,
  buildManifest,
  sha256Hex,
} from "../../scripts/voice/train/lib/prepare.mjs";

const HELDOUT_TEXT = readFileSync("data/voice/heldout.jsonl", "utf8");
const HELDOUT: VoiceRow[] = HELDOUT_TEXT.trim()
  .split("\n")
  .map((line) => JSON.parse(line) as VoiceRow);

describe("S43-a: prepare.mjs's pure pieces", () => {
  it("VT1: buildChatRow's messages are exactly the system prompt, the sentence, and canonical(form)", () => {
    const row = HELDOUT[0];
    const systemPrompt = "You turn one sentence about the production board into a JSON form.";
    const chatRow = buildChatRow(systemPrompt, row);
    expect(chatRow).toEqual({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: row.sentence },
        { role: "assistant", content: canonical(row.form) },
      ],
    });
  });

  it("VT2: a predictions file for three held-out rows scores through score.mjs exactly as the rule parser's own answers do", () => {
    const threeRows = HELDOUT.slice(0, 3);
    const ruleParserPredict = (row: VoiceRow) => {
      const result = parseCommand(row.sentence);
      return result.ok ? result.command : null;
    };

    // Path A: feed the rule parser's answers straight into the repo's score().
    const direct = score(threeRows, ruleParserPredict);

    // Path B: write those same answers as a predictions.jsonl file, keyed by
    // id (brief §2's exact shape), and run the ACTUAL score.mjs CLI against
    // it -- proving the file round-trips through what `--predictions` reads,
    // not a re-implementation of its loader.
    const dir = mkdtempSync(join(tmpdir(), "voice-vt2-"));
    const heldoutPath = join(dir, "heldout.jsonl");
    const predictionsPath = join(dir, "predictions.jsonl");
    writeFileSync(heldoutPath, threeRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const predictions = threeRows.map((row) => ({
      id: row.id,
      sentence: row.sentence,
      form: ruleParserPredict(row),
    }));
    writeFileSync(
      predictionsPath,
      predictions.map((p) => JSON.stringify(p)).join("\n") + "\n",
      "utf8",
    );

    const stdout = execFileSync(
      process.execPath,
      [
        "scripts/voice/score.mjs",
        "--heldout",
        heldoutPath,
        "--predictions",
        predictionsPath,
        "--bar",
        "0",
      ],
      { encoding: "utf8" },
    );

    const cleanLine = stdout.split("\n").find((l) => l.trim().startsWith("clean:"));
    expect(cleanLine, stdout).toBeTruthy();
    const match = cleanLine!.match(/(\d+)\/(\d+)/);
    expect(match, cleanLine).toBeTruthy();
    const [, correctStr, nStr] = match!;
    expect(Number(correctStr)).toBe(direct.clean.correct);
    expect(Number(nStr)).toBe(direct.clean.n);
    // both paths saw the rule parser's own answers -- every row is correct
    expect(direct.clean.correct).toBe(direct.clean.n);
  });

  it("VT3: the manifest names a sample whose canonical form matches form.mjs", () => {
    const forbidden = new Set(HELDOUT.map((r) => r.sentence));
    const trainRows = generateTrainingRows(1, 10, forbidden);
    const systemPrompt = "test system prompt";
    const trainChatText =
      buildChatRows(systemPrompt, trainRows)
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n";

    const manifest = buildManifest({
      trainRows,
      heldoutRows: HELDOUT,
      systemPrompt,
      gitSha: "deadbee",
      trainSeed: 1,
      heldoutSeed: 20260911,
      generatedAt: "2026-09-12T00:00:00.000Z",
      trainChatText,
      heldoutText: HELDOUT_TEXT,
    });

    expect(manifest.trainRows).toBe(trainRows.length);
    expect(manifest.heldoutRows).toBe(HELDOUT.length);

    const sampleRow = HELDOUT.find((r) => r.id === manifest.sample.id);
    expect(sampleRow, manifest.sample.id).toBeTruthy();
    expect(manifest.sample.sentence).toBe(sampleRow!.sentence);
    expect(manifest.sample.canonicalForm).toBe(canonical(sampleRow!.form as Command));
  });

  it("F-148: buildManifest's files block hashes are a fresh hash of the exact bytes passed in, keyed by row count too", () => {
    const forbidden = new Set(HELDOUT.map((r) => r.sentence));
    const trainRows = generateTrainingRows(1, 5, forbidden);
    const systemPrompt = "test system prompt";
    const trainChatText =
      buildChatRows(systemPrompt, trainRows)
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n";

    const manifest = buildManifest({
      trainRows,
      heldoutRows: HELDOUT,
      systemPrompt,
      gitSha: "deadbee",
      trainSeed: 1,
      heldoutSeed: 20260911,
      generatedAt: "2026-09-12T00:00:00.000Z",
      trainChatText,
      heldoutText: HELDOUT_TEXT,
    });

    expect(manifest.files["train.chat.jsonl"]).toEqual({
      sha256: sha256Hex(trainChatText),
      rows: trainRows.length,
    });
    expect(manifest.files["heldout.jsonl"]).toEqual({
      sha256: sha256Hex(HELDOUT_TEXT),
      rows: HELDOUT.length,
    });
    // A byte change is caught even when the row count doesn't move.
    expect(sha256Hex(trainChatText + " ")).not.toBe(manifest.files["train.chat.jsonl"].sha256);
  });

  it("VT4 (F-145): the notebook's Predict cell refuses to resume across a different held-out file", () => {
    const notebook = JSON.parse(readFileSync("scripts/voice/train/train_qwen3.ipynb", "utf8")) as {
      cells: Array<{ cell_type: string; source: string[] }>;
    };
    const predictCell = notebook.cells.find(
      (cell) => cell.cell_type === "code" && cell.source.join("").includes("Predict on held-out"),
    );
    expect(predictCell, "Predict cell not found in the notebook").toBeTruthy();
    const source = predictCell!.source.join("");
    expect(source).toContain("F-145");
    // Pin the MECHANISM, not just the word "F-145" -- a doc comment alone
    // could carry the string while the actual check was deleted. The cell
    // must still raise, and must still compare the two sentences by name.
    expect(source).toContain("raise RuntimeError");
    expect(source).toContain("existing_sentence != heldout_sentence");
    // A third reason: an id from predictions.jsonl that is not in the
    // CURRENT held-out file at all must say so, rather than falling into
    // "answers a different sentence" and printing a misleading
    // "held-out sentence: None" as though that None were a real mismatch.
    expect(source).toContain("is not in the current held-out file");
    // The refusal fires before any id is treated as already predicted --
    // it must appear ahead of the resume skip, not after it.
    expect(source.indexOf("F-145")).toBeLessThan(source.indexOf("if done_ids:"));
    // Every prediction row now carries its own sentence alongside id/form.
    expect(source).toContain('"sentence": row["sentence"]');
  });

  it("VT8 (F-147): the notebook's Train cell stamps the adapter and checkpoints with the data they were trained on, and refuses a mismatch or a missing stamp", () => {
    const notebook = JSON.parse(readFileSync("scripts/voice/train/train_qwen3.ipynb", "utf8")) as {
      cells: Array<{ cell_type: string; source: string[] }>;
    };
    const trainCell = notebook.cells.find(
      (cell) => cell.cell_type === "code" && cell.source.join("").includes("Train (S43-a brief"),
    );
    expect(trainCell, "Train cell not found in the notebook").toBeTruthy();
    const source = trainCell!.source.join("");
    expect(source).toContain("F-147");

    // The stamp is computed from the manifest's own identifying fields
    // (read from prepare.mjs's buildManifest, not retyped: gitSha,
    // trainRows, heldoutRows, seeds) plus train.chat.jsonl's and
    // heldout.jsonl's sha256 -- pin the mechanism, not just the word
    // "sha256".
    expect(source).toContain('manifest["gitSha"]');
    expect(source).toContain('manifest["trainRows"]');
    expect(source).toContain('manifest["heldoutRows"]');
    expect(source).toContain('manifest["seeds"]');
    // F-148: both hashes come from manifest["files"] -- already checked
    // against Drive by the data-load cell above -- rather than being
    // re-hashed here. There is exactly one hashing site left in the
    // notebook (the data-load cell), not two.
    expect(source).toContain('manifest["files"]["train.chat.jsonl"]["sha256"]');
    expect(source).toContain('manifest["files"]["heldout.jsonl"]["sha256"]');
    expect(source).not.toContain("hashlib.sha256()");
    expect(source).not.toContain("import hashlib");

    // The stamp file itself, written for both the adapter and the
    // checkpoints dir.
    expect(source).toContain('"trained-on.json"');
    expect(source).toContain("_write_stamp(ADAPTER_DIR");
    expect(source).toContain("_write_stamp(CHECKPOINTS_DIR");

    // Read-and-compare before the skip: the adapter's own trained-on.json
    // is read and compared before training is ever skipped in its favour
    // -- the comparison must appear ahead of the resume/skip action (VT4's
    // guard style: an ordering assertion, not just presence).
    expect(source.indexOf("_read_stamp(ADAPTER_DIR)")).toBeLessThan(
      source.indexOf("model = PeftModel.from_pretrained(base_model, ADAPTER_DIR)"),
    );
    // Same for the checkpoint stamp: read and compared before a resume is
    // ever handed to the trainer.
    expect(source.indexOf("_read_stamp(CHECKPOINTS_DIR)")).toBeLessThan(
      source.indexOf("trainer.train(resume_from_checkpoint=resume_from)"),
    );

    // SystemExit -- both on a missing stamp (adapter and checkpoints) and
    // on a mismatch (adapter and checkpoints): four distinct refusals.
    expect(source).toContain('raise SystemExit(f"F-147: {ADAPTER_DIR} has no trained-on.json")');
    expect(source).toContain(
      'raise SystemExit(f"F-147: {CHECKPOINTS_DIR} has no trained-on.json")',
    );
    const systemExitCount = (source.match(/raise SystemExit/g) ?? []).length;
    expect(systemExitCount).toBeGreaterThanOrEqual(4);

    // No flag overrides a mismatch -- ALLOW_UNSTAMPED_ADAPTER only ever
    // bypasses a MISSING stamp, never a mismatched one; the mismatch
    // refusals say so in their own message.
    const mismatchMessageCount = (source.match(/No flag overrides a mismatch\./g) ?? []).length;
    expect(mismatchMessageCount).toBe(2);

    // Field-by-field printing on a mismatch, not just "they differ".
    expect(source).toContain("_mismatched_fields(saved_stamp, current_stamp)");
    expect(source).toContain("current data: {current_stamp[key]!r}");

    // The Settings cell carries the override flag, defaulted off.
    const settingsCell = notebook.cells.find(
      (cell) => cell.cell_type === "code" && cell.source.join("").includes("# Settings -- every"),
    );
    expect(settingsCell, "Settings cell not found in the notebook").toBeTruthy();
    const settingsSource = settingsCell!.source.join("");
    expect(settingsSource).toContain("ALLOW_UNSTAMPED_ADAPTER = False");
  });

  it("VT9 (F-148): the SOURCE notebook carries the EXPECTED_FILES placeholder, and the data-load cell refuses to run unprepared", () => {
    // The fifth Colab run found ALL THREE files stale on Drive, including
    // manifest.json itself -- an old same-named file had been left in
    // place instead of the one that run actually prepared (how is not
    // known; the maintainer checked and found no renamed duplicate, so the
    // notebook's own message does not claim a cause). So checking the data
    // files against manifest.json alone is not enough; the notebook must
    // carry its own fingerprint, baked in fresh by `npm run voice:prepare`
    // right before upload. The SOURCE notebook checked into the repo keeps
    // a placeholder and refuses to run at all until it has been through
    // prepare.mjs.
    const notebook = JSON.parse(readFileSync("scripts/voice/train/train_qwen3.ipynb", "utf8")) as {
      cells: Array<{ cell_type: string; source: string[] }>;
    };

    const settingsCell = notebook.cells.find(
      (cell) => cell.cell_type === "code" && cell.source.join("").includes("# Settings -- every"),
    );
    expect(settingsCell, "Settings cell not found in the notebook").toBeTruthy();
    const settingsSource = settingsCell!.source.join("");
    expect(settingsSource).toContain("EXPECTED_FILES = None");
    expect(settingsSource).toContain("F-148");
    expect(settingsSource).toContain("npm run voice:prepare");
    expect(settingsSource).toContain("data/voice/colab/train_qwen3.ipynb");

    const dataCell = notebook.cells.find(
      (cell) =>
        cell.cell_type === "code" && cell.source.join("").includes("Mount Drive and load data"),
    );
    expect(dataCell, "data-load cell not found in the notebook").toBeTruthy();
    const source = dataCell!.source.join("");

    // The placeholder refusal itself: code, not just a comment.
    expect(source).toContain("if EXPECTED_FILES is None:");
    expect(source).toContain("raise SystemExit(");
    expect(source).toContain("F-148");
    expect(source).toContain("npm run voice:prepare");
    expect(source).toContain("data/voice/colab/train_qwen3.ipynb");

    // The per-file fingerprint check itself: the hash, the row count, the
    // compare, and the SystemExit -- pin the mechanism, not just the word
    // "F-148".
    expect(source).toContain("import hashlib");
    expect(source).toContain("hashlib.sha256()");
    expect(source).toContain("f.read(1 << 20)"); // streamed, not f.read() in one shot
    expect(source).toContain("_count_jsonl_rows");
    expect(source).toContain('EXPECTED_FILES["train.chat.jsonl"]');
    expect(source).toContain('EXPECTED_FILES["heldout.jsonl"]');
    expect(source).toContain('EXPECTED_FILES["manifest.json"]');
    expect(source).toContain(
      'print(f"F-148: {_filename} on Drive is not the file this notebook expects")',
    );
    expect(source).toContain(
      'raise SystemExit(f"F-148: {_filename} on Drive is not the file this notebook expects")',
    );
    // The refusal's own explanatory message does not claim a cause (the
    // maintainer found no renamed "(1)" duplicate on Drive, so the notebook
    // must not assert one) -- it tells the operator what to do regardless
    // of cause: delete, re-upload, check size and date.
    expect(source).not.toContain("(1)");
    expect(source).toContain("However the old file got there");
    expect(source).toContain("check its size and date in the folder");

    // Ordering: the placeholder refusal, and the per-file check, both run
    // before manifest.json is ever parsed and trusted.
    expect(source.indexOf("if EXPECTED_FILES is None:")).toBeLessThan(
      source.indexOf('with open(MANIFEST_PATH, "r", encoding="utf-8") as f:'),
    );
    expect(source.indexOf("_sha256_file(_path)")).toBeLessThan(
      source.indexOf('with open(MANIFEST_PATH, "r", encoding="utf-8") as f:'),
    );
  });

  it("VT11 (F-148 review): the data-load cell's missing-file check raises SystemExit, not FileNotFoundError, so a missing Drive file prints a clean message instead of a Colab traceback", () => {
    // F-148 review found this: every OTHER refusal in this cell (the
    // EXPECTED_FILES placeholder, the per-file fingerprint mismatch) and in
    // cell 6 (F-147's stamp mismatch) uses `raise SystemExit(...)`, which an
    // uncaught exception in a plain Python process (and, unlike a normal
    // exception class, a Jupyter/Colab kernel too) prints as just its own
    // message -- no frame-by-frame traceback. The pre-existing "file is
    // missing" check raised `FileNotFoundError` instead, which prints a full
    // traceback ahead of the same message; simulated locally (a scratch
    // harness built from this exact cell's own source, run against a
    // directory missing train.chat.jsonl), that traceback appeared even
    // though the exception's own text was already clear. One exception
    // class for every refusal in this cell now.
    const notebook = JSON.parse(readFileSync("scripts/voice/train/train_qwen3.ipynb", "utf8")) as {
      cells: Array<{ cell_type: string; source: string[] }>;
    };
    const dataCell = notebook.cells.find(
      (cell) =>
        cell.cell_type === "code" && cell.source.join("").includes("Mount Drive and load data"),
    );
    expect(dataCell, "data-load cell not found in the notebook").toBeTruthy();
    const source = dataCell!.source.join("");

    expect(source).not.toContain("FileNotFoundError");
    expect(source).toContain("raise SystemExit(\n");
    expect(source).toContain("is missing. Upload the three files");

    // Out of this review's scope: the scoring cell's OWN, unrelated
    // "score_port.py is missing" check keeps its FileNotFoundError --
    // touching it was never part of F-148 (brief: "cells 1-3, and, only if
    // needed, cell 6's stamp fields -- nothing else").
    const scoringCell = notebook.cells.find(
      (cell) =>
        cell.cell_type === "code" &&
        cell.source.join("").includes("score_port.py is missing from /content/"),
    );
    expect(scoringCell, "scoring cell not found in the notebook").toBeTruthy();
    expect(scoringCell!.source.join("")).toContain("raise FileNotFoundError(\n");
  });

  it("VT10 (F-148): prepare.mjs's CLI writes a notebook copy whose EXPECTED_FILES hashes are a fresh hash of the files it wrote, with no placeholder left", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-vt10-"));
    const trainPath = join(dir, "train.jsonl");
    const heldoutPath = join(dir, "heldout.jsonl");
    const outDir = join(dir, "colab");
    const threeRows = HELDOUT.slice(0, 3);
    const forbidden = new Set(HELDOUT.map((r) => r.sentence));
    const trainRows = generateTrainingRows(1, 3, forbidden);
    writeFileSync(trainPath, trainRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    writeFileSync(heldoutPath, threeRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    execFileSync(
      process.execPath,
      [
        "scripts/voice/train/prepare.mjs",
        "--train",
        trainPath,
        "--heldout",
        heldoutPath,
        "--out",
        outDir,
      ],
      { encoding: "utf8" },
    );

    const copyPath = join(outDir, "train_qwen3.ipynb");
    const copyNotebook = JSON.parse(readFileSync(copyPath, "utf8")) as {
      cells: Array<{ cell_type: string; source: string[] }>;
    };
    const settingsCell = copyNotebook.cells.find(
      (cell) => cell.cell_type === "code" && cell.source.join("").includes("# Settings -- every"),
    );
    expect(settingsCell, "Settings cell not found in the notebook copy").toBeTruthy();
    const settingsSource = settingsCell!.source.join("");

    // No placeholder left in the copy.
    expect(settingsSource).not.toContain("EXPECTED_FILES = None");

    const trainChatBytes = readFileSync(join(outDir, "train.chat.jsonl"));
    const heldoutBytes = readFileSync(join(outDir, "heldout.jsonl"));
    const manifestBytes = readFileSync(join(outDir, "manifest.json"));
    const freshTrainChatSha256 = sha256Hex(trainChatBytes.toString("utf8"));
    const freshHeldoutSha256 = sha256Hex(heldoutBytes.toString("utf8"));
    const freshManifestSha256 = sha256Hex(manifestBytes.toString("utf8"));

    const match = settingsSource.match(/EXPECTED_FILES = \{[\s\S]*?\n\}/);
    expect(match, settingsSource).toBeTruthy();
    const literal = match![0];
    expect(literal).toContain(`"sha256": "${freshTrainChatSha256}", "rows": ${trainRows.length}`);
    expect(literal).toContain(`"sha256": "${freshHeldoutSha256}", "rows": ${threeRows.length}`);
    expect(literal).toContain(`"manifest.json": {"sha256": "${freshManifestSha256}"}`);

    // Every other cell of the copy is byte-identical to the source
    // notebook -- only the Settings cell's placeholder was replaced.
    const sourceNotebook = JSON.parse(
      readFileSync("scripts/voice/train/train_qwen3.ipynb", "utf8"),
    ) as { cells: Array<{ source: string[] }> };
    copyNotebook.cells.forEach((cell, i) => {
      if (cell === settingsCell) return;
      expect(cell.source.join("")).toBe(sourceNotebook.cells[i].source.join(""));
    });
  });

  it("VT6 (S56, re-pinned S58): score_port.py prints the same table as score.mjs, on a file covering every intent including split/headcount", () => {
    // S56 brief §3: "score.mjs's by-field tally must cover the new intents'
    // fields (with, other, from, to, until) and the port score_port.py must
    // print the same table on the same file" -- both are already generic
    // (score.mjs's own `score()` walks `Object.keys(row.form)`, never a
    // hard-coded field list), so this is the parity CHECK that generic
    // claim, extended (per the brief) with a row per new intent rather than
    // VT2's own three assign/book/unassign rows.
    //
    // S58 (S56-b data brief §5): re-pinned again -- split/headcount join the
    // ten intents; split's own `at` field is the only genuinely NEW field
    // name the two add (`headcount`'s own field already exists on `book`).
    const oneRowPerIntent: VoiceRow[] = [];
    const seenIntents = new Set<string>();
    for (const row of HELDOUT) {
      if (seenIntents.has(row.intent)) continue;
      seenIntents.add(row.intent);
      oneRowPerIntent.push(row);
    }
    expect(seenIntents).toEqual(
      new Set([
        "assign",
        "book",
        "unassign",
        "move",
        "several",
        "replace",
        "swap",
        "copy",
        "split",
        "headcount",
      ]),
    );

    const ruleParserPredict = (row: VoiceRow) => {
      const result = parseCommand(row.sentence);
      return result.ok ? result.command : null;
    };

    const dir = mkdtempSync(join(tmpdir(), "voice-vt6-"));
    const heldoutPath = join(dir, "heldout.jsonl");
    const predictionsPath = join(dir, "predictions.jsonl");
    writeFileSync(
      heldoutPath,
      oneRowPerIntent.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
    const predictions = oneRowPerIntent.map((row) => ({
      id: row.id,
      sentence: row.sentence,
      form: ruleParserPredict(row),
    }));
    writeFileSync(
      predictionsPath,
      predictions.map((p) => JSON.stringify(p)).join("\n") + "\n",
      "utf8",
    );

    const jsStdout = execFileSync(
      process.execPath,
      [
        "scripts/voice/score.mjs",
        "--heldout",
        heldoutPath,
        "--predictions",
        predictionsPath,
        "--bar",
        "0",
      ],
      { encoding: "utf8" },
    );
    const pyStdout = execFileSync(
      "python",
      ["scripts/voice/train/score_port.py", heldoutPath, predictionsPath, "--bar", "0"],
      { encoding: "utf8" },
    );

    // Every "By field" line (including the new intents' own with/other/
    // from/to/until, and split's own `at`) must appear, byte for byte, in
    // both printouts.
    const fieldLines = jsStdout
      .split("\n")
      .filter((l) => /^\s{2}(with|other|from|to|until|at)\s+\d+\/\d+/.test(l));
    expect(fieldLines.length).toBe(6);
    for (const line of fieldLines) {
      expect(pyStdout, `line missing from score_port.py's table: ${line}`).toContain(line.trim());
    }

    const jsClean = jsStdout.match(/clean:\s+(\d+)\/(\d+)/);
    const pyClean = pyStdout.match(/clean:\s+(\d+)\/(\d+)/);
    expect(jsClean, jsStdout).toBeTruthy();
    expect(pyClean, pyStdout).toBeTruthy();
    expect(pyClean![0]).toBe(jsClean![0]);

    const jsPerturbed = jsStdout.match(/perturbed:\s+(\d+)\/(\d+)/);
    const pyPerturbed = pyStdout.match(/perturbed:\s+(\d+)\/(\d+)/);
    expect(pyPerturbed![0]).toBe(jsPerturbed![0]);
  });

  it("VT7 (S56-b brief §4's own flag): prepare.mjs's own CLI writes manifest.json with heldoutSeed 20260915, the seed data/voice/README.md documents", () => {
    // The first pass left `HELDOUT_SEED` hard-coded at the stale 20260911
    // (a value from before S56's own first regeneration) -- this runs the
    // ACTUAL CLI (not just `buildManifest`, VT3's own job) so a future
    // edit that drifts the constant from the README's documented command
    // again fails here, not just by eyeball.
    const dir = mkdtempSync(join(tmpdir(), "voice-vt7-"));
    const trainPath = join(dir, "train.jsonl");
    const heldoutPath = join(dir, "heldout.jsonl");
    const outDir = join(dir, "colab");
    const threeRows = HELDOUT.slice(0, 3);
    const forbidden = new Set(HELDOUT.map((r) => r.sentence));
    const trainRows = generateTrainingRows(1, 3, forbidden);
    writeFileSync(trainPath, trainRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    writeFileSync(heldoutPath, threeRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    execFileSync(
      process.execPath,
      [
        "scripts/voice/train/prepare.mjs",
        "--train",
        trainPath,
        "--heldout",
        heldoutPath,
        "--out",
        outDir,
      ],
      { encoding: "utf8" },
    );

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as {
      seeds: { train: number; heldout: number };
    };
    expect(manifest.seeds.heldout).toBe(20260915);
  });

  it("VT5 (F-145): the notebook's Score cell (cell 8) reads predictions.jsonl through score_predictions/load_jsonl, not the unprotected predictions_predict path", () => {
    const notebook = JSON.parse(readFileSync("scripts/voice/train/train_qwen3.ipynb", "utf8")) as {
      cells: Array<{ cell_type: string; source: string[] }>;
    };
    const scoreCell = notebook.cells.find(
      (cell) =>
        cell.cell_type === "code" && cell.source.join("").includes("score_port.print_table"),
    );
    expect(scoreCell, "Score cell not found in the notebook").toBeTruthy();
    const source = scoreCell!.source.join("");
    expect(source).toContain("score_port.score_predictions(");
    expect(source).toContain("score_port.load_jsonl(PREDICTIONS_PATH)");
    // The old unprotected call this incident happened around must be gone
    // from the cell that scores the very predictions.jsonl the Predict
    // cell just wrote.
    expect(source).not.toContain("predictions_predict");
  });
});
