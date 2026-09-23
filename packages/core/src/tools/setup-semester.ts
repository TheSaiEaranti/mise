/**
 * setup_semester — the onboarding wizard's tool, HIDDEN from the model
 * (tools/index.ts filters it out of modelToolSpecs). It is the one legitimate
 * pinned-creation path: classes are inserted pinned:true with a weekly rrule,
 * so buildValidation (which blocks pinned creation) is deliberately NOT used.
 * Instead one representative week of class instances is validated with
 * pinned:false to catch class-vs-class overlaps — user typos in the wizard.
 */
import { z } from 'zod';
import { getDb, schema } from '../db/client';
import { getSemester } from '../schedule';
import { newId } from '../proposals';
import { validate } from '../validator';
import { effectiveConstraints } from '@mise/config/settings';
import { DATE_RE, TIME_RE, addDaysWall, composeTs, weekMonday, weekdayCode } from '../time';
import type {
  Conflict,
  Diff,
  EventChange,
  MutationToolDef,
  ProposedInstance,
} from '../types';

const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
type DayCode = (typeof DAY_CODES)[number];

const ClassZ = z.object({
  title: z.string().min(1).describe('Class title, e.g. "CS 429".'),
  days: z
    .array(z.enum(DAY_CODES))
    .min(1)
    .describe('Weekdays the class meets, RFC5545 codes: MO TU WE TH FR SA SU.'),
  start_time: z.string().regex(TIME_RE).describe('Class start, HH:mm (24h).'),
  end_time: z.string().regex(TIME_RE).describe('Class end, HH:mm (24h).'),
  location: z.string().optional().describe('Building/room, e.g. "GDC 2.216". Used for commute checks.'),
});

const ArgsZ = z.object({
  name: z.string().min(1).describe('Semester name, e.g. "Fall 2026".'),
  start_date: z.string().regex(DATE_RE).describe('First day of the semester, YYYY-MM-DD.'),
  end_date: z.string().regex(DATE_RE).describe('Last day of the semester, YYYY-MM-DD.'),
  timezone: z.string().default('America/Chicago').describe('IANA timezone of the semester.'),
  classes: z
    .array(ClassZ)
    .default([])
    .describe('The weekly class schedule. May be empty to start the semester with a clean, class-free calendar.'),
  replace: z
    .boolean()
    .default(false)
    .describe('Replace an existing semester (deletes its events, exceptions, and meal plans).'),
});

export type SetupSemesterArgs = z.infer<typeof ArgsZ>;

const DAY_INDEX: Record<DayCode, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

/** Earliest date >= start_date whose weekday is in days. */
function firstOccurrence(start_date: string, days: DayCode[]): string {
  for (let i = 0; i < 7; i++) {
    const d = addDaysWall(start_date, i);
    if (days.includes(weekdayCode(d))) return d;
  }
  return start_date; // unreachable: days is non-empty
}

