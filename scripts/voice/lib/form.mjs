// scripts/voice/lib/form.mjs — a stable text form for a `Command`, so two
// structurally-equal forms compare equal regardless of key order (S42-a §3).

// R-402 (S52-a, docs/agent-briefs/s52-a-shift-grammar-brief.md §2 item 5,
// closed by the S52-c data brief): every single command carries a `shift`
// field now, and `data/voice/heldout.jsonl` has been regenerated to carry
// it on every row -- the tolerance that used to read a MISSING `shift` key
// as an implicit `null` (for the committed set that predated the field) is
// gone. `canonical`/`equalForms` compare exactly what is there; a form
// missing `shift` is simply missing it, the same as any other field.
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
 *  `canonical({a:1,b:2})  === canonical({b:2,a:1})`. */
export function canonical(form) {
  return JSON.stringify(sortKeysDeep(form));
}

/** Structural equality of two forms, independent of key order. */
export function equalForms(a, b) {
  return canonical(a) === canonical(b);
}
