# Talking to the board — plan

_Production Scheduler · brainstorm plan · 3 Sept 2026, revised the same day with the chatbot and packaging_

> **As built (11 Sept 2026, session 139).** Stage 2 is stage `S40` in `docs/plan.yaml`
> (requirements R-378 to R-383), built from `docs/agent-briefs/p1-7a-typed-command-bar-brief.md`.
> Two things changed from the text below when the maintainer read it: the command bar ASKS when the
> span lands inside a job already booked for that part on that cell (join it, or a separate block —
> R-383), rather than always making a direct block; and the order of the commands after _assign_ is
> book a job, unassign, move, with "who is free" moved to the chatbot's lookup menu because it is a
> question, not an action. This document stays the archive of _why_; the plan is where things stand.

The goal: a scheduler says or types "Assign Operator 1 to Housing A on Cell 1 in Line 1 from 10 to 2" and the board does it, after showing what it is about to do. Behind it, a small open-source AI model that we fine-tune ourselves, runs on our own hardware, and later learns more commands.

## The one idea that makes this safe

The board already has one door for every assignment: the server function that today's Save button calls. It checks training, area, overlaps, and permissions, and refuses with a reason. Nothing in this plan adds a second door. Voice, typing, and the AI model only _fill in the same form_ that the popover fills in today, and the server keeps the final say. The model can be wrong; it cannot break a rule.

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

**1. "Train on the app and nothing else" means fine-tune, not train from scratch.** A model trained only on scheduler sentences would not know English: it would not know that "from 10 to 2" is a time span or that "put Sam on" means assign. The way to get what you want is to start from a small pretrained open model, which already knows English, and then teach it _only our job_: turning scheduler sentences into our form. The result is a model file that lives on your machine, was trained on your data, and does exactly one thing. That is what people mean in practice by "trained on the app", and it is very feasible.

**2. The model should not memorize your operators, products, or cells.** Every site has different names, and they change weekly. If the model learned "Operator 1" as a fact, you would retrain every time someone was hired. Instead the model writes down the _words it heard_ — `operator: "Operator 1"`, `product: "Housing A"`, `cell: "Cell 1"`, `line: "Line 1"` — and the app matches those words against the board's real data. One model serves every site, and adding an operator needs no training.

With those two in place, the task is small: read one sentence, fill one form with five or six fields. This is close to the easiest thing a language model can do.

**Size.** A model of roughly 1 to 2 billion parameters is plenty; 0.5 billion is worth testing. For comparison, the models behind chat assistants are hundreds of times bigger. Concretely:

| Candidate base model  | Size | Licence       | Why it is on the list                                                      |
| --------------------- | ---- | ------------- | -------------------------------------------------------------------------- |
| Qwen2.5-1.5B-Instruct | 1.5B | Apache-2.0    | Strong at structured output for its size; licence matches the repo's       |
| Qwen2.5-0.5B-Instruct | 0.5B | Apache-2.0    | Small enough to run inside the browser; test whether it is accurate enough |
| SmolLM2-1.7B-Instruct | 1.7B | Apache-2.0    | Built for exactly this "small and fine-tunable" niche                      |
| Llama-3.2-1B / 3B     | 1–3B | Llama licence | Good models, but the licence is not Apache and adds terms to a public repo |

Licence matters because the repo is going public under Apache-2.0; a model with the same licence keeps the story simple. Speech recognition has the same shape: OpenAI's Whisper is open (MIT), the `base` and `small` sizes run on a laptop CPU, and it is much better in factory noise than the browser's built-in recognizer.

**Hardware.** Fine-tuning a 1.5B model with the standard cheap method (LoRA — it trains a thin layer on top and leaves the base untouched) takes well under an hour on a gaming GPU with 8–12 GB of memory, or on a free Google Colab session. Running it afterwards needs no GPU: compressed to 4-bit it is about a 1 GB file and answers a sentence in under a second on an ordinary CPU. It could run as a small service next to the database, or, at the 0.5B size, inside the browser tab itself (a one-time download of a few hundred MB).

