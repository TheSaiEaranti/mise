/**
 * The validator. (SPEC §5)
 *
 * PURE FUNCTION: proposed instances + constraints in, conflicts out.
 * No DB access, no I/O, no clock, no randomness — identical input always
 * yields identical output in identical order. This is the trust anchor of
 * the whole app; only `pinned_moved` blocks (see severityOf in types.ts).
 *
 * Output order: pinned_moved, overlap, no_commute, constraint (sleep,
 * gym_after_*, *_window) — each group ordered by starts_at/date.
 */
import type { Constraints } from '@mise/config';
import type { Conflict, ProposedInstance, ValidationInput } from './types';
import {
  addDaysWall,
  composeTs,
  dateOf,
  diffMinutes,
  minutesOfDay,
  overlapMinutes,
  parseWindow,
  rangeDates,
  timeOf,
  fmt12,
} from './time';

type Win = { start: string; end: string };

/** Touched by this proposal: newly created, or carrying original_* markers.
 *  Pre-existing state is never the proposal's fault. */
function isChanged(e: ProposedInstance): boolean {
  return e.created === true || e.original_starts_at !== undefined || e.original_ends_at !== undefined;
}

function notCancelled(events: ProposedInstance[]): ProposedInstance[] {
  return events.filter((e) => e.cancelled !== true);
}

