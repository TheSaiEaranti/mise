# DESIGN.md — Visual & interaction system

Read this before writing a single component. Every rule here exists to serve one
idea; if a choice doesn't serve it, cut the choice.

---

## The thesis

**White, quiet, and near-empty. Depth is the only signal — and it encodes exactly
one thing: what can move and what can't.**

Pinned events (classes, exams) are *inset* — recessed into the grid, cooler,
with a hairline rule. Movable events (gym, cook, personal) are *raised* — pure
white cards floating on the grid with a whisper of shadow.

You learn the entire interaction model by looking at it once. No lock icons. No
legend. No color-coding chart. No tooltip explaining what the colors mean. The
surface itself tells you: things that sit *in* the page don't move; things that
sit *on* the page do.

That is the signature. Spend the design budget there and nowhere else.

---

## Why not just do Apple

"Apple-like" gets built as SF Pro + rounded rects + `#007AFF` + a lot of `#8E8E93`
grey. That's the visual language of a Settings pane — a list of controls you
configure. This is not that. This is a spatial document you read at a glance from
across a desk while eating cereal.

So we take from Apple the things that are actually principles — restraint,
generous whitespace, deference to content, real materials, one accent used
sparingly — and we reject the things that are just *Apple's chrome*, because the
chrome was designed for a different job.

Specifically:

- **No iOS blue.** `#007AFF` on white is the single most generic pairing in
  software. It signals "I picked a default."
- **No pill buttons, no 12px+ radii.** Soft-rounded everything makes a calendar
  read as toy-like and makes dense time blocks look mushy where they abut.
- **No grey-on-grey secondary text at 60% opacity.** That's how you get an
  interface that's technically clean and completely unreadable in sunlight on the
  walk to Gregory Gym.

---

## Tokens

### Color

Six values. That's the whole palette. If you find yourself needing a seventh,
you're solving the wrong problem.

```css
--paper:     #FFFFFF;   /* the page. everything sits on this. */
--recessed:  #F2F4F7;   /* pinned event fill. cool, slightly blue-grey.
                           reads as "carved out of" the paper. */
--rule:      #E7E9EC;   /* grid lines, dividers, card borders. hairlines only. */
--ink:       #16181D;   /* primary text. near-black, never pure #000. */
--ink-soft:  #6B7280;   /* secondary text. times, labels, metadata.
                           WCAG AA on paper. do not go lighter. */
--ink-lock:  #3E4A5C;   /* text inside pinned events. cool-shifted to match
                           the recessed surface. */

--signal:    #C2410C;   /* THE accent. burnt orange. used ONLY for:
                           - "now" line on the grid
                           - unapproved proposal diff highlights
                           - blocking conflicts
                           nothing else. not links. not buttons. not focus.
                           if it's orange, it means "look here, now." */
```

**On the accent:** burnt orange because you go to UT and it costs nothing to be
specific rather than generic. But it is used *ruthlessly sparingly* — a 2px "now"
line and a conflict badge. If more than ~1% of pixels are orange, it stops
meaning anything.

### Event color — a second channel, not a replacement

> **Revised.** The original rule here was "do not add colors per event kind —
> gym is not green." Sai overrode it: with a real week loaded, six identical
> white cards are hard to scan at a glance. Color now identifies *what* a block
> is. It does **not** identify what can move.

The eight-value event palette (`EVENT_COLORS` in `packages/core/src/types.ts`)
is a **second, subordinate channel**. Depth still carries the invariant:

- **Pinned** events keep the recessed treatment — tinted fill, 2px left spine,
  inset shadow, no drag handle, `cursor: default`.
- **Movable** events keep the raised treatment — tinted fill, hairline border,
  drop shadow, `cursor: grab`.

The test that keeps this honest: **turn every event the same color and the app
must still be fully legible** — you still know instantly what can move. Color is
an accelerant for scanning, never the carrier of meaning. Each palette entry is
a tint (`fill`), a spine (`line`), and a text color (`ink`) that clears 4.5:1 on
its own fill; nothing in the palette approaches `--signal`, so the now-line and
conflict badges stay the only orange on screen.