export const setupSemesterTool: MutationToolDef<SetupSemesterArgs> = {
  name: 'setup_semester',
  description:
    'Onboarding wizard tool: create the semester and its weekly class schedule as pinned recurring events. Not available to the chat model.',
  parameters: z.toJSONSchema(ArgsZ, { io: 'input' }),
  argsSchema: ArgsZ,
  kind: 'mutation',
  async run(args, mode) {
    const db = getDb();
    const existing = getSemester(db);

    if (existing && !args.replace) {
      const diff: Diff = {
        summary: `Set up ${args.name} · semester exists`,
        changes: [],
        unchanged_pinned: [],
      };
      const conflicts: Conflict[] = [
        {
          type: 'constraint',
          rule: 'semester_exists',
          message: `A semester already exists (${existing.name}). Pass replace to overwrite it.`,
        },
      ];
      return { diff, conflicts };
    }

    // One EventChange per class at its FIRST occurrence. Pinned true — this
    // is the one legitimate pinned-creation path, so buildValidation (which
    // would block it) is not used here.
    const classRows = args.classes.map((c) => {
      const first = firstOccurrence(args.start_date, c.days);
      return {
        cls: c,
        id: newId('evt'),
        first,
        starts_at: composeTs(first, c.start_time),
        ends_at: composeTs(first, c.end_time),
        rrule: `FREQ=WEEKLY;BYDAY=${c.days.join(',')};UNTIL=${args.end_date.replaceAll('-', '')}`,
      };
    });

    const changes: EventChange[] = classRows.map((r) => ({
      event_id: r.id,
      instance_date: r.first,
      title: r.cls.title,
      kind: 'class',
      pinned: true,
      before: null,
      after: { starts_at: r.starts_at, ends_at: r.ends_at },
    }));

    // Class-vs-class sanity check: expand ONE representative week (pinned
    // false so pinned_moved cannot fire) and keep only overlap conflicts.
    const monday = weekMonday(args.start_date);
    const representative: ProposedInstance[] = [];
    for (const r of classRows) {
      for (const day of r.cls.days) {
        const d = addDaysWall(monday, DAY_INDEX[day]);
        representative.push({
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
          color: null,
          workout: null,
        });
      }
    }
    const conflicts: Conflict[] = validate({
      events: representative,
      constraints: effectiveConstraints(),
    }).filter((c) => c.type === 'overlap');

    // A replace deletes the previous semester's entire world. That destruction
    // must appear ON the diff the user approves — approving a card that shows
    // only additions while it silently drops every event is exactly the kind of
    // hidden mutation I2 exists to prevent. So list every existing event as a
    // removal: it makes the card honest AND keeps the diff actionable even when
    // there are zero classes to add (a reset to a clean, empty calendar).
    const removals: EventChange[] = [];
    if (existing && args.replace) {
      const oldEvents = db.select().from(schema.event).all();
      for (const e of oldEvents) {
        removals.push({
          event_id: e.id,
          instance_date: e.starts_at.slice(0, 10),
          title: e.title,
          kind: e.kind,
          pinned: !!e.pinned,
          before: { starts_at: e.starts_at, ends_at: e.ends_at },
          after: null,
        });
      }
      conflicts.unshift({
        type: 'constraint',
        rule: 'replace_semester',
        message:
          `Replaces ${existing.name}: deletes ${oldEvents.length} event${oldEvents.length === 1 ? '' : 's'} ` +
          `(including its pinned classes). This cannot be undone.`,
      });
    }

    const diff: Diff = {
      summary:
        args.classes.length === 0
          ? `Set up ${args.name} · empty calendar`
          : `Set up ${args.name} · ${args.classes.length} class${args.classes.length === 1 ? '' : 'es'}`,
      detail:
        args.classes.length === 0
          ? `Fresh start, no classes yet — ${args.start_date} → ${args.end_date}`
          : args.classes.map((c) => `${c.title} — ${c.days.join('/')} ${c.start_time}–${c.end_time} weekly`).join('\n'),
      changes: [...removals, ...changes],
      unchanged_pinned: [],
    };

    if (mode === 'dry') return { diff, conflicts };

    db.transaction((tx) => {
      if (existing && args.replace) {
        // Single-semester app: wipe the old semester's world.
        tx.delete(schema.eventException).run();
        tx.delete(schema.event).run();
        tx.delete(schema.semester).run();
      }
      const semId = newId('sem');
      tx.insert(schema.semester)
        .values({
          id: semId,
          name: args.name,
          start_date: args.start_date,
          end_date: args.end_date,
          timezone: args.timezone,
        })
        .run();
      for (const r of classRows) {
        tx.insert(schema.event)
          .values({
            id: r.id,
            semester_id: semId,
            title: r.cls.title,
            kind: 'class',
            starts_at: r.starts_at,
            ends_at: r.ends_at,
            pinned: true,
            rrule: r.rrule,
            source: 'recurring',
            location: r.cls.location ?? null,
            notes: null,
          })
          .run();
      }
    });

    return { diff, conflicts };
  },
};
