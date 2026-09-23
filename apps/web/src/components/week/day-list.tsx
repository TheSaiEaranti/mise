'use client';

/**
 * Mobile week view (<md): a vertical day list, no grid, no drag. The
 * pinned/movable depth distinction survives intact — it's a fill-and-spine
 * difference and works at any width. Empty state is one line of --ink-soft.
 */
import { clsx } from 'clsx';
import { fmtDateLong, fmtRange12 } from '@mise/core/time';
import { colorSpec, type EventInstance } from '@/lib/api';
import { instanceKey } from './geometry';

interface DayListProps {
  days: string[];
  today: string;
  byDate: Map<string, EventInstance[]>;
  pendingKeys: Set<string>;
}

export function DayList({ days, today, byDate, pendingKeys }: DayListProps) {
  return (
    <div className="flex flex-col gap-6 md:hidden">
      {days.map((date) => {
        const list = byDate.get(date) ?? [];
        const dayName = fmtDateLong(date, 'EEEE');
        return (
          <section key={date}>
            <h2 className={clsx('t-micro pb-3', date === today ? 'text-ink' : 'text-ink-soft')}>
              {dayName}
            </h2>
            {list.length === 0 ? (
              <p className="t-label text-ink-soft">No events {dayName}.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {list.map((inst) => (
                  <DayRow
                    key={instanceKey(inst.event_id, inst.instance_date)}
                    inst={inst}
                    pending={pendingKeys.has(instanceKey(inst.event_id, inst.instance_date))}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function DayRow({ inst, pending }: { inst: EventInstance; pending: boolean }) {
  const spec = colorSpec(inst.color, inst.kind);
  return (
    <div
      className={clsx(
        'min-h-11 rounded-r px-3 py-3',
        inst.pinned ? 'shadow-inset-pin' : 'border shadow-lift',
      )}
      style={{
        background: spec.fill,
        color: spec.ink,
        // Same fill-and-spine language as the grid: pinned sits IN the page,
        // movable sits ON it. Works at any width, colors on or off.
        borderLeft: inst.pinned ? `2px solid ${spec.line}` : undefined,
        borderColor: inst.pinned ? undefined : pending ? 'var(--signal)' : `${spec.line}33`,
      }}
    >
      {/* Same reading order as the grid: the SPECIFIC thing first ("Chest and
          back", not "Gym" — see event-block.tsx), then WHEN, the whole timeframe
          rather than a start time. There is room here for the generic title as
          well, so the phone shows it under the time. Nothing sits side by side:
          the column is narrow and a right-aligned range squeezes the headline
          into an ellipsis. */}
      <p className="t-body truncate">{inst.subtitle || inst.title}</p>
      <p className="t-time truncate">{fmtRange12(inst.starts_at, inst.ends_at)}</p>
      {inst.subtitle && <p className="t-label truncate">{inst.title}</p>}
      {inst.location && <p className="t-label truncate">{inst.location}</p>}
    </div>
  );
}