Color is **cosmetic metadata**: recoloring changes no time, no pin, and nothing
derived, so it saves directly instead of filing a proposal — the same carve-out
recipes and grocery checkboxes already have. Only *time* is under the proposal
flow, and on pinned events only time is locked.

### Depth

The entire visual system, in three values:

```css
/* raised — movable events. sits ON the paper. */
--lift: 0 1px 2px rgba(22, 24, 29, 0.04),
        0 2px 8px rgba(22, 24, 29, 0.04);

/* raised, active — while dragging */
--lift-drag: 0 4px 12px rgba(22, 24, 29, 0.08),
             0 12px 32px rgba(22, 24, 29, 0.06);

/* recessed — pinned events. sits IN the paper. */
/* the inset shadow is subtle; the real signal is the fill + the left rule. */
--inset: inset 0 1px 2px rgba(62, 74, 92, 0.06);
```

Pinned events also get `border-left: 2px solid var(--ink-lock)`. That rule is the
thing your eye actually catches. It reads as a tab, a spine, a *fixed point*.

Movable events get `border: 1px solid var(--rule)` and no left rule.

### Radius

```css
--r: 6px;    /* everything. events, cards, buttons, inputs. */
```

One value. 6px is sharp enough that adjacent time blocks read as a clean column,
soft enough that it doesn't feel like a spreadsheet. Do not introduce a second
radius. Do not use `rounded-full` on anything except the avatar you're not going
to build.

### Type

Two faces. Both are workhorses, neither is decorative, and the pairing is doing
real work.

```css
--font-ui:  'Inter Tight', system-ui, sans-serif;
--font-num: 'IBM Plex Mono', ui-monospace, monospace;
```

**Inter Tight**, not Inter. Slightly condensed, which matters enormously in a
7-column week grid where "Intro to Machine Learning" has to fit in ~120px. It's
also just far enough from SF/Inter-classic that the app doesn't read as generic.

**IBM Plex Mono** for *every number that represents time or quantity*: the hour
gutter, event start/end times, grocery quantities, the diff card's before→after.
Tabular figures mean times align vertically down the gutter — a column of
`9:30 / 10:00 / 10:30` where the digits actually stack. This is the single
highest-value typographic decision in the app and it costs you nothing.

Scale — five sizes, no more:

```
display   28px / 600 / -0.02em    screen titles ("Week of Mar 3")
body      15px / 500 / -0.01em    event titles, chat, list items
label     13px / 500 / -0.005em   secondary text, categories, day headers
time      12px / 500 / mono       event times, grid gutter, quantities
micro     11px / 600 / 0.04em     eyebrows. UPPERCASE. use ~3 times total.
```

Uppercase the day-of-week headers (`MON  TUE  WED`) and nothing else in the
interface. That one uppercase row gives the grid a top edge and a rhythm, and
because it's the only uppercase thing, it doesn't compete.

### Space

4px base. Only these values: `4 · 8 · 12 · 16 · 24 · 40 · 64`.

Be generous. When in doubt, go up one step. The app should feel underfull. A
week with four events should look calm, not sparse-and-broken.

---

## Component rules

### Buttons

You said no complicated buttons, and the honest answer is: **the app barely has
any.** Count them:

- `Approve` / `Reject` on a proposal card
- `Add event` (a `+`, in the corner)
- Week `←` / `→`

(`Import recipe` is gone with the Groceries feature — recipes are pasted into
chat and the AI imports them onto the Meals tab.)

That's it. Four places. So they can be dead simple:

```
Primary   → ink fill, paper text, 6px radius, 36px tall
Secondary → paper fill, rule border, ink text
Ghost     → text only, no border, no fill
```

No icon-only buttons except the week arrows and the `+`. No button groups. No
dropdowns. No kebab menus. If you catch yourself building a `<Menu>`, stop —
that's the moment the design breaks. The chat panel *is* the menu. Anything you'd
put in a dropdown, you should just be able to type.

### The grid