/** Deterministic order: starts_at, then ends_at, then event_id, then date. */
function byStart(a: ProposedInstance, b: ProposedInstance): number {
  if (a.starts_at !== b.starts_at) return a.starts_at < b.starts_at ? -1 : 1;
  if (a.ends_at !== b.ends_at) return a.ends_at < b.ends_at ? -1 : 1;
  if (a.event_id !== b.event_id) return a.event_id < b.event_id ? -1 : 1;
  if (a.instance_date !== b.instance_date) return a.instance_date < b.instance_date ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// 1. pinned_moved — the ONLY blocking conflict. (I4)
// ---------------------------------------------------------------------------

function checkPinnedMoved(events: ProposedInstance[]): Conflict[] {
  const out: Conflict[] = [];
  for (const e of [...events].sort(byStart)) {
    if (!e.pinned) continue;
    const moved =
      (e.original_starts_at !== undefined && e.original_starts_at !== e.starts_at) ||
      (e.original_ends_at !== undefined && e.original_ends_at !== e.ends_at);
    // An agent must not create pinned events either.
    if (moved || e.cancelled === true || e.created === true) {
      out.push({ type: 'pinned_moved', event_id: e.event_id, title: e.title });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. overlap — pairwise among non-cancelled instances, each unordered pair
//    once, a = earlier starts_at.
// ---------------------------------------------------------------------------

function checkOverlaps(events: ProposedInstance[]): Conflict[] {
  const active = notCancelled(events).sort(byStart);
  const out: Conflict[] = [];
  for (let i = 0; i < active.length; i++) {
    const a = active[i]!;
    for (let j = i + 1; j < active.length; j++) {
      const b = active[j]!;
      // Starts are ascending: once b starts at/after a's end, nothing later
      // can overlap a. Zero-gap adjacency is NOT an overlap (half-open).
      if (b.starts_at >= a.ends_at) break;
      const minutes = overlapMinutes(a.starts_at, a.ends_at, b.starts_at, b.ends_at);
      if (minutes > 0) {
        out.push({
          type: 'overlap',
          a: a.event_id,
          b: b.event_id,
          a_title: a.title,
          b_title: b.title,
          minutes,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. no_commute — consecutive same-date pair at different locations with a
//    gap too small to commute. Negative gap is already an overlap.
// ---------------------------------------------------------------------------

function normLoc(loc: string | null): string | null {
  const t = loc?.trim().toLowerCase();
  return t ? t : null;
}

function checkNoCommute(events: ProposedInstance[], constraints: Constraints): Conflict[] {
  const active = notCancelled(events).sort(byStart);
  const out: Conflict[] = [];
  for (let i = 0; i + 1 < active.length; i++) {
    const prev = active[i]!;
    const next = active[i + 1]!;
    if (dateOf(prev.starts_at) !== dateOf(next.starts_at)) continue;
    const from = normLoc(prev.location);
    const to = normLoc(next.location);
    if (from === null || to === null || from === to) continue;
    const gap = diffMinutes(prev.ends_at, next.starts_at);
    if (gap >= 0 && gap < constraints.commute.default) {
      out.push({
        type: 'no_commute',
        from: prev.event_id,
        to: next.event_id,
        from_title: prev.title,
        to_title: next.title,
        gap_minutes: gap,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4a. constraint: sleep — nothing scheduled inside the protected window.
//     Only instances CHANGED by the proposal are flagged.
// ---------------------------------------------------------------------------

/** The protected window as concrete timestamp segments on a given date.
 *  A window whose end <= start wraps midnight and splits into two segments. */
function windowSegments(win: Win, date: string): Array<[string, string]> {
  if (win.start < win.end) return [[composeTs(date, win.start), composeTs(date, win.end)]];
  if (win.start === win.end) return [];
  const segs: Array<[string, string]> = [];
  if (win.end !== '00:00') segs.push([composeTs(date, '00:00'), composeTs(date, win.end)]);
  segs.push([composeTs(date, win.start), composeTs(addDaysWall(date, 1), '00:00')]);
  return segs;
}

function intersectsProtected(e: ProposedInstance, win: Win): boolean {
  // Check the window on every date the event touches, so an event crossing
  // midnight (ends_at on the next day) hits the next morning's window too.
  for (const d of rangeDates(dateOf(e.starts_at), dateOf(e.ends_at))) {
    for (const [s, x] of windowSegments(win, d)) {
      if (overlapMinutes(e.starts_at, e.ends_at, s, x) > 0) return true;
    }
  }
  return false;
}

function checkSleep(events: ProposedInstance[], constraints: Constraints): Conflict[] {
  const win = parseWindow(constraints.sleep.protect);
  const out: Conflict[] = [];
  for (const e of notCancelled(events).sort(byStart)) {
    if (!isChanged(e)) continue;
    if (!intersectsProtected(e, win)) continue;
    out.push({
      type: 'constraint',
      rule: 'sleep',
      message: `${e.title} runs ${fmt12(e.starts_at)}–${fmt12(e.ends_at)}, inside protected sleep hours (${fmt12(win.start)}–${fmt12(win.end)})`,
      event_id: e.event_id,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4b. constraint: gym_after_<kind> — gym starting too soon after a session of
//     one of gym.not_after_kinds ends (same date). Fires when either party
//     was changed by the proposal.
// ---------------------------------------------------------------------------

function checkGymAfter(events: ProposedInstance[], constraints: Constraints): Conflict[] {
  const active = notCancelled(events);
  const gyms = active.filter((e) => e.kind === 'gym').sort(byStart);
  const maxGap = constraints.gym.not_after_gap_minutes;
  const out: Conflict[] = [];
  for (const gym of gyms) {
    for (const kind of constraints.gym.not_after_kinds) {
      const priors = active.filter((e) => e.kind === kind && e !== gym).sort(byStart);
      for (const prior of priors) {
        if (!isChanged(gym) && !isChanged(prior)) continue;
        if (dateOf(prior.ends_at) !== dateOf(gym.starts_at)) continue;
        const gap = diffMinutes(prior.ends_at, gym.starts_at);
        // "within N minutes after" is inclusive: gap === N still fires.
        if (gap >= 0 && gap <= maxGap) {
          out.push({
            type: 'constraint',
            rule: `gym_after_${kind}`,
            message: `${gym.title} starts ${gap} min after ${prior.title} ends — no gym within ${maxGap} min of a ${kind} session`,
            event_id: gym.event_id,
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4c. constraint: gym_window / cook_window — a CHANGED gym/cook instance
//     outside every preferred window; message measured against the nearest.
// ---------------------------------------------------------------------------

function preferredWindowsFor(e: ProposedInstance, constraints: Constraints): string[] | null {
  if (e.kind === 'gym') return constraints.gym.preferred_windows;
  if (e.kind === 'cook') return constraints.cook.preferred_windows;
  return null;
}

function checkWindows(events: ProposedInstance[], constraints: Constraints): Conflict[] {
  const out: Conflict[] = [];
  for (const e of notCancelled(events).sort(byStart)) {
    if (!isChanged(e)) continue;
    const raw = preferredWindowsFor(e, constraints);
    if (!raw || raw.length === 0) continue;

    const startMin = minutesOfDay(timeOf(e.starts_at));
    // End as minutes from the START day's midnight, so a cross-midnight event
    // correctly reads as ending past every same-day window.
    const endMin = startMin + diffMinutes(e.starts_at, e.ends_at);

    let fits = false;
    let best: { before: number; past: number; win: Win } | null = null;
    for (const w of raw.map(parseWindow)) {
      const before = Math.max(0, minutesOfDay(w.start) - startMin);
      const past = Math.max(0, endMin - minutesOfDay(w.end));
      if (before === 0 && past === 0) {
        fits = true;
        break;
      }
      if (best === null || before + past < best.before + best.past) best = { before, past, win: w };
    }
    if (fits || best === null) continue;

    // Conflict messages are read by Sai, not by the machine — 12-hour clock.
    const winStr = `${fmt12(best.win.start)}–${fmt12(best.win.end)}`;
    // Report the dominant side of the nearest window (SPEC §9 phrasing).
    const message =
      best.past >= best.before
        ? `${e.title} ends ${fmt12(e.ends_at)}, ${best.past} min past your preferred window (${winStr})`
        : `${e.title} starts ${fmt12(e.starts_at)}, ${best.before} min before your preferred window (${winStr})`;
    out.push({ type: 'constraint', rule: `${e.kind}_window`, message, event_id: e.event_id });
  }
  return out;
}

// ---------------------------------------------------------------------------

export function validate(input: ValidationInput): Conflict[] {
  const { events, constraints } = input;
  return [
    ...checkPinnedMoved(events),
    ...checkOverlaps(events),
    ...checkNoCommute(events, constraints),
    ...checkSleep(events, constraints),
    ...checkGymAfter(events, constraints),
    ...checkWindows(events, constraints),
  ];
}
