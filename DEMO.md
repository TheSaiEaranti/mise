# Mise — live demo script

Five commands, about two minutes including talking. Everything runs on a fake
Fall semester (`bun run seed:demo`), so there is no real personal data on
screen and you can rehearse as often as you like.

## Setup (do this 10 minutes before)

1. **Key.** `~/Projects/mise/.env` must contain `ANTHROPIC_API_KEY=sk-ant-...`
   (gitignored; Bun loads it). No other env vars are needed.
2. **Seed the demo calendar** — its own database, `data/demo.db`; your real
   `data/mise.db` is never touched:
   ```bash
   cd ~/Projects/mise
   bun run seed:demo
   ```
   It builds the week around *today*, and whatever day that is, guarantees:
   a gym block today, a pinned class after 3 PM tomorrow with blocks after it,
   gym on Fridays, and an advising appointment to cancel.
3. **Start the API** (terminal 1):
   ```bash
   bun run demo:api
   ```
   Wait for these two lines — the second means the first command won't be cold:
   ```
   [chat] backend: Anthropic API (claude-haiku-4-5, escalates to claude-sonnet-5), CLI/Ollama fallback
   [chat] prompt cache warmed in ~1700ms (… tokens written, …)
   ```
4. **Start the UI** (terminal 2) — a production build, so no dev badge and no
   latency panel on screen:
   ```bash
   bun run demo:web
   ```
5. Open **http://localhost:3000** in a browser window at 100% zoom, sized
   ≥ 1440 px wide so the week grid and the chat rail sit side by side.
6. Keep the backup video (`demo.webm`, 63 s, 1920×1080 — opens in Chrome) open in another tab.

Backend and model: the Anthropic Messages API, **Claude Haiku 4.5** for every
turn, escalating to **Claude Sonnet 5** only for compound requests or a tool
call that fails validation. Commands 1 and 2 don't call a model at all.

To rehearse again: `bun run seed:demo` (the API can stay running), then reload
the page.

## The five commands

Type each into the chat box and press Enter.

### 1. A simple move — `move my gym block to 6pm`
*~10 ms. No model call.*

Say: "The most common edits are parsed deterministically — no LLM — and go
through the same pipeline a model's tool call would: dry-run, a Proposal row,
the validator, commit." Point at today's gym sliding to 6 PM and the receipt
card with **Undo**.

### 2. The pinned class — `shift everything after 3pm tomorrow back an hour`
*~10 ms. No model call.*

Point at **tomorrow's ECO 304K** (a class, drawn recessed): it is still at its
time. Everything movable after 3 PM slid an hour **earlier** ("back" always
means earlier here): the gym 6 → 5 PM, starting right as the class ends, and the
study group 8 → 7 PM. The diff card lists the class under "unchanged".

Say: "Pinned events can't move — and that isn't the prompt asking nicely. The
validator refuses any change that moves one, whoever proposes it." (Invariant
I4.)

### 3. A recurring change — `no gym on Fridays`
*~1.3–1.8 s. One Haiku call.*

Watch the status line under the message ("Looking at your calendar…" →
"Reshaping Gym…" → "Moved"), then every Friday's gym disappears in one call.

Say: "This one needs the model. The router saw a recurring-days request and
sent Haiku only that family's rules and six tools instead of the whole 30k-char
manual, and the static part of the prompt comes from the prompt cache."

### 4. A cancel — `cancel my advising appointment`
*~1.0–1.2 s to the card.*

It does **not** cancel yet: a confirm card appears with **Approve / Reject**,
and the appointment is outlined as pending. Click **Approve**.

Say: "Reversible changes just happen, with Undo. A cancel deletes things undo
can't fully restore, so it always asks first."

### 5. Undo — press **Cmd-Z** (click an empty part of the calendar first, so the chat box isn't focused)
*~2 ms.*

The appointment comes back; a line under the header says what was undone.

## What to say about the engineering (if asked)

- **Measured first.** Every turn is traced: prompt build, each model round
  (time to first token, input / cache / output tokens), each tool dry-run and
  commit, SQLite time. `Ctrl+Shift+L` shows it in dev.
- **Before → after**, 22 commands × 2: p50 **10.4 s → 1.28 s**, p90
  **18.8 s → 1.87 s**, ~302k → ~6.7k input tokens per turn, accuracy
  **90.9 % → 100 %** — no individual command got worse. Details in the README.
- **The causes, in order of impact:** the CLI dragged 138 unrelated connector
  tools (~95k tokens) into every call; a new process per model round (~2.6 s);
  the whole 30k-char prompt + 26 tool schemas on every round; an extra model
  round after every change just to write text the app discards.
- **The safety didn't move:** the model only proposes; one gate
  (`applyProposal`) commits, re-validating against current state; pinned
  events and blocking conflicts are refused there, not in the prompt.

## Measured timings (`bun run demo:timing`)

The five commands, 3 rounds each, through the real API routes after the same
cache warm-up the server does:

| step | today = Wed (tomorrow Thu) | today = Fri (tomorrow Sat) |
|---|---|---|
| 1 move gym to 6 PM | 11–22 ms | 12–27 ms |
| 2 shift everything after 3 PM tomorrow | 11–12 ms | 10–11 ms |
| 3 no gym on Fridays — status line / diff card | 2–4 ms / 1.35–1.47 s | 2–4 ms / 1.27–1.76 s |
| 4 cancel — status line / confirm card | 3 ms / 1.02–1.23 s | 2–3 ms / 0.94–1.21 s |
| 4 approve click | 5–6 ms | 5 ms |
| 5 undo | 1 ms | 1–2 ms |

Every step is under 3 s, and on every round the story held: the pinned class
didn't move, Fridays lost their gym, the cancel asked first, Undo restored it.
Re-check on the day with `bun run demo:timing --now 2026-09-25T14:00` (any
date/time). **Not on a Monday:** "tomorrow" is then Tuesday, whose gym would
land on ECO 304K an hour earlier, so step 2 is refused (Mise says why).

## If something goes wrong

- **A command gives a clarifying question instead of acting** — answer it; it
  keeps working. Or run `bun run seed:demo`, reload, and repeat.
- **The API errors** (network, key): the backend falls back to the claude CLI
  automatically; it's slower (~5 s) but works. Or switch to the backup video (`demo.webm`).
- **Cmd-Z does nothing** — the chat box has focus; click the calendar first, or
  use the **Undo** button on the card.

## Re-recording the backup video

```bash
bun run seed:demo
bun run demo:api          # terminal 1
bun run demo:web          # terminal 2
bun run record:demo --out demo.webm      # Playwright + your installed Chrome, 1920×1080
# optional, for QuickTime / iOS (needs ffmpeg):
ffmpeg -i demo.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart demo.mp4
```
The recorder types the five commands with a visible cursor dot, waits for each
answer, and saves five stills to `demo-frames/`.
