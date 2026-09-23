/**
 * reschedule_to_free_slot — THE TOOL does the slot search, the model just
 * asks (SPEC §4). The model says "find gym a new home this week"; this file
 * scans 30-minute candidate starts inside the preferred part of day, filters
 * out occupied / sleep-protected / commute-squeezed slots, ranks preferred
 * gym/cook windows first, and proposes the winner (top 3 in diff.candidates).
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/client';
import { getInstances } from '../schedule';
import { buildValidation, newId } from '../proposals';
import { effectiveConstraints } from '@mise/config/settings';
import {
  DATE_RE,
  addDaysWall,
  addMinutesWall,
  composeTs,
  dateOf,
  diffMinutes,
  durationMinutes,
  fmtDateLong,
  minutesOfDay,
  nowInTz,
  overlapMinutes,
  parseWindow,
  timeOf,
  todayInTz,
  fmt12,
} from '../time';
import type { EventInstance } from '../types';
import {
  severityOf,
  type Conflict,
  type Diff,
  type EventChange,
  type MutationToolDef,
  type SlotCandidate,
  type ToolResult,
} from '../types';

const ArgsZ = z.object({
  event_id: z.string().min(1).describe('ID of the event to find a new time for.'),
  search_from: z
    .string()
    .regex(DATE_RE)
    .describe('First date to search, YYYY-MM-DD. Usually today or tomorrow.'),
  search_days: z
    .number()
    .int()
    .min(1)
    .max(14)
    .describe('How many days to search forward from search_from (1-14).'),
  prefer: z
    .enum(['morning', 'afternoon', 'evening', 'any'])
    .describe('Part of day to search: morning 06:00-12:00, afternoon 12:00-17:00, evening 17:00-22:00, any 07:00-22:00.'),
});

export type RescheduleArgs = z.infer<typeof ArgsZ>;

const PREFER_WINDOWS: Record<RescheduleArgs['prefer'], { start: string; end: string }> = {
  morning: { start: '06:00', end: '12:00' },
  afternoon: { start: '12:00', end: '17:00' },
  evening: { start: '17:00', end: '22:00' },
  any: { start: '07:00', end: '22:00' },
};

const STEP_MINUTES = 30;

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Sleep-protect window as concrete segments on a date (wraps midnight). */
function sleepSegments(protect: string, date: string): Array<[string, string]> {
  const win = parseWindow(protect);
  if (win.start < win.end) return [[composeTs(date, win.start), composeTs(date, win.end)]];
  if (win.start === win.end) return [];
  const segs: Array<[string, string]> = [];
  if (win.end !== '00:00') segs.push([composeTs(date, '00:00'), composeTs(date, win.end)]);
  segs.push([composeTs(date, win.start), composeTs(addDaysWall(date, 1), '00:00')]);
  return segs;
}

function normLoc(loc: string | null): string | null {
  const t = loc?.trim().toLowerCase();
  return t ? t : null;
}

function staleResult(eventId: string): ToolResult {
  return {
    diff: {
      summary: 'Reschedule · event not found',
      changes: [],
      unchanged_pinned: [],
      candidates: [],
    },
    conflicts: [
      {
        type: 'constraint',
        rule: 'stale',
        message: `Event ${eventId} no longer exists — nothing to reschedule.`,
      },
    ],
  };
}

