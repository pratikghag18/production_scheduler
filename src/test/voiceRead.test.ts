/**
 * S44-b (brief docs/agent-briefs/s44-b-read-by-model-brief.md §3.5) --
 * `src/lib/voice/decode.ts` and `src/lib/voice/readSentence.ts`, unmocked
 * except for the `fetch` seam `makeReader` takes for exactly this reason.
 * VR1-VR7 name the cases the brief lists.
 */
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { parseCommand } from "@/lib/command/parse";
import { decodeCommand } from "@/lib/voice/decode";
import { makeReader, SYSTEM_PROMPT } from "@/lib/voice/readSentence";
import type { Reading } from "@/lib/voice/readSentence";
import formSchema from "../../scripts/voice/serve/form.schema.json";

const SENTENCE = "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2";
const SYSTEM_PROMPT_PATH = "scripts/voice/train/system_prompt.txt";

function fetchReturningContent(content: string): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
    }),
  ) as unknown as typeof fetch;
}

/** A `fetch` that never settles on its own -- only an abort (real fetch's
 *  own behaviour) rejects it, exactly what `makeReader`'s combined
 *  controller relies on for both the timeout and the caller's own signal. */
function hangingFetch(): typeof fetch {
  return vi.fn((_input: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      });
    });
  }) as unknown as typeof fetch;
}

describe("VR1: each of the four forms decodes", () => {
  it("VR1: assign, book, unassign and move all round-trip through decodeCommand", () => {
    const sentences = [
      "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2",
      "book Housing A on Cell 1 in Line 1 from 6 to 2",
      "unassign Sam from Cell 1 in Line 1 from 10 to 2",
      "move Sam on Cell 1 in Line 1 to Cell 2",
    ];
    for (const sentence of sentences) {
      const parsed = parseCommand(sentence);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
      expect(decodeCommand(roundTripped)).toEqual(parsed.command);
    }
  });
});

describe("VR2: a missing field and a mistyped field are refused", () => {
  it("VR2: refuses a missing field and a mistyped field", () => {
    const parsed = parseCommand(SENTENCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;

    const missingProduct = { ...valid };
    delete missingProduct.product;
    expect(decodeCommand(missingProduct)).toBeNull();

    const mistypedHour = {
      ...valid,
      start: { ...(valid.start as Record<string, unknown>), hour: "7" },
    };
    expect(decodeCommand(mistypedHour)).toBeNull();
  });
});

describe("VR3: an invented key is ignored; attach/existing are forced null", () => {
  it("VR3: extra top-level and nested keys are ignored, attach/existing forced null", () => {
    const parsed = parseCommand(SENTENCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;

    const withExtras = {
      ...valid,
      unexpectedTopLevel: "surprise",
      start: { ...(valid.start as Record<string, unknown>), unexpectedNested: "surprise" },
      attach: { kind: "run", runId: "should-be-ignored" },
      existing: { kind: "separate" },
    };
    const decoded = decodeCommand(withExtras);
    expect(decoded).toEqual(parsed.command);
    expect(decoded?.intent).toBe("assign");
    if (decoded && decoded.intent === "assign") {
      expect(decoded.attach).toBeNull();
      expect(decoded.existing).toBeNull();
    }
  });
});

describe("VR4: network failures read as unavailable", () => {
  it("VR4: fetch rejects and a 503 both read as unavailable", async () => {
    const rejecting = vi
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const readerA = makeReader({ baseUrl: "http://voice.local", fetch: rejecting });
    const resultA = await readerA(SENTENCE, new AbortController().signal);
    expect(resultA.ok).toBe(false);
    if (!resultA.ok) expect(resultA.reason).toBe("unavailable");

    const failing = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503 })) as unknown as typeof fetch;
    const readerB = makeReader({ baseUrl: "http://voice.local", fetch: failing });
    const resultB = await readerB(SENTENCE, new AbortController().signal);
    expect(resultB.ok).toBe(false);
    if (!resultB.ok) expect(resultB.reason).toBe("unavailable");
  });
});

