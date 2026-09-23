/**
 * Holistic reflow.
 *
 * makeRoom (cascade.ts) only ever pushes a colliding block LATER, just far
 * enough to clear. That's right for "nudge gym 30 min" but wrong for "friends
 * are coming at 8" — there, the whole evening should REARRANGE around the new
 * fixed point, by Sai's standing rules (cook before gym, keep things in their
 * windows), moving as little as it can get away with.
 *
 * A day is a tiny scheduling problem: a handful of movable blocks, a fixed
 * skeleton (pinned classes + the new anchor + sleep). So we can just try every
 * ORDER of the movable blocks, greedily place each order into the free time,
 * score the whole layout against the preferences, and keep the cheapest. N is
 * 1–4 in practice (N! ≤ 24), sub-millisecond; we cap the search for pathological
 * days and fall back to a couple of sensible seed orders.
 *
 * It returns KNOCK-ONS in exactly the shape makeRoom does, so fit_in_event
 * commits them through the same buildValidation → commitKnockOns → transaction
 * spine every other tool uses. The trust model — diff card, auto-apply's
 * blocking refusal, Cmd-Z — is unchanged.
 */
import type { DB } from './db/client';
import { getInstances } from './schedule';
import { effectiveConstraints, type Constraints } from '@mise/config/settings';
import { getPreferences, type Preferences } from './preferences';
import { addMinutesWall, composeTs, dateOf, durationMinutes, parseWindow, timeOf } from './time';
import type { Conflict, EventChange, EventInstance } from './types';

/** Minutes past midnight for a 'HH:mm' clock time. */
const hmToMin = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
/** Minutes past midnight for a wall-time 'YYYY-MM-DDTHH:mm'. */
const minOf = (ts: string): number => hmToMin(ts.slice(11, 16));
const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** The standing rules the reflow optimises for, derived from the constraints. */
export interface ReflowPrefs {
  /** [a, b] means a block of kind `a` should come before one of kind `b`. */
  order: Array<[string, string]>;
  /** kind → preferred windows as [startMin, endMin]. */
  windows: Record<string, Array<[number, number]>>;
  /** Spacing rules: no `kind` within `gapMinutes` after one of `afterKinds`. */
  buffers: Array<{ kind: string; afterKinds: string[]; gapMinutes: number }>;
  /** Minutes between any two different-location events. */
  commuteMin: number;
  /** Waking day, in minutes. Nothing movable is placed outside it. */
  dayStart: number;
  dayEnd: number;
}

/** Minutes to hold a `movKind` block off after a block of `prevKind` (0 if none). */
function bufferAfter(movKind: string, prevKind: string, prefs: ReflowPrefs): number {
  let gap = 0;
  for (const b of prefs.buffers) {
    if (b.kind === movKind && b.afterKinds.includes(prevKind)) gap = Math.max(gap, b.gapMinutes);
  }
  return gap;
}

export function derivePrefs(prefs: Preferences, c: Constraints = effectiveConstraints()): ReflowPrefs {
  const win = (arr: string[]): Array<[number, number]> =>
    arr.map((w) => {
      const { start, end } = parseWindow(w);
      return [hmToMin(start), hmToMin(end)] as [number, number];
    });
  const windows: Record<string, Array<[number, number]>> = {};
  for (const [kind, wins] of Object.entries(prefs.windows)) windows[kind] = win(wins);
  const sleep = parseWindow(c.sleep.protect); // '00:00-07:00'
  const sleepEnd = hmToMin(sleep.end);
  const sleepStart = hmToMin(sleep.start);
  return {
    // Sai's standing ordering rules (default: cook before gym), now editable.
    order: prefs.order.map((o) => [o.before, o.after] as [string, string]),
    windows,
    buffers: prefs.buffers.map((b) => ({ kind: b.kind, afterKinds: b.after_kinds, gapMinutes: b.gap_minutes })),
    commuteMin: c.commute.default,
    dayStart: sleepEnd, // 07:00 → 420
    // A sleep window that wraps midnight (00:00-07:00) means the day runs to
    // midnight; otherwise to the sleep start.
    dayEnd: sleepStart <= sleepEnd ? 24 * 60 : sleepStart,
  };
}

interface Slot {
  inst: EventInstance;
  start: number; // minutes
  end: number;
}

/** A pinned block the day must flow around, tagged with its kind for buffers. */
interface FixedInterval {
  start: number;
  end: number;
  kind: string;
}

