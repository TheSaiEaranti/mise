/**
 * Reminders CRUD — day+time+label markers, separate from calendar events.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, type DB } from '../src/db/client';
import { createReminder, listReminders, deleteReminder } from '../src/reminders';

let db: DB;
beforeEach(() => {
  db = resetDbForTests();
});

describe('reminders', () => {
  test('create + list, sorted by date then time', () => {
    createReminder(db, { date: '2026-09-10', time: '14:00', title: 'Call mom' });
    createReminder(db, { date: '2026-09-08', time: '09:30', title: 'Dentist' });
    createReminder(db, { date: '2026-09-08', time: '08:00', title: 'Take vitamins' });
    const all = listReminders(db);
    expect(all.map((r) => r.title)).toEqual(['Take vitamins', 'Dentist', 'Call mom']);
    expect(all[0]!.date).toBe('2026-09-08');
    expect(all[0]!.time).toBe('08:00');
    expect(all[0]!.id).toBeTruthy();
    expect(all[0]!.created_at).toBeTruthy();
  });

  test('list filters by date range (inclusive)', () => {
    createReminder(db, { date: '2026-09-01', time: '10:00', title: 'A' });
    createReminder(db, { date: '2026-09-15', time: '10:00', title: 'B' });
    createReminder(db, { date: '2026-09-30', time: '10:00', title: 'C' });
    expect(listReminders(db, '2026-09-10', '2026-09-20').map((r) => r.title)).toEqual(['B']);
  });

  test('title is trimmed', () => {
    const r = createReminder(db, { date: '2026-09-08', time: '09:30', title: '  buy flowers  ' });
    expect(r.title).toBe('buy flowers');
  });

  test('delete removes it and reports success/failure', () => {
    const r = createReminder(db, { date: '2026-09-08', time: '09:30', title: 'X' });
    expect(deleteReminder(db, r.id)).toBe(true);
    expect(listReminders(db)).toEqual([]);
    expect(deleteReminder(db, r.id)).toBe(false); // already gone
    expect(deleteReminder(db, 'nope')).toBe(false);
  });
});
