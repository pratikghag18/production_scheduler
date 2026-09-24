# The spoken walk through Whisper — the SECOND list, prepared 24 Sept 2026

The typed half of this second round is `e2e/typedWalk.spec.ts` (`WALK_SET=2`) over
`e2e/walk/sentences2.ts` (R-433, S71-n). This is a fresh list — different people, cells, hours and
days from the 22 Sept list (`docs/walks/voice-walk-2026-09-22.md`) — proved the same way: green
twice as a typed spec before it is handed over. The sentences below say "today" the way a person
does; the spec itself says the walk day as its own ISO date (F-182: never the day a person is
using — see "Before you start").

Nothing needs to be written down by hand. Every sentence the bar hears, what the model read, what
it asked, what was answered and what was written lands in `data/voice/trace/bar.jsonl`, one line
per turn, with `"by":"local"` on a Whisper turn. The developer reads that file after.

Two shapes the brief asked for were tried against the grammar and dropped rather than forced (both
recorded in this lane's own report to the maintainer, not repeated here): a bare "from 10 to 2"
with no am/pm resolves DETERMINISTICALLY today (no question is ever asked for it), and "same as
yesterday" always means "onto today", which this walk never touches on purpose (F-182). Dropping
both lands this list at 22 entries, same as the first. A NAMED weekday for sentence 17's own copy
("Friday") was also tried and dropped once the typed spec actually ran it — see that row's own
note below.

## Before you start

1. **The two services are up.** In a PowerShell window in the repo: `npm run voice:serve` (it stays
   in the foreground like `npm run dev`; leave the window open). It prints
   `http://127.0.0.1:8090 -- healthy` for Whisper and `http://127.0.0.1:8089 -- healthy` for the
   model.
2. **The app points at Whisper.** `.env.local` has `VITE_WHISPER_URL=/whisper` and `npm run dev` is
   running. If the dev server was started before the line was added, restart it.
3. **Sign in as Dana** (`dana@example.test`, `devpassword`), the Plant A admin — the same person the
   spec walks as. Open the board on today (the toolbar's Today button), open the corner launcher,
   and keep the thread on screen so you can read what was heard before what was done.
4. **The board must start EMPTY, the way the spec starts.** Before you speak, the developer runs
   the same clean-up the spec runs (Plant A, today through the next nine days), through the app's
   own door as Dana, and tells you "cleared". Ask for it; do not start until you have it. Sentences
   21 and 22 leave Line 2 and Area 2 empty at the end; Cell 1 and Cell 2 (Line 1) are NOT cleared by
   any sentence in this list on purpose (sentences2.ts's own header doc) — the developer's own
   clean-up handles them before and after.
5. **The microphone.** Press Ctrl+M (or the button that reads "Speak a sentence"), WAIT for the
   "Listening…" label beside the mic --- it appears only once the microphone is actually open (F-214;
   speaking before it cost the first word all through the 23 Sept walk) --- then say one sentence, stop. The
   clip ends by itself a second and a half after you stop speaking, or at twelve seconds. The text
   lands in the bar and submits exactly as Enter does. The thread's first bubble is what Whisper
   heard.
6. **If a name is misheard**, the bar asks — "No person called … Did you mean …?" with buttons.
   Press the button that is right. Only type a sentence if the bar cannot recover.
7. **Sam Patel is owned by Line 1**, not the whole plant (the one demo person a LINE owns, not a
   plant — dev_demo.sql's own comment). Off Cell 1/Cell 2 he is refused the same way an uncertified
   person is (a different rule, the area gate, F-165) — every Sam Patel sentence below stays on
   Cell 2 for exactly this reason; it is not a mistake if you notice it.

## The sentences, in order

Say each exactly as written. "Bar says" is what the status line shows when the turn settles.
"You do" is the button or the typed answer, when there is one.

| # | Say | Bar says | You do |
|---|---|---|---|
| 1 | clear Cell 6 today | Cell 6 has nobody on it … | — |
| 2 | Assign Priya Shah to Line 1 Subassembly A on Cell 1 in Line 1 from 6am to 2pm today | Priya Shah → Line 1 Subassembly A · Cell 1 · 06:00–14:00 | — |
| 3 | Assign Maria Lopez to Area 2 Frame A on Cell 6 in Line 3 from 8am to 12pm today | Maria Lopez → Area 2 Frame A · Cell 6 · 08:00–12:00 | — |
| 4 | Assign Lena Novak to Bracket A on Cell 2 in Line 1 from 8am to 12pm today | Lena Novak is not certified for Cell 2: missing Welding. Say the reason to schedule anyway, or no. | say **Lena is covering for the Line 1 shortfall today** → written with the override |
| 5 | Assign John Kim to Common Fastener on Cell 5 in Line 3 from 8am to 12pm today | John Kim → Common Fastener · Cell 5 · 08:00–12:00 | — |
| 6 | Assign Sam Patel to Bracket Pay on Cell 2 in Line 1 from 3pm to 7pm today | Did you mean … with a Bracket A button | press **Bracket A** → Sam Patel → Bracket A · Cell 2 · 15:00–19:00 |
| 7 | Assign Tom Baker to Cell 3 from 8am to 12pm today | Which part? Cell 3 makes: … | press **Housing A** → Tom Baker → Housing A · Cell 3 · 08:00–12:00 |
| 8 | book Common Fastener on Cell 6 in Line 3 for 2 people from 1pm to 5pm today | Common Fastener · Cell 6 · 13:00–17:00 · 2 people | — |
| 9 | end John Kim's block at 10am today | John Kim · Cell 5 · end 12:00 → 10:00 | — |
| 10 | shorten Lena Novak's block by 30 minutes today | Lena Novak · Cell 2 · end 12:00 → 11:30 | — |
| 11 | extend Sam Patel's assignment by an hour today | Sam Patel · Cell 2 · end 19:00 → 20:00 | — |
| 12 | split Tom Baker's block at 10am today | 2 commands ready: … (the model may mishear "Tom Baker" as "Tom Bakker" first — press **Tom Baker** if it asks) | say or type **yes** |
| 13 | swap Lena Novak and Priya Shah today | Lena Novak is not certified for Cell 1: missing Welding. Nothing was written. | — |
| 14 | swap Maria Lopez and John Kim today | 4 commands ready: … | say or type **yes** |
| 15 | make the Common Fastener job on Cell 6 5 people today | Common Fastener · Cell 6 · … · 5 people | — |
| 16 | Assign John Kim to Housing A on Cell 6 in Line 3 from 4 until end of shift today | John Kim → Housing A · Cell 6 · 16:00–22:00 (or 04:00–06:00 if the model reads "4" literally — either is recorded) | — |
| 17 | copy today to tomorrow for Cell 5 | Maria Lopez → Common Fastener · Cell 5 · 08:00–10:00 | — |
| 18 | Assign Lena Novak to Common Fastener on Cell 4 in Line 2 every weekday next week from 9am to 1pm | next week is not on the board. Move the board to that day first. | press **Show that day** → 5 commands ready: … → say or type **no** |
| 19 | Maria Lopez is off today | Remove Maria Lopez's Common Fastener block on Cell 5, 08:00–10:00? — say or type yes to do it, no to leave it. | press **Remove it** → Removing Maria Lopez's Common Fastener block · … |
| 20 | cover Priya Shah with Sam Patel today | 2 commands ready: … | say or type **yes** |
| 21 | clear Line 2 today | N commands ready: … (every block on Cell 3 and Cell 4 today) | say or type **yes** |
| 22 | clear Area 2 today | N commands ready: … (every block and job on Cell 5 and Cell 6 today) | say or type **yes** |

Two things worth saying plainly, both found by actually running the typed spec (three runs, all
recorded in `data/voice/trace/bar.jsonl`), not guessed from reading the grammar alone:

- Sentence 15 (the headcount change) sits seven sentences after sentence 8's own booking on
  purpose, the same distance the first list keeps between its own two — right next to each other,
  the client's own realtime sync raced the write once and the bar refused it ("That job is no
  longer on the board"). Wait for the readout, do not rush the two.
- Sentence 17 (the copy) was first tried as "copy today to Friday for Cell 5" — the copy grammar
  DOES read a bare weekday, but pressing "Show that day" for a day four days out moves the window
  in a way that drops TODAY back off the board, so the copy's own source then asks a second
  question it never gets past. "Tomorrow" needs no such move, and copying exactly one block never
  asks at all — it just writes, the same as an ordinary single sentence (S47).

## What the developer reads after

- Every turn with `"by":"local"`: what Whisper wrote against what was said — the mishearings the
  hint should have caught, the ones that need a new hint word, and the clips that came back empty
  or cut at twelve seconds.
- Every question the bar asked and the button pressed: a Did-you-mean that recovered is the hint
  working; a Did-you-mean with the wrong first offer is a finding.
- Sentence 19's own question (`remove_which`) is new to this list — read whether it names the
  right person, part, cell and hours before pressing anything.
- Anything the bar did wrong once it had heard correctly is a bar finding, not a voice one, and
  goes to the typed spec first.

## Results (S72-c, R-453)

**How to read this.** Every clip you spoke this afternoon is on disk with the words you actually said
beside it. The scorer plays each clip to a model and compares the model's words to yours. Four numbers
per model:

- **Words wrong per 100** --- of every 100 words you said, how many the model got wrong (missed, added
  or swapped). 0 is perfect. This is the number that decides.
- **Names heard right** --- every person, part, cell, line and area you named (88 of them across the
  round); how many came back exactly right. A wrong name is the mistake the board cannot recover from.
- **Word-perfect clips** --- of the 44 clips, how many the model transcribed with not one word wrong.
- **Seconds to answer** --- how long you wait after you stop talking, on this machine.

"Hint" means the model is told the board's own words (the names, the verbs) before it listens; that is
what the app does today.

| Model | Hint | Words wrong per 100 | Names heard right | Word-perfect clips | Seconds to answer | In short |
|---|---|---|---|---|---|---|
| small.en (today's default) | yes | 16 | 83 of 88 | 17 of 44 | 6.7 | The one to beat |
| small.en | no | 26 | 55 of 88 | 11 of 44 | 4.8 | The hint is worth a third of the errors and a third of the names |
| small.en, yesterday's clips | yes | 19 | 69 of 78 | 11 of 36 | 5.7 | Yesterday's round, for comparison; the mic was quieter |
| tiny.en | yes | waiting for the swap | | | | |
| base.en | yes | waiting for the swap | | | | |
| medium.en-q5_0 | yes | waiting for the swap | | | | |
| large-v3-turbo-q5_0 | yes | waiting for the swap | | | | |

**Where the 16 words per 100 went.** Nearly all of them are the first word of the sentence: "end" came
back as "and" four times out of five, "swap" as "show up", "assign" as "sign" or "a sign", "split ...
at 10am" twice as nonsense. The names, the cells and the hours in the middle of the sentence were
almost always right. That is why the board is being taught to ask "did you mean end, move or split?"
instead of printing grammar: the ear drops the verb, the board can offer it back.

The ten worst clips by WER (small.en, beam, hint on), `heard` beside what was said:

1. WER 1.500 — said "clear Cell 6 today" — heard "See you at the next one."
2. WER 1.111 (answer) — said "Lena is covering for the Line 1 shortfall today" — heard "Lena is governing for line 1, shot 1, 2, 3, 4, 5, 6, 7"
3. WER 0.375 — said "split Tom Baker's block at 10am today" — heard "Split, Tom Baker's block, that they named, today,"
4. WER 0.375 — said "split Tom Baker's block at 10am today" — heard "Split Tom Baker's Block at N.A.M.P.D."
5. WER 0.316 — said "Assign John Kim to Housing A on Cell 6 in Line 3 from 4 until end of shift today" — heard "Sign John Kim to Housing A on Cell 6, online 3, from 4, and then end up shift today."
6. WER 0.286 — said "swap Lena Novak and Priya Shah today" — heard "Show up Lena Novak and Priya Shah today."
7. WER 0.250 — said "extend Sam Patel's assignment by an hour today" — heard "Extend Sam Patel's assignment by an R2D."
8. WER 0.250 — said "shorten Lena Novak's block by 30 minutes today" — heard "Shorten Lena Novak's Vlog by 30 minutes, please."
9. WER 0.250 — said "end John Kim's block at 10am today" — heard "and John Kim's vlog at 10 a.m. today"
10. WER 0.250 — said "end John Kim's block at 10am today" — heard "and John Kim's love at 10 a.m. today"
