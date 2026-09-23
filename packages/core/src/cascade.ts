/**
 * Making room.
 *
 * "Move gym, something came up" must not mean "put gym on top of my class". An
 * overlap used to be a warning, so it did exactly that: gym committed straight
 * over CS 429 and the app told you afterwards. Two events at the same time is
 * not a judgement call you make — it is simply not a schedule.
 *
 * So placing an event now moves the schedule around it:
 *
 *   PINNED things never move. If the placement lands on a class, that is a
 *   refusal (double_booked, blocking) — not a shove, and not a warning.
 *
 *   MOVABLE things get out of the way. Whatever the placement collides with is
 *   pushed later, just far enough to clear; if that one now collides with the
 *   next thing, that one moves too. The knock-ons are real changes in the diff,
 *   so you see the whole ripple and can undo the lot.
 *
 *   Only that ripple is settled. An overlap already on the day between two
 *   things the placement never touches (a quiz booked over a lecture) is not
 *   its to fix: pushing one would move something nobody asked about, and
 *   refusing would block a change that has nothing to do with it. The
 *   validator never blames a proposal for pre-existing state either.
 *
 * Pushing is always FORWARD. Pulling an event earlier to make room would move
 * something you'd already planned your day around into the past-facing part of
 * it; later is the direction that costs you the least.
 */
import { eq } from 'drizzle-orm';
import type { DB } from './db/client';
import { schema } from './db/client';
import { getInstances } from './schedule';
import { newId } from './proposals';
import { effectiveConstraints } from '@mise/config/settings';
import { addMinutesWall, dateOf, diffMinutes, parseWindow, timeOf } from './time';
import type { Conflict, EventChange, EventInstance } from './types';

/** Safety valve on the ripple: a real day has a handful of events. */
const MAX_PUSHES = 12;

interface Placed {
  inst: EventInstance;
  starts_at: string;
  ends_at: string;
  /** The user asked for THIS one to be here. It does not get pushed. */
  anchored: boolean;
  /** Pushed by the cascade — becomes a change in the diff. */
  pushed: boolean;
  original: { starts_at: string; ends_at: string } | null;
}

const keyOf = (id: string, date: string) => `${id}|${date}`;

function overlaps(a: Placed, b: Placed): boolean {
  return a.starts_at < b.ends_at && b.starts_at < a.ends_at;
}

export interface RoomResult {
  /** The caller's changes PLUS everything that had to move for them. */
  changes: EventChange[];
  /** Only the things the cascade moved — the tool commits these itself. */
  knockOns: EventChange[];
  /** Blocking reasons the placement cannot happen at all. */
  conflicts: Conflict[];
}

/**
 * Take the changes a tool wants to make and return them together with whatever
 * else has to move. Read-only: it computes, it does not write.
 */
