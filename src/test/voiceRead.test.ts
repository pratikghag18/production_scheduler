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
    // S55 (D130 item 2): the three board-answered intents join the walk --
    // same field-for-field check, same $defs indirection.
    { sentence: "cover Sam with Ana on Cell 1 today", intent: "replace" },
    { sentence: "swap Sam and Ana on Cell 1 tomorrow", intent: "swap" },
    { sentence: "copy Monday to Tuesday for Cell 1", intent: "copy" },
    // S58 (D132 items 2 and 4): split and headcount join the walk -- same
    // field-for-field check, same $defs indirection, neither ever inside a
    // several (D132's own words for headcount; D130 item 2 for split).
    { sentence: "split Sam on Cell 1 at 12 today", intent: "split" },
    { sentence: "make the Housing A job on Cell 1 4 people", intent: "headcount" },
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

      // S55 (brief §3): "extend it so a form the schema accepts always
      // decodes and vice versa" -- the schema's own field set (just pinned
      // above) and the decoder's accepted field set must be the same set,
      // so a form built from exactly those keys round-trips through
      // `decodeCommand` back to the parsed command itself.
      expect(decodeCommand(form)).toEqual(parsed.command);
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

// S55 (docs/agent-briefs/s55-c-decoder-brief.md §1/§3, R-406, design
// §19.101/D130): "cover Sam with Ana" -- `place` may be empty (wherever the
// operator is), the day-vs-hours-vs-shift invariants are the same ones
// unassign/move already have.
describe("VR14 (S55, R-406): replace decodes", () => {
  it("VR14: a well-formed replace round-trips through decodeCommand", () => {
    const parsed = parseCommand("cover Sam with Ana on Cell 1 today");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command.intent).toBe("replace");
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it('VR14: place may be empty ("replace Sam with Ana")', () => {
    const parsed = parseCommand("replace Sam with Ana");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.command.intent !== "replace") return;
    expect(parsed.command.place).toEqual([]);
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it("VR14: extra top-level keys are ignored -- a replace has no attach/existing to force null, so an invented one is simply dropped", () => {
    const parsed = parseCommand("cover Sam with Ana on Cell 1 today");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    const withExtras = { ...valid, unexpectedTopLevel: "surprise", existing: { kind: "separate" } };
    expect(decodeCommand(withExtras)).toEqual(parsed.command);
  });

  it("VR14: refuses a replace naming both a shift and hours", () => {
    const parsed = parseCommand("cover Sam with Ana on Cell 1 from 2 to 4");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const both = { ...(parsed.command as unknown as Record<string, unknown>), shift: "2" };
    expect(decodeCommand(both)).toBeNull();
  });
});

// S55 (R-406): "swap Sam and Ana" -- same shape as replace with `other` in
// place of `with`.
describe("VR15 (S55, R-406): swap decodes", () => {
  it("VR15: a well-formed swap (no place, no day) round-trips through decodeCommand", () => {
    const parsed = parseCommand("swap Sam and Ana");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command.intent).toBe("swap");
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it("VR15: a swap with a place and a day round-trips through decodeCommand", () => {
    const parsed = parseCommand("swap Sam with Ana on Cell 1 tomorrow");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });
});

// S55 (R-408, D130 item 4): "same as yesterday for Cell 1" / "copy Monday to
// Tuesday" -- the one place a week kind (`this_week`/`next_week`/
// `last_week`) is ever legal.
describe("VR16 (S55, R-408, D130 item 4): copy decodes, week kinds included", () => {
  it("VR16: a day-to-day copy round-trips through decodeCommand", () => {
    const parsed = parseCommand("copy Monday to Tuesday for Cell 1");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command.intent).toBe("copy");
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it("VR16: a week-to-week copy (this_week to next_week) round-trips through decodeCommand", () => {
    const parsed = parseCommand("repeat this week next week");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.command.intent !== "copy") return;
    expect(parsed.command.from).toEqual({ kind: "this_week" });
    expect(parsed.command.to).toEqual({ kind: "next_week" });
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it('VR16: "same as yesterday" (a day source implying a day destination) round-trips, place may be empty', () => {
    const parsed = parseCommand("same as yesterday");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.command.intent !== "copy") return;
    expect(parsed.command.from).toEqual({ kind: "yesterday" });
    expect(parsed.command.to).toEqual({ kind: "today" });
    expect(parsed.command.place).toEqual([]);
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it("VR16: extra top-level keys are ignored on a copy", () => {
    const parsed = parseCommand("copy Monday to Tuesday for Cell 1");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    const withExtras = { ...valid, unexpectedTopLevel: "surprise" };
    expect(decodeCommand(withExtras)).toEqual(parsed.command);
  });
});

// S55 (R-409): `until` joins `UnassignCommand` -- REQUIRED (a missing key
// garbles the form, the same strictness `shift` got at VR8/VR13), `null` on
// every removal that is not an absence carrying its own `until`.
describe("VR17 (S55, R-409): unassign's until -- required, decodes, missing is garbled", () => {
  it('VR17: an absence with an until ("Ana is on leave till Friday") round-trips through decodeCommand', () => {
    const parsed = parseCommand("Ana is on leave till Friday");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.command.intent !== "unassign") return;
    expect(parsed.command.until).toEqual({ kind: "weekday", day: 5 });
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it("VR17: an ordinary removal's until is null and round-trips through decodeCommand", () => {
    const parsed = parseCommand("unassign Sam from Cell 1 in Line 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.command.intent !== "unassign") return;
    expect(parsed.command.until).toBeNull();
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it("VR17: a missing until is garbled", () => {
    const parsed = parseCommand("unassign Sam from Cell 1 in Line 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    delete valid.until;
    expect(decodeCommand(valid)).toBeNull();
  });
});

// S55 (brief §1; coordinator correction, 14 Sept): the three week kinds are
// legal ONLY on a copy's from/to -- refused everywhere else by BOTH gates.
// The schema is the fence the served model is physically forced through
// (`day_word` itself carries only the five ordinary day kinds; `week_word`,
// the three week kinds, is reachable only from `$defs.copy`'s own from/to),
// and `decodeDayWord` (used for `day` everywhere, and for `until`) is the
// second gate, for every caller that is not the served model -- it has no
// case for a week kind, so one anywhere else garbles the whole form.
describe("VR18 (S55): a week kind is garbled everywhere except a copy's from/to", () => {
  it("VR18: the schema itself refuses a week kind on day_word -- week_word's three kinds are reachable only from copy's own from/to", () => {
    type JsonSchemaNode = {
      $ref?: string;
      properties?: Record<string, unknown>;
      oneOf?: JsonSchemaNode[];
    };
    const root = formSchema as { $defs: Record<string, JsonSchemaNode> };

    const dayWordKinds = (root.$defs.day_word.oneOf ?? [])
      .map((n) => (n.properties?.kind as { const?: string } | undefined)?.const)
      .sort();
    expect(dayWordKinds).toEqual(["date", "today", "tomorrow", "weekday", "yesterday"]);

    const weekWordKinds = (root.$defs.week_word.oneOf ?? [])
      .map((n) => (n.properties?.kind as { const?: string } | undefined)?.const)
      .sort();
    expect(weekWordKinds).toEqual(["last_week", "next_week", "this_week"]);

    // Every branch with a `day` (and unassign's own `until`) points at
    // `day_word` alone -- `week_word` never appears there -- so the served
    // model is physically unable to emit a week kind on any of them. S58:
    // assign and book are the one exception, gaining `repeat_day_word`
    // alongside `day_word` (R-416) -- `week_word` still never reaches them.
    for (const name of ["unassign", "move", "replace", "swap"]) {
      const branch = root.$defs[name];
      const dayProp = branch.properties?.day as { oneOf?: JsonSchemaNode[] } | undefined;
      const refs = (dayProp?.oneOf ?? []).map((n) => n.$ref).filter((r): r is string => !!r);
      expect(refs, `${name}.day`).toEqual(["#/$defs/day_word"]);
    }
    for (const name of ["assign", "book"]) {
      const branch = root.$defs[name];
      const dayProp = branch.properties?.day as { oneOf?: JsonSchemaNode[] } | undefined;
      const refs = (dayProp?.oneOf ?? []).map((n) => n.$ref).filter((r): r is string => !!r);
      expect(refs, `${name}.day`).toEqual(["#/$defs/day_word", "#/$defs/repeat_day_word"]);
    }
    const untilProp = root.$defs.unassign.properties?.until as
      { oneOf?: JsonSchemaNode[] } | undefined;
    const untilRefs = (untilProp?.oneOf ?? []).map((n) => n.$ref).filter((r): r is string => !!r);
    expect(untilRefs).toEqual(["#/$defs/day_word"]);

    // The copy branch is the one place both defs are reachable.
    const copyFrom = root.$defs.copy.properties?.from as { oneOf?: JsonSchemaNode[] } | undefined;
    const copyTo = root.$defs.copy.properties?.to as { oneOf?: JsonSchemaNode[] } | undefined;
    expect((copyFrom?.oneOf ?? []).map((n) => n.$ref)).toEqual([
      "#/$defs/day_word",
      "#/$defs/week_word",
    ]);
    expect((copyTo?.oneOf ?? []).map((n) => n.$ref)).toEqual([
      "#/$defs/day_word",
      "#/$defs/week_word",
    ]);

    // ... and the decoder, the second gate, refuses the same shapes the
    // schema (the first gate) now refuses.
    const assignParsed = parseCommand("assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2");
    expect(assignParsed.ok).toBe(true);
    if (assignParsed.ok) {
      const valid = JSON.parse(JSON.stringify(assignParsed.command)) as Record<string, unknown>;
      expect(decodeCommand({ ...valid, day: { kind: "this_week" } })).toBeNull();
    }
    const unassignParsed = parseCommand("unassign Sam from Cell 1 in Line 1 from 10 to 2");
    expect(unassignParsed.ok).toBe(true);
    if (unassignParsed.ok) {
      const valid = JSON.parse(JSON.stringify(unassignParsed.command)) as Record<string, unknown>;
      expect(decodeCommand({ ...valid, until: { kind: "next_week" } })).toBeNull();
    }
  });

  it("VR18: a week kind on an assign's day is garbled", () => {
    const parsed = parseCommand("assign Sam to Housing A on Cell 1 in Line 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    expect(decodeCommand({ ...valid, day: { kind: "this_week" } })).toBeNull();
  });

  it("VR18: a week kind on an unassign's until is garbled", () => {
    const parsed = parseCommand("unassign Sam from Cell 1 in Line 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    expect(decodeCommand({ ...valid, until: { kind: "next_week" } })).toBeNull();
  });

  it("VR18: a week kind on a replace's or a swap's day is garbled", () => {
    const replaceParsed = parseCommand("cover Sam with Ana on Cell 1 today");
    expect(replaceParsed.ok).toBe(true);
    if (replaceParsed.ok) {
      const valid = JSON.parse(JSON.stringify(replaceParsed.command)) as Record<string, unknown>;
      expect(decodeCommand({ ...valid, day: { kind: "last_week" } })).toBeNull();
    }

    const swapParsed = parseCommand("swap Sam and Ana");
    expect(swapParsed.ok).toBe(true);
    if (swapParsed.ok) {
      const valid = JSON.parse(JSON.stringify(swapParsed.command)) as Record<string, unknown>;
      expect(decodeCommand({ ...valid, day: { kind: "this_week" } })).toBeNull();
    }
  });
});

// S55 (D130 item 2): a `several` never holds a `replace`/`swap`/`copy` -- the
// model says two or three plain commands, or one of these three; the board
// makes the many. `decodeSingle` (shared by `decodeSeveral`) has no case for
// any of the three, so one anywhere in `commands` garbles the whole form.
describe("VR19 (S55, D130 item 2): a several never holds replace/swap/copy", () => {
  const validInnerAssign = {
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

  it("VR19: a replace inside commands garbles the whole several", () => {
    const replaceParsed = parseCommand("cover Sam with Ana on Cell 1 today");
    expect(replaceParsed.ok).toBe(true);
    if (!replaceParsed.ok) return;
    const replaceForm: unknown = JSON.parse(JSON.stringify(replaceParsed.command));
    expect(
      decodeCommand({ intent: "several", commands: [validInnerAssign, replaceForm] }),
    ).toBeNull();
  });

  it("VR19: a swap inside commands garbles the whole several", () => {
    const swapParsed = parseCommand("swap Sam and Ana");
    expect(swapParsed.ok).toBe(true);
    if (!swapParsed.ok) return;
    const swapForm: unknown = JSON.parse(JSON.stringify(swapParsed.command));
    expect(decodeCommand({ intent: "several", commands: [validInnerAssign, swapForm] })).toBeNull();
  });

  it("VR19: a copy inside commands garbles the whole several", () => {
    const copyParsed = parseCommand("copy Monday to Tuesday for Cell 1");
    expect(copyParsed.ok).toBe(true);
    if (!copyParsed.ok) return;
    const copyForm: unknown = JSON.parse(JSON.stringify(copyParsed.command));
    expect(decodeCommand({ intent: "several", commands: [validInnerAssign, copyForm] })).toBeNull();
  });
});

// S58 (docs/agent-briefs/s58-c-decoder-brief.md, R-412, design section
// 19.103/D132 item 1): a re-time by one edge -- `MoveCommand.adjust`, now
// REQUIRED. Non-null implies `toPlace`, `span` and `shift` are all null.
describe("VR20 (S58, R-412): move's adjust decodes", () => {
  it('VR20: a "by" adjust ("extend Sam\'s block by an hour") round-trips through decodeCommand', () => {
    const parsed = parseCommand("extend Sam's block by an hour");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command.intent).toBe("move");
    if (parsed.command.intent === "move") {
      expect(parsed.command.adjust).toEqual({ edge: "end", by: 60 });
    }
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it('VR20: an "at" adjust ("move Sam\'s start to 9") round-trips through decodeCommand', () => {
    const parsed = parseCommand("move Sam's start to 9");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command.intent).toBe("move");
    if (parsed.command.intent === "move") {
      expect(parsed.command.adjust).toEqual({ edge: "start", at: { hour: 9, minute: 0 } });
    }
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it("VR20: an ordinary move's adjust is null and round-trips through decodeCommand", () => {
    const parsed = parseCommand("move Sam on Cell 1 in Line 1 to Cell 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.command.intent !== "move") return;
    expect(parsed.command.adjust).toBeNull();
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it("VR20: a missing adjust key is garbled", () => {
    const parsed = parseCommand("move Sam on Cell 1 in Line 1 to Cell 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    delete valid.adjust;
    expect(decodeCommand(valid)).toBeNull();
  });

  it("VR20: an adjust with span also set is garbled", () => {
    const parsed = parseCommand("extend Sam's block by an hour");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const both = {
      ...(parsed.command as unknown as Record<string, unknown>),
      span: { start: { hour: 10, minute: 0 }, end: { hour: 12, minute: 0 } },
    };
    expect(decodeCommand(both)).toBeNull();
  });

  it("VR20: an adjust with shift also set is garbled", () => {
    const parsed = parseCommand("extend Sam's block by an hour");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const both = { ...(parsed.command as unknown as Record<string, unknown>), shift: "2" };
    expect(decodeCommand(both)).toBeNull();
  });

  it("VR20: an adjust with toPlace also set is garbled (AJ16: an adjust never carries a destination)", () => {
    const parsed = parseCommand("extend Sam's block by an hour");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const both = {
      ...(parsed.command as unknown as Record<string, unknown>),
      toPlace: ["Cell 2"],
    };
    expect(decodeCommand(both)).toBeNull();
  });

  it("VR20: by = 0 is garbled (AJ5: never a no-op)", () => {
    const parsed = parseCommand("move Sam on Cell 1 in Line 1 to Cell 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const zero = {
      ...(parsed.command as unknown as Record<string, unknown>),
      toPlace: null,
      adjust: { edge: "end", by: 0 },
    };
    expect(decodeCommand(zero)).toBeNull();
  });

  it("VR20: an adjust naming both by and at, or neither, is garbled", () => {
    const parsed = parseCommand("move Sam on Cell 1 in Line 1 to Cell 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const base = { ...(parsed.command as unknown as Record<string, unknown>), toPlace: null };
    expect(
      decodeCommand({ ...base, adjust: { edge: "end", by: 60, at: { hour: 9, minute: 0 } } }),
    ).toBeNull();
    expect(decodeCommand({ ...base, adjust: { edge: "end" } })).toBeNull();
  });

  it("VR20: move's schema branch requires adjust, and $defs.adjust is the two-variant union (by non-zero, at a clock_time)", () => {
    type JsonSchemaNode = {
      $ref?: string;
      properties?: Record<string, unknown>;
      required?: string[];
      oneOf?: JsonSchemaNode[];
    };
    const root = formSchema as { $defs: Record<string, JsonSchemaNode> };
    expect(root.$defs.move.required).toContain("adjust");
    expect(root.$defs.move.properties?.adjust).toEqual({
      oneOf: [{ type: "null" }, { $ref: "#/$defs/adjust" }],
    });
    const variants = root.$defs.adjust.oneOf ?? [];
    expect(variants).toHaveLength(2);
    const byVariant = variants.find((v) => v.required?.includes("by"));
    const atVariant = variants.find((v) => v.required?.includes("at"));
    expect(byVariant?.properties?.by).toEqual({ type: "integer", not: { const: 0 } });
    expect(atVariant?.properties?.at).toEqual({ $ref: "#/$defs/clock_time" });
  });
});

// S58 (R-413, design section 19.103/D132 item 2): "split Sam's block at
// noon" -- board-answered like replace/swap/copy, never inside a several.
describe("VR21 (S58, R-413): split decodes", () => {
  it('VR21: a well-formed split ("split Sam on Cell 1 at 12 today") round-trips through decodeCommand', () => {
    const parsed = parseCommand("split Sam on Cell 1 at 12 today");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command.intent).toBe("split");
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it('VR21: place may be empty ("split Sam\'s block at noon")', () => {
    const parsed = parseCommand("split Sam's block at noon");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.command.intent !== "split") return;
    expect(parsed.command.place).toEqual([]);
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it("VR21: a missing at is garbled", () => {
    const parsed = parseCommand("split Sam's block at noon");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    delete valid.at;
    expect(decodeCommand(valid)).toBeNull();
  });

  it("VR21: extra top-level keys are ignored on a split", () => {
    const parsed = parseCommand("split Sam's block at noon");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    const withExtras = { ...valid, unexpectedTopLevel: "surprise" };
    expect(decodeCommand(withExtras)).toEqual(parsed.command);
  });

  it("VR21: a split inside a several garbles the whole several (D130 item 2, widened by S58)", () => {
    const assignParsed = parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2");
    expect(assignParsed.ok).toBe(true);
    const splitParsed = parseCommand("split Sam's block at noon");
    expect(splitParsed.ok).toBe(true);
    if (!assignParsed.ok || !splitParsed.ok) return;
    const assignForm: unknown = JSON.parse(JSON.stringify(assignParsed.command));
    const splitForm: unknown = JSON.parse(JSON.stringify(splitParsed.command));
    expect(decodeCommand({ intent: "several", commands: [assignForm, splitForm] })).toBeNull();
  });
});

// S58 (R-415, design section 19.103/D132 item 4): "make the Housing A job on
// Cell 1 4 people" -- one existing write, never inside a several.
describe("VR22 (S58, R-415): headcount decodes", () => {
  it('VR22: a well-formed headcount ("make the Housing A job on Cell 1 4 people") round-trips through decodeCommand', () => {
    const parsed = parseCommand("make the Housing A job on Cell 1 4 people");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command.intent).toBe("headcount");
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it("VR22: a headcount naming a span and a shift both round-trip through decodeCommand", () => {
    const spanParsed = parseCommand("make the Housing A job on Cell 1 today from 8 to 4 4 people");
    expect(spanParsed.ok).toBe(true);
    if (spanParsed.ok) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(spanParsed.command));
      expect(decodeCommand(roundTripped)).toEqual(spanParsed.command);
    }

    const shiftParsed = parseCommand("make the Housing A job on Cell 1 for shift 2 3 people");
    expect(shiftParsed.ok).toBe(true);
    if (shiftParsed.ok) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(shiftParsed.command));
      expect(decodeCommand(roundTripped)).toEqual(shiftParsed.command);
    }
  });

  it("VR22: headcount 0 and headcount 100 are both garbled (HC6/HC7's own bound)", () => {
    const parsed = parseCommand("make the Housing A job on Cell 1 4 people");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    expect(decodeCommand({ ...valid, headcount: 0 })).toBeNull();
    expect(decodeCommand({ ...valid, headcount: 100 })).toBeNull();
  });

  it("VR22: a missing headcount key is garbled", () => {
    const parsed = parseCommand("make the Housing A job on Cell 1 4 people");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    delete valid.headcount;
    expect(decodeCommand(valid)).toBeNull();
  });

  it("VR22: naming both a span and a shift is garbled", () => {
    const parsed = parseCommand("make the Housing A job on Cell 1 4 people");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const both = {
      ...(parsed.command as unknown as Record<string, unknown>),
      span: { start: { hour: 8, minute: 0 }, end: { hour: 16, minute: 0 } },
      shift: "2",
    };
    expect(decodeCommand(both)).toBeNull();
  });

  it("VR22: an empty place is garbled (a headcount always names the run's own cell)", () => {
    const parsed = parseCommand("make the Housing A job on Cell 1 4 people");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const empty = { ...(parsed.command as unknown as Record<string, unknown>), place: [] };
    expect(decodeCommand(empty)).toBeNull();
  });

  it("VR22: a headcount inside a several garbles the whole several (never part of a lot)", () => {
    const assignParsed = parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2");
    expect(assignParsed.ok).toBe(true);
    const headcountParsed = parseCommand("make the Housing A job on Cell 1 4 people");
    expect(headcountParsed.ok).toBe(true);
    if (!assignParsed.ok || !headcountParsed.ok) return;
    const assignForm: unknown = JSON.parse(JSON.stringify(assignParsed.command));
    const headcountForm: unknown = JSON.parse(JSON.stringify(headcountParsed.command));
    expect(decodeCommand({ intent: "several", commands: [assignForm, headcountForm] })).toBeNull();
  });

  it("VR22: the headcount schema branch bounds headcount 1-99 and requires exactly the form's keys", () => {
    type JsonSchemaNode = { properties?: Record<string, unknown>; required?: string[] };
    const root = formSchema as { $defs: Record<string, JsonSchemaNode> };
    const branch = root.$defs.headcount;
    expect(branch.properties?.headcount).toEqual({ type: "integer", minimum: 1, maximum: 99 });
    expect([...(branch.required ?? [])].sort()).toEqual(
      ["day", "headcount", "intent", "place", "product", "shift", "span"].sort(),
    );
  });
});

// S58 (R-416, design section 19.103/D132 item 5): "every weekday this week" /
// "every day next week" -- two REPEAT day kinds, legal ONLY on an assign's or
// a book's own `day` (the house rule the brief calls out explicitly: the
// schema is the fence, and must be exactly as strict as the decoder).
describe("VR23 (S58, R-416): a repeat day word decodes only on assign/book's own day", () => {
  it('VR23: "weekdays" on an assign round-trips through decodeCommand', () => {
    const parsed = parseCommand("assign Sam to Housing A on Cell 1 every weekday this week 8 to 4");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.command.intent !== "assign") return;
    expect(parsed.command.day).toEqual({ kind: "weekdays", week: "this_week" });
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it('VR23: "every_day" on a book round-trips through decodeCommand', () => {
    const parsed = parseCommand("book Housing A on Cell 2 every day next week 6 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.command.intent !== "book") return;
    expect(parsed.command.day).toEqual({ kind: "every_day", week: "next_week" });
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it("VR23: a repeat day on an unassign's day is garbled", () => {
    const parsed = parseCommand("unassign Sam from Cell 1 in Line 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    expect(decodeCommand({ ...valid, day: { kind: "weekdays", week: "this_week" } })).toBeNull();
  });

  it("VR23: a repeat day on an unassign's until is garbled", () => {
    const parsed = parseCommand("unassign Sam from Cell 1 in Line 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    expect(decodeCommand({ ...valid, until: { kind: "every_day", week: "this_week" } })).toBeNull();
  });

  it("VR23: a repeat day on a move's, a replace's, a swap's or a split's day is garbled", () => {
    const moveParsed = parseCommand("move Sam on Cell 1 in Line 1 to Cell 2");
    expect(moveParsed.ok).toBe(true);
    if (moveParsed.ok) {
      const valid = JSON.parse(JSON.stringify(moveParsed.command)) as Record<string, unknown>;
      expect(decodeCommand({ ...valid, day: { kind: "weekdays", week: "next_week" } })).toBeNull();
    }

    const replaceParsed = parseCommand("cover Sam with Ana on Cell 1 today");
    expect(replaceParsed.ok).toBe(true);
    if (replaceParsed.ok) {
      const valid = JSON.parse(JSON.stringify(replaceParsed.command)) as Record<string, unknown>;
      expect(decodeCommand({ ...valid, day: { kind: "every_day", week: "this_week" } })).toBeNull();
    }

    const swapParsed = parseCommand("swap Sam and Ana");
    expect(swapParsed.ok).toBe(true);
    if (swapParsed.ok) {
      const valid = JSON.parse(JSON.stringify(swapParsed.command)) as Record<string, unknown>;
      expect(decodeCommand({ ...valid, day: { kind: "weekdays", week: "this_week" } })).toBeNull();
    }

    const splitParsed = parseCommand("split Sam on Cell 1 at 12 today");
    expect(splitParsed.ok).toBe(true);
    if (splitParsed.ok) {
      const valid = JSON.parse(JSON.stringify(splitParsed.command)) as Record<string, unknown>;
      expect(decodeCommand({ ...valid, day: { kind: "every_day", week: "next_week" } })).toBeNull();
    }
  });

  it("VR23: the schema itself admits repeat_day_word only on assign.day and book.day -- week_word never joins it there", () => {
    type JsonSchemaNode = {
      $ref?: string;
      properties?: Record<string, unknown>;
      oneOf?: JsonSchemaNode[];
    };
    const root = formSchema as { $defs: Record<string, JsonSchemaNode> };

    const repeatKinds = (root.$defs.repeat_day_word.oneOf ?? [])
      .map((n) => (n.properties?.kind as { const?: string } | undefined)?.const)
      .sort();
    expect(repeatKinds).toEqual(["every_day", "weekdays"]);

    for (const name of ["assign", "book"]) {
      const dayProp = root.$defs[name].properties?.day as { oneOf?: JsonSchemaNode[] } | undefined;
      const refs = (dayProp?.oneOf ?? []).map((n) => n.$ref).filter((r): r is string => !!r);
      expect(refs, `${name}.day`).toEqual(["#/$defs/day_word", "#/$defs/repeat_day_word"]);
    }
    for (const name of ["unassign", "move", "replace", "swap", "split"]) {
      const dayProp = root.$defs[name].properties?.day as { oneOf?: JsonSchemaNode[] } | undefined;
      const refs = (dayProp?.oneOf ?? []).map((n) => n.$ref).filter((r): r is string => !!r);
      expect(refs, `${name}.day`).toEqual(["#/$defs/day_word"]);
    }
    const untilProp = root.$defs.unassign.properties?.until as
      { oneOf?: JsonSchemaNode[] } | undefined;
    const untilRefs = (untilProp?.oneOf ?? []).map((n) => n.$ref).filter((r): r is string => !!r);
    expect(untilRefs).toEqual(["#/$defs/day_word"]);
  });
});

// S59 (docs/agent-briefs/s59-b-bar-brief.md §1, F-149): every NAME string
// (operator, product, with, other, every element of place/toPlace, a
// non-null shift) must hold at least one letter or digit -- a name made of
// pure punctuation is garbled, the same as any other malformed field.
describe("VR24 (S59, F-149): a name made of punctuation is garbled", () => {
  it('VR24: the assign probe -- place ["],", "product"] is garbled', () => {
    const parsed = parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    const garbled = { ...valid, place: ["],", "product"] };
    expect(decodeCommand(garbled)).toBeNull();
  });

  it('VR24: the headcount probe -- place ["],"] is garbled', () => {
    const parsed = parseCommand("make the Housing A job on Cell 1 4 people");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    const garbled = { ...valid, place: ["],"] };
    expect(decodeCommand(garbled)).toBeNull();
  });

  it('VR24: place ["Cell 1"] and shift "2" are not garbled', () => {
    const parsed = parseCommand("assign Sam to Housing A on Cell 1 for shift 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.command));
    expect(decodeCommand(roundTripped)).toEqual(parsed.command);
  });

  it('VR24: a person named "A-3" is fine (a letter is enough)', () => {
    const parsed = parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    const named = { ...valid, operator: "A-3" };
    expect(decodeCommand(named)).toEqual({ ...parsed.command, operator: "A-3" });
  });

  it("VR24: a punctuation-only operator, product, with, other or toPlace element is garbled", () => {
    const assignParsed = parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2");
    expect(assignParsed.ok).toBe(true);
    if (assignParsed.ok) {
      const valid = JSON.parse(JSON.stringify(assignParsed.command)) as Record<string, unknown>;
      expect(decodeCommand({ ...valid, operator: "],#" })).toBeNull();
      expect(decodeCommand({ ...valid, product: "--" })).toBeNull();
    }

    const replaceParsed = parseCommand("cover Sam with Ana on Cell 1 today");
    expect(replaceParsed.ok).toBe(true);
    if (replaceParsed.ok) {
      const valid = JSON.parse(JSON.stringify(replaceParsed.command)) as Record<string, unknown>;
      expect(decodeCommand({ ...valid, with: "!!" })).toBeNull();
    }

    const swapParsed = parseCommand("swap Sam and Ana");
    expect(swapParsed.ok).toBe(true);
    if (swapParsed.ok) {
      const valid = JSON.parse(JSON.stringify(swapParsed.command)) as Record<string, unknown>;
      expect(decodeCommand({ ...valid, other: "()" })).toBeNull();
    }

    const moveParsed = parseCommand("move Sam on Cell 1 in Line 1 to Cell 2");
    expect(moveParsed.ok).toBe(true);
    if (moveParsed.ok) {
      const valid = JSON.parse(JSON.stringify(moveParsed.command)) as Record<string, unknown>;
      expect(decodeCommand({ ...valid, toPlace: ["Cell 2", "]"] })).toBeNull();
    }
  });

  it("VR24: an empty place ([] for unassign/move) still decodes -- the name check only judges PRESENT elements", () => {
    const unassignParsed = parseCommand("unassign Sam from Cell 1 in Line 1 from 10 to 2");
    expect(unassignParsed.ok).toBe(true);
    if (!unassignParsed.ok) return;
    const unassignForm = { ...(unassignParsed.command as unknown as Record<string, unknown>) };
    unassignForm.place = [];
    expect(decodeCommand(unassignForm)).toEqual({ ...unassignParsed.command, place: [] });
  });

  it("VR24: any script's letter counts -- a Unicode name is not garbled", () => {
    const parsed = parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    const named = { ...valid, operator: "李四" };
    expect(decodeCommand(named)).toEqual({ ...parsed.command, operator: "李四" });
  });

  // VR25 (reviewer follow-up): three shapes the S59 fence description warned
  // about -- an empty string mixed into an otherwise-present place array, an
  // empty shift, and a product made of nothing but emoji. The first two keep
  // their PRE-S59 contract exactly (an empty string was already refused by
  // `isNonEmptyString`, before F-149 existed, so `isValidName`'s narrower
  // check changes nothing here); the third is new -- `hasLetterOrDigit`
  // refuses an emoji-only string the same way it refuses pure punctuation
  // (`\p{L}`/`\p{N}` do not match emoji code points), so F-149's fix also
  // closes this door, not asked for by the card but a direct consequence of
  // "holds no letter or digit" rather than "holds no letter, digit or
  // emoji".
  it('VR25: place ["Cell 1", ""] stays garbled -- an empty element already failed before F-149, unchanged', () => {
    const parsed = parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    expect(decodeCommand({ ...valid, place: ["Cell 1", ""] })).toBeNull();
  });

  it('VR25: shift "" stays garbled -- an empty shift already failed before F-149, unchanged', () => {
    const parsed = parseCommand("assign Sam to Housing A on Cell 1 for shift 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    expect(decodeCommand({ ...valid, shift: "" })).toBeNull();
  });

  it("VR25: a product made only of emoji is garbled -- no letter or digit, the same as pure punctuation", () => {
    const parsed = parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    expect(decodeCommand({ ...valid, product: "🎉🎉" })).toBeNull();
  });
});

// S59-e (R-421, brief docs/agent-briefs/s59-e-trace-brief.md §2): `makeReader`'s
// own `raw` field on `Reading` -- reviewer follow-up, since nothing in this
// file exercised the new field's actual VALUE (only VR4/VR5/VR7's `toEqual`
// on the reason/no-raw shapes, which happen not to touch it). Pins every
// branch the brief's own doc comment names: `ok: true` and the three
// garbled-with-a-body cases carry it; a garbled answer with no body (no
// message content, or a response that failed to parse as JSON at all) does
// not.
describe("VR26 (S59-e, R-421): readSentence.ts's own `raw` field on Reading", () => {
  it('VR26: ok: true carries "raw" -- the content the model actually sent, verbatim', async () => {
    const parsed = parseCommand(SENTENCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const content = JSON.stringify(parsed.command);
    const reader = makeReader({
      baseUrl: "http://voice.local",
      fetch: fetchReturningContent(content),
    });
    const result = await reader(SENTENCE, new AbortController().signal);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.raw).toBe(content);
  });

  it('VR26: "no JSON object in content" carries raw (the content itself)', async () => {
    const content = "no object in here at all";
    const reader = makeReader({
      baseUrl: "http://voice.local",
      fetch: fetchReturningContent(content),
    });
    const result = await reader(SENTENCE, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("garbled");
      expect(result.raw).toBe(content);
    }
  });

  it("VR26: bad JSON in the content carries raw (the content itself)", async () => {
    const content = "{intent: assign}";
    const reader = makeReader({
      baseUrl: "http://voice.local",
      fetch: fetchReturningContent(content),
    });
    const result = await reader(SENTENCE, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("garbled");
      expect(result.raw).toBe(content);
    }
  });

  it("VR26: a well-formed object decodeCommand refuses still carries raw", async () => {
    const content = '{"intent":"assign"}';
    const reader = makeReader({
      baseUrl: "http://voice.local",
      fetch: fetchReturningContent(content),
    });
    const result = await reader(SENTENCE, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("garbled");
      expect(result.raw).toBe(content);
    }
  });

  it('VR26: "no message content" (no choices[0].message.content string) carries NO raw', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }),
      ) as unknown as typeof fetch;
    const reader = makeReader({ baseUrl: "http://voice.local", fetch: fetchMock });
    const result = await reader(SENTENCE, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("garbled");
      expect(result.raw).toBeUndefined();
    }
  });

  it("VR26: a response body that fails to parse as JSON at all carries NO raw", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const reader = makeReader({ baseUrl: "http://voice.local", fetch: fetchMock });
    const result = await reader(SENTENCE, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("garbled");
      expect(result.raw).toBeUndefined();
    }
  });
});

// S60-b (docs/agent-briefs/s60-b-which-part-brief.md §2, R-422): `product`
// may decode as the empty string on `assign`, `book` and `headcount` ONLY --
// "no part was said, the resolver asks which" -- and F-149's letter-or-digit
// rule keeps applying the moment the string is non-empty.
describe("VR27 (S60-b, R-422): product may be '' on assign, book and headcount only", () => {
  it("VR27: an empty product decodes on assign", () => {
    const parsed = parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    expect(decodeCommand({ ...valid, product: "" })).toEqual({ ...parsed.command, product: "" });
  });

  it("VR27: an empty product decodes on book", () => {
    const parsed = parseCommand("book Housing A on Cell 1 from 6 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    expect(decodeCommand({ ...valid, product: "" })).toEqual({ ...parsed.command, product: "" });
  });

  it("VR27: an empty product decodes on headcount", () => {
    const parsed = parseCommand("make the Housing A job on Cell 1 4 people");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    expect(decodeCommand({ ...valid, product: "" })).toEqual({ ...parsed.command, product: "" });
  });

  it("VR27: a non-empty punctuation-only product still garbles book and headcount (F-149 keeps applying)", () => {
    const bookParsed = parseCommand("book Housing A on Cell 1 from 6 to 2");
    expect(bookParsed.ok).toBe(true);
    if (bookParsed.ok) {
      const valid = JSON.parse(JSON.stringify(bookParsed.command)) as Record<string, unknown>;
      expect(decodeCommand({ ...valid, product: "--" })).toBeNull();
    }

    const hcParsed = parseCommand("make the Housing A job on Cell 1 4 people");
    expect(hcParsed.ok).toBe(true);
    if (hcParsed.ok) {
      const valid = JSON.parse(JSON.stringify(hcParsed.command)) as Record<string, unknown>;
      expect(decodeCommand({ ...valid, product: "--" })).toBeNull();
    }
  });

  it("VR27: an empty product does NOT widen any other name field -- operator, place elements and shift still require a letter or digit", () => {
    const parsed = parseCommand("assign Sam to Housing A on Cell 1 from 10 to 2");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const valid = JSON.parse(JSON.stringify(parsed.command)) as Record<string, unknown>;
    expect(decodeCommand({ ...valid, operator: "" })).toBeNull();
    expect(decodeCommand({ ...valid, place: [""] })).toBeNull();
  });
});
