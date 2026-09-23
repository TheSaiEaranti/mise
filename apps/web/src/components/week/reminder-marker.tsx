'use client';

/**
 * A reminder on the week grid: a small red "R" dot pinned at its time on the day
 * column's left edge (out of the way of event blocks). Hovering it opens a tiny
 * card with the label + time and a Delete action — that's the only way to remove
 * a reminder (adding is done from the Reminders tab).
 */
import { useState } from 'react';
import { fmt12 } from '@mise/core/time';
import type { Reminder } from '@mise/core/types';
import { DAY_END_MIN, DAY_START_MIN, type Geometry } from './geometry';

const SIZE = 18;

function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

export function ReminderMarker({
  reminder,
  geo,
  onDelete,
}: {
  reminder: Reminder;
  geo: Geometry;
  onDelete(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  // Clamp to the visible 6am–midnight window so an off-hours reminder still pins
  // to the nearest edge instead of floating off the grid.
  const min = Math.min(DAY_END_MIN, Math.max(DAY_START_MIN, minutesOf(reminder.time)));
  const y = geo.yOf(min);

  return (
    <div
      className="absolute z-20"
      style={{ top: y - SIZE / 2, left: 2 }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        role="img"
        aria-label={`Reminder: ${reminder.title} at ${fmt12(reminder.time)}`}
        className="flex cursor-default items-center justify-center rounded-full bg-red-500 font-semibold leading-none text-white shadow-sm"
        style={{ width: SIZE, height: SIZE, fontSize: 11 }}
      >
        R
      </span>

      {open && (
        <div className="absolute left-6 top-0 z-30 w-max max-w-[220px] rounded-r border border-rule bg-paper p-2 text-left shadow-lift">
          <p className="t-label break-words text-ink">{reminder.title}</p>
          <p className="t-label mt-0.5 text-ink-soft">{fmt12(reminder.time)}</p>
          <button
            type="button"
            onClick={() => onDelete(reminder.id)}
            className="t-label mt-1.5 text-red-600 hover:underline"
          >
            Delete reminder
          </button>
        </div>
      )}
    </div>
  );
}
