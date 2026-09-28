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

/**
 * DEF-0048 / R-409 (28 Sept): the one key the grammar's output may carry that
 * the model's recorded forms never do. `parseCommand` marks an absence
 * ("Sam Patel is off tomorrow") with `absence: "off"` on the unassign; the
 * mark is DERIVED FROM THE WORDS (the rules read them, and the bar marks the
 * model's reading from the heard words with `markAbsence`), and the model is
 * NOT taught it -- no retrain, no change to the decoder's schema, no
 * regenerated data file. So the oracle ignores this key, by name, on an
 * unassign form only. Nothing else is loosened: every other key, at every
 * depth, still compares exactly.
 */
const DERIVED_UNASSIGN_KEYS = new Set(["absence"]);

function withoutDerivedKeys(value) {
  if (Array.isArray(value)) return value.map(withoutDerivedKeys);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      if (value.intent === "unassign" && DERIVED_UNASSIGN_KEYS.has(key)) continue;
      out[key] = withoutDerivedKeys(value[key]);
    }
    return out;
  }
  return value;
}

/** Structural equality of two forms, independent of key order -- and of the
 *  one derived key above. */
export function equalForms(a, b) {
  return canonical(withoutDerivedKeys(a)) === canonical(withoutDerivedKeys(b));
}
