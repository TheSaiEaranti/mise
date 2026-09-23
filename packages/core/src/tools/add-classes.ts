/**
 * add_classes — append pinned weekly classes to the EXISTING semester.
 *
 * Two callers now. It is still the commit path for the schedule-photo import
 * (the vision model extracts a list, the user edits and approves, this writes
 * them). It is ALSO available to the chat model: Sai wanted the assistant able
 * to rebuild his schedule itself, classes and all, so "add my classes …" works
 * from chat. It creates pinned events — which I4 once reserved for user actions
 * — but that is a deliberate, scoped relaxation (prompt rule 5ak), fenced by the
 * overlap check below, the blocking-conflict refusal on apply, and undo.
 *
 * Unlike setup_semester it is additive: it never deletes anything.
 */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Conflict, Diff, EventChange, MutationToolDef, ProposedInstance } from '../types';
import { isEventColor, severityOf } from '../types';
import { getDb, schema } from '../db/client';
import { getSemester } from '../schedule';
import { newId } from '../proposals';
import { validate } from '../validator';
import { effectiveConstraints } from '@mise/config/settings';
import { DATE_RE, TIME_RE, addDaysWall, composeTs, weekMonday, weekdayCode } from '../time';

const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
const DAY_INDEX: Record<(typeof DAYS)[number], number> = {
  MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6,
};

export const ClassZ = z.object({
  title: z.string().min(1).max(80).describe('Course title, e.g. "CS 429 Computer Organization".'),
  days: z.array(z.enum(DAYS)).min(1).describe('Weekdays it meets.'),
  start_time: z.string().regex(TIME_RE).describe('HH:mm, 24-hour.'),
  end_time: z.string().regex(TIME_RE).describe('HH:mm, 24-hour.'),
  location: z.string().max(60).optional().describe('Building/room code, e.g. "GDC 2.216".'),
  color: z.string().optional().describe('Palette key. Omit for the default.'),
});

export type ParsedClass = z.infer<typeof ClassZ>;

const ArgsZ = z.object({
  classes: z.array(ClassZ).min(1).max(12),
});

export type AddClassesArgs = z.infer<typeof ArgsZ>;

/** First date on/after `from` whose weekday is in `days`. */
function firstOccurrence(from: string, days: readonly string[]): string {
  for (let i = 0; i < 7; i++) {
    const d = addDaysWall(from, i);
    if (days.includes(weekdayCode(d))) return d;
  }
  return from;
}

function empty(summary: string, conflicts: Conflict[]) {
  return { diff: { summary, changes: [], unchanged_pinned: [] } as Diff, conflicts };
}

