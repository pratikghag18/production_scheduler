"""score_port.py -- a Python port of `scripts/voice/lib/score.mjs`'s
arithmetic (S43-a brief §3), so the Colab notebook can print a table without
a Node.js runtime, and so the maintainer can double-check the notebook's
number against `npm run voice:score` from a plain shell:

    python scripts/voice/train/score_port.py <heldout.jsonl> <predictions.jsonl> [--bar 0.95]

`<predictions.jsonl>` is rows `{"id": "<heldout id>", "form": <parsed JSON or
null>}` -- the exact shape `scripts/voice/score.mjs --predictions` reads
(S43-a brief §2). This file has no third-party imports: it must run inside a
freshly-created Colab runtime before any training package is installed, and
it must `python -m py_compile` clean on a machine with only the standard
library (this repo's build machine has neither `torch` nor `transformers`).

Importable from the notebook as `import score_port` (same directory) --
`canonical`, `score`, `rate`, `load_jsonl`, `print_table` are the pieces it
calls directly rather than re-deriving.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Callable, Dict, List, Optional


def sort_keys_deep(value: Any) -> Any:
    """Mirrors `form.mjs`'s `sortKeysDeep`: recursively sorts every object's
    keys so two structurally-equal forms serialise identically regardless of
    the key order they were built or parsed in."""
    if isinstance(value, list):
        return [sort_keys_deep(v) for v in value]
    if isinstance(value, dict):
        return {k: sort_keys_deep(value[k]) for k in sorted(value.keys())}
    return value


def canonical(form: Any) -> str:
    """Mirrors `form.mjs`'s `canonical`: JSON text with every object's keys
    sorted, and JS's `JSON.stringify` compactness (no spaces) so the text a
    Python-side form produces is byte-for-byte the same as the JS side's,
    given the same value."""
    return json.dumps(sort_keys_deep(form), separators=(",", ":"), ensure_ascii=False)


def load_jsonl(path: str) -> List[Dict[str, Any]]:
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def _empty_bucket() -> Dict[str, int]:
    return {"n": 0, "correct": 0}


def score(
    rows: List[Dict[str, Any]], predict: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]
) -> Dict[str, Any]:
    """Mirrors `lib/score.mjs`'s `score(rows, predict)` field for field,
    including the one asymmetry in the original: the overall/per-intent
    correctness check compares `canonical()` (sorted keys), but the
    per-field check compares plain `JSON.stringify` (insertion order) --
    ported here as plain `json.dumps` with no key sorting, to match."""
    clean = _empty_bucket()
    perturbed = _empty_bucket()
    by_intent: Dict[str, Dict[str, Dict[str, int]]] = {}
    by_field: Dict[str, Dict[str, int]] = {}

    for row in rows:
        overall = clean if row["clean"] else perturbed
        overall["n"] += 1

        predicted = predict(row)
        is_correct = predicted is not None and canonical(predicted) == canonical(row["form"])
        if is_correct:
            overall["correct"] += 1

        intent_bucket = by_intent.setdefault(
            row["intent"], {"clean": _empty_bucket(), "perturbed": _empty_bucket()}
        )
        intent_side = intent_bucket["clean"] if row["clean"] else intent_bucket["perturbed"]
        intent_side["n"] += 1
        if is_correct:
            intent_side["correct"] += 1

        same_intent = predicted is not None and predicted.get("intent") == row["intent"]
        for field in row["form"].keys():
            field_bucket = by_field.setdefault(field, _empty_bucket())
            field_bucket["n"] += 1
            if same_intent and json.dumps(predicted.get(field)) == json.dumps(row["form"][field]):
                field_bucket["correct"] += 1

    return {"clean": clean, "perturbed": perturbed, "byIntent": by_intent, "byField": by_field}


def rate(bucket: Dict[str, int]) -> float:
    return 1.0 if bucket["n"] == 0 else bucket["correct"] / bucket["n"]


def pct(n: float) -> str:
    return f"{n * 100:.1f}%"


def print_table(result: Dict[str, Any]) -> None:
    print("\nOverall:")
    print(
        f"  clean:     {result['clean']['correct']}/{result['clean']['n']}  ({pct(rate(result['clean']))})"
    )
    print(
        f"  perturbed: {result['perturbed']['correct']}/{result['perturbed']['n']}  ({pct(rate(result['perturbed']))})"
    )

    print("\nBy intent:")
    for intent, bucket in result["byIntent"].items():
        print(
            f"  {intent.ljust(10)} clean {str(bucket['clean']['correct']).rjust(3)}/{str(bucket['clean']['n']).ljust(3)} ({pct(rate(bucket['clean']))})"
            f"   perturbed {str(bucket['perturbed']['correct']).rjust(3)}/{str(bucket['perturbed']['n']).ljust(3)} ({pct(rate(bucket['perturbed']))})"
        )

    print("\nBy field:")
    for field, bucket in result["byField"].items():
        print(f"  {field.ljust(12)} {bucket['correct']}/{bucket['n']}  ({pct(rate(bucket))})")
    print("")


def predictions_predict(
    predictions_path: str,
) -> Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]:
    rows = load_jsonl(predictions_path)
    by_id = {r["id"]: r.get("form") for r in rows}

    def predict(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        return by_id.get(row["id"])

    return predict


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("heldout", help="path to heldout.jsonl")
    parser.add_argument("predictions", help="path to a predictions.jsonl (rows {id, form})")
    parser.add_argument("--bar", type=float, default=0.95, help="minimum clean rate (default 0.95)")
    args = parser.parse_args(argv)

    rows = load_jsonl(args.heldout)
    predict = predictions_predict(args.predictions)
    result = score(rows, predict)
    print_table(result)

    clean_rate = rate(result["clean"])
    print(f"clean rate {pct(clean_rate)} vs bar {pct(args.bar)}")
    if clean_rate < args.bar:
        print(f"FAIL: clean rate {pct(clean_rate)} is below the bar {pct(args.bar)}", file=sys.stderr)
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