**The whole day fits on screen.** 06:00–24:00, no scrolling. The grid measures
its container and derives px-per-minute from the height available, rather than
fixing an hour height and letting the day run off the bottom — you should be
able to take in the entire day from across the desk without touching anything.
Blocks shed detail as they shrink (title + time + location → title + time →
title), and never shrink their type below the scale.

- Hairline `--rule` lines, 1px, at each hour. Half-hours get nothing.
- Hour labels in the left gutter, mono, `--ink-soft`, right-aligned, 12px.
- Day headers: uppercase micro, `--ink-soft`. Today's column header is `--ink`
  and 600 weight. That's the only "today" treatment in the header — no pill, no
  circle, no background.
- The **now line**: 2px, `--signal`, full width of today's column, with a 5px dot
  at the left edge. This is one of two places orange appears. It should be the
  first thing your eye finds.
- Grid background is `--paper`. Not off-white. Not `#FAFAFA`. White.

### Events

```
PINNED (class)                    MOVABLE (gym, cook, personal)
┌─────────────────────┐           ┌─────────────────────┐
│▌ CS 429             │           │  Gym                │   ← lifted, white
│▌ 14:00 – 15:30      │           │  16:00 – 17:30      │      1px rule border
│▌ GDC 2.216          │           │                     │      no left spine
└─────────────────────┘           └─────────────────────┘      grab cursor
  recessed fill                     drop shadow
  2px left spine                    hover: shadow deepens
  cursor: default                   drag: --lift-drag + 2° tilt
  no drag handle
```

The 2° tilt on drag is the one bit of personality. It makes the card feel like a
physical thing you've picked up off the page. Everything else about motion is
restrained, so this lands.

**Drag is 2D, and dropping applies.** A movable block can be dragged to any time
on any day — the card follows the pointer and snaps to (day column, 15-minute
step). A cross-day move is still pure *intent*: it becomes a `delta_minutes`
(Tue 17:00 → Thu 18:00 is `+2940`), so the tool still owns every timestamp (I3).

> **Revised.** Drops used to bounce back and wait for an Approve click in chat.
> That is the right ceremony for a sentence you typed — the model might have
> misread you — but it is the wrong ceremony for a block you physically put
> somewhere. You already said exactly what you meant, with your hand. Making you
> confirm it twice reads as the app not trusting the mouse.

So a drop **applies**: the block lands where you put it. It still files a real
proposal — validated, transactional, written to the audit log — and it is still
*refused outright* if it would touch a pinned event or raise a blocking
conflict, in which case the block snaps home and the card in chat explains why.
Dragging **is** the approval. Warnings the validator raised ("ends 210 min past
your gym window") appear on one `--ink-soft` line under the header with a ghost
**Undo** — surfaced, not blocking. Typed requests still go through the diff card,
because there the model's reading of you is the thing worth checking.

**Click a block to recolor it.** A click (not a drag — past the 4px slop it's a
drag) opens a small raised popover of swatches, anchored to the block. Not a
modal, no backdrop. Pinned blocks recolor too: color is cosmetic, only time is
locked.

Title on line 1, time on line 2 (mono), location on line 3 if present and if the
block is tall enough. Under 30 minutes, title only — truncate, don't shrink.

### The diff card

This is the most important component in the app. It is where you decide whether
to trust the assistant, and it appears inline in the chat.

```
┌───────────────────────────────────────┐
│  Shift Tuesday                        │   ← body weight
│  Everything after 15:00, +1 hour      │   ← label, ink-soft
│                                       │
│  Gym          16:00 → 17:00           │   ← mono. arrow is ink-soft.
│  Cook         18:30 → 19:30           │      new time in --signal
│                                       │
│  ─────────────────────────────────    │
│  ▌ CS 429     14:00      unchanged    │   ← recessed row, ink-lock.
│                                       │      SHOW the thing it didn't
│  ⚠ Cook ends 20:30, past your         │      touch. this is how trust
│    preferred window                   │      gets built.
│                                       │
│  [ Approve ]        Reject            │   ← primary + ghost
└───────────────────────────────────────┘
```

Rules:
- Changed values render in `--signal`. Old values in `--ink-soft` with the arrow.
- **Always render the pinned rows it left alone**, in their recessed treatment,
  labeled `unchanged`. Omitting them would be tidier and would be a mistake — you
  need to *see* that it respected the lock, every single time, or you'll never
  stop double-checking the calendar by hand.
- Warnings: `--ink-soft` text, `--signal` glyph. Non-blocking, approve anyway.
- Blocking conflicts: the `Approve` button is disabled and the reason sits where
  the button would be. Never show an enabled button that will fail.

### Chat

Right panel, ~360px, hairline `--rule` divider, `--paper` background — same white
as the calendar, no tinted sidebar. It's one continuous surface.

User messages: right-aligned, `--recessed` fill, 6px radius.
Assistant: left-aligned, no bubble, no fill. Just ink on paper. The assistant
doesn't need a container; it's the app talking to you.

Single input at the bottom. No send button — Enter sends. No attachment icon, no
slash-command menu, no model picker, no token counter.

While thinking: a single `--ink-soft` pulsing dot. Not three bouncing dots. Not
a skeleton. Not streaming tokens — the output is a tool call, and streaming a
tool call is theater.

### Meals (was: Groceries — that screen is deleted)

The Meals tab lists what the AI imported from pasted recipes: suites first, then
breakfasts and lunches, each meal's ingredient lines verbatim underneath (that
IS the shopping list — no checkboxes, no derivation). Delete is the only local
action. A cook block's suite is assigned from the block's popover on the week
grid, and shows as the block's subtitle.

