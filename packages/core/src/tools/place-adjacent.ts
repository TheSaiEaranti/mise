/**
 * place_adjacent — put one block right before or right after another, with no
 * time math left to the model.
 *
 * "Gym immediately after cooking, no break" and "cook before gym" are the same
 * shape: line X up against Y. The model kept botching this — cancelling gym,
 * adding duplicates, computing the wrong clock time — because it had to work out
 * "cook ends 6:30, gym is 90 min, so gym is 6:30–8:00" itself, which is exactly
 * the arithmetic it gets wrong. Here it just names the two blocks and the side:
 * the tool reads the anchor's real time and moves the other one to touch it.
 *
 * It changes WHEN a block sits (delegating to set_event_time), so it makes room
 * and refuses to land on a class, and it keeps the block's length.
 */
import { z } from 'zod';
import type { Conflict, EventInstance, MutationToolDef, ToolMode, ToolResult } from '../types';
import { severityOf, titlesMatch } from '../types';
import { getDb } from '../db/client';
import { getInstances } from '../schedule';
import { setEventTimeTool } from './set-event-time';
import { addMinutesWall, durationMinutes, timeOf, DATE_RE } from '../time';

const argsSchema = z.object({
  event_id: z.string().describe('Id of the block to MOVE, from the schedule table.'),
  expect_title: z.string().describe("REQUIRED: that block's TITLE, copied exactly. Checked against the real event."),
  date: z.string().regex(DATE_RE).describe('YYYY-MM-DD of the day this is on.'),
  anchor_title: z
    .string()
    .describe("The OTHER block to line up against, by title on the same day — e.g. 'Cook lunches' for \"gym after cooking\"."),
  position: z
    .enum(['after', 'before'])
    .describe("'after' puts the moved block right after the anchor ends; 'before' puts it right before the anchor starts."),
  gap_minutes: z
    .number()
    .int()
    .min(0)
    .max(240)
    .default(0)
    .describe('Minutes of gap to leave between them. 0 = touching ("immediately after, no break"). Default 0.'),
});

export type PlaceAdjacentArgs = z.infer<typeof argsSchema>;

function noTarget(summary: string, conflicts: Conflict[]): ToolResult {
  return { diff: { summary, changes: [], unchanged_pinned: [] }, conflicts };
}

async function run(args: PlaceAdjacentArgs, mode: ToolMode): Promise<ToolResult> {
  const db = getDb();
  const day = getInstances(db, args.date, args.date);

  const mover = day.find((i) => i.event_id === args.event_id);
  if (!mover) {
    return noTarget('Nothing to move', [
      { type: 'constraint', rule: 'stale', message: `${args.expect_title} isn't on ${args.date} — check the schedule.` },
    ]);
  }
  if (!titlesMatch(args.expect_title, mover.title)) {
    return {
      diff: { summary: 'Wrong event — nothing moved', changes: [], unchanged_pinned: [] },
      conflicts: [{ type: 'wrong_event', event_id: mover.event_id, expected: args.expect_title, actual: mover.title }],
    };
  }

  // The anchor: the nearest same-day block with that title, other than the mover.
  const anchor = day.find((i) => titlesMatch(args.anchor_title, i.title) && i.event_id !== args.event_id);
  if (!anchor) {
    return noTarget('No anchor', [
      {
        type: 'constraint',
        rule: 'no_anchor',
        message: `There's no ${args.anchor_title} on that day to line ${mover.title} up against.`,
      },
    ]);
  }

  // "X before Y" against a MOVABLE anchor is a REORDER, not tucking X into
  // whatever gap sits before Y. Sai's rule for "i cook before i gym": keep BOTH
  // blocks in the same evening window, just put the cook first — do NOT drag it
  // to a lone slot before the window (that's how it ended up at 4 PM, on a
  // class). Slide the mover to the START of the pair's current window and let
  // set_event_time's make-room push the anchor — and anything else movable — to
  // follow it, in order. Two blocks move, not one, and make-room refuses to land
  // any of them on a class, so school timings are respected for free.
  //
  // (A PINNED anchor — a class, an exam — can't be pushed, so there's nothing to
  // reorder: the mover just tucks in right before it, handled by the primary
  // path below. "study block right before my exam" still works that way.)
  if (args.position === 'before' && !anchor.pinned) {
    const windowStart = mover.starts_at < anchor.starts_at ? mover.starts_at : anchor.starts_at;
    const dur = durationMinutes(mover.starts_at, mover.ends_at);
    return setEventTimeTool.run(
      {
        event_id: mover.event_id,
        expect_title: mover.title,
        date: args.date,
        start_time: timeOf(windowStart),
        end_time: timeOf(addMinutesWall(windowStart, dur)),
      } as never,
      mode,
    );
  }

  // Primary: move the named block so it touches the anchor. Delegate to
  // set_event_time — it owns the recurring-override write, make-room, and the
  // class-collision refusal, so this stays a pure "compute the times".
  const primary = await retime(mover, anchor, args.position, args.gap_minutes, args.date, mode);
  if (!isBlocked(primary)) return primary;

  // The direct 'after' move is blocked — usually the mover would land on a class
  // that sits right beside the anchor. The same order can be reached by moving
  // the anchor to the other side of the mover instead, if it's free to move.
  if (!anchor.pinned) {
    const opposite = args.position === 'before' ? 'after' : 'before';
    const mirror = await retime(anchor, mover, opposite, args.gap_minutes, args.date, mode);
    if (!isBlocked(mirror)) return mirror;
  }

  // Neither side fits — hand back the primary attempt so the real conflict shows.
  return primary;
}

const isBlocked = (r: ToolResult): boolean => r.conflicts.some((c) => severityOf(c) === 'blocking');

/** Move `subject` to touch `reference` on the given side, keeping its length. */
function retime(
  subject: EventInstance,
  reference: EventInstance,
  position: 'after' | 'before',
  gap: number,
  date: string,
  mode: ToolMode,
): Promise<ToolResult> {
  const dur = durationMinutes(subject.starts_at, subject.ends_at);
  const startTs =
    position === 'after'
      ? addMinutesWall(reference.ends_at, gap)
      : addMinutesWall(addMinutesWall(reference.starts_at, -gap), -dur);
  return setEventTimeTool.run(
    {
      event_id: subject.event_id,
      expect_title: subject.title,
      date,
      start_time: timeOf(startTs),
      end_time: timeOf(addMinutesWall(startTs, dur)),
    } as never,
    mode,
  );
}

export const placeAdjacentTool: MutationToolDef<PlaceAdjacentArgs> = {
  name: 'place_adjacent',
  description:
    'Put one block before or after ANOTHER block on the same day, without working out any clock times. Pass the block ' +
    'to move (event_id + expect_title), the day, the anchor_title to line up against, and position ("after"/"before"). ' +
    "It keeps the moved block's length, makes room, and refuses to land anything on a class. Two behaviours: " +
    '(1) "before" against a movable block REORDERS the pair — "i cook before i gym" slides the cook to the start of ' +
    'their current evening window and pushes the gym (and anything else movable) to follow, so BOTH stay in the same ' +
    'timeframe with the cook first; it does not drag the cook off to an early-afternoon slot. ' +
    '(2) "after", and "before" against a pinned class/exam, line the moved block right up to the anchor ' +
    '("gym immediately after cooking", "study block just before my 2 PM exam"); gap_minutes 0 = touching. ' +
    'For each day Sai wants this, call it once for that day.',
  parameters: z.toJSONSchema(argsSchema) as Record<string, unknown>,
  argsSchema,
  run,
  kind: 'mutation',
};
