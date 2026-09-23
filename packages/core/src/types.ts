/**
 * Shared types for the whole app. This file is the contract between the
 * validator, the tools, the agent, the API, and the UI.
 *
 * TIME REPRESENTATION (read this before touching anything):
 * - Timestamps are ISO 8601 *wall time* strings in the semester timezone
 *   (America/Chicago): `YYYY-MM-DDTHH:mm`. No offset suffix, minutes precision.
 * - Dates are `YYYY-MM-DD`. Times of day are `HH:mm`.
 * - Fixed-width means lexicographic order == chronological order. String
 *   comparison is the sanctioned way to compare timestamps.
 * - All arithmetic goes through `time.ts`. Never `new Date()` math. (I3)
 */

export type EventKind = 'class' | 'gym' | 'cook' | 'meal' | 'personal' | 'commute';

// ---------------------------------------------------------------------------
// Event colors
//
// DESIGN.md originally forbade per-kind color ("Gym is not green") so that
// depth alone carried the pinned/movable signal. Sai asked for distinct colors,
// so color is now a SECOND channel — but depth still carries the meaning:
// pinned events stay recessed with a spine and no drag handle, movable ones
// stay raised. Color tells you WHAT a block is; depth still tells you whether
// it can move. Removing every color must leave the app fully legible.
//
// Each entry: `fill` is the block background (a light tint), `line` the spine /
// border accent, `ink` the text on that fill (all ≥ 4.5:1 on their own fill).
// ---------------------------------------------------------------------------

export type EventColor =
  | 'slate' | 'indigo' | 'teal' | 'green' | 'amber' | 'rose' | 'violet' | 'stone';

export interface ColorSpec {
  key: EventColor;
  label: string;
  fill: string;
  line: string;
  ink: string;
}

export const EVENT_COLORS: ColorSpec[] = [
  { key: 'slate',  label: 'Slate',  fill: '#F2F4F7', line: '#3E4A5C', ink: '#2E3846' },
  { key: 'indigo', label: 'Indigo', fill: '#EEF0FB', line: '#3F4CA8', ink: '#333F91' },
  { key: 'teal',   label: 'Teal',   fill: '#E7F3F2', line: '#0F6E68', ink: '#0C5B56' },
  { key: 'green',  label: 'Green',  fill: '#EBF3EC', line: '#2F6B3A', ink: '#275931' },
  { key: 'amber',  label: 'Amber',  fill: '#F7F1E3', line: '#8A6408', ink: '#725307' },
  { key: 'rose',   label: 'Rose',   fill: '#FAEDF0', line: '#9E3055', ink: '#862848' },
  { key: 'violet', label: 'Violet', fill: '#F3EEF9', line: '#6A3FA0', ink: '#593485' },
  { key: 'stone',  label: 'Stone',  fill: '#F1F0EE', line: '#57534E', ink: '#44403C' },
];

/** Default color per kind, used when an event has no explicit color. */
export const KIND_COLOR: Record<EventKind, EventColor> = {
  class: 'slate',
  gym: 'indigo',
  cook: 'green',
  meal: 'teal',
  personal: 'violet',
  commute: 'stone',
};

export function colorSpec(color: string | null | undefined, kind: EventKind): ColorSpec {
  const key = (color ?? KIND_COLOR[kind]) as EventColor;
  return EVENT_COLORS.find((c) => c.key === key) ?? EVENT_COLORS[0]!;
}

export function isEventColor(v: unknown): v is EventColor {
  return typeof v === 'string' && EVENT_COLORS.some((c) => c.key === v);
}
export type EventSource = 'manual' | 'agent' | 'recurring';
export type ExceptionStatus = 'moved' | 'cancelled';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export const EVENT_KINDS: EventKind[] = ['class', 'gym', 'cook', 'meal', 'personal', 'commute'];

// ---------------------------------------------------------------------------
// Event instances
// ---------------------------------------------------------------------------

