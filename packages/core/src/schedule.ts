/**
 * Schedule reading: thin DB glue over the pure recurrence expander.
 * Single-semester assumption throughout (SPEC: one user, one semester at a time).
 */
import type { DB } from './db/client';
import { event, eventException, semester } from './db/schema';
import { expandInstances } from './recurrence';
import type { EventInstance } from './types';

export type SemesterRow = typeof semester.$inferSelect;

/** The (single) semester row, or null before setup has run. */
export function getSemester(db: DB): SemesterRow | null {
  return db.select().from(semester).limit(1).all()[0] ?? null;
}

/**
 * Concrete event instances in [windowStart, windowEnd], clamped to the
 * semester's [start_date, end_date]. Empty when no semester exists or the
 * clamped window is empty.
 */
export function getInstances(db: DB, windowStart: string, windowEnd: string): EventInstance[] {
  const sem = getSemester(db);
  if (!sem) return [];

  const start = windowStart > sem.start_date ? windowStart : sem.start_date;
  const end = windowEnd < sem.end_date ? windowEnd : sem.end_date;
  if (start > end) return [];

  const events = db.select().from(event).all();
  const exceptions = db.select().from(eventException).all();
  return expandInstances(events, exceptions, start, end);
}
