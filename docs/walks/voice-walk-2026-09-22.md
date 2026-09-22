# The spoken walk through Whisper — the list, prepared 22 Sept 2026

The typed half of this walk is `e2e/typedWalk.spec.ts` over `e2e/walk/sentences.ts` (R-433). This
is the same list, to be SPOKEN, with the plant's clock as the day: the sentences below say "today",
"tomorrow" and "this week" the way a person does, which is exactly what the spec ran green with
until 22 Sept and what the maintainer typed clean on 17 Sept. (The spec now runs on next Monday
instead, F-182, so it never clears the day a person is using; the spoken walk is the person, on
their own day, by choice — see "Before you start".)

Nothing needs to be written down by hand. Every sentence the bar hears, what the model read, what
it asked, what was answered and what was written lands in `data/voice/trace/bar.jsonl`, one line
per turn, with `"by":"local"` on a Whisper turn. The developer reads that file after.

## Before you start

1. **The two services are up.** In a PowerShell window in the repo: `npm run voice:serve` (it stays
   in the foreground like `npm run dev`; leave the window open). It prints
   `http://127.0.0.1:8090 -- healthy` for Whisper and `http://127.0.0.1:8089 -- healthy` for the
   model. On 22 Sept both were started this way and answered healthy.
2. **The app points at Whisper.** `.env.local` has `VITE_WHISPER_URL=/whisper` (it does on this
   machine) and `npm run dev` is running. If the dev server was started before the line was added,
   restart it.
