# Mise

A local-first calendar agent for one person. It manages class schedule, gym,
meal prep, and meals on a single Mac; a local LLM (via Ollama) proposes
schedule changes and a deterministic engine validates and applies them. The UI
is reachable from a laptop and phone over Tailscale. Single user, no auth, no
cloud. The full design lives in [SPEC.md](./SPEC.md); this file is how to run it.

Five invariants define the app (SPEC §0):

- **I1** — The model never writes to the database; tools own all writes.
- **I2** — Every mutation is proposed → approved → committed; a Proposal is a DB row, never ephemeral UI state.
- **I3** — Time arithmetic is never done by the model; it emits deltas, tools compute timestamps.
- **I4** — Pinned events (classes, exams) cannot move; the validator enforces it, not the prompt.
- **I5** — What a cook block cooks is DERIVED from its assignment (`cook_assignment` → suite/meal), never stored on the instance; the Meals tab's shopping list is the meals' verbatim ingredient lines.

## Quickstart

Prerequisites: [Bun](https://bun.sh), [Ollama](https://ollama.com) (running),
and optionally [Tailscale](https://tailscale.com) for phone/laptop access.

```bash
bun install
bash scripts/setup.sh    # pulls the models, checks Ollama + Tailscale, prints your tailnet URL
bun run seed             # demo semester, meals, a suite + cook assignment (WIPES the DB — never run against real data)
bun dev                  # UI on :3000, API on :3001
```

Two models: `qwen3:30b-a3b` does the scheduling — a mixture-of-experts model, so
only ~3B parameters are active per token: it is as fast as an 8B and markedly
better at picking the right tool and the right day. `qwen2.5vl:7b` reads photos
of class schedules. Override with `MISE_MODEL` / `MISE_VISION_MODEL`.

Open http://localhost:3000. Ollama stays on `127.0.0.1:11434` — only the API
server talks to it.

## Phone and laptop (Tailscale)

Tailscale is the auth boundary: the UI and API bind `0.0.0.0` but are only
reachable on your tailnet. There is no login screen on purpose.

- `scripts/setup.sh` prints the MagicDNS URL, e.g. `http://sai-mac.tail1234.ts.net:3000`.
- Laptop: open that URL in a browser.
- iPhone: open it in Safari → Share → **Add to Home Screen**. The PWA manifest
  makes it a standalone app; its job is checking today, asking the assistant to
  move something, and reading the Meals tab's ingredient list at HEB.

## Desktop shell (Tauri)

Optional — the browser works fine. The shell adds a tray icon and native
notifications. It needs Rust, and it is intentionally *not* part of the Bun
workspace, so it installs its own deps:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # install Rust once
bun dev                                                          # in one terminal — the shell wraps :3000
cd apps/desktop && bun install && bunx tauri dev                 # in another
```

`bunx tauri build` produces the `.app`/`.dmg`; it static-exports the web app
(`TAURI_BUILD=1`) and bundles it, so the built shell doesn't need the dev
server. Closing the window hides it to the tray; quit from the tray menu.

## Repo layout

| Path | What it is |
|---|---|
| `apps/api` | Bun + Hono API on :3001 — agent loop, proposal lifecycle, the only Ollama consumer |
| `apps/web` | Next.js UI on :3000 — week view, chat + diff cards, Meals tab; responsive PWA |
| `apps/desktop` | Tauri v2 shell wrapping the UI — tray + notifications (outside the Bun workspace) |
| `packages/core` | Drizzle schema, validator, tools (dry/commit), agent — shared by api and web |
| `config` | Constraints (defaults) and the settings overlay |
| `scripts` | `setup.sh`, `dev.ts`, `seed.ts` |
| `data` | SQLite (`mise.db`) and `settings.local.json` — gitignored |

## Constraints and settings

Scheduling rules live in [`config/constraints.ts`](./config/constraints.ts) —
a typed, hand-edited, version-controlled TS file, deliberately not in the DB:
commute gaps, gym targets and windows, cook cadence, the load-bearing
`dinner: 'out'`, protected sleep hours. Edit it directly when your rules change.

Those values are *defaults*. Onboarding answers (cook cadence, gym target,
which meals are out) are written to `data/settings.local.json` (gitignored) and
[`config/settings.ts`](./config/settings.ts) merges them over the defaults —
`effectiveConstraints()` is what the validator and tools actually consume. So
Sai's habits are hardcoded into the defaults, not into the app.

## Using the week view

- **Colors.** Every event kind has a default color (class slate, gym indigo,
  cook green, personal violet…). **Click any block** to open a swatch popover and
  recolor it, or recolor every event of that kind at once. Color is cosmetic
  metadata — it saves directly, no approval needed. Depth still carries the real
  signal: pinned events sit *in* the page (recessed, spine, no drag), movable
  ones sit *on* it (raised, grabbable). Turn everything one color and the app is
  still fully legible.
- **The whole day fits on screen** (06:00–24:00). The grid derives its scale from
  the window height instead of scrolling; blocks shed detail as they shrink.
- **Drag a block to any time on any day, and it moves.** Cross-day drags work.
  Dropping applies the change immediately, with an **Undo**.
- **The assistant just does it.** Ask it to move something, tell it a plan
  ("going out with friends 6-8" → it makes the block), ask it to rearrange your
  week — it applies the change and shows you a receipt you can undo. It does not
  make you approve small things. **Cancelling still asks**, because a cancel
  deletes the event, and no undo puts it back.
- **Times are 12-hour** everywhere you read them, and every block shows its whole
  timeframe (`5 – 6:30 PM`) underneath its name — never a bare start time. The
  machine layer (database, tool arguments, the model's own context) stays
  24-hour so nothing is ambiguous.
- **A block leads with the specific thing, not the generic one.** A gym block
  says *Chest and back*, not "Gym"; a cook block says *Chipotle Chicken Rice
  Bowls*, not "Cook lunches". The colour already tells you what kind it is, so
  the line is spent on what you actually opened the calendar to find out — the
  week reads as chest / shoulders / chest rather than gym / gym / gym. **Click a
  block → View details** for the exact lifts and loads, or the recipe's
  ingredients and method. The split lives in
  [`config/workouts.ts`](./config/workouts.ts), hand-edited like the constraints.
- **The assistant never narrates its own work.** What you read is written from
  what actually committed. It used to say "I moved your gym and cook sessions"
  on a day with no cook session — a confident false sentence about your calendar
  is worse than an error, because you believe it. Now the app reports; the model
  only speaks when it changed nothing.
- **Import your class schedule from a photo.** "Import schedule" in the week
  header (or during onboarding): drop, paste, or choose a screenshot of your
  registrar page. A local vision model (`qwen2.5vl:7b`) transcribes it, you fix
  what it got wrong in an editable preview, and the classes are added as pinned
  recurring events through the normal approve flow. The model reads pixels — it
  never writes to the database, and it never computes a timestamp.

## What done looks like (SPEC §12)

- Ollama runs on the desktop Mac; a `curl` from the MacBook over Tailscale returns a schedule.
- The iPhone home-screen icon opens the week view, offline-tolerantly.
- "Shift everything after 3pm tomorrow back an hour" → diff card → approve → calendar updates — and CS 429 did not move.
- Paste a recipe into chat → the AI imports it onto the Meals tab (import_meals); a breakfast + lunch pasted together become a suite, and clicking a cook block assigns what it cooks.
- The `proposal` table has a row for every mutation ever made, with the tool name, args, and diff.
