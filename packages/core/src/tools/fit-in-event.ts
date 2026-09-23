/**
 * fit_in_event — "hey I have friends coming over at 8".
 *
 * The one call that IS the headline flow: anchor a fixed thing at the exact time
 * Sai said, then reflow the whole day's movable blocks around it by his standing
 * rules (cook before gym, preferred windows, minimal disruption) in a single
 * deterministic pass. No multi-round model reasoning, no "create then also move
 * the gym" — one tool, one reflow, one undo.
 *
 * It is create_event for a one-off PLUS reflow.ts instead of makeRoom's push-to-
 * clear: same firstChange shape, same buildValidation → commitKnockOns → single
 * transaction spine, so the diff card, auto-apply's blocking refusal, and Cmd-Z
 * are unchanged. The anchor never lands on a class (that's a blocking refusal,
 * same as everywhere else); the movable blocks reflow around it.
 */
import { z } from 'zod';
import type { Conflict, EventChange, MutationToolDef, ToolMode, ToolResult } from '../types';
import { severityOf } from '../types';
import { getDb, schema } from '../db/client';
import { getInstances, getSemester } from '../schedule';
import { buildValidation, newId } from '../proposals';
import { commitKnockOns } from '../cascade';
import { reflowDay } from '../reflow';
import { addMinutesWall, composeTs, fmt12, DATE_RE, TIME_RE } from '../time';

const argsSchema = z.object({
  title: z.string().min(1).describe("Short title for the thing coming up, e.g. 'Friends over' or 'Dinner'."),
  kind: z
    .enum(['personal', 'meal', 'commute'])
    .default('personal')
    .describe("Kind of block. Almost always 'personal' for a spontaneous plan. Not for gym/cook (use create_event) or classes."),
  date: z.string().regex(DATE_RE).describe('YYYY-MM-DD of the day it happens.'),
  start_time: z.string().regex(TIME_RE).describe("When it starts, 'HH:mm' 24h. This is FIXED — it goes exactly here."),
  duration_minutes: z
    .number()
    .int()
    .min(5)
    .max(720)
    .default(120)
    .describe('How long, in minutes. Default 120 (2 hours) if Sai only gives a start time.'),
  location: z.string().optional().describe("Optional location, a plain string ('home', a bar name)."),
});

export type FitInEventArgs = z.infer<typeof argsSchema>;

function fail(summary: string, conflicts: Conflict[]): ToolResult {
  return { diff: { summary, changes: [], unchanged_pinned: [] }, conflicts };
}

async function run(args: FitInEventArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const sem = getSemester(db);
  if (!sem) return fail('No semester', [{ type: 'constraint', rule: 'no_semester', message: 'Set up a semester first.' }]);

  const eventId = newId('evt');
  const starts_at = composeTs(args.date, args.start_time);
  const ends_at = addMinutesWall(starts_at, args.duration_minutes);

  const anchor: EventChange = {
    event_id: eventId,
    instance_date: args.date,
    title: args.title,
    kind: args.kind,
    pinned: false,
    location: args.location ?? null,
    before: null,
    after: { starts_at, ends_at },
  };

  // The anchor is FIXED where Sai put it — so if it lands on a class, that's a
  // refusal, not something to reflow around. (Movable clashes are what reflow is
  // for; a pinned clash means the stated time itself is impossible.)
  const dayInsts = getInstances(db, args.date, args.date);
  const onClass = dayInsts.find(
    (i) => i.pinned && i.starts_at < ends_at && starts_at < i.ends_at,
  );
  if (onClass) {
    return fail(`Can't add ${args.title} then`, [
      {
        type: 'double_booked',
        moving: eventId,
        moving_title: args.title,
        fixed: onClass.event_id,
        fixed_title: onClass.title,
        minutes: 0,
      },
    ]);
  }

  // Reflow the movable blocks around the anchor by the standing rules.
  const { knockOns, conflicts: reflowConflicts } = reflowDay(db, args.date, anchor);

  const changes: EventChange[] = [anchor, ...knockOns];
  const outcome = buildValidation(db, changes);
  const conflicts = [...reflowConflicts, ...outcome.conflicts];

  const moved = knockOns.length;
  const summary = `Add ${args.title}`;
  const detail =
    `${fmt12(args.start_time)}–${fmt12(ends_at)}` + (moved > 0 ? ` · reflowed ${moved} around it` : ' · nothing else had to move');
  const diff = { summary, detail, changes, unchanged_pinned: outcome.unchanged_pinned };

  if (mode === 'dry') return { diff, conflicts };
  if (conflicts.some((c) => severityOf(c) === 'blocking')) return { diff, conflicts };

  db.transaction((tx) => {
    tx.insert(schema.event)
      .values({
        id: eventId,
        semester_id: sem.id,
        title: args.title,
        kind: args.kind,
        starts_at,
        ends_at,
        pinned: false,
        rrule: null,
        source: 'agent',
        location: args.location ?? null,
        notes: null,
      })
      .run();
    commitKnockOns(tx as never, sem.id, knockOns);
  });

  return { diff, conflicts };
}

export const fitInEventTool: MutationToolDef<FitInEventArgs> = {
  name: 'fit_in_event',
  description:
    'Drop a fixed, one-off thing onto the calendar at an EXACT time AND automatically reflow the day around it. Use ' +
    'this for "friends coming over at 8", "dinner at 7", "I have a call 3-3:30" — anything Sai states as happening at a ' +
    'set time. Pass title, start_time (HH:mm), duration_minutes (default 120), kind (usually personal). It pins the new ' +
    "block at that time and rearranges the movable blocks (gym, cook, study) around it by Sai's standing rules — cook " +
    'before gym, preferred windows, moving as little as possible — in ONE call. Do NOT also call shift/place_adjacent ' +
    'afterward; the reflow already moved everything. It refuses only if the stated time lands on a class.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
