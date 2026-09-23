# SPEC.md — Personal Calendar Agent

A local-first desktop calendar that manages class schedule, gym, meal prep, and
groceries. A local LLM proposes schedule mutations; a deterministic engine
validates and applies them. Reachable from a second Mac and iPhone over Tailscale.

**Single user. No auth. No cloud. No multi-tenancy.**

---

## 0. Non-negotiable invariants

These are the reason this app is worth building instead of using Google Calendar.
If an implementation choice violates one of these, the choice is wrong.

**I1 — The model never writes to the database.**
The LLM's only output is a tool call. Tools own all writes. A tool call that the
validator rejects is a no-op, not a partial write.

**I2 — Every mutation is proposed, validated, and committed as a Proposal row.**
No exceptions, including "obviously safe" ones. Nothing writes to the schedule
except a tool, running its own validation, inside a transaction, leaving a
Proposal row behind. A Proposal is a first-class row in the DB, not ephemeral UI
state — it is the audit log, and it is never deleted.

*Who approves* depends on what is at stake, not on who asked:

- **Reversible changes apply themselves.** Moving an event, adding one,
  rescheduling one — from chat or from a drag — commit immediately and appear as
  a receipt with an **Undo**. Sai asked for this in as many words: he does not
  want to approve small changes, he wants to trust it. Confirming a thing you can
  undo in one click is friction that buys nothing.
- **Irreversible changes still ask.** Cancelling an event deletes it and any meal
  plan it was cooking, and no honest undo puts those back; replacing a semester
  wipes the calendar. These stay `pending` and render as a diff card.

What did *not* move is the enforcement. `applyProposal` is the only door to the
database, and it re-validates against current state, refuses any blocking
conflict (a pinned class cannot move whether or not a human is watching), refuses
an empty diff, and commits inside the tool's transaction. Auto-applying is only
defensible because those hold with nobody watching — and because everything it
does is one click from undone.

