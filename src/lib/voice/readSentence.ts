/**
 * S44-b (brief docs/agent-briefs/s44-b-read-by-model-brief.md §3.2) — the
 * reader: sends the typed sentence to the model service (§2's contract) and
 * turns its answer into a `Command`, or a reason it could not. Never throws;
 * `CommandBar` falls back to the rules on anything but `ok`.
 *
 * The system prompt is imported as raw bytes from the training script's own
 * file (`?raw`, vite/client.d.ts's built-in module shape) — never a copy, so
 * the app always sends exactly what the model was trained on.
 */
import type { Command } from "../command/parse.ts";
import { decodeCommand } from "./decode.ts";
// `?raw` is a Vite/vitest import-query for the file's bytes as a string,
// declared by vite/client.d.ts ("declare module '*?raw'") — not a copy.
import SYSTEM_PROMPT_RAW from "../../../scripts/voice/train/system_prompt.txt?raw";
// S45-a: the same schema the probe sends under `response_format`, so the
// server's grammar refuses a wrong-shaped answer here too — never a copy
// under `src` (brief §2.3).
import formSchema from "../../../scripts/voice/serve/form.schema.json";

export const SYSTEM_PROMPT: string = SYSTEM_PROMPT_RAW;

export type Reading =
  | { ok: true; command: Command; by: "model" }
  | { ok: false; reason: "no-service" | "unavailable" | "timeout" | "garbled"; detail?: string };

export type Reader = (text: string, signal: AbortSignal) => Promise<Reading>;

/** Generous on purpose (brief §3.2): the first call on a cold cache pays the
 *  ~450-token system prompt. */
const DEFAULT_TIMEOUT_MS = 20000;

/** `VITE_VOICE_URL`, trimmed, or `null` when unset/empty — "no service". */
export function voiceServiceUrl(): string | null {
  const raw = import.meta.env.VITE_VOICE_URL;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The first complete top-level `{...}` in `text`, honouring strings and
 * escapes so a brace inside a quoted value never closes the object early —
 * ports `extract_first_json_object`'s brace-scan idea from
 * `scripts/voice/train/train_qwen3.ipynb` (brief §2). `null` when no object
 * ever closes.
 */
function extractFirstJsonObject(text: string): string | null {
  let depth = 0;
  let started = false;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (!started) {
        started = true;
        start = i;
      }
      depth++;
    } else if (ch === "}") {
      if (started) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Builds a `Reader`. `opts.baseUrl` defaults to `voiceServiceUrl()` (pass
 * `null` explicitly for "no service" regardless of the env); `opts.fetch`
 * defaults to the global `fetch` (a test's seam); `opts.timeoutMs` defaults
 * to `DEFAULT_TIMEOUT_MS`.
 */
export function makeReader(opts?: {
  baseUrl?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Reader {
  const baseUrl = opts?.baseUrl === undefined ? voiceServiceUrl() : opts.baseUrl;
  const doFetch = opts?.fetch ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function readSentenceReader(text: string, signal: AbortSignal): Promise<Reading> {
    if (baseUrl === null) {
      return { ok: false, reason: "no-service" };
    }

    // One controller fed by BOTH the caller's signal and a timeout — never
    // `AbortSignal.any` (brief §3.2: jsdom may lack it).
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    signal.addEventListener("abort", onCallerAbort);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: text },
          ],
          temperature: 0,
          max_tokens: 256,
          cache_prompt: true,
          chat_template_kwargs: { enable_thinking: false },
          response_format: { type: "json_schema", json_schema: { schema: formSchema } },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) return { ok: false, reason: "timeout" };
      return { ok: false, reason: "unavailable", detail: String(err) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onCallerAbort);
    }

    if (!response.ok) {
      return { ok: false, reason: "unavailable", detail: `status ${response.status}` };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      return { ok: false, reason: "garbled", detail: String(err) };
    }

    const message =
      isRecord(payload) && Array.isArray(payload.choices) && isRecord(payload.choices[0])
        ? payload.choices[0].message
        : null;
    const content =
      isRecord(message) && typeof message.content === "string" ? message.content : null;
    if (content === null) {
      return { ok: false, reason: "garbled", detail: "no message content" };
    }

    const jsonText = extractFirstJsonObject(content);
    if (jsonText === null) {
      return { ok: false, reason: "garbled", detail: "no JSON object in content" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      return { ok: false, reason: "garbled", detail: String(err) };
    }

    const command = decodeCommand(parsed);
    if (command === null) {
      return { ok: false, reason: "garbled", detail: "decodeCommand refused the form" };
    }

    return { ok: true, command, by: "model" };
  };
}

/** `makeReader()` with the env and the global `fetch` — what `BoardPage`
 *  wires up (brief §3.4). */
export const readSentence: Reader = makeReader();