/**
 * A concrete occurrence on the calendar. For non-recurring events this is the
 * event row itself; for recurring events (rrule != null) each expanded
 * occurrence becomes one instance. `instance_date` disambiguates which
 * occurrence of a recurring event this is.
 */
export interface EventInstance {
  event_id: string;
  /** YYYY-MM-DD of this occurrence (equals dateOf(starts_at)). */
  instance_date: string;
  title: string;
  kind: EventKind;
  starts_at: string;
  ends_at: string;
  pinned: boolean;
  location: string | null;
  notes: string | null;
  source: EventSource;
  /** True when this instance comes from an rrule expansion. */
  recurring: boolean;
  /** Palette key, or null to use the kind's default. Cosmetic only. */
  color: string | null;
  /** For gym events: which session of the split (config/workouts.ts key). */
  workout: string | null;
  /**
   * The second line of identity on a block: WHICH gym day this is ("Chest and
   * back"), WHAT is being cooked ("Chipotle Chicken Rice Bowls"). Derived, never
   * stored — see enrichInstances. Null when the block is just itself.
   */
  subtitle?: string | null;
  /** True when there is something to show behind "View details". */
  has_details?: boolean;
}

// ---------------------------------------------------------------------------
// Event details — what "View details" opens.
// ---------------------------------------------------------------------------

export interface DetailLine {
  /** Left column: the exercise, the ingredient. */
  label: string;
  /** Right column, mono: the load ("60*10*8"), the quantity ("2 lb"). */
  value?: string;
}

export interface DetailSection {
  heading: string;
  lines: DetailLine[];
}

export interface EventDetails {
  title: string;
  /** "Chest and back" · "Chipotle Chicken Rice Bowls" */
  subtitle: string | null;
  /** Tue · 4 – 5:30 PM */
  when: string;
  sections: DetailSection[];
  /** Free text under the sections (recipe method, notes). */
  body?: string | null;
}

/**
 * What the validator sees: a proposed instance, carrying its original times
 * when the proposal changes them. `original_*` unset means "not moved by this
 * proposal". `cancelled: true` means the proposal removes this instance.
 */
export interface ProposedInstance extends EventInstance {
  original_starts_at?: string;
  original_ends_at?: string;
  cancelled?: boolean;
  /** True when this instance is newly created by the proposal. */
  created?: boolean;
}

// ---------------------------------------------------------------------------
// Conflicts (SPEC §5)
// ---------------------------------------------------------------------------

export type Conflict =
  | { type: 'pinned_moved'; event_id: string; title: string }
  /**
   * The model targeted an event that is not the one it named. It copies an
   * event_id out of the schedule table, and it sometimes copies the wrong row:
   * asked to move "tomorrow's gym" on a day with no gym, it grabbed the cook
   * session instead. Nothing downstream could tell — an id is an id — so the
   * tool now makes the model state which event it THINKS it is moving, and
   * refuses when that doesn't match. Blocking: moving the wrong event silently
   * is the worst thing this app can do.
   */
  | { type: 'wrong_event'; event_id: string; expected: string; actual: string }
  /**
   * A moved/created event would land on a PINNED one. You cannot be at the gym
   * during CS 429, so this is not a judgement call and not a warning — it is a
   * refusal. (Two MOVABLE events colliding is different: the schedule just makes
   * room for them, see cascade.ts.)
   */
  | {
      type: 'double_booked';
      moving: string;
      moving_title: string;
      fixed: string;
      fixed_title: string;
      minutes: number;
    }
  /** Nothing could be pushed far enough to make room without running into the
   *  small hours. Blocking: silently shoving a cook session to 1am is not help. */
  | { type: 'no_room'; event_id: string; title: string; message: string }
  | { type: 'overlap'; a: string; b: string; a_title: string; b_title: string; minutes: number }
  | { type: 'no_commute'; from: string; to: string; from_title: string; to_title: string; gap_minutes: number }
  | { type: 'constraint'; rule: string; message: string; event_id?: string };