Cosmetic metadata (an event's color) is not a schedule mutation and saves
directly — like a recipe, or a ticked grocery box.

**I3 — Time arithmetic is never done by the model.**
The model emits *intent* (`shift_events`, `delta_minutes: 60`). The tool computes
new timestamps in TypeScript with a real date library. If the model emits a
literal timestamp anywhere in a mutation tool's arguments, that's a bug in the
tool schema — fix the schema, don't validate around it.

*Dates are arithmetic too.* Asked to move "Tuesday's gym", an 8B model will
happily work out the wrong Tuesday — and then report a real conflict it found on
the wrong day, which is worse than an error because it looks like an answer. So
the model is never asked to derive a date: `buildContext` hands it a CALENDAR
block mapping each weekday to its exact date, and it copies one.

**I3b — The model must name what it is touching.**
An `event_id` alone is unverifiable: the model copies ids out of a table and can
copy the wrong row (asked for "tomorrow's gym" on a day with no gym, it took the
cook session, and the change was applied). Every tool that takes an `event_id`
also takes `expect_title`, and refuses — blocking — if the id is not that event.
Identity is checked, not assumed.

**I4 — Pinned events cannot move.**
Classes and exams are `pinned: true`. Any proposal that moves a pinned event is
rejected by the validator before the user ever sees it. The model is told this in
its system prompt, but the validator is what enforces it.

**I5 — What a cook block cooks is derived, never hand-maintained.**
A cook block's subtitle and details are a pure function of its
`cook_assignment` (→ suite or meal). There is no stored subtitle. If it is
wrong. One-off items go in a separate `extras` list that is explicitly not derived.

---

## 1. Topology

```
┌──── Desktop Mac (M-series, 64GB, always on) ───────────┐
│                                                         │
│   Ollama            :11434   (127.0.0.1 only)          │
│   API server        :3001    (0.0.0.0, Bun + Hono)     │
│   SQLite            ./data/mise.db                      │
│   Next.js UI        :3000    (0.0.0.0)                 │
│   Tauri shell       wraps :3000, adds tray + notifs     │
│                                                         │
└──────────────────┬──────────────────────────────────────┘
                   │  Tailscale (tailnet, no public ingress)
        ┌──────────┴──────────┐
        │                     │
   MacBook browser       iPhone Safari → "Add to Home Screen"
   http://mac:3000       http://mac:3000  (same UI, responsive)
```

**Tailscale is the auth boundary.** The API binds `0.0.0.0` but is only reachable
on the tailnet. Do not build a login screen. Do not add JWT. If it's on the
tailnet, it's Sai.

**Ollama stays on `127.0.0.1`.** Only the API server talks to it. Clients never
touch Ollama directly — otherwise the agent loop and tool layer would have to be
reimplemented per client, and the phone would be able to bypass the validator.

### Setup steps Claude Code should script (`scripts/setup.sh`)

```bash
# Ollama must listen on localhost only; the API server is the only consumer.
# Default is fine. Do NOT set OLLAMA_HOST=0.0.0.0 — nothing outside the box
# should reach the model directly.

ollama pull qwen3:8b          # primary — strong tool calling, ~5GB
ollama pull qwen3:30b-a3b     # optional heavier fallback, MoE, still fast

tailscale status              # verify tailnet is up; print the MagicDNS name
```

Print the MagicDNS hostname at the end of setup so the phone/laptop know where
to point. Something like `http://sai-mac.tail1234.ts.net:3000`.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Tauri v2** | ~10MB vs Electron's ~150MB. Rust core, native webview. Gives tray icon + native notifications. |
| UI | **Next.js 15 + TS + Tailwind + shadcn/ui** | Same stack as your other work. Tauri points at the dev server in dev, at a static export in prod. |
| API | **Bun + Hono** | Single process, fast cold start, trivial to daemonize. Hono because the route surface is small and typed. |
| DB | **SQLite** via `bun:sqlite` | Single user, single machine. Postgres is unjustified overhead here. WAL mode on. |
| Migrations | **Drizzle** | Typed schema, and you'll want migrations when the semester model changes. |
| Model runtime | **Ollama** | Already installed. Use its OpenAI-compatible `/v1/chat/completions` endpoint so the tool-calling code is portable. |
| Dates | **Temporal polyfill** or **date-fns-tz** | Pick one, use it everywhere. Never `new Date()` arithmetic. |

Everything in one repo. Bun workspaces:
`apps/api`, `apps/web`, `apps/desktop` (Tauri), `packages/core` (schema + validator + tools — must be importable by both api and web).

---

## 3. Data model

Drizzle schema, SQLite. All timestamps stored as **ISO 8601 strings in
America/Chicago**, not epoch ints — you will be reading this DB by hand and epoch
ints are miserable to debug. Store the IANA zone explicitly on the semester.

```ts
semester      id, name, start_date, end_date, timezone
event         id, semester_id, title, kind, starts_at, ends_at,
              pinned (bool), rrule (nullable), source, notes
              // kind: 'class' | 'gym' | 'cook' | 'meal' | 'personal' | 'commute'
              // source: 'manual' | 'agent' | 'recurring'
              // rrule: RFC5545 string for the weekly class pattern
event_exception  id, event_id, original_date, status, override_event_id
              // how a single instance of a recurring event gets moved/cancelled
              // status: 'moved' | 'cancelled'

meal          id, name, meal_type ('breakfast'|'lunch'), ingredients (json string[]),
              details, created_at
              // ingredient lines VERBATIM — the Meals tab's shopping list (§7 v2)
meal_suite    id, name, breakfast_meal_id, lunch_meal_id, created_at
cook_assignment id, event_id, date, suite_id, meal_id, created_at
              // what a cook block cooks: suite XOR meal, one per (event_id, date)

proposal      id, created_at, user_message, tool_name, tool_args (json),
              diff (json), conflicts (json), status, applied_at
              // status: 'pending' | 'approved' | 'rejected' | 'expired'
              // this is the audit log. never delete rows.
chat_message  id, proposal_id (nullable), role, content, created_at
```

**`proposal` is the spine of the app.** Every agent action leaves a row. When the
model does something dumb, you open the table and see exactly what tool it called
with what args and what diff came out. Do not make this ephemeral.

---

## 4. The agent loop

One file: `packages/core/agent.ts`. Everything about the model lives here.

```
user message
  → build context (see below)
  → POST http://127.0.0.1:11434/v1/chat/completions
      { model, messages, tools, tool_choice: "auto" }
  → model returns tool_calls[]
  → for each call:
      - look up tool by name (reject unknown names, don't guess)
      - zod-parse args (reject on failure, feed error back to model, retry once)
      - execute tool in DRY-RUN mode → { diff, conflicts }
  → write Proposal row (status: pending)
  → stream diff to UI
  → user clicks Approve
  → re-run tool in COMMIT mode against current DB state
  → if DB changed since proposal was made, re-validate; if conflicts appeared, re-prompt
  → status: approved, applied_at set
```

**Every tool is written once and takes a `mode: 'dry' | 'commit'` flag.** Dry
returns the diff without touching the DB. Commit applies it inside a transaction.
This is what makes I2 cheap instead of a maintenance nightmare — you are not
writing the logic twice.

### Context window construction

Do not dump the whole semester into the prompt. Send:
- Today's date + current time + timezone
- Events from `today - 1d` to `today + 14d`, as a compact table
- The pinned-event list for that window, flagged explicitly
- Constraint summary (from §6)
- Last ~6 chat turns

That's it. Keep it under ~2k tokens so an 8B model doesn't lose the plot.

### Tool schemas

Exactly these. No free-form "do a thing" tool.

```ts
shift_events({
  scope: 'day' | 'range' | 'single',
  date: string,                      // YYYY-MM-DD, the anchor
  end_date?: string,                 // for scope: 'range'
  event_id?: string,                 // for scope: 'single'
  delta_minutes: number,             // ±. THE MODEL NEVER EMITS A TIMESTAMP.
  kinds?: EventKind[]                // optional filter: only shift gym+cook
})

create_event({
  title, kind, date, start_time, duration_minutes, notes?
})
// start_time is 'HH:mm' local. The tool composes the timestamp, not the model.

cancel_event({ event_id, reason? })

reschedule_to_free_slot({
  event_id,
  search_from: string,               // YYYY-MM-DD
  search_days: number,               // how far to look
  prefer: 'morning' | 'afternoon' | 'evening' | 'any'
})
// The TOOL does the slot-finding search, not the model. Model just says
// "find gym a new home this week." Tool returns candidate slots in the diff.

set_pantry({ items: [{ name, qty, unit }] })

plan_meal({ week_of, recipe_id, cook_date, servings })

get_schedule({ start_date, end_date })   // read-only, no proposal needed
get_meals({})                            // read-only, no proposal needed — imported meals + suites
```

Read-only tools skip the proposal flow entirely and return straight to chat.
Only mutations create proposals.

### System prompt (write it in full, don't paraphrase)

Tell the model, explicitly:
- It is a scheduling assistant for one person, Sai, a UT Austin junior.
- It **cannot** move events marked `pinned` (classes, exams). If asked, it should
  propose moving the *other* things around them instead.
- It **must not** compute timestamps. It emits deltas and durations.
- If a request is ambiguous ("move stuff back"), it asks one clarifying question
  rather than guessing.
- Current date/time is injected, always.

Then, separately, the validator enforces all of it anyway. The prompt is a
performance optimization, not a safety mechanism.

---

## 5. The validator

`packages/core/validator.ts`. **Pure function. No DB access. No I/O.** Takes a
proposed event list and a constraint set, returns conflicts. This is the file you
unit-test the hell out of, and it's the reason the app is trustworthy.

```ts
type Conflict =
  | { type: 'pinned_moved';    event_id: string }
  | { type: 'overlap';         a: string; b: string; minutes: number }
  | { type: 'no_commute';      from: string; to: string; gap_minutes: number }
  | { type: 'constraint';      rule: string; message: string }
  | { type: 'orphaned_meal';   date: string; message: string }

validate(events: Event[], constraints: Constraints): Conflict[]
```

**Severity matters.** Split conflicts into:
- `blocking` — proposal cannot be approved. Only: `pinned_moved`.
- `warning` — user can approve anyway, with a visible "yes, I know" checkbox.
  Everything else. A 15-minute overlap between gym and cooking is *your call*,
  not the app's.

Do not make the app paternalistic. It surfaces, you decide.

`orphaned_meal` is the interesting one: if the assistant cancels a cook session on
Tuesday, the Wednesday and Thursday lunches that session was covering now have no
food. The validator catches that. This is the single highest-value check in the
whole app and it's the thing Google Calendar can never do for you.

---

## 6. Constraints (`config/constraints.ts`, editable by hand)

Not in the DB. A TS file you edit in the repo. Typed, version-controlled, and you
will tweak it constantly.

```ts
export const constraints = {
  classes: { pinned: true },

  commute: {
    // minutes needed between any two events at different locations
    default: 15,
    // location comes from event.notes or a location field — keep it dumb,
    // just a string match on campus building codes
  },

  gym: {
    target_per_week: 4,
    duration_minutes: 90,
    // never schedule gym immediately after a cook session
    not_after_kinds: ['cook'],
    preferred_windows: ['06:30-08:30', '16:00-19:00'],
  },

  cook: {
    // Sai cooks lunch every OTHER day. One session = 2 days of lunch.
    cadence_days: 2,
    duration_minutes: 60,
    covers_next_lunches: 2,
    preferred_windows: ['18:00-21:00'],
  },

  meals: {
    breakfast: 'batch',   // overnight protein prep, made once, no daily event
    lunch:     'cook',    // from meal_plan
    dinner:    'out',     // NOT SCHEDULED. Never generate a dinner event.
                          // Never put dinner ingredients on the grocery list.
  },

  sleep: { protect: '00:00-07:00' },  // nothing scheduled here, ever
}
```

**The `dinner: 'out'` line is load-bearing.** Every generic meal-planning app will
try to give you 21 meals a week. This app gives you 7 lunches and a fridge full of
breakfast, because that's what you actually do.

---

## 7. Meals v2 (supersedes the original grocery derivation)

> The original §7 specified `deriveGroceries` — meal-plan ingredients scaled by
> servings, minus pantry, grouped by category. That whole system (recipe parser,
> meal_plan, pantry, grocery_extra, the Groceries tab) was scrapped on
> 2026-07-20 at Sai's request and replaced with the model below. Code comments
> that cite "SPEC §7 v2" mean this section.

Meals are imported BY THE AI from recipes Sai pastes into chat (`import_meals`):
each dish becomes a `meal` row — name, `meal_type` ('breakfast' | 'lunch'), and
its ingredient lines kept **verbatim** (no parsing, no units, no scaling; the
Meals tab lists these lines as the shopping list). A paste containing both a
breakfast and a lunch is pairs into a `meal_suite` automatically, inside the
tool. `create_suite` pairs already-imported meals by loose name.

A cook block on the calendar carries at most one `cook_assignment` per
`(event_id, date)`: a suite (cooking both meals) or a single meal, assigned from
the block's popover on the week grid (direct CRUD, not a proposal — it moves no
time). The block's subtitle and "View details" derive from the assignment (I5).
For a STANDALONE cook event the assignment follows the block across day-drags:
reads fall back to the event's single assignment and writes replace event-wide.

