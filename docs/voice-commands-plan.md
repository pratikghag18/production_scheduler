# Talking to the board — plan

*Production Scheduler · brainstorm plan · 3 Sept 2026*

The goal: a scheduler says or types "Assign Operator 1 to Housing A on Cell 1 in Line 1 from 10 to 2" and the board does it, after showing what it is about to do. Behind it, a small open-source AI model that we fine-tune ourselves, runs on our own hardware, and later learns more commands.

## The one idea that makes this safe

The board already has one door for every assignment: the server function that today's Save button calls. It checks training, area, overlaps, and permissions, and refuses with a reason. Nothing in this plan adds a second door. Voice, typing, and the AI model only *fill in the same form* that the popover fills in today, and the server keeps the final say. The model can be wrong; it cannot break a rule.

So the pipeline is:

```
 speech ──► text ──► small model ──► form (who / what / where / when)
                                          │
                                          ▼
                              app matches names to real records
                              (Operator 1 → this operator's id, etc.)
                                          │
                                          ▼
                              confirmation chip on the board  ── "yes" ──► create_assignment
```

The typed version and the spoken version share everything after the first arrow, which is why the plan builds typing first.

## Is a small local model enough? Yes — with two clarifications

**1. "Train on the app and nothing else" means fine-tune, not train from scratch.** A model trained only on scheduler sentences would not know English: it would not know that "from 10 to 2" is a time span or that "put Sam on" means assign. The way to get what you want is to start from a small pretrained open model, which already knows English, and then teach it *only our job*: turning scheduler sentences into our form. The result is a model file that lives on your machine, was trained on your data, and does exactly one thing. That is what people mean in practice by "trained on the app", and it is very feasible.

**2. The model should not memorize your operators, products, or cells.** Every site has different names, and they change weekly. If the model learned "Operator 1" as a fact, you would retrain every time someone was hired. Instead the model writes down the *words it heard* — `operator: "Operator 1"`, `product: "Housing A"`, `cell: "Cell 1"`, `line: "Line 1"` — and the app matches those words against the board's real data. One model serves every site, and adding an operator needs no training.

With those two in place, the task is small: read one sentence, fill one form with five or six fields. This is close to the easiest thing a language model can do.

**Size.** A model of roughly 1 to 2 billion parameters is plenty; 0.5 billion is worth testing. For comparison, the models behind chat assistants are hundreds of times bigger. Concretely:

| Candidate base model | Size | Licence | Why it is on the list |
|---|---|---|---|
| Qwen2.5-1.5B-Instruct | 1.5B | Apache-2.0 | Strong at structured output for its size; licence matches the repo's |
| Qwen2.5-0.5B-Instruct | 0.5B | Apache-2.0 | Small enough to run inside the browser; test whether it is accurate enough |
| SmolLM2-1.7B-Instruct | 1.7B | Apache-2.0 | Built for exactly this "small and fine-tunable" niche |
| Llama-3.2-1B / 3B | 1–3B | Llama licence | Good models, but the licence is not Apache and adds terms to a public repo |

Licence matters because the repo is going public under Apache-2.0; a model with the same licence keeps the story simple. Speech recognition has the same shape: OpenAI's Whisper is open (MIT), the `base` and `small` sizes run on a laptop CPU, and it is much better in factory noise than the browser's built-in recognizer.

**Hardware.** Fine-tuning a 1.5B model with the standard cheap method (LoRA — it trains a thin layer on top and leaves the base untouched) takes well under an hour on a gaming GPU with 8–12 GB of memory, or on a free Google Colab session. Running it afterwards needs no GPU: compressed to 4-bit it is about a 1 GB file and answers a sentence in under a second on an ordinary CPU. It could run as a small service next to the database, or, at the 0.5B size, inside the browser tab itself (a one-time download of a few hundred MB).

**Accuracy to expect.** On sentences shaped like the ones it was trained on, 95–98% correct forms is realistic. The confirmation chip is what makes the remaining few percent harmless. The model never gets the last word.

**How much training data.** For the single "assign" command, two to five thousand example sentences with their correct forms. We do not write these by hand: a script combines sentence templates ("assign {op} to {product} on {cell} in {line} from {start} to {end}", "put {op} on {cell} {time}", "{op} does {product} {time} on {cell}") with the real kinds of names and times, adds spelling variants and speech-recognition-style slips ("housing eh"), and writes the answer alongside. As the typed command bar is used, real sentences that people actually typed are added to the set (their corrected forms come free from what the person confirmed). Each new command later (move, unassign, who is free) adds another one to two thousand.