export const addClassesTool: MutationToolDef<AddClassesArgs> = {
  name: 'add_classes',
  description:
    'Add real COURSES to the calendar as pinned, immovable weekly blocks for the whole semester. Use this when Sai ' +
    'describes actual classes to schedule — a course name with a fixed weekly meeting time, usually a room ("add ' +
    'DATABASE DESIGN Mon/Wed 11–12:30 in GAR 2.112", "my classes this term are …"). Pass the WHOLE list in one call: ' +
    'each class = title, days (weekday codes MO/TU/WE/TH/FR/SA/SU), start_time + end_time (24-hour HH:mm), optional ' +
    'location. It also backs the schedule-photo import. ONLY for genuine classes (fixed, recurring, cannot move) — ' +
    'gym, cook, study, and personal blocks are create_event and are NOT pinned. Never use it to rename or move a class.',
  parameters: z.toJSONSchema(ArgsZ, { io: 'input' }),
  argsSchema: ArgsZ,
  kind: 'mutation',
  async run(args, mode) {
    const db = getDb();
    const sem = getSemester(db);
    if (!sem) {
      return empty('Add classes · no semester', [
        { type: 'constraint', rule: 'no_semester', message: 'Set up a semester first, then import your classes.' },
      ]);
    }

    const rows = args.classes.map((c) => {
      const first = firstOccurrence(sem.start_date, c.days);
      return {
        cls: c,
        id: newId('evt'),
        first,
        starts_at: composeTs(first, c.start_time),
        ends_at: composeTs(first, c.end_time),
        rrule: `FREQ=WEEKLY;BYDAY=${c.days.join(',')};UNTIL=${sem.end_date.replaceAll('-', '')}`,
      };
    });

    const bad = rows.find((r) => r.cls.start_time >= r.cls.end_time);
    if (bad) {
      return empty('Add classes · bad times', [
        {
          type: 'constraint',
          rule: 'bad_times',
          message: `${bad.cls.title}: ${bad.cls.start_time}–${bad.cls.end_time} ends before it starts. Fix it in the preview.`,
        },
      ]);
    }

    const changes: EventChange[] = rows.map((r) => ({
      event_id: r.id,
      instance_date: r.first,
      title: r.cls.title,
      kind: 'class',
      pinned: true,
      location: r.cls.location ?? null,
      before: null,
      after: { starts_at: r.starts_at, ends_at: r.ends_at },
    }));

    // Overlap check against ONE representative week of the existing schedule
    // plus the new classes. pinned:false throughout so pinned_moved cannot fire
    // — creating pinned events is exactly what this tool is for; what we want to
    // catch is a photo misread that double-books an hour.
    const monday = weekMonday(sem.start_date);
    const proposed: ProposedInstance[] = [];
    for (const r of rows) {
      for (const day of r.cls.days) {
        const d = addDaysWall(monday, DAY_INDEX[day]);
        proposed.push({
          event_id: r.id,
          instance_date: d,
          title: r.cls.title,
          kind: 'class',
          starts_at: composeTs(d, r.cls.start_time),
          ends_at: composeTs(d, r.cls.end_time),
          pinned: false,
          location: r.cls.location ?? null,
          notes: null,
          source: 'recurring',
          recurring: true,
          color: r.cls.color ?? null,
          workout: null,
          created: true,
        });
      }
    }
    const conflicts: Conflict[] = validate({
      events: proposed,
      constraints: effectiveConstraints(),
    }).filter((c) => c.type === 'overlap');

    const diff: Diff = {
      summary: `Add ${rows.length} class${rows.length === 1 ? '' : 'es'} · ${sem.name}`,
      detail: args.classes
        .map((c) => `${c.title} — ${c.days.join('/')} ${c.start_time}–${c.end_time}`)
        .join('\n'),
      changes,
      unchanged_pinned: [],
    };

    if (mode === 'dry') return { diff, conflicts };
    if (conflicts.some((c) => severityOf(c) === 'blocking')) return { diff, conflicts };

    db.transaction((tx) => {
      for (const r of rows) {
        tx.insert(schema.event)
          .values({
            id: r.id,
            semester_id: sem.id,
            title: r.cls.title,
            kind: 'class',
            starts_at: r.starts_at,
            ends_at: r.ends_at,
            pinned: true,
            rrule: r.rrule,
            source: 'recurring',
            location: r.cls.location ?? null,
            notes: null,
            color: isEventColor(r.cls.color) ? r.cls.color : null,
          })
          .run();
      }
    });

    return { diff, conflicts };
  },
};

/**
 * Recolor an event. Cosmetic only — it changes no time, no pin, no derivation,
 * so it does NOT go through the proposal flow (same carve-out as saving a
 * recipe or ticking a grocery box). It is a direct, instantly reversible write.
 */
export function setEventColor(eventId: string, color: string | null): { ok: boolean } {
  const db = getDb();
  if (color !== null && !isEventColor(color)) return { ok: false };
  const row = db.select().from(schema.event).where(eq(schema.event.id, eventId)).get();
  if (!row) return { ok: false };
  db.update(schema.event).set({ color }).where(eq(schema.event.id, eventId)).run();
  return { ok: true };
}

/**
 * Rename an event. Like recolor, a title changes no time, no pin, and nothing
 * derived (the validator has no title rule), so it's a direct write, not a
 * proposal — click a block, type a name, done.
 *
 * A RECURRING event renames for EVERY instance in one go, because they all read
 * the base row's title — and any moved-occurrence override rows spawned from it
 * (which copied the old title) are relabeled too, or those days would keep the
 * stale name. A one-off block is just its own row.
 */
export function setEventTitle(eventId: string, title: string): { ok: boolean } {
  const db = getDb();
  const t = title.trim();
  if (t.length === 0 || t.length > 80) return { ok: false };
  const row = db.select().from(schema.event).where(eq(schema.event.id, eventId)).get();
  if (!row) return { ok: false };
  db.transaction((tx) => {
    tx.update(schema.event).set({ title: t }).where(eq(schema.event.id, eventId)).run();
    if (row.rrule !== null) {
      const excs = tx.select().from(schema.eventException).where(eq(schema.eventException.event_id, eventId)).all();
      for (const x of excs) {
        if (x.override_event_id) {
          tx.update(schema.event).set({ title: t }).where(eq(schema.event.id, x.override_event_id)).run();
        }
      }
    }
  });
  return { ok: true };
}

/** Recolor every event of a kind at once (the "apply to all gym" affordance). */
export function setKindColor(kind: string, color: string | null): { ok: boolean; updated: number } {
  const db = getDb();
  if (color !== null && !isEventColor(color)) return { ok: false, updated: 0 };
  const rows = db
    .select()
    .from(schema.event)
    .where(and(eq(schema.event.kind, kind as never)))
    .all();
  for (const r of rows) {
    db.update(schema.event).set({ color }).where(eq(schema.event.id, r.id)).run();
  }
  return { ok: true, updated: rows.length };
}