export type ConflictSeverity = 'blocking' | 'warning';

/**
 * Blocking conflicts are the ones the user cannot wave through, because they
 * mean the change is not the change anyone asked for:
 *   pinned_moved — it would move a class (I4)
 *   wrong_event  — it would move something other than what was named
 * Everything else is a judgement call and stays the user's. (SPEC §5)
 */
export function severityOf(c: Conflict): ConflictSeverity {
  return c.type === 'pinned_moved' ||
    c.type === 'wrong_event' ||
    c.type === 'double_booked' ||
    c.type === 'no_room'
    ? 'blocking'
    : 'warning';
}

/** Human-readable one-liner for a conflict, used by chat + diff cards. */
export function describeConflict(c: Conflict): string {
  switch (c.type) {
    case 'pinned_moved':
      return `${c.title} is pinned and cannot move`;
    case 'wrong_event':
      return `That's "${c.actual}", not "${c.expected}" — nothing was moved`;
    case 'double_booked':
      return `${c.moving_title} would land on ${c.fixed_title}, which can't move`;
    case 'no_room':
      return c.message;
    case 'overlap':
      return `${c.a_title} overlaps ${c.b_title} by ${c.minutes} min`;
    case 'no_commute':
      return `Only ${c.gap_minutes} min between ${c.from_title} and ${c.to_title} at different locations`;
    case 'constraint':
      return c.message;
  }
}

// ---------------------------------------------------------------------------
// Validator input (SPEC §5) — pure data, no DB handles.
// ---------------------------------------------------------------------------

export interface ValidationInput {
  /** Full proposed window: untouched instances as-is, touched ones carrying
   *  original_* / cancelled / created flags. */
  events: ProposedInstance[];
  constraints: import('@mise/config').Constraints;
}

// ---------------------------------------------------------------------------
// Diffs (what a Proposal renders as)
// ---------------------------------------------------------------------------

/** One event-level change inside a diff. before=null → created, after=null → cancelled. */
export interface EventChange {
  event_id: string;
  instance_date: string;
  title: string;
  kind: EventKind;
  pinned: boolean;
  /** For created instances: lets the commute check see the new location. */
  location?: string | null;
  before: { starts_at: string; ends_at: string } | null;
  after: { starts_at: string; ends_at: string } | null;
  /** Nobody asked for this one. It moved because the change needed the room —
   *  the gym slides later so the friends block fits. Shown in the diff as such,
   *  and undone with the rest of it. */
  knock_on?: boolean;
  /** For a repeating create: the human phrase for the pattern ("every other
   *  day"), so the reply and card say the series repeats, not just its first
   *  day. Absent for one-off changes. */
  recurrence?: string | null;
}

/** A pinned instance in the affected window that the proposal did NOT touch.
 *  Always rendered in the diff card, per DESIGN.md — that's how trust is built. */
export interface UnchangedPinned {
  event_id: string;
  instance_date: string;
  title: string;
  starts_at: string;
  ends_at: string;
}

/** Candidate slot returned by reschedule_to_free_slot. The first one is the
 *  slot the proposal will commit; the rest are alternatives for the UI. */
export interface SlotCandidate {
  date: string;
  start_time: string; // HH:mm
  end_time: string;   // HH:mm
}

/** A lightweight point-in-time reminder (day + time + label), painted as an "R"
 *  marker on the week grid. Pure data — shared by core, the API, and the web. */