**Accuracy to expect.** On sentences shaped like the ones it was trained on, 95–98% correct forms is realistic. The confirmation chip is what makes the remaining few percent harmless. The model never gets the last word.

**How much training data.** For the single "assign" command, two to five thousand example sentences with their correct forms. We do not write these by hand: a script combines sentence templates ("assign {op} to {product} on {cell} in {line} from {start} to {end}", "put {op} on {cell} {time}", "{op} does {product} {time} on {cell}") with the real kinds of names and times, adds spelling variants and speech-recognition-style slips ("housing eh"), and writes the answer alongside. As the typed command bar is used, real sentences that people actually typed are added to the set (their corrected forms come free from what the person confirmed). Each new command later (move, unassign, who is free) adds another one to two thousand.

## Stages, in the order to build them

Each stage ends the way every piece of work in this repo ends: tests, a plan.yaml entry, a commit. Estimates are working days.

**Stage 1 — Decide the forms.** Write down, in one file, the commands we will support and the exact form each one fills in. Start with one: _assign_. Sketch but do not build the next four so the form design does not paint us into a corner: _book a job_ (a run on a cell), _move_, _unassign_, and _who is free at …_. Half a day. This is the stage where a decision from you shapes the product; the rest is building.

**Stage 2 — Command bar, no AI yet.** _(Brief written: `docs/agent-briefs/p1-7a-typed-command-bar-brief.md`.)_ A text box on the board. For this stage the sentence is read by a plain rule-based parser (it recognizes the fixed pattern "assign … to … on … in … from … to …" and nothing else). Its output goes through the _matcher_, which turns the words into records: exact name match, then partial match, then a one-question prompt with buttons when two things match or nothing does ("Two people match 'Sam' — Sam Patel · Sam Ortiz"). Then — instead of a new confirmation chip — the bar opens the **existing "New block" popover pre-filled** (person, part, cell, times), because that popover already is the confirmation: it shows the training and area warnings with their reason boxes, probes capacity, and shows the server's refusal in words. Pressing Create is the same click as today. The sentence always makes a direct block; joining a job already booked on the cell is a later command. Two to three days. This stage is usable on its own and is most of the value.

