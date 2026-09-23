/**
 * Drizzle schema, SQLite. (SPEC §3)
 * Timestamps are wall-time strings `YYYY-MM-DDTHH:mm` in the semester
 * timezone — readable by hand, lexicographically sortable. Dates `YYYY-MM-DD`.
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const semester = sqliteTable('semester', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  start_date: text('start_date').notNull(),
  end_date: text('end_date').notNull(),
  timezone: text('timezone').notNull().default('America/Chicago'),
});

export const event = sqliteTable(
  'event',
  {
    id: text('id').primaryKey(),
    semester_id: text('semester_id')
      .notNull()
      .references(() => semester.id),
    title: text('title').notNull(),
    kind: text('kind', {
      enum: ['class', 'gym', 'cook', 'meal', 'personal', 'commute'],
    }).notNull(),
    starts_at: text('starts_at').notNull(),
    ends_at: text('ends_at').notNull(),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /** RFC5545 string for the weekly class pattern, e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR */
    rrule: text('rrule'),
    source: text('source', { enum: ['manual', 'agent', 'recurring'] }).notNull(),
    location: text('location'),
    notes: text('notes'),
    /** Palette key (see types.ts EVENT_COLORS). Null = the kind's default color.
     *  Cosmetic only — never affects scheduling, validation, or derivation. */
    color: text('color'),
    /** For gym events: which session of the split this is (config/workouts.ts).
     *  The block shows its name; the details view lists the lifts. */
    workout: text('workout'),
  },
  (t) => [index('event_starts_at_idx').on(t.starts_at), index('event_semester_idx').on(t.semester_id)],
);

/** How a single instance of a recurring event gets moved or cancelled. */
export const eventException = sqliteTable(
  'event_exception',
  {
    id: text('id').primaryKey(),
    event_id: text('event_id')
      .notNull()
      .references(() => event.id),
    /** The YYYY-MM-DD of the original occurrence being overridden. */
    original_date: text('original_date').notNull(),
    status: text('status', { enum: ['moved', 'cancelled'] }).notNull(),
    /** For status 'moved': the standalone event row holding the new time. */
    override_event_id: text('override_event_id'),
  },
  (t) => [index('exception_event_idx').on(t.event_id, t.original_date)],
);

/** A breakfast or lunch Sai pasted into chat, imported by the AI (import_meals).
 *  Ingredients are plain lines kept verbatim — the Meals tab lists them as the
 *  shopping list. */
export const meal = sqliteTable(
  'meal',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    meal_type: text('meal_type', { enum: ['breakfast', 'lunch'] }).notNull(),
    /** JSON string[] — ingredient lines exactly as given. */
    ingredients: text('ingredients', { mode: 'json' }).$type<string[]>().notNull(),
    details: text('details').notNull().default(''),
    created_at: text('created_at').notNull(),
  },
  (t) => [index('meal_name_idx').on(t.name)],
);

/** A breakfast + lunch pairing. Created by the AI when a paste contains both,
 *  or on request ("make a suite of X and Y"). */
export const mealSuite = sqliteTable('meal_suite', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  breakfast_meal_id: text('breakfast_meal_id')
    .notNull()
    .references(() => meal.id),
  lunch_meal_id: text('lunch_meal_id')
    .notNull()
    .references(() => meal.id),
  created_at: text('created_at').notNull(),
});

/** What a specific cook block is cooking: one row per (event_id, date),
 *  pointing at a suite (cooking both meals) or a single meal. Assigned from the
 *  cook block's popover on the week grid. */
export const cookAssignment = sqliteTable(
  'cook_assignment',
  {
    id: text('id').primaryKey(),
    event_id: text('event_id').notNull(),
    /** YYYY-MM-DD of the cook instance this feeds. */
    date: text('date').notNull(),
    suite_id: text('suite_id').references(() => mealSuite.id),
    meal_id: text('meal_id').references(() => meal.id),
    created_at: text('created_at').notNull(),
  },
  (t) => [index('cook_assignment_evt_idx').on(t.event_id, t.date), index('cook_assignment_date_idx').on(t.date)],
);

