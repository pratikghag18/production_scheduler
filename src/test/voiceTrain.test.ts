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
    const predictions = threeRows.map((row) => ({ id: row.id, form: ruleParserPredict(row) }));
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
});
