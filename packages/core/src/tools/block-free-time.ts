/**
 * block_free_time — "friends are over at 10, make everything before that a study
 * hour." Fill the free gap leading up to something with one block.
 *
 * The point of this tool existing at all is I3. The model *could* be asked to
 * work out "gym ends 6:30, friends arrive at 10, so create Study 18:30–22:00" —
 * and it would get it wrong, because that is three pieces of arithmetic over a
 * schedule it is reading out of a table. So it doesn't: it says WHAT to call the
 * block and WHAT it has to be finished before, and the tool does the looking.
 *
 * "Everything before that" means: from the end of your last commitment up to the
 * thing you named. Not the whole day — the free run that actually leads into it.
 */
import { z } from 'zod';
import type { EventChange, MutationToolDef, ToolMode, ToolResult } from '../types';
import { severityOf, titlesMatch } from '../types';
import { getDb, schema } from '../db/client';
import { getInstances, getSemester } from '../schedule';
import { buildValidation, newId } from '../proposals';
import { makeRoom, commitKnockOns } from '../cascade';
import { effectiveConstraints } from '@mise/config/settings';
import {
  DATE_RE,
  TIME_RE,
  composeTs,
  diffMinutes,
  fmt12,
  fmtDateLong,
  minutesOfDay,
  nowInTz,
  parseWindow,
  timeOf,
  todayInTz,
} from '../time';

const argsSchema = z
  .object({
    date: z.string().regex(DATE_RE).describe('Which day, YYYY-MM-DD. Copy it from the CALENDAR block.'),
    title: z.string().min(1).max(60).describe('What to call the block, in Sai\'s words — e.g. "Study".'),
    kind: z
      .enum(['personal', 'cook', 'gym', 'commute'])
      .default('personal')
      .describe('Kind of block. "personal" for study, work, reading — anything that is not a gym or cook session.'),
    until_time: z
      .string()
      .regex(TIME_RE)
      .optional()
      .describe('HH:mm the block must FINISH by — e.g. "22:00" for "before my 10pm plans".'),
    until_event_id: z
      .string()
      .optional()
      .describe('Instead of until_time: the id of the event this must finish before (copy it from the schedule table).'),
    expect_title: z
      .string()
      .optional()
      .describe('Required with until_event_id: that event\'s TITLE, copied from the table. Checked against the real event.'),
    after_time: z
      .string()
      .regex(TIME_RE)
      .optional()
      .describe('Optional HH:mm not to start before. Leave it out and the tool starts after Sai\'s last commitment.'),
    min_minutes: z
      .number()
      .int()
      .min(15)
      .max(240)
      .default(30)
      .describe('Do not bother if the free run is shorter than this. Default 30.'),
    max_minutes: z
      .number()
      .int()
      .min(15)
      .max(600)
      .optional()
      .describe(
        'Cap the block at this many minutes. When Sai gives a length ("the 2 hours before my exam"), set this to ' +
          '120 — the block becomes the LAST 2 hours before the anchor instead of the whole free run. Without it, ' +
          'the block fills the entire gap.',
      ),
  })
  .superRefine((v, ctx) => {
    if (v.until_time === undefined && v.until_event_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['until_time'],
        message: 'Say what the block has to finish before: until_time (HH:mm) or until_event_id.',
      });
    }
    if (v.until_event_id !== undefined && v.expect_title === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['expect_title'],
        message: 'expect_title is required with until_event_id — copy the title from the schedule table.',
      });
    }
  });

export type BlockFreeTimeArgs = z.infer<typeof argsSchema>;

function refuse(summary: string, rule: string, message: string): ToolResult {
  return {
    diff: { summary, changes: [], unchanged_pinned: [] },
    conflicts: [{ type: 'constraint', rule, message }],
  };
}

