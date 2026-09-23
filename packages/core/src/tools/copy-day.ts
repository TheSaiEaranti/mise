/**
 * copy_day — "add the same blocks as Tuesday to Thu/Fri/Sat/Sun."
 *
 * The model has no COPY: told to "add the same block as Tuesday", it builds a
 * fresh block and drops it in the first free slot it finds — so the time drifts
 * (Tuesday's 10 AM gym became a 9:30 run) and the label is lost. This clones the
 * real blocks from a source day onto the target weekdays, VERBATIM: same time,
 * length, kind, workout label, location — as a weekly repeat. Pinned classes are
 * never copied (they come from semester setup). Optional per-block rename ("name
 * the gym block Run"); a renamed block drops its split label, since it's now a
 * different activity.
 */
import { z } from 'zod';
import type { Conflict, EventChange, EventKind, MutationToolDef, ToolMode, ToolResult } from '../types';
import { severityOf, titlesMatch } from '../types';
import { getDb, schema } from '../db/client';
import { getInstances, getSemester } from '../schedule';
import { buildValidation, newId } from '../proposals';
import { addDaysWall, addMinutesWall, composeTs, durationMinutes, timeOf, todayInTz, weekdayCode, DATE_RE } from '../time';

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
const DAY_NAME: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };

const argsSchema = z.object({
  source_date: z.string().regex(DATE_RE).describe('YYYY-MM-DD of the day to copy blocks FROM (e.g. the Tuesday whose gym/shower you want).'),
  days: z.array(z.enum(WEEKDAYS)).min(1).describe("Target weekdays to copy onto, e.g. ['TH','FR','SA','SU']. Each copy repeats weekly on that day."),
  only_titles: z
    .array(z.string())
    .optional()
    .describe('Optional: copy ONLY blocks with these titles (e.g. ["Gym","Shower"]). Omit to copy every movable block on the source day.'),
  rename: z
    .array(z.object({ from: z.string(), to: z.string() }))
    .optional()
    .describe('Optional renames while copying, e.g. [{from:"Gym", to:"Run"}]. A renamed block drops its workout/split label.'),
});

export type CopyDayArgs = z.infer<typeof argsSchema>;

function refuse(summary: string, conflicts: Conflict[]): ToolResult {
  return { diff: { summary, changes: [], unchanged_pinned: [] }, conflicts };
}

/** First date on/after `from` whose weekday is in `days`. */
function firstOnDays(from: string, days: readonly string[]): string {
  for (let i = 0; i < 7; i++) {
    const d = addDaysWall(from, i);
    if (days.includes(weekdayCode(d))) return d;
  }
  return from;
}

async function run(args: CopyDayArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const sem = getSemester(db);
  if (!sem) return refuse('No semester', [{ type: 'constraint', rule: 'no_semester', message: 'Set up a semester first.' }]);

  // The blocks to clone: everything movable on the source day (a class never
  // copies — it's pinned and owned by semester setup).
  let source = getInstances(db, args.source_date, args.source_date).filter((i) => !i.pinned && i.kind !== 'class');
  if (args.only_titles && args.only_titles.length > 0) {
    source = source.filter((i) => args.only_titles!.some((t) => titlesMatch(t, i.title)));
  }
  if (source.length === 0) {
    return refuse('Nothing to copy', [
      { type: 'constraint', rule: 'stale', message: `There are no movable blocks to copy on ${args.source_date}.` },
    ]);
  }

  const renameFor = (title: string): string | null => {
    for (const r of args.rename ?? []) if (titlesMatch(r.from, title)) return r.to;
    return null;
  };

  const anchor = todayInTz(sem.timezone) < sem.start_date ? sem.start_date : todayInTz(sem.timezone);
  const until = sem.end_date.replaceAll('-', '');
  const firstOcc = firstOnDays(anchor, args.days);

  const added: EventChange[] = [];
  const newRows: { id: string; title: string; kind: EventKind; starts_at: string; ends_at: string; rrule: string; workout: string | null; location: string | null }[] = [];
  let skipped = 0;
  for (const b of source) {
    const renamed = renameFor(b.title);
    const title = renamed ?? b.title;
    const dur = durationMinutes(b.starts_at, b.ends_at);
    const startTime = timeOf(b.starts_at);

    // Don't duplicate: if the target days already carry this block at this time,
    // there's nothing to add.
    const existing = getInstances(db, firstOcc, addDaysWall(firstOcc, 6)).some(
      (i) => titlesMatch(title, i.title) && timeOf(i.starts_at) === startTime && args.days.includes(weekdayCode(i.instance_date)),
    );
    if (existing) {
      skipped++;
      continue;
    }

    const starts_at = composeTs(firstOcc, startTime);
    const ends_at = addMinutesWall(starts_at, dur);
    const id = newId('evt');
    newRows.push({
      id,
      title,
      kind: b.kind,
      starts_at,
      ends_at,
      rrule: `FREQ=WEEKLY;BYDAY=${args.days.join(',')};INTERVAL=1;UNTIL=${until}`,
      // A renamed block is a different activity, so it doesn't carry the split label.
      workout: renamed ? null : b.workout ?? null,
      location: b.location ?? null,
    });
    added.push({
      event_id: id,
      instance_date: firstOcc,
      title,
      kind: b.kind,
      pinned: false,
      location: b.location ?? null,
      before: null,
      after: { starts_at, ends_at },
      recurrence: `every ${args.days.map((d) => DAY_NAME[d]).join('/')}`,
    });
  }

  if (added.length === 0) {
    return refuse('Nothing to copy', [
      { type: 'constraint', rule: 'already', message: `Those days already have those blocks — nothing to add.` },
    ]);
  }

  const outcome = buildValidation(db, added);

  const diff = {
    summary: `Copy ${source.length === 1 ? source[0]!.title : `${added.length} block${added.length === 1 ? '' : 's'}`} → ${args.days.map((d) => DAY_NAME[d]).join('/')}`,
    detail: added.map((c) => `${c.title} ${timeOf(c.after!.starts_at)}`).join(' · ') + (skipped > 0 ? ` · ${skipped} already there` : ''),
    changes: added,
    unchanged_pinned: outcome.unchanged_pinned,
  };
  if (mode === 'dry') return { diff, conflicts: outcome.conflicts };
  if (outcome.conflicts.some((c) => severityOf(c) === 'blocking')) return { diff, conflicts: outcome.conflicts };

  db.transaction((tx) => {
    for (const r of newRows) {
      tx.insert(schema.event)
        .values({
          id: r.id,
          semester_id: sem.id,
          title: r.title,
          kind: r.kind,
          starts_at: r.starts_at,
          ends_at: r.ends_at,
          pinned: false,
          rrule: r.rrule,
          source: 'recurring',
          location: r.location,
          notes: null,
          color: null,
          workout: r.workout,
        })
        .run();
    }
  });
  return { diff, conflicts: outcome.conflicts };
}

export const copyDayTool: MutationToolDef<CopyDayArgs> = {
  name: 'copy_day',
  description:
    'Copy the blocks from one day onto other weekdays, VERBATIM — same time, length, kind, split label, location — as a ' +
    'weekly repeat. Use for "add the same gym and shower as Tuesday to Thu/Fri/Sat/Sun", "copy my Monday to Wednesday". ' +
    'This is a real CLONE, so times and labels match the source exactly (unlike create_event, which guesses a fresh slot). ' +
    'Pass source_date (the day to copy from) + days (target weekdays). Optional only_titles to copy just some blocks, and ' +
    'rename (e.g. Gym→Run) — a renamed block drops its split label. Pinned classes are never copied.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
