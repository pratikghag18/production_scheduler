// scripts/voice/lib/form.mjs — a stable text form for a `Command`, so two
// structurally-equal forms compare equal regardless of key order (S42-a §3).

// R-402 (S52-a, docs/agent-briefs/s52-a-shift-grammar-brief.md §2 item 5):
// every single command gained a `shift` field, but the COMMITTED
// `data/voice/heldout.jsonl` predates it -- none of its forms carry the key
// at all. Regenerating that file is the data lane's own job (a later
// brief), so here, the one comparison point every caller shares, a missing
// `shift` on a single-command-shaped object is read the same as an explicit
// `shift: null` ("no shift"), so an old row and a freshly parsed command
// that both mean "no shift" still compare equal.
const SINGLE_COMMAND_INTENTS = new Set(["assign", "book", "unassign", "move"]);

function withDefaultShift(value) {
  if (Array.isArray(value)) return value.map(withDefaultShift);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = withDefaultShift(value[key]);
    if (SINGLE_COMMAND_INTENTS.has(out.intent) && !("shift" in out)) out.shift = null;
    return out;
  }
  return value;
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/** JSON text for `form` with every object's keys sorted, recursively --
 *  `canonical({a:1,b:2})  === canonical({b:2,a:1})`. A missing `shift` on a
 *  single command reads as `shift: null` (S52-a, see the comment above). */
export function canonical(form) {
  return JSON.stringify(sortKeysDeep(withDefaultShift(form)));
}

/** Structural equality of two forms, independent of key order. */
export function equalForms(a, b) {
  return canonical(a) === canonical(b);
}