Deletion is the only local mutation on the Meals tab; deleting a meal cascades
through the suites built on it and their assignments (in code — SQLite FKs are
not enforced).

---

## 8. Recipe import (the manual-but-not-painful path)

You said you'd import these yourself. Make it two clicks, not a form.

**Primary: paste-and-parse.**
Textarea. You paste a recipe as plain text from anywhere. Local model parses it
into the `recipe` + `ingredient` schema. Shows you a **structured preview**, which
is a form you can edit inline before saving. Model gets it 85% right, you fix the
15%, hit save. This is fast, and importantly the model here is doing *extraction*,
not generation — which is exactly what an 8B is good at.

**Secondary: URL paste.** Fetch the page, look for JSON-LD `schema.org/Recipe`
(most recipe sites emit it), parse it directly with zero model involvement. If
there's no JSON-LD, strip the HTML to text and fall back to paste-and-parse above.

**Tertiary: raw form.** Always available. Sometimes you just want to type "chicken
+ rice + broccoli, 4 servings."

Do not build a recipe search agent. You explicitly don't want one.

---

## 9. UI

Four screens. Resist adding a fifth.

**Week** (default) — 7-column grid, time on the Y. Classes rendered in a locked,
visually-distinct treatment (they cannot move; the UI should *feel* that — no drag
handle, muted, maybe a subtle lock glyph). Gym/cook/personal are draggable, and
dragging fires the same `shift_events` proposal flow as chat does. **The drag and
the chat must go through the identical code path.** No shortcuts.