/** The spine of the app. Audit log — never delete rows. (SPEC §3) */
export const proposal = sqliteTable(
  'proposal',
  {
    id: text('id').primaryKey(),
    created_at: text('created_at').notNull(),
    user_message: text('user_message').notNull(),
    tool_name: text('tool_name').notNull(),
    tool_args: text('tool_args', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    diff: text('diff', { mode: 'json' }).notNull(),
    conflicts: text('conflicts', { mode: 'json' }).notNull(),
    status: text('status', {
      enum: ['pending', 'approved', 'rejected', 'expired'],
    }).notNull().default('pending'),
    applied_at: text('applied_at'),
  },
  (t) => [index('proposal_status_idx').on(t.status)],
);

export const chatMessage = sqliteTable(
  'chat_message',
  {
    id: text('id').primaryKey(),
    proposal_id: text('proposal_id'),
    role: text('role', { enum: ['user', 'assistant', 'system', 'tool'] }).notNull(),
    content: text('content').notNull(),
    created_at: text('created_at').notNull(),
  },
  (t) => [index('chat_created_idx').on(t.created_at)],
);

/** Sai's gym split, now EDITABLE (the AI can add days/lifts/loads). One row
 *  (id 1) holding the whole split as JSON; seeded from config/workouts.ts the
 *  first time it's read. Kept whole so an edit is one snapshot to undo. */
export const workoutSplit = sqliteTable('workout_split', {
  id: integer('id').primaryKey(),
  data: text('data').notNull(),
});

/** Standing scheduling PREFERENCES (id 1) — Sai's durable rules the reflow
 *  engine and validator read: ordering ("cook before gym"), preferred windows,
 *  buffers. One JSON row, seeded from config/constraints.ts the first time it's
 *  read, edited by set_preference, undone as one snapshot. */
export const preferences = sqliteTable('preferences', {
  id: integer('id').primaryKey(),
  data: text('data').notNull(),
});

/** Lightweight point-in-time reminders — a day + time + label. NOT calendar
 *  blocks (no duration, never reflowed); they paint as a small "R" marker on the
 *  week grid. Added from the Reminders tab, deleted by hovering the marker. */
export const reminder = sqliteTable(
  'reminder',
  {
    id: text('id').primaryKey(),
    /** YYYY-MM-DD (wall date). */
    date: text('date').notNull(),
    /** HH:mm (wall time of day). */
    time: text('time').notNull(),
    /** What to be reminded of. */
    title: text('title').notNull(),
    created_at: text('created_at').notNull(),
  },
  (t) => [index('reminder_date_idx').on(t.date)],
);

/** One internship listing on the Internships board, pulled from a community
 *  aggregator feed (internships.ts). `id` is `${source}:${feed id}`. Unlike the
 *  rest of the app, timestamps here are full ISO 8601 UTC strings — the feeds
 *  give unix seconds and these dates are global, not semester wall-time.
 *  Listings that close are kept with active=false, never deleted — tracked
 *  applications to closed roles must persist. */
export const internship = sqliteTable(
  'internship',
  {
    id: text('id').primaryKey(),
    /** Which feed this came from ('simplify' | 'vanshb03' | future sources). */
    source: text('source').notNull(),
    company: text('company').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    /** JSON string[] — e.g. ["San Francisco, CA", "Remote"]. */
    locations: text('locations', { mode: 'json' }).$type<string[]>().notNull(),
    /** JSON string[] — e.g. ["Summer 2026"]. */
    terms: text('terms', { mode: 'json' }).$type<string[]>().notNull(),
    /** Normalized: Software | AI/ML/Data | Hardware | Product | Quant | … */
    category: text('category').notNull(),
    sponsorship: text('sponsorship'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    date_posted: text('date_posted').notNull(),
    date_updated: text('date_updated').notNull(),
    /** When a sync first saw this listing. Preserved across upserts. */
    first_seen: text('first_seen').notNull(),
  },
  (t) => [
    index('internship_company_idx').on(t.company),
    index('internship_posted_idx').on(t.date_posted),
    index('internship_active_idx').on(t.active),
  ],
);

/** Sai's application pipeline for a listing: interested → applied → oa →
 *  interview → offer/rejected/ghosted. At most one row per internship;
 *  untracking deletes the row. */
export const internshipApplication = sqliteTable('internship_application', {
  internship_id: text('internship_id')
    .primaryKey()
    .references(() => internship.id),
  status: text('status', {
    enum: ['interested', 'applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted'],
  }).notNull(),
  notes: text('notes'),
  /** Stamped the first time status becomes 'applied'; kept thereafter. */
  applied_at: text('applied_at'),
  updated_at: text('updated_at').notNull(),
});

/** Per-feed sync bookkeeping: the last GitHub commit sha of the listings file
 *  (so an unchanged 11 MB feed is never re-downloaded) and when we last
 *  synced. */
export const internshipSource = sqliteTable('internship_source', {
  source: text('source').primaryKey(),
  last_commit_sha: text('last_commit_sha'),
  last_synced: text('last_synced'),
  etag: text('etag'),
});