**Stage 3 — The training set and the test set.** The generator script described above, checked into `scripts/`, plus a _held-out test set_ of a few hundred sentences the model never trains on. The test set is the instrument: every model we ever train is scored against it, and a score below the bar fails the build, the same way a lost test file fails `npm run test` today. Every sentence a person types into the command bar is saved (with the site's permission) to grow both sets. One to two days.

**Stage 4 — Fine-tune the first model.** Pick the base from the table, fine-tune with LoRA on the Stage 3 data, score it on the test set, and compare with the rule parser on the same set. Export to the compressed file format that the local runtime uses. Constrain the model's output to the form's exact shape at generation time, so it is physically unable to answer with anything but a valid form. One to two days including the false starts that training always has.

**Stage 5 — Serve it.** A small container running the model alongside the local database (Ollama or llama.cpp; both fit the "run it yourself" spirit of the project). The command bar sends the sentence there and gets the form back. If the service is down, the bar falls back to the rule parser and says so. Later, the 0.5B model can be tried inside the browser so there is nothing to run at all. One day.

**Stage 6 — The microphone.** A button next to the command bar. First version uses the browser's built-in recognizer (zero setup, fine in an office, sends audio to Google or Microsoft, which some sites will not accept). Second version runs Whisper locally through the same small service as the model, which keeps the audio in the building and handles noise. Half a day, then one day.

**Stage 6b — Package it so a site can install it.** Not an AI stage, but the chatbot and the model service both assume it. The app, the database and the AI each become a container (a sealed box that runs the same on any machine), started together with one command, so a site can put all of it on a server in the plant or on a cloud machine of their own. One install serves several plants; the database's permission rules already keep each plant's data to its own people. Two to three days, and worth doing whether or not the AI ever ships.

**Stage 7 — Widen.** Add the next command from Stage 1, generate its data, retrain, re-score. Repeat. Each command is roughly a day once the pipeline exists. This is also where "a bunch of other things" lives: any question or action that can be expressed as a form is the same recipe.

## The chatbot — the same machine, pointed at reading

Added after the command-bar plan (3 Sept): you asked what it would take for a local model to answer questions about the app's data, respecting each person's permissions. The answer reuses everything above.

_The model is a translator, not a memory._ It is never trained on the data. It turns a question into a lookup the app runs **as the signed-in person**; the database returns only the rows that person may see (the same rules every screen uses today); the model turns those rows into a sentence, and the screen shows the rows beside the sentence so an invented name is obvious. No new door into the database, same as the command bar.

_Two tiers._ First, a fixed menu of 20–30 questions schedulers actually ask, each written as a tested lookup — that catalog is yours to write and is the most valuable hour in this part of the project. The **same small model** that reads command-bar sentences learns to pick the question and fill in the blanks, so it is one model, one training pipeline, one serving box for both jobs. Second, optionally and later, a larger model (about 7 billion parameters, e.g. Qwen2.5-Coder-7B) that writes its own database lookup for questions not on the menu — behind three guards: read-only, run as the person, capped and time-limited.

_Stages it adds_, after Stage 4: **(8)** the question catalog and one tested lookup per question — useful on its own as a "quick answers" panel before any AI; **(9)** teach the existing small model the menu (same generator and held-out test set); **(10)** the chat panel, sentence plus rows; **(11)** the optional 7B free-question model. Roughly two to three weeks of agent work once the command bar has landed.

_Hardware, honestly._ Training happens on Google Colab either way: the 1.5B model on the free tier easily, the 7B one on the free T4 card using QLoRA (a method that trains a thin layer on a compressed model), one to three hours a run, saving progress to Drive because free sessions disconnect; Colab's paid tier or an hourly rented GPU (a few dollars a run) removes the annoyance. A 16 GB laptop with no graphics card does everything else — generating data, running tests, running the small model at full speed, running the 7B one slowly for checking. Serving the chatbot to a plant wants a graphics card (a gaming card in the plant's server, or a small GPU machine in their cloud); the command bar alone does not.

_One change to Stage 2._ The parse and resolve modules moved from the board feature to `src/lib/command/`, because the chat panel will be app-wide and the repo's rules forbid one feature importing from another. The brief has been updated.

## What you would notice at each stage

After Stage 2 you can type the sentence and the board does it, with the same guardrails as clicking. After Stage 4 you can phrase it however you like. After Stage 6 you can say it. After Stage 6b a site can install the whole thing on a machine of their choosing. After Stage 7 you can say other things. After Stage 10 you can ask the board questions and get answers that respect who you are.

## Risks, in plain terms

_The floor is loud._ The browser recognizer will mishear on the floor; plan on the local Whisper version for real use, and always show the recognized text so a mishearing is visible before it is acted on.

_Times are ambiguous._ "10 to 2" on a night shift crosses midnight; "this afternoon" depends on the shift. The form carries the date the board is showing, and the confirmation readout always spells out the full date and time.

_The model is confidently wrong._ Caught by three layers: output constrained to the form's shape, the matcher refusing to guess between two candidates, and the confirmation chip. None of these are new rules; the server's rules stay exactly as they are.

_Training data drifts from real use._ Fixed by saving what people actually type and re-scoring every model on the growing test set.

_Public repo, private model._ The training script and the test set go in the repo; a trained model file is large and is published separately (a release download) or built by the user with one command. Nothing site-specific is in the training data because the model never sees real names.

## The decision that is yours

Which commands beyond _assign_ matter most, and in what order. My guess is _book a job_ (because the assign sentence often implies it), then _unassign_, then _move_, then _who is free_. If you would order it differently, that changes Stage 1 and nothing else.