**Chat** — right-hand panel, always visible on desktop, bottom sheet on phone.
When a proposal comes back, it renders as a **diff card** inline in the chat:

```
┌─────────────────────────────────────┐
│  Shift Tuesday · +60 min            │
│                                     │
│  Gym          16:00 → 17:00         │
│  Cook         18:30 → 19:30         │
│  ─────────────────────────────────  │
│  CS 429       14:00    (pinned)     │
│                                     │
│  ⚠ Cook now ends 20:30, 30 min      │
│    past your preferred window       │
│                                     │
│  [ Approve ]  [ Reject ]  [ Edit ]  │
└─────────────────────────────────────┘
```

Pinned events shown greyed *in* the diff, so you can see what the assistant
correctly refused to touch. That's how you build trust in it.

**Meals** (screen) — imported meals with their verbatim ingredient lines (the shopping list), suites, delete-only. Superseded description (was Groceries): the derived list, grouped by category, with a "why is this here"
affordance: tap any item → shows which recipe(s) it came from and in what
quantity. Checkboxes are local UI state, cleared each week. Sub-tab for `extras`.

**Meal plan** — the week's cook sessions, which lunches each covers, and the
recipe library. Big obvious "Import recipe" button.

### Mobile

Same Next.js app, responsive. Add a `manifest.json` and iOS meta tags so
"Add to Home Screen" gives you a real standalone app. Do not build a separate
React Native client. The phone's job is: check today, ask the assistant to move
something, read the shopping list at HEB. That's it, and a PWA does it fine.