3. **Sign in as Dana** (`dana@example.test`, `devpassword`), the Plant A admin — the same person the
   spec walks as. Open the board on today (the toolbar's Today button), open the corner launcher,
   and keep the thread on screen so you can read what was heard before what was done.
4. **The board must start EMPTY, the way the spec starts.** The spec removes every block and
   every job on Plant A for its own days before it speaks; the list below was proved against
   that empty board. Your board today carries the seed: a block and a job on each of Cells 1 to
   4, 06:00 to 14:00, today and every day this week. With those in place sentence 1 lists Priya
   Shah instead of saying nobody, and sentence 6 books a job over one that is already there. So
   before you speak, the developer runs the same clean-up the spec runs, Plant A from today
   through the next seven days, through the app's own door as Dana, and tells you "cleared".
   Ask for it; do not start until you have it. Sentences 21 and 22 leave the day empty at the end.
5. **The microphone.** The button reads "Speak a sentence". Press it, say one sentence, stop. The
   clip ends by itself a second and a half after you stop speaking, or at twelve seconds — a long
   sentence said slowly can hit the cap, so say it in one breath. The text lands in the bar and
   submits exactly as Enter does; you do not press anything after speaking. The thread's first
   bubble is what Whisper heard.
6. **If a name is misheard**, the bar asks — "No person called … Did you mean …?" with buttons.
   Press the button that is right. That is the walk working, and it is what the hint is for; the
   trace records both the mishearing and the pick. Only type a sentence if the bar cannot recover.

## The sentences, in order

Say each exactly as written. "Bar says" is what the status line shows when the turn settles.
"You do" is the button or the typed answer, when there is one.

| # | Say | Bar says | You do |
|---|---|---|---|
| 1 | clear Cell 4 today | Cell 4 has nobody on it … | — |
| 2 | Assign John Kim to Housing A on Cell 3 in Line 2 from 8am to 12pm today | John Kim → Housing A · Cell 3 · 08:00–12:00 | — |
| 3 | Assign Priya Shah to Common Fasteners on Cell 4 in Line 2 from 8am to 12pm today | Priya Shah → Common Fastener · Cell 4 · 08:00–12:00 (the plural is matched, no question) | — |
| 4 | Assign Maria Lopez to Housing Pay on Cell 4 in Line 2 from 1pm to 3pm today | Did you mean … with a Housing A button | press **Housing A** → Maria Lopez → Housing A · Cell 4 · 13:00–15:00 |
| 5 | Assign Sam Patel to Cell 1 from 8am to 4pm today | Which part? Cell 1 makes: … | press **Housing A** → Sam Patel → Housing A · Cell 1 · 08:00–16:00 |
| 6 | book Bracket A on Cell 3 in Line 2 for 3 people from 1pm to 5pm today | Bracket A · Cell 3 · 13:00–17:00 · 3 people | — |
| 7 | Assign Priya Shah to Line 1 Subassembly A on Cell 2 in Line 1 from 2 until end of shift today | Priya Shah → Line 1 Subassembly A · Cell 2 · 14:00–22:00 (or 02:00–06:00 if the model reads "2" as two in the morning — either is recorded) | — |
| 8 | Assign Tom Baker to Area 2 Frame A on Cell 6 in Line 3 from 8am to 2pm today | Tom Baker → Area 2 Frame A · Cell 6 · 08:00–14:00 | — |
| 9 | end Sam Patel's block at 2pm | Sam Patel · Cell 1 · end 16:00 → 14:00 | — |
| 10 | swap Tom Baker and Sam Patel today | Tom Baker is not certified for Cell 1: missing Welding. Nothing was written. (the model may hear "Tom Bakker" first and ask Did you mean — press **Tom Baker**) | — |
| 11 | split Sam Patel's block at 1pm | 2 commands ready: … | say or type **yes** |
| 12 | extend John Kim's block by an hour | John Kim · Cell 3 · end 12:00 → 13:00 | — |
| 13 | make the Bracket A job on Cell 3 4 people | Bracket A · Cell 3 · 4 people | — |
| 14 | Assign Lena Novak to Area 2 Frame A on Cell 5 in Line 3 from 8am to 1pm today | Lena Novak → Area 2 Frame A · Cell 5 · 08:00–13:00 | — |
| 15 | swap Lena Novak and John Kim today | 4 commands ready: … | say or type **yes** |
| 16 | copy today to tomorrow for Cell 3 | N commands ready: … | say or type **yes** |
| 17 | Assign Lena Novak to Bracket A on Cell 4 in Line 2 every weekday this week from 8am to 12pm | this week is not on the board. Move the board to that day first. | press **Show that day** → 5 commands ready: … → say or type **no** |
| 18 | Assign Tom Baker to Housing A on Cell 1 in Line 1 from 3pm to 5pm today | Tom Baker is not certified for Cell 1: missing Welding. Say the reason to schedule anyway, or no. | say **the line supervisor approved the cover** → the block is written with the override |
| 19 | Assign Maria Lopez to Bracket A on Cell 3 in Line 2 from 8am to 12pm on *(next Monday's date, e.g. "September twenty-eighth")* | … is not on the board. Move the board to that day first. | press **Show that day** → Maria Lopez → Bracket A · Cell 3 · 08:00–12:00 |
| 20 | Assign Maria Lopez to Bracket A on Cell 3 in Line 2 from 8am to 12pm | today is not on the board. Move the board to that day first. | press **Show that day** → Maria Lopez → Bracket A · Cell 3 · 08:00–12:00 |
| 21 | clear Area 1 today | N commands ready: … (every block on Cells 1 to 4 today) | say or type **yes** |
| 22 | clear Area 2 today | N commands ready: … (every block on Cells 5 and 6 today) | say or type **yes** |

Sentence 19 is the one place the spec says a date the way a spec does (`2026-09-28`). Spoken, say
the date however you naturally would; how Whisper writes it and whether the bar reads it is
itself one of the things this walk is for. If the bar cannot read it, type the sentence with the
date as `2026-09-28` and carry on.

## What the developer reads after

- Every turn with `"by":"local"`: what Whisper wrote against what was said — the mishearings the
  hint should have caught (a board name, a digit), the ones that need a new hint word, and the
  clips that came back empty or cut at twelve seconds.
- Every question the bar asked and the button pressed: a Did-you-mean that recovered is the hint
  working; a Did-you-mean with the wrong first offer is a finding.
- Anything the bar did wrong once it had heard correctly is a bar finding, not a voice one, and
  goes to the typed spec first.