export const rescheduleTool: MutationToolDef<RescheduleArgs> = {
  name: 'reschedule_to_free_slot',
  description:
    'Find a free time slot for an existing event and move it there. The tool does the searching: it scans the requested days and part of day, skips occupied times, protected sleep hours, and slots without commute gaps, prefers gym/cook preferred windows, and proposes the best slot (top 3 candidates returned). Use when asked to "find a new time" for something.',
  parameters: z.toJSONSchema(ArgsZ, { io: 'input' }),
  argsSchema: ArgsZ,
  kind: 'mutation',
  async run(args, mode) {
    const db = getDb();
    const constraints = effectiveConstraints();

    const ev = db.select().from(schema.event).where(eq(schema.event.id, args.event_id)).get();
    if (!ev) return staleResult(args.event_id);

    // The instance being moved: standalone events are their own row; for a
    // recurring event pick the first occurrence at/after search_from (falling
    // back to the most recent before it).
    let current: { starts_at: string; ends_at: string; instance_date: string };
    if (ev.rrule === null) {
      current = { starts_at: ev.starts_at, ends_at: ev.ends_at, instance_date: dateOf(ev.starts_at) };
    } else {
      const nearby = getInstances(
        db,
        addDaysWall(args.search_from, -7),
        addDaysWall(args.search_from, args.search_days + 6),
      ).filter((i) => i.event_id === ev.id);
      const target =
        nearby.find((i) => i.instance_date >= args.search_from) ?? nearby[nearby.length - 1];
      if (!target) return staleResult(args.event_id);
      current = { starts_at: target.starts_at, ends_at: target.ends_at, instance_date: target.instance_date };
    }

    const dur = durationMinutes(current.starts_at, current.ends_at);
    const lastDay = addDaysWall(args.search_from, args.search_days - 1);
    const busy: EventInstance[] = getInstances(db, args.search_from, lastDay).filter(
      (i) => !(i.event_id === ev.id && i.instance_date === current.instance_date),
    );

    const preferredWindows =
      ev.kind === 'gym'
        ? constraints.gym.preferred_windows
        : ev.kind === 'cook'
          ? constraints.cook.preferred_windows
          : [];
    const preferredParsed = preferredWindows.map(parseWindow);

    const win = PREFER_WINDOWS[args.prefer];
    const winStart = minutesOfDay(win.start);
    const winEnd = minutesOfDay(win.end);
    const today = todayInTz();
    const now = nowInTz();
    const myLoc = normLoc(ev.location);

    const scored: Array<{ cand: SlotCandidate; preferred: boolean; startTs: string }> = [];
    for (let di = 0; di < args.search_days; di++) {
      const d = addDaysWall(args.search_from, di);
      if (d < today) continue;
      for (let m = winStart; m + dur <= winEnd; m += STEP_MINUTES) {
        const startTs = composeTs(d, hhmm(m));
        const endTs = addMinutesWall(startTs, dur);
        // Skip past slots: on today, only starts after now.
        if (d === today && startTs <= now) continue;
        // Sleep protection.
        if (sleepSegments(constraints.sleep.protect, d).some(([s, e]) => overlapMinutes(startTs, endTs, s, e) > 0)) {
          continue;
        }
        // No overlap with any instance except the one being moved.
        if (busy.some((i) => overlapMinutes(startTs, endTs, i.starts_at, i.ends_at) > 0)) continue;
        // Commute gap vs adjacent different-location events (both locations set).
        if (myLoc !== null) {
          const sameDay = busy.filter((i) => dateOf(i.starts_at) === d);
          const prev = sameDay
            .filter((i) => i.ends_at <= startTs)
            .sort((a, b) => (a.ends_at < b.ends_at ? -1 : 1))
            .pop();
          const next = sameDay
            .filter((i) => i.starts_at >= endTs)
            .sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1))[0];
          const prevLoc = prev ? normLoc(prev.location) : null;
          const nextLoc = next ? normLoc(next.location) : null;
          if (prev && prevLoc !== null && prevLoc !== myLoc && diffMinutes(prev.ends_at, startTs) < constraints.commute.default) continue;
          if (next && nextLoc !== null && nextLoc !== myLoc && diffMinutes(endTs, next.starts_at) < constraints.commute.default) continue;
        }
        const preferred = preferredParsed.some(
          (w) => m >= minutesOfDay(w.start) && m + dur <= minutesOfDay(w.end),
        );
        scored.push({
          cand: { date: d, start_time: hhmm(m), end_time: timeOf(endTs) },
          preferred,
          startTs,
        });
      }
    }

    scored.sort((a, b) => {
      if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
      return a.startTs < b.startTs ? -1 : a.startTs > b.startTs ? 1 : 0;
    });
    const candidates = scored.slice(0, 3).map((s) => s.cand);

    if (candidates.length === 0) {
      const diff: Diff = {
        summary: `Reschedule ${ev.title} · no free slot`,
        detail: `Searched ${args.search_days} day${args.search_days === 1 ? '' : 's'} from ${fmtDateLong(args.search_from, 'EEE MMM d')} (${args.prefer})`,
        changes: [],
        unchanged_pinned: [],
        candidates: [],
      };
      const conflicts: Conflict[] = [
        {
          type: 'constraint',
          rule: 'no_slot',
          message: `No free ${args.prefer === 'any' ? '' : `${args.prefer} `}slot found for ${ev.title} in the ${args.search_days} day${args.search_days === 1 ? '' : 's'} from ${args.search_from}.`,
        },
      ];
      return { diff, conflicts };
    }

    const best = candidates[0]!;
    const newStarts = composeTs(best.date, best.start_time);
    const newEnds = addMinutesWall(newStarts, dur);

    // The best free slot IS the one it is already in. Nothing to do — and say so,
    // rather than emitting "Gym 5 PM → 5 PM" as a change and reporting it applied.
    if (newStarts === current.starts_at && newEnds === current.ends_at) {
      return {
        diff: { summary: `${ev.title} is already in the best free slot`, changes: [], unchanged_pinned: [] },
        conflicts: [
          {
            type: 'constraint',
            rule: 'already_there',
            message: `${ev.title} is already at ${fmt12(current.starts_at)} and nothing is in the way — it doesn't need moving.`,
            event_id: ev.id,
          },
        ],
      };
    }

    const changes: EventChange[] = [
      {
        event_id: ev.id,
        instance_date: current.instance_date,
        title: ev.title,
        kind: ev.kind,
        pinned: ev.pinned,
        before: { starts_at: current.starts_at, ends_at: current.ends_at },
        after: { starts_at: newStarts, ends_at: newEnds },
      },
    ];

    const outcome = buildValidation(db, changes);
    const diff: Diff = {
      summary: `Reschedule ${ev.title} · ${fmtDateLong(best.date, 'EEE MMM d')} ${best.start_time}`,
      detail: `${fmtDateLong(current.instance_date, 'EEE MMM d')} ${fmt12(current.starts_at)} → ${fmtDateLong(best.date, 'EEE MMM d')} ${fmt12(best.start_time)}`,
      changes,
      unchanged_pinned: outcome.unchanged_pinned,
      candidates,
    };

    if (mode === 'dry') return { diff, conflicts: outcome.conflicts };
    if (outcome.conflicts.some((c) => severityOf(c) === 'blocking')) {
      return { diff, conflicts: outcome.conflicts };
    }

    db.transaction((tx) => {
      if (ev.rrule === null) {
        tx.update(schema.event)
          .set({ starts_at: newStarts, ends_at: newEnds })
          .where(eq(schema.event.id, ev.id))
          .run();
      } else {
        // Move ONE instance of a recurring event: exception + override row.
        const overrideId = newId('evt');
        tx.insert(schema.event)
          .values({
            id: overrideId,
            semester_id: ev.semester_id,
            title: ev.title,
            kind: ev.kind,
            starts_at: newStarts,
            ends_at: newEnds,
            pinned: ev.pinned,
            rrule: null,
            source: 'agent',
            location: ev.location,
            notes: ev.notes,
            // Same as set_event_time/shift: a rescheduled recurring gym must keep
            // its workout label and colour on the override row.
            color: ev.color,
            workout: ev.workout,
          })
          .run();
        tx.insert(schema.eventException)
          .values({
            id: newId('exc'),
            event_id: ev.id,
            original_date: current.instance_date,
            status: 'moved',
            override_event_id: overrideId,
          })
          .run();
      }
    });

    return { diff, conflicts: outcome.conflicts };
  },
};
