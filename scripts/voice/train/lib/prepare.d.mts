/** Types for `prepare.mjs`. See `scripts/voice/lib/rng.d.mts` for why this
 *  sidecar-declaration pattern exists in this repo. */
import type { VoiceRow } from "../../lib/rows.d.mts";

export function parseJsonl(text: string): VoiceRow[];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRow {
  messages: ChatMessage[];
}

export function buildChatRow(systemPrompt: string, row: VoiceRow): ChatRow;
export function buildChatRows(systemPrompt: string, trainRows: VoiceRow[]): ChatRow[];

export function assertDisjoint(trainRows: VoiceRow[], heldoutRows: VoiceRow[]): void;

export interface RuleParserBaseline {
  clean: number;
  perturbed: number;
}

export function ruleParserBaseline(heldoutRows: VoiceRow[]): RuleParserBaseline;

export function sha256Hex(text: string): string;

export interface ManifestFileEntry {
  sha256: string;
  rows: number;
}

export interface PrepareManifest {
  gitSha: string;
  generatedAt: string;
  trainRows: number;
  heldoutRows: number;
  seeds: { train: number; heldout: number };
  systemPrompt: string;
  ruleParserBaseline: RuleParserBaseline;
  sample: { id: string; sentence: string; canonicalForm: string };
  files: {
    "train.chat.jsonl": ManifestFileEntry;
    "heldout.jsonl": ManifestFileEntry;
  };
}

export function buildManifest(args: {
  trainRows: VoiceRow[];
  heldoutRows: VoiceRow[];
  systemPrompt: string;
  gitSha: string;
  trainSeed: number;
  heldoutSeed: number;
  generatedAt: string;
  trainChatText: string;
  heldoutText: string;
}): PrepareManifest;

export function buildExpectedFilesLines(args: {
  gitSha: string;
  manifest: PrepareManifest;
  manifestText: string;
}): string[];

export function replaceCellSourceInRawText(
  rawText: string,
  cellIndex: number,
  newLines: string[],
): string;