async function run(args: BlockFreeTimeArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const sem = getSemester(db);
  if (!sem) return refuse('Nothing to block', 'no_semester', 'Set up a semester first.');

  const day = getInstances(db, args.date, args.date);
  const c = effectiveConstraints();

  // ---- Where does the run END? -------------------------------------------
  let endTime: string;
  let anchorLabel: string;

  if (args.until_event_id !== undefined) {
    const anchor = day.find((i) => i.event_id === args.until_event_id);
    if (!anchor) {
      return refuse(
        'Nothing to block',
        'stale',
        `There's nothing with that id on ${fmtDateLong(args.date, 'EEEE')} — check the schedule.`,
      );
    }
    // Same identity check as every other tool that takes an id (I3b).
    if (args.expect_title !== undefined && !titlesMatch(args.expect_title, anchor.title)) {
      return {
        diff: { summary: 'Wrong event — nothing blocked', changes: [], unchanged_pinned: [] },
        conflicts: [
          { type: 'wrong_event', event_id: anchor.event_id, expected: args.expect_title, actual: anchor.title },
        ],
      };
    }
    endTime = timeOf(anchor.starts_at);
    anchorLabel = anchor.title;
  } else {
    endTime = args.until_time!;
    anchorLabel = fmt12(endTime);
  }

  // ---- Where does the run START? -----------------------------------------
  // At the end of the last thing that is in the way. "Make EVERYTHING before
  // that a study hour" means the free run that actually leads into the anchor —
  // not the whole day, and not over the top of anything.
  //
  // Note this asks when the last event STARTING before the anchor ENDS, not
  // which events end before it. Those are different questions, and the second
  // one is wrong: with the anchor at 11:00 and a class running 10:00–11:30, no
  // event "ends before 11:00", so the naive version saw an empty morning and
  // cheerfully booked a study block straight through the class.
  const endMin = minutesOfDay(endTime);
  const busyEndMin = day
    .filter((i) => minutesOfDay(timeOf(i.starts_at)) < endMin)
    .reduce((max, i) => Math.max(max, minutesOfDay(timeOf(i.ends_at))), -1);

  if (busyEndMin >= endMin) {
    return refuse(
      'No room to block',
      'no_gap',
      `There's no free time before ${anchorLabel} on ${fmtDateLong(args.date, 'EEEE')} — you're busy right up to it.`,
    );
  }

  const busyEnd =
    busyEndMin < 0
      ? null
      : `${String(Math.floor(busyEndMin / 60)).padStart(2, '0')}:${String(busyEndMin % 60).padStart(2, '0')}`;

  // Never inside protected sleep, never before an explicit after_time, and —
  // if this is today — never in the past.
  const sleep = parseWindow(c.sleep.protect);
  const candidates = [busyEnd, args.after_time, sleep.end].filter((t): t is string => t != null);
  if (args.date === todayInTz(sem.timezone)) candidates.push(timeOf(nowInTz(sem.timezone)));

  let startTime = candidates.reduce((a, b) => (minutesOfDay(a) >= minutesOfDay(b) ? a : b));

  // Cap the length if Sai gave one. "The 2 hours before my exam" is the LAST two
  // hours before the anchor, not the whole afternoon — so push the start forward
  // until the block is at most max_minutes. This is the guard against blocking
  // three hours when he asked for two.
  if (args.max_minutes !== undefined) {
    const capStart = minutesOfDay(endTime) - args.max_minutes;
    if (capStart > minutesOfDay(startTime)) {
      startTime = `${String(Math.floor(capStart / 60)).padStart(2, '0')}:${String(capStart % 60).padStart(2, '0')}`;
    }
  }

  // Round the start up to the next 5 minutes — a study block that begins at
  // 18:32 because that is when you asked is not a thing anyone wants.
  const startMin = minutesOfDay(startTime);
  const rounded = Math.ceil(startMin / 5) * 5;
  if (rounded !== startMin && rounded < 24 * 60) {
    startTime = `${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
  }

  const starts_at = composeTs(args.date, startTime);
  const ends_at = composeTs(args.date, endTime);
  const minutes = diffMinutes(starts_at, ends_at);

  if (minutes < args.min_minutes) {
    return refuse(
      'No room to block',
      'no_gap',
      minutes <= 0
        ? `There's no free time before ${anchorLabel} on ${fmtDateLong(args.date, 'EEEE')}.`
        : `Only ${minutes} min free before ${anchorLabel} — too short to be worth blocking.`,
    );
  }

  // ---- Build it like any other created event ------------------------------
  const eventId = newId('evt');
  const changes: EventChange[] = [
    {
      event_id: eventId,
      instance_date: args.date,
      title: args.title,
      kind: args.kind,
      pinned: false,
      location: null,
      before: null,
      after: { starts_at, ends_at },
    },
  ];

  const room = makeRoom(db, changes);
  const outcome = buildValidation(db, room.changes);
  const conflicts = [...room.conflicts, ...outcome.conflicts];

  const diff = {
    summary: `${args.title} · ${fmtDateLong(args.date, 'EEE MMM d')}`,
    detail: `${fmt12(starts_at)}–${fmt12(ends_at)} — the free run before ${anchorLabel}`,
    changes: room.changes,
    unchanged_pinned: outcome.unchanged_pinned,
  };

  if (mode === 'dry') return { diff, conflicts };
  if (conflicts.some((k) => severityOf(k) === 'blocking')) return { diff, conflicts };

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
        location: null,
        notes: null,
        color: null,
        workout: null,
      })
      .run();
    commitKnockOns(tx as never, sem.id, room.knockOns);
  });

  return { diff, conflicts };
}

export const blockFreeTimeTool: MutationToolDef<BlockFreeTimeArgs> = {
  name: 'block_free_time',
  description:
    'Fill the free time leading up to something with one block — "make everything before my 10pm plans a study hour", ' +
    '"block off the afternoon before my exam". Use this only when NO length is given (it fills the whole gap); for a ' +
    'fixed length with no anchor ("study 2 hours sometime") use create_event instead. YOU DO NOT WORK OUT THE TIMES: ' +
    'say which day, what to call the block, and what it has to finish before (until_time, or until_event_id + ' +
    'expect_title). The tool finds where Sai is free — after his last commitment, outside sleep, not in the past. ' +
    'Pass max_minutes to cap the length ("the 2 hours before my exam" → max_minutes 120).',
  parameters: z.toJSONSchema(argsSchema, { io: 'input' }) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
