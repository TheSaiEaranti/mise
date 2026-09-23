'use client';

/**
 * The now line: 2px --signal across today's column with a 5px dot at the left
 * edge. One of the sanctioned uses of orange. Position refreshes every minute.
 */
import { useEffect, useState } from 'react';
import { minutesOfDay, nowInTz, timeOf } from '@mise/core/time';
import { DAY_END_MIN, DAY_START_MIN, type Geometry } from './geometry';

/**
 * Wall-clock 'YYYY-MM-DDTHH:mm' in the semester zone, refreshed every minute.
 * Null until mounted — SSR and hydration would disagree about the minute.
 */
export function useNowTick(): string | null {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    setNow(nowInTz());
    const timer = setInterval(() => setNow(nowInTz()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function NowLine({ geo }: { geo: Geometry }) {
  const now = useNowTick();
  if (!now) return null;
  const min = minutesOfDay(timeOf(now));
  if (min < DAY_START_MIN || min > DAY_END_MIN) return null;
  const y = geo.yOf(min);
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10">
      <div className="absolute inset-x-0 bg-signal" style={{ top: y - 1, height: 2 }} />
      <div
        className="absolute rounded-full bg-signal"
        style={{ top: y - 2.5, left: -2.5, width: 5, height: 5 }}
      />
    </div>
  );
}
