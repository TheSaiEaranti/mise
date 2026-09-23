/**
 * Schedule-photo import. The vision model reads pixels; THESE functions decide
 * what the app actually believes. A misread day code or a botched AM/PM silently
 * puts a class in the wrong place all semester, so they get pinned down hard.
 *
 * No network, no Ollama: the model call is not exercised here.
 */
import { describe, test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { normalizeDays, normalizeTime, stripDataUrl } from '../src/schedule-import';
import { resetDbForTests, schema } from '../src/db/client';
import { addClassesTool } from '../src/tools/add-classes';
import { getInstances } from '../src/schedule';
import { createProposal, type ProposalRow } from '../src/proposals';
import { undoProposal, isUndoable } from '../src/undo';

describe('normalizeDays — registrar day codes come in every shape', () => {
  test('run-together codes', () => {
    expect(normalizeDays('MWF')).toEqual(['MO', 'WE', 'FR']);
    expect(normalizeDays('TTh')).toEqual(['TU', 'TH']);
    expect(normalizeDays('TuTh')).toEqual(['TU', 'TH']);
    expect(normalizeDays('MW')).toEqual(['MO', 'WE']);
  });

  test('"Th" is Thursday, never Tuesday+H', () => {
    expect(normalizeDays('Th')).toEqual(['TH']);
    expect(normalizeDays('T')).toEqual(['TU']);
    // The classic registrar shorthand: R = Thursday.
    expect(normalizeDays('TR')).toEqual(['TU', 'TH']);
  });

  test('separators and long names', () => {
    expect(normalizeDays('Mon/Wed')).toEqual(['MO', 'WE']);
    expect(normalizeDays('Monday, Wednesday')).toEqual(['MO', 'WE']);
    expect(normalizeDays('M W F')).toEqual(['MO', 'WE', 'FR']);
    expect(normalizeDays(['Tue', 'Thu'])).toEqual(['TU', 'TH']);
  });

  test('deduplicates and sorts into week order', () => {
    expect(normalizeDays('F M W M')).toEqual(['MO', 'WE', 'FR']);
  });

  test('junk yields nothing rather than a wrong guess', () => {
    expect(normalizeDays('')).toEqual([]);
    expect(normalizeDays('n/a')).toEqual([]);
  });
});

describe('normalizeTime — the model reports what is printed; we convert', () => {
  test('12-hour with meridiem', () => {
    expect(normalizeTime('10:00 AM')).toBe('10:00');
    expect(normalizeTime('2:00 PM')).toBe('14:00');
    expect(normalizeTime('3:30pm')).toBe('15:30');
    expect(normalizeTime('12:00 PM')).toBe('12:00'); // noon
    expect(normalizeTime('12:30 AM')).toBe('00:30'); // after midnight
  });

  test('already 24-hour', () => {
    expect(normalizeTime('14:00')).toBe('14:00');
    expect(normalizeTime('09:05')).toBe('09:05');
  });

  test('odd but real formats', () => {
    expect(normalizeTime('9 AM')).toBe('09:00');
    expect(normalizeTime('1.30pm')).toBe('13:30');
  });

  test('unreadable → null, never a guess', () => {
    expect(normalizeTime('')).toBeNull();
    expect(normalizeTime('TBA')).toBeNull();
    expect(normalizeTime('25:00')).toBeNull();
    expect(normalizeTime('10:70')).toBeNull();
  });
});

test('stripDataUrl tolerates a data: prefix', () => {
  expect(stripDataUrl('data:image/png;base64,AAAB')).toBe('AAAB');
  expect(stripDataUrl('AAAB')).toBe('AAAB');
});

describe('add_classes — the commit path for an imported schedule', () => {
  const semester = {
    id: 'sem-1',
    name: 'Fall 2026',
    start_date: '2026-08-26', // a Wednesday
    end_date: '2026-12-11',
    timezone: 'America/Chicago',
  };

  test('creates pinned recurring classes that expand on the right days', async () => {
    const db = resetDbForTests();
    db.insert(schema.semester).values(semester).run();

    const { diff, conflicts } = await addClassesTool.run(
      {
        classes: [
          { title: 'CS 429', days: ['MO', 'WE', 'FR'], start_time: '10:00', end_time: '11:00', location: 'GDC 2.216' },
          { title: 'CS 439', days: ['TU', 'TH'], start_time: '14:00', end_time: '15:30' },
        ],
      },
      'commit',
    );

    expect(conflicts).toHaveLength(0);
    expect(diff.changes).toHaveLength(2);
    expect(diff.changes.every((c) => c.pinned)).toBe(true);

    // Week of Mon 2026-09-07: CS 429 on Mo/We/Fr, CS 439 on Tu/Th.
    const week = getInstances(db, '2026-09-07', '2026-09-13');
    expect(week.filter((i) => i.title === 'CS 429').map((i) => i.instance_date)).toEqual([
      '2026-09-07', '2026-09-09', '2026-09-11',
    ]);
    expect(week.filter((i) => i.title === 'CS 439')).toHaveLength(2);
    expect(week.every((i) => i.pinned)).toBe(true);
    expect(week.find((i) => i.title === 'CS 429')?.location).toBe('GDC 2.216');
  });

  test('dry run writes nothing', async () => {
    const db = resetDbForTests();
    db.insert(schema.semester).values(semester).run();

    await addClassesTool.run(
      { classes: [{ title: 'CS 429', days: ['MO'], start_time: '10:00', end_time: '11:00' }] },
      'dry',
    );
    expect(db.select().from(schema.event).all()).toHaveLength(0);
  });

  test('a photo that double-books an hour surfaces an overlap warning', async () => {
    const db = resetDbForTests();
    db.insert(schema.semester).values(semester).run();

    const { conflicts } = await addClassesTool.run(
      {
        classes: [
          { title: 'CS 429', days: ['MO'], start_time: '10:00', end_time: '11:00' },
          { title: 'M 340L', days: ['MO'], start_time: '10:30', end_time: '11:30' },
        ],
      },
      'dry',
    );
    expect(conflicts.some((c) => c.type === 'overlap')).toBe(true);
  });

  test('no semester → refuses, with no writes', async () => {
    const db = resetDbForTests();
    const { conflicts, diff } = await addClassesTool.run(
      { classes: [{ title: 'CS 429', days: ['MO'], start_time: '10:00', end_time: '11:00' }] },
      'commit',
    );
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'no_semester')).toBe(true);
    expect(diff.changes).toHaveLength(0);
    expect(db.select().from(schema.event).all()).toHaveLength(0);
  });

  test('backwards times are caught, not committed', async () => {
    const db = resetDbForTests();
    db.insert(schema.semester).values(semester).run();

    const { conflicts } = await addClassesTool.run(
      { classes: [{ title: 'CS 429', days: ['MO'], start_time: '14:00', end_time: '13:00' }] },
      'commit',
    );
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'bad_times')).toBe(true);
    expect(db.select().from(schema.event).all()).toHaveLength(0);
  });

  // Now that the chat model can add classes itself, a chat-added class has to be
  // one Cmd-Z from gone — the safety that lets it auto-apply.
  test('an added class is undoable — Cmd-Z removes it again', async () => {
    const db = resetDbForTests();
    db.insert(schema.semester).values(semester).run();

    const { diff } = await addClassesTool.run(
      { classes: [{ title: 'DATABASE DESIGN', days: ['MO', 'WE'], start_time: '11:00', end_time: '12:30', location: 'GAR 2.112' }] },
      'commit',
    );
    expect(db.select().from(schema.event).where(eq(schema.event.kind, 'class')).all()).toHaveLength(1);

    const p = createProposal(db, { user_message: 'add my classes', tool_name: 'add_classes', tool_args: {}, diff, conflicts: [] });
    db.update(schema.proposal).set({ status: 'approved' }).where(eq(schema.proposal.id, p.id)).run();
    const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, p.id)).get()! as ProposalRow;

    expect(isUndoable(row)).toBe(true);
    expect(undoProposal(db, row).ok).toBe(true);
    expect(db.select().from(schema.event).where(eq(schema.event.kind, 'class')).all()).toHaveLength(0);
  });
});