## Stages, in the order to build them

Each stage ends the way every piece of work in this repo ends: tests, a plan.yaml entry, a commit. Estimates are working days.

**Stage 1 — Decide the forms.** Write down, in one file, the commands we will support and the exact form each one fills in. Start with one: *assign*. Sketch but do not build the next four so the form design does not paint us into a corner: *book a job* (a run on a cell), *move*, *unassign*, and *who is free at …*. Half a day. This is the stage where a decision from you shapes the product; the rest is building.

**Stage 2 — Command bar and confirmation, no AI yet.** A text box on the board. For this stage the sentence is read by a plain rule-based parser (it recognizes the fixed pattern "assign … to … on … in … from … to …" and nothing else). Its output goes through the *matcher*, which turns the words into records: exact name match, then fuzzy match, then a one-question prompt when two things match or nothing does ("Two operators called Sam — which one?"). Then the ghost chip appears where the assignment would land, with the plain readout, and Enter or "yes" calls the same server function the popover calls. Refusals show the same reasons and the same override buttons as today. If no job for that product exists on that cell at that time, the chip says so and offers to book the job and staff it in one go. Two to three days. This stage is usable on its own and is most of the value.

**Stage 3 — The training set and the test set.** The generator script described above, checked into `scripts/`, plus a *held-out test set* of a few hundred sentences the model never trains on. The test set is the instrument: every model we ever train is scored against it, and a score below the bar fails the build, the same way a lost test file fails `npm run test` today. Every sentence a person types into the command bar is saved (with the site's permission) to grow both sets. One to two days.

**Stage 4 — Fine-tune the first model.** Pick the base from the table, fine-tune with LoRA on the Stage 3 data, score it on the test set, and compare with the rule parser on the same set. Export to the compressed file format that the local runtime uses. Constrain the model's output to the form's exact shape at generation time, so it is physically unable to answer with anything but a valid form. One to two days including the false starts that training always has.

**Stage 5 — Serve it.** A small container running the model alongside the local database (Ollama or llama.cpp; both fit the "run it yourself" spirit of the project). The command bar sends the sentence there and gets the form back. If the service is down, the bar falls back to the rule parser and says so. Later, the 0.5B model can be tried inside the browser so there is nothing to run at all. One day.

**Stage 6 — The microphone.** A button next to the command bar. First version uses the browser's built-in recognizer (zero setup, fine in an office, sends audio to Google or Microsoft, which some sites will not accept). Second version runs Whisper locally through the same small service as the model, which keeps the audio in the building and handles noise. Half a day, then one day.

**Stage 7 — Widen.** Add the next command from Stage 1, generate its data, retrain, re-score. Repeat. Each command is roughly a day once the pipeline exists. This is also where "a bunch of other things" lives: any question or action that can be expressed as a form is the same recipe.

## What you would notice at each stage

After Stage 2 you can type the sentence and the board does it, with the same guardrails as clicking. After Stage 4 you can phrase it however you like. After Stage 6 you can say it. After Stage 7 you can say other things.

## Risks, in plain terms

*The floor is loud.* The browser recognizer will mishear on the floor; plan on the local Whisper version for real use, and always show the recognized text so a mishearing is visible before it is acted on.

*Times are ambiguous.* "10 to 2" on a night shift crosses midnight; "this afternoon" depends on the shift. The form carries the date the board is showing, and the confirmation readout always spells out the full date and time.

*The model is confidently wrong.* Caught by three layers: output constrained to the form's shape, the matcher refusing to guess between two candidates, and the confirmation chip. None of these are new rules; the server's rules stay exactly as they are.

*Training data drifts from real use.* Fixed by saving what people actually type and re-scoring every model on the growing test set.

*Public repo, private model.* The training script and the test set go in the repo; a trained model file is large and is published separately (a release download) or built by the user with one command. Nothing site-specific is in the training data because the model never sees real names.

## The decision that is yours

Which commands beyond *assign* matter most, and in what order. My guess is *book a job* (because the assign sentence often implies it), then *unassign*, then *move*, then *who is free*. If you would order it differently, that changes Stage 1 and nothing else.
