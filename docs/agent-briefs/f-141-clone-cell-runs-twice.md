# Brief F-141: the notebook's Setup cell fails when it runs a second time in one runtime

## What went wrong

`scripts/voice/train/train_qwen3.ipynb`, Setup cell: the llama.cpp clone

```python
subprocess.run(
    ["git", "clone", "--depth", "1", "https://github.com/ggml-org/llama.cpp.git", "/content/llama.cpp"],
    check=True,
)
```

is not idempotent. On a second run of the cell in the same runtime the folder exists, git
answers `fatal: destination path '/content/llama.cpp' already exists and is not an empty
directory`, exit 128, and `check=True` raises `CalledProcessError`. The maintainer hit this on
13 Sept 2026 starting run two. Every other step in that cell (pip installs) is safe to repeat;
this one is not.

## What to change (and only this)

1. In the Setup cell, guard the clone: if `/content/llama.cpp/convert_hf_to_gguf.py` already
   exists, print one line (`llama.cpp already present at /content/llama.cpp; not cloning again`)
   and skip; otherwise clone as now. Use `os.path.exists`; `os` is imported at the top of the
   cell already (check; if not, add it beside the other imports). Keep the long comment above the
   clone; add one sentence to it saying the guard exists because the cell must survive being run
   twice in one runtime (F-141).
2. Also capture the failure text so the next such error is readable in the notebook output: pass
   `capture_output=True, text=True` and, on a non-zero return, `raise SystemExit(f"git clone
   failed ({r.returncode}):\n{r.stderr}")`. Do NOT swallow the error.
3. `scripts/voice/train/README.md`: under the troubleshooting list (the numbered "first run"
   findings near the bottom), add item for F-141: the Setup cell may be run again in the same
   runtime; it skips the clone when the folder is there. Two sentences.
4. Run `python scripts/voice/train/check_notebook.py` (it validates the notebook JSON and cell
   contents) and paste its output in your report. If python is not on PATH here, `py -3` is.

## Rules

- Edit the notebook JSON in place with a small node script or python; do not rewrite the file
  wholesale. The notebook's other cells must be byte-identical afterwards: confirm with
  `git diff --stat` (one file, a handful of lines) and say so in your report.
- Files you own: `scripts/voice/train/train_qwen3.ipynb`, `scripts/voice/train/README.md`.
  Nothing else. Do not touch `docs/plan.yaml`; the developer session records the finding.
- Do not run `npm run test`. Do not commit.
- Report: the diff of the notebook cell as plain text, the README lines, the check_notebook
  output, and the `git diff --stat` line.