---

## 10. Build order

Do not build these out of order. Each phase is independently useful, and if you
stop after any of them you still have a working thing.

**Phase 0 — Skeleton.** Monorepo, Drizzle schema, SQLite, Bun/Hono API with
health check, Next.js app, Tauri wrapping it. `bun dev` brings up everything.
Verify from the second Mac over Tailscale before writing a single feature.

**Phase 1 — Calendar, no AI.** Semester setup wizard. Manual class entry with a
weekly recurrence pattern. Week view. Drag-to-move with the validator wired in.
**Onboarding asks the meal-pattern question** (cook cadence, which meals are out,
gym target) and writes it to a local config — do not hardcode Sai's answers into
the app, hardcode them into the *defaults*.

**Phase 2 — The validator.** Pure. Fully unit-tested. `pinned_moved`, `overlap`,
`no_commute`, `orphaned_meal`. Write the tests first; this file is the trust
anchor for everything after it.

**Phase 3 — Recipes + groceries.** Import (all three paths). Meal plan. Derived
grocery list. Unit normalization with the flag-don't-guess behavior. Still no AI
in the loop except for recipe *extraction*.

**Phase 4 — The agent.** Ollama client, tool schemas, dry/commit tools, proposal
table, diff cards, approve/reject. This is last on purpose: by now the tools and
validator already exist and are tested, so the agent is a thin layer that calls
them. If you build the agent first, you'll build the tools badly to suit it.

**Phase 5 — Polish.** Tray icon, native notifications ("cook session in 30 min"),
PWA manifest, iOS home-screen icon.

---

## 11. Things to explicitly not build

Cutting these is a design decision, not a scoping compromise.

- **Auth / login / users.** Tailscale is the boundary. One user.
- **Cloud sync, Postgres, hosted deployment.** It runs on your Mac.
- **Google Calendar two-way sync.** Enormous complexity, and it inverts the trust
  model — the whole point is that *this* app owns the schedule.
- **A recipe-search agent.** You said you'd import manually. Believe yourself.
- **Dinner planning.** You eat out. 
- **Nutrition/macro tracking.** Different app. Scope creep with a bow on it.
- **A unit-conversion engine.** Alias map + flag ambiguity. Move on.
- **Streaming token-by-token in chat.** The output is a tool call, not prose.
  Show a spinner, then show the diff card. Streaming here is pure vanity.

---

## 12. Definition of done

- [ ] Ollama on desktop Mac; `curl` from MacBook over Tailscale returns a schedule.
- [ ] iPhone home-screen icon opens the week view offline-tolerantly.
- [ ] "Shift everything after 3pm tomorrow back an hour" → diff card → approve →
      calendar updates → **CS 429 did not move**.
- [ ] Paste a breakfast + lunch recipe into chat → import_meals lands both on the
      Meals tab with verbatim ingredients and pairs them into a suite → click a
      cook block → assign the suite → the block's subtitle shows it and View
      details lists both meals' ingredients.
- [ ] `proposal` table has a row for every mutation ever made, with the tool name,
      args, and diff.