/** Minutes a block sits outside ALL its preferred windows (0 if inside one, or if the kind has no window). */
function windowMiss(kind: string, start: number, end: number, prefs: ReflowPrefs): number {
  const wins = prefs.windows[kind];
  if (!wins || wins.length === 0) return 0;
  let best = Infinity;
  for (const [ws, we] of wins) {
    // Distance the block falls outside [ws, we]: how far start is before ws
    // plus how far end runs past we.
    const miss = Math.max(0, ws - start) + Math.max(0, end - we);
    best = Math.min(best, miss);
  }
  return best === Infinity ? 0 : best;
}

/** Required gap (minutes) to leave AFTER `prev` before `next` starts. */
function requiredGap(prev: EventInstance, next: EventInstance, prefs: ReflowPrefs): number {
  let gap = bufferAfter(next.kind, prev.kind, prefs);
  if (prev.location && next.location && prev.location !== next.location) gap = Math.max(gap, prefs.commuteMin);
  return gap;
}

/**
 * Place `order` (a specific sequence of movable blocks) into the day, left to
 * right. Each block goes at its ORIGINAL time if it can (minimal disruption),
 * else the earliest free minute after the previous block that clears the fixed
 * skeleton. Returns null if any block can't fit before the day ends.
 */
function place(order: EventInstance[], fixed: FixedInterval[], prefs: ReflowPrefs): Slot[] | null {
  const slots: Slot[] = [];
  let floor = prefs.dayStart; // earliest the next block may start
  for (let i = 0; i < order.length; i++) {
    const inst = order[i]!;
    const dur = durationMinutes(inst.starts_at, inst.ends_at);
    const gap = i > 0 ? requiredGap(order[i - 1]!, inst, prefs) : 0;
    const earliest = i > 0 ? slots[i - 1]!.end + gap : floor;
    // Prefer to leave the block where it is; only slide forward when forced.
    let start = Math.max(earliest, minOf(inst.starts_at));
    // Clear the fixed skeleton: step past any interval this block overlaps, and
    // honour any buffer it needs after a fixed block (e.g. cook 30 min after a
    // class) even when it merely butts up against one. Re-check after each move,
    // since a push can land it on the next fixed block.
    for (let guard = 0; guard < 64; guard++) {
      let moved = false;
      for (const f of fixed) {
        const overlaps = start < f.end && f.start < start + dur;
        const buf = bufferAfter(inst.kind, f.kind, prefs);
        const tooSoonAfter = buf > 0 && f.end <= start && start < f.end + buf;
        if (overlaps) {
          start = f.end + buf; // clear it, plus any required buffer after it
          moved = true;
          break;
        }
        if (tooSoonAfter) {
          start = f.end + buf;
          moved = true;
          break;
        }
      }
      if (!moved) break;
    }
    if (start + dur > prefs.dayEnd) return null; // no room before bedtime
    slots.push({ inst, start, end: start + dur });
    floor = start + dur;
  }
  return slots;
}

/** All permutations of a small array. */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i]!, ...p]);
  }
  return out;
}

const ORDER_PENALTY = 100_000; // dominates window/disruption; ordering is a rule, not a nicety
const WINDOW_WEIGHT = 1; // per minute outside a preferred window
const DISRUPTION_WEIGHT = 0.4; // per minute a block moves from where it was

function score(slots: Slot[], prefs: ReflowPrefs): number {
  let cost = 0;
  // Ordering: for each rule a-before-b, penalise any b that starts before an a.
  for (const [a, b] of prefs.order) {
    const aStarts = slots.filter((s) => s.inst.kind === a).map((s) => s.start);
    const bStarts = slots.filter((s) => s.inst.kind === b).map((s) => s.start);
    for (const bs of bStarts) for (const as of aStarts) if (bs < as) cost += ORDER_PENALTY;
  }
  for (const s of slots) {
    cost += WINDOW_WEIGHT * windowMiss(s.inst.kind, s.start, s.end, prefs);
    cost += DISRUPTION_WEIGHT * Math.abs(s.start - minOf(s.inst.starts_at));
  }
  return cost;
}

export interface ReflowResult {
  /** Movable blocks that moved — shaped exactly like makeRoom's knock-ons. */
  knockOns: EventChange[];
  conflicts: Conflict[];
}

const MAX_EXACT = 7; // 7! = 5040 layouts, still instant

/**
 * Rearrange the movable blocks on `date` around a fixed anchor (a new or moved
 * event) by the standing preferences. `anchor` is the change being made (its
 * `after` interval is treated as immovable); pass null to reflow the day in
 * place (e.g. a swap). `forceOrder` pins the relative order of the given kinds
 * (["cook","gym"] for "cook before gym", ["gym","cook"] to swap).
 */
