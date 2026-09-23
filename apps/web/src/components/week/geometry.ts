/**
 * Shared geometry for the week grid: one place that decides how minutes map
 * to pixels so the hour gutter, hairlines, event blocks, drag snapping and
 * the now line all align to the pixel.
 *
 * The scale is no longer fixed — the whole day must fit the viewport with no
 * scrolling, so the grid measures its available height at runtime and builds a
 * `Geometry` for that scale. Everything that paints takes the geometry as an
 * argument; nothing may hardcode px-per-minute.
 */
import { durationMinutes, fmt12, minutesOfDay, timeOf } from '@mise/core/time';
import type { EventInstance } from '@mise/core/types';

/** Visible window: 06:00–24:00. The full configured day, on one screen. */
export const DAY_START_HOUR = 6;
export const DAY_END_HOUR = 24;
export const DAY_START_MIN = DAY_START_HOUR * 60;
export const DAY_END_MIN = DAY_END_HOUR * 60;
export const TOTAL_MINUTES = DAY_END_MIN - DAY_START_MIN;

export const SNAP_MINUTES = 15;
export const GUTTER_WIDTH = 56;
export const DAY_COLUMNS = 7;

/** Below ~0.45 a 60-min block is under 27px and the title stops being readable;
 *  above ~1.4 the grid outgrows tall displays and starts scrolling again. */
export const MIN_PX_PER_MIN = 0.45;
export const MAX_PX_PER_MIN = 1.4;

/** Hour marks 06:00 … 24:00 inclusive, in minutes past midnight. */
export const HOUR_MARKS: number[] = Array.from(
  { length: (DAY_END_MIN - DAY_START_MIN) / 60 + 1 },
  (_, i) => DAY_START_MIN + i * 60,
);

export function clampPxPerMin(v: number): number {
  if (!Number.isFinite(v)) return MIN_PX_PER_MIN;
  return Math.min(MAX_PX_PER_MIN, Math.max(MIN_PX_PER_MIN, v));
}

export interface BlockRect {
  top: number;
  height: number;
  minutes: number;
  /** Minutes past midnight — the drag clamp works in minutes, not pixels. */
  startMin: number;
  endMin: number;
}

export interface Geometry {
  pxPerMin: number;
  gridHeight: number;
  /** One 15-min step in px. Fractional at most scales — round only when painting. */
  snapPx: number;
  yOf(min: number): number;
  blockRect(inst: EventInstance): BlockRect;
}

export function makeGeometry(pxPerMin: number): Geometry {
  const p = clampPxPerMin(pxPerMin);
  const gridHeight = Math.round(TOTAL_MINUTES * p);
  // Hairlines and block edges land on integer pixels; the underlying math stays
  // in minutes so a chain of rounded steps can never drift.
  const yOf = (min: number) => Math.round((min - DAY_START_MIN) * p);
  return {
    pxPerMin: p,
    gridHeight,
    snapPx: SNAP_MINUTES * p,
    yOf,
    blockRect(inst) {
      const startMin = minutesOfDay(timeOf(inst.starts_at));
      const minutes = Math.max(durationMinutes(inst.starts_at, inst.ends_at), 0);
      const endMin = startMin + minutes;
      const top = Math.max(0, yOf(startMin));
      const bottom = Math.min(gridHeight, yOf(endMin));
      const floor = Math.round(SNAP_MINUTES * p);
      return { top, height: Math.max(bottom - top, floor), minutes, startMin, endMin };
    },
  };
}

/** 'AM' | 'PM' for an hour mark. 24:00 is midnight, i.e. hour 0 → AM. */
function meridiemOf(min: number): 'AM' | 'PM' {
  return Math.floor(min / 60) % 24 < 12 ? 'AM' : 'PM';
}

/**
 * The gutter label, split so the numbers can keep their own right-aligned
 * column: `{ hour: '6', meridiem: 'AM' }`.
 *
 * AM/PM is printed ONLY where it changes — 6 AM at the top of the day, 12 PM at
 * noon, 12 AM at midnight. Stamping it on all 19 rows turns the quietest column
 * in the app into a wall of letters; naming it exactly where the half of the day
 * flips is the whole information content, and 7 through 11 inherit it from the
 * mark above. The meridiem sits in a fixed-width slot in week-grid, so the
 * digits stack on one axis whether or not a row carries one.
 */
export function hourLabel(min: number): { hour: string; meridiem: string | null } {
  const h24 = Math.floor(min / 60) % 24;
  const label = fmt12(`${String(h24).padStart(2, '0')}:00`); // '6 AM', '1 PM', '12 AM'
  const [hour = '', meridiem = ''] = label.split(' ');
  const changed = min === HOUR_MARKS[0] || meridiemOf(min - 60) !== meridiemOf(min);
  return { hour, meridiem: changed ? meridiem : null };
}

/** Stable identity for an instance — React keys and pending-proposal lookup. */
export function instanceKey(eventId: string, instanceDate: string): string {
  return `${eventId}|${instanceDate}`;
}
