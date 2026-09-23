/**
 * Reminders — lightweight day+time+label markers, separate from calendar events.
 * They have no duration and are never reflowed; the week grid paints each as a
 * small "R" marker. Added from the Reminders tab, deleted from the calendar.
 */
import { and, eq, gte, lte } from 'drizzle-orm';
import type { DB } from './db/client';
import { schema } from './db/client';
import { newId } from './proposals';
import { DEFAULT_TZ, nowInTz } from './time';
import type { Reminder } from './types';

export type { Reminder };

export function createReminder(db: DB, input: { date: string; time: string; title: string }): Reminder {
  const row: Reminder = {
    id: newId('rem'),
    date: input.date,
    time: input.time,
    title: input.title.trim(),
    created_at: nowInTz(DEFAULT_TZ),
  };
  db.insert(schema.reminder).values(row).run();
  return row;
}

/** All reminders, or those within [start, end] inclusive (by date). Sorted. */
export function listReminders(db: DB, start?: string, end?: string): Reminder[] {
  const rows =
    start && end
      ? db.select().from(schema.reminder).where(and(gte(schema.reminder.date, start), lte(schema.reminder.date, end))).all()
      : db.select().from(schema.reminder).all();
  return rows.sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
}

/** Returns false if there was no such reminder. */
export function deleteReminder(db: DB, id: string): boolean {
  const existing = db.select().from(schema.reminder).where(eq(schema.reminder.id, id)).get();
  if (!existing) return false;
  db.delete(schema.reminder).where(eq(schema.reminder.id, id)).run();
  return true;
}