export interface Reminder {
  id: string;
  date: string;
  time: string;
  title: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Meals — recipes Sai pastes into chat, imported by the AI (SPEC §7 v2).
//
// A meal is a breakfast or a lunch with a plain-text ingredient list (the
// shopping list on the Meals tab is just these lines). A suite pairs one
// breakfast with one lunch; a cook block on the calendar can be assigned a
// suite (cooking both) or a single meal. Pure data — shared by core, API, web.
// ---------------------------------------------------------------------------

export type MealType = 'breakfast' | 'lunch';

export interface Meal {
  id: string;
  name: string;
  meal_type: MealType;
  /** Ingredient lines exactly as given ("2 cups rice", "1 lb chicken"). */
  ingredients: string[];
  /** Free-text method / notes from the pasted recipe. */
  details: string;
  created_at: string;
}

export interface MealSuite {
  id: string;
  name: string;
  breakfast_meal_id: string;
  lunch_meal_id: string;
  created_at: string;
}

/** What a specific cook block on the calendar is cooking. One per
 *  (event_id, instance date); exactly one of suite_id / meal_id is set. */
export interface CookAssignment {
  id: string;
  event_id: string;
  date: string;
  suite_id: string | null;
  meal_id: string | null;
  created_at: string;
}

export interface Diff {
  /** Short human title, e.g. "Shift Tuesday · +60 min". */
  summary: string;
  /** Secondary line, e.g. "Everything after 15:00, +1 hour". */
  detail?: string;
  changes: EventChange[];
  unchanged_pinned: UnchangedPinned[];
  candidates?: SlotCandidate[];
  /** Human lines describing a gym-split edit ("Added Legs", "Chest and back →
   *  Bench press 125x8"). Shown on the card and in the reply. */
  workout_changes?: string[];
  /** The whole split BEFORE this edit — the snapshot Cmd-Z restores. Opaque
   *  JSON to the rest of the app; only undo.ts reads it back. */
  workout_before?: unknown;
  /** The split AFTER this edit — undo compares it to the live split and refuses
   *  if they differ, so undoing an old edit can't clobber a newer one. */
  workout_after?: unknown;
  /** A gym SESSION's workout label was changed (not the split). Holds the event
   *  and its before/after key so the reply reads right and Cmd-Z restores it. */
  workout_relabel?: { event_id: string; before: string | null; after: string | null };
  /** Human lines describing a standing-preferences edit ("cook before gym"). */
  pref_changes?: string[];
  /** The whole preferences object BEFORE / AFTER the edit — same snapshot-undo
   *  contract as workout_before/after (undo restores before, refuses if the live
   *  copy no longer matches after). Opaque JSON; only undo.ts reads them. */
  pref_before?: unknown;
  pref_after?: unknown;
  /** Sleep window ('HH:mm-HH:mm') BEFORE / AFTER a sleep-hours edit. Lives in the
   *  settings file, not the DB prefs, so undo restores it separately. */
  sleep_before?: string;
  sleep_after?: string;
  /** Human lines describing a reminder the AI set ("Call the bank · Thu 2 PM"). */
  reminder_changes?: string[];
  /** The id of the reminder created, so undo can delete it. */
  reminder_id?: string;
  /** Human lines describing imported meals / created suites
   *  ("Imported Overnight oats (breakfast) · 6 ingredients"). */
  meal_changes?: string[];
  /** Ids of meals CREATED by this proposal, so undo can delete them.
   *  (A re-import that updates an existing meal is not listed — undo won't
   *  restore the old ingredients, it only removes what the proposal added.) */
  meal_ids?: string[];
  /** Ids of suites created by this proposal, so undo can delete them. */
  suite_ids?: string[];
  /** Human lines describing an internship-application change
   *  ("Stripe — Software Engineering Intern: (untracked) → applied"). */
  application_changes?: string[];
  /** The internship whose application this proposal touched, so undo can find it. */
  application_internship_id?: string;
  /** The application row BEFORE / AFTER the change (null = not tracked) — same
   *  snapshot-undo contract as workout_before/after (undo restores before,
   *  refuses if the live row no longer matches after). Opaque JSON; only
   *  undo.ts reads them. */
  application_before?: unknown;
  application_after?: unknown;
}

/**
 * Does this diff actually apply anything? A tool that could not do its job
 * (no semester yet, unknown recipe, no free slot, target already gone) returns
 * a diff with nothing in it plus a constraint conflict explaining why.
 *
 * Such a proposal must never be approvable: committing it writes nothing, and
 * stamping it `approved` would put a lie in the audit log (SPEC §3) and show a
 * success state for a no-op. The UI also uses this to keep the Approve button
 * off — "never show an enabled button that will fail" (DESIGN.md).
 */
/**
 * Does the event the model targeted match the event it says it targeted?
 *
 * Deliberately forgiving about wording (it may say "gym" for "Gym", or copy the
 * full "Cook lunches") and unforgiving about identity: "gym" must not pass for
 * "Cook lunches". One string containing the other is enough; anything else is a
 * mismatch and the tool refuses.
 */
export function titlesMatch(expected: string, actual: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const e = norm(expected);
  const a = norm(actual);
  if (!e || !a) return false;
  return e === a || a.includes(e) || e.includes(a);
}

/**
 * Does this change actually change anything? A "move" whose after-times equal
 * its before-times is a no-op wearing a change's clothes — reschedule_to_free_slot
 * produced exactly that (it searched for a free slot, found the one the event was
 * already in, and reported "Gym 5 PM → 5 PM · applied"), so the user was told
 * their gym had been adjusted when nothing had happened.
 */
export function isRealChange(ch: EventChange): boolean {
  if (!ch.before || !ch.after) return true; // a create or a cancel is always real
  return ch.before.starts_at !== ch.after.starts_at || ch.before.ends_at !== ch.after.ends_at;
}

export function isActionable(diff: Diff): boolean {
  return (
    diff.changes.some(isRealChange) ||
    (diff.workout_changes?.length ?? 0) > 0 ||
    diff.workout_relabel !== undefined ||
    (diff.pref_changes?.length ?? 0) > 0 ||
    (diff.reminder_changes?.length ?? 0) > 0 ||
    (diff.meal_changes?.length ?? 0) > 0 ||
    (diff.application_changes?.length ?? 0) > 0
  );
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type ToolMode = 'dry' | 'commit';

export interface ToolResult {
  diff: Diff;
  conflicts: Conflict[];
}

/**
 * Every mutation tool is written ONCE and takes a mode flag (SPEC §4).
 * 'dry' computes the diff + conflicts without touching the DB.
 * 'commit' applies the diff inside a transaction. Commit MUST re-derive the
 * diff from current DB state (not trust the stored one) and re-validate.
 */
export interface MutationToolDef<A> {
  name: string;
  description: string;
  /** JSON Schema for Ollama's `tools` parameter (derived from zod). */
  parameters: Record<string, unknown>;
  /** Zod schema; agent loop parses args with this and retries once on failure. */
  argsSchema: import('zod').ZodType<A>;
  run(args: A, mode: ToolMode): Promise<ToolResult>;
  kind: 'mutation';
}

export interface ReadToolDef<A> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  argsSchema: import('zod').ZodType<A>;
  /** Read-only: returns data straight back to the chat, no proposal. */
  run(args: A): Promise<unknown>;
  kind: 'read';
}

export type AnyToolDef = MutationToolDef<any> | ReadToolDef<any>;

// ---------------------------------------------------------------------------
// Settings (onboarding answers; defaults live in config/constraints.ts)
// ---------------------------------------------------------------------------

export interface MealPattern {
  breakfast: 'batch' | 'cook' | 'out';
  lunch: 'batch' | 'cook' | 'out';
  dinner: 'batch' | 'cook' | 'out';
}

export interface UserSettings {
  cook_cadence_days: number;
  covers_next_lunches: number;
  gym_target_per_week: number;
  gym_duration_minutes: number;
  meals: MealPattern;
  onboarded: boolean;
}