describe("VR5: timeout and garbled answers", () => {
  it("VR5: a fetch that never resolves times out at timeoutMs", async () => {
    const reader = makeReader({
      baseUrl: "http://voice.local",
      fetch: hangingFetch(),
      timeoutMs: 20,
    });
    const result = await reader(SENTENCE, new AbortController().signal);
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("VR5: content with no object is garbled", async () => {
    const reader = makeReader({
      baseUrl: "http://voice.local",
      fetch: fetchReturningContent("no object in here at all"),
    });
    const result = await reader(SENTENCE, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("garbled");
  });

  it("VR5: content with bad JSON is garbled", async () => {
    const reader = makeReader({
      baseUrl: "http://voice.local",
      fetch: fetchReturningContent("{intent: assign}"),
    });
    const result = await reader(SENTENCE, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("garbled");
  });

  it("VR5: a valid object that fails decoding is garbled", async () => {
    const reader = makeReader({
      baseUrl: "http://voice.local",
      fetch: fetchReturningContent('{"intent":"assign"}'),
    });
    const result = await reader(SENTENCE, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("garbled");
  });
});

describe("VR6: the request body matches the contract exactly", () => {
  it("VR6: the system message is the training file's bytes, and the other fields match", async () => {
    let capturedBody: string | undefined;
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;

    const reader = makeReader({ baseUrl: "http://voice.local", fetch: fetchMock });
    await reader(SENTENCE, new AbortController().signal);

    expect(capturedBody).toBeDefined();
    const body = JSON.parse(capturedBody as string) as {
      messages: { role: string; content: string }[];
      temperature: number;
      max_tokens: number;
      cache_prompt: boolean;
      chat_template_kwargs: { enable_thinking: boolean };
      response_format: { type: string; json_schema: { schema: unknown } };
    };
    const expectedSystemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
    expect(SYSTEM_PROMPT).toBe(expectedSystemPrompt);
    expect(body.messages[0]).toEqual({ role: "system", content: expectedSystemPrompt });
    expect(body.messages[1]).toEqual({ role: "user", content: SENTENCE });
    expect(body.temperature).toBe(0);
    // S50 (docs/agent-briefs/s50-b-data-brief.md §2 item 4): 256 -> 640, big
    // enough for a several of three complete forms.
    expect(body.max_tokens).toBe(640);
    expect(body.cache_prompt).toBe(true);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { schema: formSchema },
    });
    // Byte-equal to the file's parsed content, not just structurally similar.
    const fileSchema = JSON.parse(
      fs.readFileSync("scripts/voice/serve/form.schema.json", "utf8"),
    ) as unknown;
    expect(body.response_format.json_schema.schema).toEqual(fileSchema);
  });

  // Reviewer fix: `scripts/voice/serve/probe.mjs` cannot import
  // `readSentence.ts`'s `MAX_TOKENS` directly (that module is Vite/vitest-
  // only -- a top-level `?raw` import of `system_prompt.txt` fails under
  // plain Node), so it keeps its own named constant instead. This is the
  // one check that the two never drift apart, the same way the assertion
  // above pins the system prompt's bytes rather than trusting two copies to
  // agree by construction.
  it("VR6: probe.mjs's own MAX_TOKENS agrees with readSentence.ts's", () => {
    const readSentenceSrc = fs.readFileSync("src/lib/voice/readSentence.ts", "utf8");
    const probeSrc = fs.readFileSync("scripts/voice/serve/probe.mjs", "utf8");
    const readSentenceMatch = readSentenceSrc.match(/const MAX_TOKENS = (\d+);/);
    const probeMatch = probeSrc.match(/const MAX_TOKENS = (\d+);/);
    expect(readSentenceMatch, "readSentence.ts: no `const MAX_TOKENS = <n>;`").toBeTruthy();
    expect(probeMatch, "probe.mjs: no `const MAX_TOKENS = <n>;`").toBeTruthy();
    expect(Number(probeMatch![1])).toBe(Number(readSentenceMatch![1]));
    expect(Number(probeMatch![1])).toBe(640);
  });
});

describe("VR7: a null baseUrl is no-service", () => {
  it("VR7: makeReader({ baseUrl: null }) answers no-service and never calls fetch", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const reader = makeReader({ baseUrl: null, fetch: fetchMock });
    const result: Reading = await reader(SENTENCE, new AbortController().signal);
    expect(result).toEqual({ ok: false, reason: "no-service" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// S45-a VR8: the schema in `form.schema.json` must agree with the four
// `Command` shapes field for field -- no schema-validation library, just a
// small hand-written walk (brief §2.4).
//
// S50 (docs/agent-briefs/s50-b-data-brief.md §2 item 4): the four branches
// now live in `$defs` and the top-level `oneOf` merely `$ref`s them (plus a
// fifth, `several`, branch) -- `resolveRef` below is the one place that
// indirection is undone, shared by VR8's own `branchFor` and VR11.
describe("VR8: the schema matches the four canonical forms field for field", () => {
  type JsonSchemaNode = {
    $ref?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    oneOf?: JsonSchemaNode[];
  };

  const root = formSchema as { $defs: Record<string, JsonSchemaNode>; oneOf: JsonSchemaNode[] };

  function resolveRef(node: JsonSchemaNode): JsonSchemaNode {
    if (typeof node.$ref !== "string") return node;
    const key = node.$ref.replace("#/$defs/", "");
    const resolved = root.$defs[key];
    if (!resolved) throw new Error(`resolveRef: no $defs entry for "${node.$ref}"`);
    return resolved;
  }

  function branchFor(intent: string): JsonSchemaNode {
    const branch = root.oneOf
      .map(resolveRef)
      .find((b) => (b.properties?.intent as { const?: string } | undefined)?.const === intent);
    if (!branch) throw new Error(`no schema branch for intent "${intent}"`);
    return branch;
  }

  const cases: Array<{ sentence: string; intent: string }> = [
    { sentence: "assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2", intent: "assign" },
    { sentence: "book Housing A on Cell 1 in Line 1 from 6 to 2", intent: "book" },
    { sentence: "unassign Sam from Cell 1 in Line 1 from 10 to 2", intent: "unassign" },
    { sentence: "move Sam on Cell 1 in Line 1 to Cell 2", intent: "move" },
  ];

  for (const { sentence, intent } of cases) {
    it(`VR8: ${intent}'s branch has exactly the form's keys, as its required list, alphabetical`, () => {
      const parsed = parseCommand(sentence);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const form = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
      const formKeys = Object.keys(form);

      const branch = branchFor(intent);
      const schemaKeys = Object.keys(branch.properties ?? {});

      for (const key of formKeys) {
        expect(schemaKeys, `"${key}" is missing from the ${intent} schema branch`).toContain(key);
      }
      expect([...(branch.required ?? [])].sort()).toEqual([...formKeys].sort());
      expect(schemaKeys).toEqual([...schemaKeys].sort());
    });
  }

  it("VR8: every properties object anywhere in the schema (branches and $defs) is alphabetical", () => {
    function walk(node: unknown): void {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node !== null && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (obj.properties && typeof obj.properties === "object") {
          const keys = Object.keys(obj.properties as Record<string, unknown>);
          expect(keys).toEqual([...keys].sort());
        }
        for (const value of Object.values(obj)) walk(value);
      }
    }
    walk(root);
  });
});

// S49 (R-397, docs/agent-briefs/s49-a-elsewhere-brief.md §5): the decoder
// accepts an empty `place` for a removal or a move ("wherever the person
// is") -- never for an assign or a booking, which still need a place to
// create anything.
describe("VR9: an empty place decodes for unassign/move, never for assign/book", () => {
  it("VR9: decodeCommand accepts place: [] for unassign and move", () => {
    const unassignParsed = parseCommand("unassign Sam from Cell 1 in Line 1 from 10 to 2");
    expect(unassignParsed.ok).toBe(true);
    if (!unassignParsed.ok) return;
    const unassignForm = { ...(unassignParsed.command as unknown as Record<string, unknown>) };
    unassignForm.place = [];
    expect(decodeCommand(unassignForm)).toEqual({ ...unassignParsed.command, place: [] });

    const moveParsed = parseCommand("move Sam on Cell 1 in Line 1 to Cell 2");
    expect(moveParsed.ok).toBe(true);
    if (!moveParsed.ok) return;
    const moveForm = { ...(moveParsed.command as unknown as Record<string, unknown>) };
    moveForm.place = [];
    expect(decodeCommand(moveForm)).toEqual({ ...moveParsed.command, place: [] });
  });

  it("VR9: decodeCommand refuses place: [] for assign and book", () => {
    const assignParsed = parseCommand("assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2");
    expect(assignParsed.ok).toBe(true);
    if (!assignParsed.ok) return;
    const assignForm = { ...(assignParsed.command as unknown as Record<string, unknown>) };
    assignForm.place = [];
    expect(decodeCommand(assignForm)).toBeNull();

    const bookParsed = parseCommand("book Housing A on Cell 1 in Line 1 from 6 to 2");
    expect(bookParsed.ok).toBe(true);
    if (!bookParsed.ok) return;
    const bookForm = { ...(bookParsed.command as unknown as Record<string, unknown>) };
    bookForm.place = [];
    expect(decodeCommand(bookForm)).toBeNull();
  });

  // Reviewer fix (S49): `decodeMove` must refuse `toPlace: null` AND
  // `span: null` together -- the text grammar's own R-389 check
  // (parseMoveRest's `no_move`), which nothing enforced on the decoder side
  // before this. Without it, a model answer naming neither a new cell nor
  // new hours reached `resolveCommand` and `buildDestinationText` threw.
  it("VR9: decodeCommand refuses a move naming neither a new cell nor new hours", () => {
    const moveParsed = parseCommand("move Sam on Cell 1 in Line 1 to Cell 2");
    expect(moveParsed.ok).toBe(true);
    if (!moveParsed.ok) return;
    const neitherForm = { ...(moveParsed.command as unknown as Record<string, unknown>) };
    neitherForm.toPlace = null;
    neitherForm.span = null;
    expect(decodeCommand(neitherForm)).toBeNull();
  });
});

// S50 (docs/agent-briefs/s50-b-data-brief.md §2 item 5): the decoder reads a
// `several` into complete commands, or refuses the whole thing.
describe("VR10: a several decodes to complete commands, or refuses", () => {
  const validInnerA = {
    intent: "assign",
    operator: "A2",
    product: "Housing A",
    place: ["Cell 1"],
    day: null,
    start: { hour: 10, minute: 0 },
    end: { hour: 14, minute: 0 },
    attach: null,
    shift: null,
    existing: null,
  };
  const validInnerB = {
    intent: "assign",
    operator: "A3",
    product: "Housing A",
    place: ["Cell 2"],
    day: null,
    start: { hour: 10, minute: 0 },
    end: { hour: 14, minute: 0 },
    attach: null,
    shift: null,
    existing: null,
  };
  const validInnerC = {
    intent: "assign",
    operator: "A4",
    product: "Housing A",
    place: ["Cell 3"],
    day: null,
    start: { hour: 10, minute: 0 },
    end: { hour: 14, minute: 0 },
    attach: null,
    shift: null,
    existing: null,
  };

  it("VR10: a several of two decodes to two complete commands", () => {
    const decoded = decodeCommand({ intent: "several", commands: [validInnerA, validInnerB] });
    expect(decoded).toEqual({ intent: "several", commands: [validInnerA, validInnerB] });
  });

  it("VR10: a several of three (the schema's own maxItems) decodes to three complete commands", () => {
    const decoded = decodeCommand({
      intent: "several",
      commands: [validInnerA, validInnerB, validInnerC],
    });
    expect(decoded).toEqual({
      intent: "several",
      commands: [validInnerA, validInnerB, validInnerC],
    });
  });

  it("VR10: one inner command malformed refuses the whole form", () => {
    const badInner: Record<string, unknown> = { ...validInnerB };
    delete badInner.product;
    expect(decodeCommand({ intent: "several", commands: [validInnerA, badInner] })).toBeNull();
  });

  it("VR10: fewer than two inner commands refuses (never a one-element several)", () => {
    expect(decodeCommand({ intent: "several", commands: [validInnerA] })).toBeNull();
  });

  // Reviewer fix: more than three inner commands refuses too -- the schema's
  // own `maxItems: 3` on the several branch (form.schema.json), mirrored
  // here so the decoder never accepts a shape the served model's grammar
  // could not have emitted in the first place.
  it("VR10: more than three inner commands refuses (matches the schema's maxItems: 3)", () => {
    const validInnerD = { ...validInnerC, operator: "A5", place: ["Cell 4"] };
    expect(
      decodeCommand({
        intent: "several",
        commands: [validInnerA, validInnerB, validInnerC, validInnerD],
      }),
    ).toBeNull();
  });

  it("VR10: a nested several inside commands refuses", () => {
    const nested = { intent: "several", commands: [validInnerA, validInnerB] };
    expect(decodeCommand({ intent: "several", commands: [validInnerA, nested] })).toBeNull();
  });
});

// S50 (docs/agent-briefs/s50-b-data-brief.md §2 item 4): the schema's fifth
// branch, and `place`'s widened `minItems` for unassign/move.
describe("VR11: the schema's fifth branch is a several of the four $defs", () => {
  type JsonSchemaNode = {
    $ref?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    oneOf?: JsonSchemaNode[];
  };
  const root = formSchema as { $defs: Record<string, JsonSchemaNode>; oneOf: JsonSchemaNode[] };

  function resolveRef(node: JsonSchemaNode): JsonSchemaNode {
    if (typeof node.$ref !== "string") return node;
    const key = node.$ref.replace("#/$defs/", "");
    const resolved = root.$defs[key];
    if (!resolved) throw new Error(`resolveRef: no $defs entry for "${node.$ref}"`);
    return resolved;
  }

  function severalBranch(): JsonSchemaNode {
    const branch = root.oneOf
      .map(resolveRef)
      .find((b) => (b.properties?.intent as { const?: string } | undefined)?.const === "several");
    if (!branch) throw new Error('no schema branch for intent "several"');
    return branch;
  }

  it("VR11: the several branch requires exactly commands and intent", () => {
    const branch = severalBranch();
    expect([...(branch.required ?? [])].sort()).toEqual(["commands", "intent"]);
    expect(Object.keys(branch.properties ?? {})).toEqual(["commands", "intent"]);
  });

  it("VR11: commands is an array of 2-3 items, each one of the four $defs branches", () => {
    const branch = severalBranch();
    const commandsSchema = branch.properties?.commands as {
      type: string;
      minItems: number;
      maxItems: number;
      items: { oneOf: { $ref: string }[] };
    };
    expect(commandsSchema.type).toBe("array");
    expect(commandsSchema.minItems).toBe(2);
    expect(commandsSchema.maxItems).toBe(3);
    const refs = commandsSchema.items.oneOf.map((r) => r.$ref).sort();
    expect(refs).toEqual(
      ["#/$defs/assign", "#/$defs/book", "#/$defs/move", "#/$defs/unassign"].sort(),
    );
  });

  it("VR11: place has minItems 0 for unassign and move, still 1 for assign and book", () => {
    const place = (name: string) =>
      (root.$defs[name].properties?.place as { minItems: number }).minItems;
    expect(place("unassign")).toBe(0);
    expect(place("move")).toBe(0);
    expect(place("assign")).toBe(1);
    expect(place("book")).toBe(1);
  });

  it("VR11: VR8 still passes -- every branch (the four $defs and the several branch) resolves and matches its own intent", () => {
    for (const intent of ["assign", "book", "unassign", "move", "several"]) {
      const branch = root.oneOf
        .map(resolveRef)
        .find((b) => (b.properties?.intent as { const?: string } | undefined)?.const === intent);
      expect(branch, intent).toBeTruthy();
    }
  });
});

// S52-a (docs/agent-briefs/s52-a-shift-grammar-brief.md, R-402): the decoder
// accepts a `shift` field (string or null), refuses a form naming BOTH a
// shift and hours, and refuses one naming NEITHER.
describe("VR12 (R-402): decode accepts shift, refuses both, refuses neither", () => {
  it("VR12: an assign with a shift and null start/end round-trips through decodeCommand", () => {
    const parsed = parseCommand("assign Sam to Housing A on Cell 1 for shift 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it("VR12: refuses an assign naming both a shift and hours", () => {
    const parsed = parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const both = { ...(parsed.command as unknown as Record<string, unknown>), shift: "2" };
    expect(decodeCommand(both)).toBeNull();
  });

  it("VR12: refuses an assign naming neither a shift nor hours", () => {
    const parsed = parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const neither = {
      ...(parsed.command as unknown as Record<string, unknown>),
      start: null,
      end: null,
    };
    expect(decodeCommand(neither)).toBeNull();
  });

  it("VR12: a book with a shift round-trips the same way, and unassign/move accept a shift with span null", () => {
    const bookParsed = parseCommand("book Housing A on Cell 1 in Line 1 on the night shift");
    expect(bookParsed.ok).toBe(true);
    if (bookParsed.ok) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(bookParsed.command));
      expect(decodeCommand(roundTripped)).toEqual(bookParsed.command);
    }

    const unassignParsed = parseCommand("unassign Sam from Cell 1 for shift 1");
    expect(unassignParsed.ok).toBe(true);
    if (unassignParsed.ok) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(unassignParsed.command));
      expect(decodeCommand(roundTripped)).toEqual(unassignParsed.command);
    }

    const moveParsed = parseCommand("move Sam on Cell 1 for shift 2");
    expect(moveParsed.ok).toBe(true);
    if (moveParsed.ok) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(moveParsed.command));
      expect(decodeCommand(roundTripped)).toEqual(moveParsed.command);
    }
  });

  it("VR12: refuses a move naming both a shift and new hours", () => {
    const moveParsed = parseCommand("move Sam on Cell 1 to Cell 2");
    expect(moveParsed.ok).toBe(true);
    if (!moveParsed.ok) return;
    const both = {
      ...(moveParsed.command as unknown as Record<string, unknown>),
      span: { start: { hour: 10, minute: 0 }, end: { hour: 12, minute: 0 } },
      shift: "2",
    };
    expect(decodeCommand(both)).toBeNull();
  });
});

// S52-c (docs/agent-briefs/s52-c-shift-data-brief.md §2 item 6, R-402): the
// schema check VR8/VR11 already run field-for-field does not itself name
// `shift` or the newly-nullable `start`/`end` -- this pins those two facts
// directly, the way VR11's own `place` check pins `minItems` directly.
describe("VR13 (S52-c, R-402): shift is in all four $defs, start/end nullable only in assign and book", () => {
  type JsonSchemaNode = {
    $ref?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    oneOf?: JsonSchemaNode[];
  };
  const root = formSchema as { $defs: Record<string, JsonSchemaNode>; oneOf: JsonSchemaNode[] };

  it("VR13: every one of the four $defs branches declares shift (nullable string) and requires it", () => {
    for (const name of ["assign", "book", "unassign", "move"]) {
      const branch = root.$defs[name];
      expect(branch.properties?.shift, name).toEqual({
        oneOf: [{ type: "null" }, { type: "string" }],
      });
      expect(branch.required, name).toContain("shift");
    }
  });

  it("VR13: start/end are nullable ({oneOf: [null, clock_time]}) in assign and book, absent from unassign and move", () => {
    for (const name of ["assign", "book"]) {
      const branch = root.$defs[name];
      for (const field of ["start", "end"]) {
        expect(branch.properties?.[field], `${name}.${field}`).toEqual({
          oneOf: [{ type: "null" }, { $ref: "#/$defs/clock_time" }],
        });
        expect(branch.required, `${name}.${field}`).toContain(field);
      }
    }
    for (const name of ["unassign", "move"]) {
      const branch = root.$defs[name];
      expect(branch.properties?.start, name).toBeUndefined();
      expect(branch.properties?.end, name).toBeUndefined();
    }
  });

  it("VR13: shift's own key sits alphabetically among each branch's other keys (VR8's own rule, restated for this one field)", () => {
    for (const name of ["assign", "book", "unassign", "move"]) {
      const branch = root.$defs[name];
      const keys = Object.keys(branch.properties ?? {});
      expect(keys).toContain("shift");
      expect(keys).toEqual([...keys].sort());
    }
  });
});
