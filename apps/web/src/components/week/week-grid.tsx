'use client';

/**
 * The desktop week grid (md and up). Pure --paper background, hairline --rule
 * lines at each hour (half-hours get nothing), mono hour gutter, uppercase
 * micro day headers. Today's header is --ink — and nothing else.
 *
 * The grid FITS: it shows 06:00–24:00 and sizes itself to whatever height is
 * left under the header, so the whole day is on screen and the grid never
 * scrolls. Everything paints from the geometry that measurement produces.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { clsx } from 'clsx';
import { fmtDateLong } from '@mise/core/time';
import type { EventInstance, Reminder } from '@mise/core/types';
import { EventBlock, type ColumnHit } from './event-block';
import { NowLine } from './now-line';
import { ReminderMarker } from './reminder-marker';
import {
  DAY_COLUMNS,
  GUTTER_WIDTH,
  HOUR_MARKS,
  TOTAL_MINUTES,
  clampPxPerMin,
  hourLabel,
  instanceKey,
  makeGeometry,
  type Geometry,
} from './geometry';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Room left below the grid: main's md:pb-6 (24px) plus a little slack, so
 *  fitting the grid never pushes a scrollbar onto the page. */
const BOTTOM_GAP = 32;

/** Fit the grid to the space between its own top edge and the viewport floor. */
function useFitGeometry(ref: RefObject<HTMLDivElement | null>): Geometry {
  const [pxPerMin, setPxPerMin] = useState(0.75);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // The grid's own height never changes its top edge, so this is stable and
      // cannot feed back on itself.
      const top = el.getBoundingClientRect().top;
      const avail = window.innerHeight - top - BOTTOM_GAP;
      if (avail <= 0) return;
      const next = clampPxPerMin(avail / TOTAL_MINUTES);
      setPxPerMin((prev) => (Math.abs(next - prev) < 0.002 ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Also watch the page body: anything that opens above the grid (the import
    // panel, a wrapped header) changes the grid's top edge without changing its
    // own size. measure() is a pure function of that top edge, so re-running it
    // converges immediately — it cannot oscillate.
    const main = el.closest('main');
    if (main) ro.observe(main);
    window.addEventListener('resize', measure);
    const raf = requestAnimationFrame(measure); // after fonts/layout settle
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      cancelAnimationFrame(raf);
    };
  }, [ref]);

  return useMemo(() => makeGeometry(pxPerMin), [pxPerMin]);
}

interface WeekGridProps {
  /** The 7 dates of the visible week, Monday first. */
  days: string[];
  today: string;
  byDate: Map<string, EventInstance[]>;
  remindersByDate: Map<string, Reminder[]>;
  pendingKeys: Set<string>;
  onProposeShift(inst: EventInstance, deltaMinutes: number): void;
  /** Resize: commit an exact new start/end ('HH:mm') for one instance. */
  onSetTime(inst: EventInstance, startTime: string, endTime: string): void;
  onDeleteReminder(id: string): void;
}

export function WeekGrid({ days, today, byDate, remindersByDate, pendingKeys, onProposeShift, onSetTime, onDeleteReminder }: WeekGridProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const colsRef = useRef<HTMLDivElement | null>(null);
  const geo = useFitGeometry(bodyRef);

  /** Which day column a pointer x lands in — clamped to the 7 tracks. */
  const columnAt = useCallback((clientX: number): ColumnHit | null => {
    const el = colsRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const width = rect.width / DAY_COLUMNS;
    if (width <= 0) return null;
    const raw = Math.floor((clientX - rect.left) / width);
    return { index: Math.min(DAY_COLUMNS - 1, Math.max(0, raw)), width };
  }, []);

  const height = geo.gridHeight + 1;

  return (
    <div className="hidden select-none md:block">
      {/* Day headers — the one uppercase row in the app. */}
      <div className="flex">
        <div aria-hidden="true" className="shrink-0" style={{ width: GUTTER_WIDTH }} />
        <div className="grid min-w-0 flex-1 grid-cols-7">
          {days.map((date) => (
            <div
              key={date}
              className={clsx('t-micro pb-2 pl-2', date === today ? 'text-ink' : 'text-ink-soft')}
            >
              {fmtDateLong(date, 'EEE')}
            </div>
          ))}
        </div>
      </div>

      <div className="flex" ref={bodyRef}>
        {/* Hour gutter — mono, right-aligned, centered on each hairline. The hour
            number keeps its own right-aligned column; AM/PM lives in a
            fixed-width slot beside it that is empty on every row where the
            meridiem hasn't changed (see hourLabel), so 6→12→1→12 still reads as
            one quiet stack of figures and nothing wraps. */}
        <div className="relative shrink-0" style={{ width: GUTTER_WIDTH, height }}>
          {HOUR_MARKS.map((min) => {
            const { hour, meridiem } = hourLabel(min);
            return (
              <div
                key={min}
                className="t-time absolute inset-x-0 flex items-baseline justify-end gap-0.5 whitespace-nowrap pr-2 leading-4 text-ink-soft"
                style={{ top: geo.yOf(min), transform: 'translateY(-50%)' }}
              >
                <span>{hour}</span>
                <span className="w-4 text-left">{meridiem}</span>
              </div>
            );
          })}
        </div>

        <div className="relative min-w-0 flex-1" style={{ height }}>
          {/* Hairlines at each hour, spanning all columns. */}
          {HOUR_MARKS.map((min) => (
            <div
              key={min}
              aria-hidden="true"
              className="absolute inset-x-0 bg-rule"
              style={{ top: geo.yOf(min), height: 1 }}
            />
          ))}

          <div className="absolute inset-0 grid grid-cols-7" ref={colsRef}>
            {days.map((date, dayIndex) => (
              <div key={date} className="relative border-l border-rule">
                {(byDate.get(date) ?? []).map((inst) => {
                  const key = instanceKey(inst.event_id, inst.instance_date);
                  return (
                    <EventBlock
                      key={key}
                      inst={inst}
                      geo={geo}
                      rect={geo.blockRect(inst)}
                      dayIndex={dayIndex}
                      pending={pendingKeys.has(key)}
                      columnAt={columnAt}
                      onProposeShift={onProposeShift}
                      onSetTime={onSetTime}
                    />
                  );
                })}
                {(remindersByDate.get(date) ?? []).map((r) => (
                  <ReminderMarker key={r.id} reminder={r} geo={geo} onDelete={onDeleteReminder} />
                ))}
                {date === today && <NowLine geo={geo} />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