export function reflowDay(
  db: DB,
  date: string,
  anchor: EventChange | null,
  opts?: { forceOrder?: string[]; prefs?: ReflowPrefs },
): ReflowResult {
  const prefs = opts?.prefs ?? derivePrefs(getPreferences(db));
  const insts = getInstances(db, date, date);

  const fixed: FixedInterval[] = [];
  for (const i of insts) if (i.pinned && i.event_id !== anchor?.event_id) fixed.push({ start: minOf(i.starts_at), end: minOf(i.ends_at), kind: i.kind });
  if (anchor?.after && dateOf(anchor.after.starts_at) === date) {
    fixed.push({ start: minOf(anchor.after.starts_at), end: minOf(anchor.after.ends_at), kind: anchor.kind });
  }

  const movable = insts.filter((i) => !i.pinned && i.event_id !== anchor?.event_id);
  if (movable.length === 0) return { knockOns: [], conflicts: [] };

  // Only the blocks that actually CLASH get rearranged — a new event you drop in
  // an empty evening shouldn't cause a surprise reshuffle of things it never
  // touched. For a forced reorder ("swap gym and cook") every named block is in
  // play; otherwise it's whatever overlaps the anchor. Everything else stays put
  // and is treated as part of the fixed skeleton (so a placed block still lands
  // in the right order relative to it, and never on top of it).
  const overlapsAnchor = (m: EventInstance): boolean => {
    if (!anchor?.after || dateOf(anchor.after.starts_at) !== date) return false;
    return minOf(m.starts_at) < minOf(anchor.after.ends_at) && minOf(anchor.after.starts_at) < minOf(m.ends_at);
  };
  const inPlay = opts?.forceOrder ? movable : movable.filter(overlapsAnchor);
  if (inPlay.length === 0) return { knockOns: [], conflicts: [] };
  const stay = movable.filter((m) => !inPlay.includes(m));
  const stayIntervals: FixedInterval[] = stay.map((s) => ({ start: minOf(s.starts_at), end: minOf(s.ends_at), kind: s.kind }));
  const fixedAll = [...fixed, ...stayIntervals];
  const staySlots: Slot[] = stay.map((s) => ({ inst: s, start: minOf(s.starts_at), end: minOf(s.ends_at) }));

  // Candidate orderings of the in-play blocks.
  let orderings: EventInstance[][];
  if (opts?.forceOrder) {
    // Sort by the forced kind order; blocks of unlisted kinds keep time order after.
    const rank = (k: string) => {
      const idx = opts.forceOrder!.indexOf(k);
      return idx === -1 ? opts.forceOrder!.length : idx;
    };
    orderings = [[...inPlay].sort((a, b) => rank(a.kind) - rank(b.kind) || a.starts_at.localeCompare(b.starts_at))];
  } else if (inPlay.length <= MAX_EXACT) {
    orderings = permutations(inPlay);
  } else {
    orderings = [[...inPlay].sort((a, b) => a.starts_at.localeCompare(b.starts_at))];
  }

  let best: { slots: Slot[]; cost: number } | null = null;
  for (const order of orderings) {
    const slots = place(order, fixedAll, prefs);
    if (!slots) continue;
    // Score the whole day — placed in-play blocks PLUS the ones that stayed — so
    // ordering rules across the two (cook stayed, gym moved) are respected.
    const cost = score([...slots, ...staySlots], prefs);
    if (!best || cost < best.cost) best = { slots, cost };
  }

  if (!best) {
    const worst = movable[movable.length - 1]!;
    return {
      knockOns: [],
      conflicts: [
        {
          type: 'no_room',
          event_id: worst.event_id,
          title: worst.title,
          message: `There isn't room to fit everything around that on ${date} without running into the night.`,
        },
      ],
    };
  }

  const knockOns: EventChange[] = [];
  for (const s of best.slots) {
    const newStart = minOf(s.inst.starts_at);
    if (s.start === newStart) continue; // didn't move
    const startTs = composeTs(date, hhmm(s.start));
    const endTs = composeTs(date, hhmm(s.end));
    knockOns.push({
      event_id: s.inst.event_id,
      instance_date: s.inst.instance_date,
      title: s.inst.title,
      kind: s.inst.kind,
      pinned: s.inst.pinned,
      location: s.inst.location,
      before: { starts_at: s.inst.starts_at, ends_at: s.inst.ends_at },
      after: { starts_at: startTs, ends_at: endTs },
      knock_on: true,
    });
  }
  return { knockOns, conflicts: [] };
}