export function makeRoom(db: DB, primary: EventChange[]): RoomResult {
  const placing = primary.filter((c) => c.after !== null);
  if (placing.length === 0) return { changes: primary, knockOns: [], conflicts: [] };

  // Everything on every day the placement touches — collisions are same-day.
  const days = [...new Set(placing.map((c) => dateOf(c.after!.starts_at)))];
  const c = effectiveConstraints();
  const sleep = parseWindow(c.sleep.protect);

  const conflicts: Conflict[] = [];
  const knockOns: EventChange[] = [];

  for (const day of days) {
    const board: Placed[] = getInstances(db, day, day).map((inst) => ({
      inst,
      starts_at: inst.starts_at,
      ends_at: inst.ends_at,
      anchored: false,
      pushed: false,
      original: null,
    }));

    // Lay the caller's changes onto the board.
    for (const ch of primary) {
      const fromKey = ch.before ? keyOf(ch.event_id, dateOf(ch.before.starts_at)) : null;
      const existing = fromKey
        ? board.find((p) => keyOf(p.inst.event_id, p.inst.instance_date) === fromKey)
        : undefined;

      if (ch.after === null) {
        // A cancel: take it off the board so nothing cascades around a ghost.
        if (existing) board.splice(board.indexOf(existing), 1);
        continue;
      }
      if (dateOf(ch.after.starts_at) !== day) continue;

      if (existing) {
        existing.starts_at = ch.after.starts_at;
        existing.ends_at = ch.after.ends_at;
        existing.anchored = true;
      } else {
        board.push({
          inst: {
            event_id: ch.event_id,
            instance_date: day,
            title: ch.title,
            kind: ch.kind,
            starts_at: ch.after.starts_at,
            ends_at: ch.after.ends_at,
            pinned: ch.pinned,
            location: ch.location ?? null,
            notes: null,
            source: 'agent',
            recurring: false,
            color: null,
            workout: null,
          },
          starts_at: ch.after.starts_at,
          ends_at: ch.after.ends_at,
          anchored: true,
          pushed: false,
          original: null,
        });
      }
    }

    // Settle the day: repeatedly find a collision the placement is part of (one
    // side placed or already pushed) and push the movable side.
    const involved = (p: Placed) => p.anchored || p.pushed;
    for (let i = 0; i <= MAX_PUSHES; i++) {
      board.sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0));

      let clash: [Placed, Placed] | null = null;
      outer: for (let x = 0; x < board.length; x++) {
        for (let y = x + 1; y < board.length; y++) {
          if (board[y]!.starts_at >= board[x]!.ends_at) break; // sorted: nothing later can hit x
          if (!involved(board[x]!) && !involved(board[y]!)) continue; // was there before; not ours
          if (overlaps(board[x]!, board[y]!)) {
            clash = [board[x]!, board[y]!];
            break outer;
          }
        }
      }
      if (!clash) break;

      const [first, second] = clash;

      // Which one gives way? Never a pinned one, never the one being placed.
      const immovable = (p: Placed) => p.inst.pinned || p.anchored;
      let mover: Placed;
      let blocker: Placed;

      if (immovable(first) && immovable(second)) {
        // Two things that both refuse to move. If one of them is pinned, this is
        // the placement landing on a class — refuse the whole thing.
        const fixed = first.inst.pinned ? first : second.inst.pinned ? second : null;
        const moving = fixed === first ? second : first;
        if (fixed) {
          conflicts.push({
            type: 'double_booked',
            moving: moving.inst.event_id,
            moving_title: moving.inst.title,
            fixed: fixed.inst.event_id,
            fixed_title: fixed.inst.title,
            minutes: Math.max(0, diffMinutes(moving.starts_at, fixed.ends_at)),
          });
        } else {
          // Two anchored placements from the same turn overlapping each other.
          conflicts.push({
            type: 'no_room',
            event_id: second.inst.event_id,
            title: second.inst.title,
            message: `${first.inst.title} and ${second.inst.title} would be at the same time.`,
          });
        }
        break;
      }

      if (immovable(first)) {
        mover = second;
        blocker = first;
      } else if (immovable(second)) {
        mover = first;
        blocker = second;
      } else {
        // Neither is fixed: the later one yields, so the day keeps its order.
        mover = second;
        blocker = first;
      }

      // Push just far enough to clear the thing it hit.
      const delta = diffMinutes(mover.starts_at, blocker.ends_at);
      if (delta <= 0) break; // nothing to do; defensive

      if (mover.original === null) {
        mover.original = { starts_at: mover.inst.starts_at, ends_at: mover.inst.ends_at };
      }
      mover.starts_at = addMinutesWall(mover.starts_at, delta);
      mover.ends_at = addMinutesWall(mover.ends_at, delta);
      mover.pushed = true;

      // Refuse to shove anything into the small hours. Better to say "there is
      // no room" than to quietly move a cook session to 1am. Sleep windows wrap
      // midnight (23:00–07:00), so "into sleep" means past the hour it starts.
      const endsNextDay = dateOf(mover.ends_at) !== day;
      const bedtime = sleep.start; // '23:00'
      const runsIntoSleep = bedtime > '12:00' && timeOf(mover.ends_at) > bedtime;
      if (endsNextDay || runsIntoSleep) {
        conflicts.push({
          type: 'no_room',
          event_id: mover.inst.event_id,
          title: mover.inst.title,
          message: `Nothing fits — moving that would push ${mover.inst.title} into the middle of the night. Move something else first, or pick another time.`,
        });
        break;
      }

      if (i === MAX_PUSHES) {
        conflicts.push({
          type: 'no_room',
          event_id: mover.inst.event_id,
          title: mover.inst.title,
          message: `That change ripples through too much of ${day}. Try a clearer slot.`,
        });
      }
    }

    // Everything the cascade pushed becomes a real change in the diff.
    for (const p of board) {
      if (!p.pushed || !p.original) continue;
      knockOns.push({
        event_id: p.inst.event_id,
        instance_date: p.inst.instance_date,
        title: p.inst.title,
        kind: p.inst.kind,
        pinned: p.inst.pinned,
        location: p.inst.location,
        before: p.original,
        after: { starts_at: p.starts_at, ends_at: p.ends_at },
        knock_on: true,
      });
    }
  }

  // A blocking conflict means the placement doesn't happen — so neither do the
  // knock-ons. Hand back the caller's own changes so the diff still shows what
  // was attempted, and let the blocking conflict stop it.
  if (conflicts.length > 0) return { changes: primary, knockOns: [], conflicts };

  return { changes: [...primary, ...knockOns], knockOns, conflicts: [] };
}

/**
 * Write the cascade's knock-on moves. Same semantics every tool already uses:
 * a standalone event is updated in place; ONE instance of a recurring event
 * becomes an exception plus a standalone override row at the new time, so the
 * rest of the series is untouched.
 *
 * Called from inside the placing tool's own transaction, so the primary change
 * and everything that moved for it land together or not at all.
 */
export function commitKnockOns(tx: DB, semesterId: string, knockOns: EventChange[]): void {
  for (const ch of knockOns) {
    if (!ch.before || !ch.after) continue;
    const row = tx.select().from(schema.event).where(eq(schema.event.id, ch.event_id)).get();
    if (!row) continue;

    if (row.rrule === null) {
      tx.update(schema.event)
        .set({ starts_at: ch.after.starts_at, ends_at: ch.after.ends_at })
        .where(eq(schema.event.id, ch.event_id))
        .run();
      continue;
    }

    const overrideId = newId('evt');
    tx.insert(schema.event)
      .values({
        id: overrideId,
        semester_id: semesterId,
        title: row.title,
        kind: row.kind,
        starts_at: ch.after.starts_at,
        ends_at: ch.after.ends_at,
        pinned: row.pinned,
        rrule: null,
        source: 'agent',
        location: row.location,
        notes: row.notes,
        color: row.color,
        workout: row.workout,
      })
      .run();
    tx.insert(schema.eventException)
      .values({
        id: newId('exc'),
        event_id: ch.event_id,
        original_date: ch.instance_date,
        status: 'moved',
        override_event_id: overrideId,
      })
      .run();
  }
}
