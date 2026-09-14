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
import { buildChatRow, buildManifest } from "../../scripts/voice/train/lib/prepare.mjs";

const HELDOUT: VoiceRow[] = readFileSync("data/voice/heldout.jsonl", "utf8")
  .trim()
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

    const manifest = buildManifest({
      trainRows,
      heldoutRows: HELDOUT,
      systemPrompt: "test system prompt",
      gitSha: "deadbee",
      trainSeed: 1,
      heldoutSeed: 20260911,
      generatedAt: "2026-09-12T00:00:00.000Z",
    });

    expect(manifest.trainRows).toBe(trainRows.length);
    expect(manifest.heldoutRows).toBe(HELDOUT.length);

    const sampleRow = HELDOUT.find((r) => r.id === manifest.sample.id);
    expect(sampleRow, manifest.sample.id).toBeTruthy();
    expect(manifest.sample.sentence).toBe(sampleRow!.sentence);
    expect(manifest.sample.canonicalForm).toBe(canonical(sampleRow!.form as Command));
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

  it("VT6 (S56): score_port.py prints the same table as score.mjs, on a file covering every intent including the three new ones", () => {
    // S56 brief §3: "score.mjs's by-field tally must cover the new intents'
    // fields (with, other, from, to, until) and the port score_port.py must
    // print the same table on the same file" -- both are already generic
    // (score.mjs's own `score()` walks `Object.keys(row.form)`, never a
    // hard-coded field list), so this is the parity CHECK that generic
    // claim, extended (per the brief) with a row per new intent rather than
    // VT2's own three assign/book/unassign rows.
    const oneRowPerIntent: VoiceRow[] = [];
    const seenIntents = new Set<string>();
    for (const row of HELDOUT) {
      if (seenIntents.has(row.intent)) continue;
      seenIntents.add(row.intent);
      oneRowPerIntent.push(row);
    }
    expect(seenIntents).toEqual(
      new Set(["assign", "book", "unassign", "move", "several", "replace", "swap", "copy"]),
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
    // from/to/until) must appear, byte for byte, in both printouts.
    const fieldLines = jsStdout
      .split("\n")
      .filter((l) => /^\s{2}(with|other|from|to|until)\s+\d+\/\d+/.test(l));
    expect(fieldLines.length).toBe(5);
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