> **Revised.** A collapsible Daily targets panel (Sai's macro/vitamin/mineral sheet, verbatim, plus per-suite coverage and combo-macros lines) now sits above Suites; the meal lists collapse — closed on first visit, open state kept per session.

---

## Motion

```css
--ease: cubic-bezier(0.32, 0.72, 0, 1);   /* the only easing curve */
--fast: 120ms;    /* hover, press */
--base: 200ms;    /* cards appearing, panels */
--slow: 320ms;    /* view transitions, diff card entrance */
```

Where motion is allowed:
1. Diff card entrance — fade + 8px rise, `--slow`. It's an arrival; give it weight.
2. Drag — the 2° tilt and shadow bloom, `--fast`.
3. Approve — the card collapses, and the affected events *slide* to their new
   position over `--slow`. **Do not re-render them into place.** Watching the
   blocks physically move is the confirmation that the thing you approved is the
   thing that happened.
4. Grocery check — 120ms strikethrough draw.

That's four. Nothing else animates. No page transitions, no stagger, no parallax,
no skeleton shimmer. Honor `prefers-reduced-motion` by cutting all four to 0ms.

---

## Mobile

Same app, one column, no grid. The week view collapses to a day list.

- Day list, vertical, generous. Pinned/movable distinction survives intact — it's
  a fill-and-spine difference, and it works at any width.
- Chat becomes a bottom sheet, dragged up. Diff cards render identically.
- No drag-to-move on touch. On mobile you *tell* the assistant. That's the mode,
  and it's the right one — you're on the walk to class, not doing calendar surgery.
- Tap targets ≥ 44px. The 16px grocery checkbox gets a 44px hit area around it.

---

## The one-accessory rule

Before you ship any screen, remove one thing. There is always one.

Candidates you will be tempted by and must delete: a legend explaining what
recessed means (the design failed if it needs one), an "AI" badge on the chat
panel (you know what it is), event category icons, a semester progress bar, a
"3 events today" summary chip, an empty-state illustration.

**Empty states are one line of `--ink-soft` text, left-aligned, and nothing else.**
"No events Thursday." That's the whole component.

---

## Quality floor

- Every interactive element has a visible keyboard focus ring: 2px `--ink`,
  2px offset. Not orange — focus isn't urgent, it's just where you are.
- Contrast: `--ink-soft` on `--paper` is 4.9:1. Nothing lighter ships.
- The app must be fully usable at 320px wide.
- `prefers-reduced-motion` kills all four animations.
- No layout shift when the diff card appears — reserve the space.
