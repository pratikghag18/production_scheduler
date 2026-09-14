"""check_notebook.py -- S43-a acceptance SS6.3: extracts every code cell of
`train_qwen3.ipynb` into one temp `.py` file, in order, and runs
`python -m py_compile` on it. Compilation checks syntax only (it does not
run the cells, and does not need `torch` or `transformers` importable) --
this is the one check that can run on a machine with no GPU and neither
package installed.

    python scripts/voice/train/check_notebook.py [path/to/notebook.ipynb]
"""

import json
import py_compile
import sys
import tempfile
from pathlib import Path

DEFAULT_NOTEBOOK = Path(__file__).parent / "train_qwen3.ipynb"


def extract_code(notebook_path: Path) -> str:
    with open(notebook_path, "r", encoding="utf-8") as f:
        nb = json.load(f)
    parts = []
    for i, cell in enumerate(nb["cells"]):
        if cell["cell_type"] != "code":
            continue
        source = "".join(cell["source"])
        parts.append(f"# --- cell {i} ---\n{source}\n")
    return "\n".join(parts)


def main(argv):
    notebook_path = Path(argv[0]) if argv else DEFAULT_NOTEBOOK
    code = extract_code(notebook_path)

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False, encoding="utf-8"
    ) as tmp:
        tmp.write(code)
        tmp_path = tmp.name

    try:
        py_compile.compile(tmp_path, doraise=True)
    except py_compile.PyCompileError as exc:
        print(f"FAIL: {notebook_path} does not compile:\n{exc}", file=sys.stderr)
        return 1
    finally:
        Path(tmp_path).unlink(missing_ok=True)
        cache = Path(tmp_path + "c")
        cache.unlink(missing_ok=True)

    print(f"PASS: every code cell of {notebook_path} compiles ({len(code.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
