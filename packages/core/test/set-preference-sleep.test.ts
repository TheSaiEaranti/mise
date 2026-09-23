/**
 * set_preference type 'sleep' — Sai's protected sleep window is EDITABLE now,
 * not a hardcoded 12am-7am. Setting it flows through effectiveConstraints, so
 * the validator lets him schedule outside his real hours (a 1 AM block when he
 * sleeps 2-9).
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { setPreferenceTool } from '../src/tools/set-preference';
import { validate } from '../src/validator';
import { effectiveConstraints } from '@mise/config/settings';
import type { ProposedInstance } from '../src/types';

const SETTINGS = `/tmp/mise-sleep-test-${process.pid}.json`;

beforeEach(() => {
  process.env.MISE_SETTINGS_PATH = SETTINGS;
  rmSync(SETTINGS, { force: true }); // start from defaults each test
});
afterAll(() => {
  rmSync(SETTINGS, { force: true });
  process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json'; // don't leak into other files
});

const at = (start: string, end: string): ProposedInstance => ({
  event_id: 'x', instance_date: '2026-09-07', title: 'Skin and hair care', kind: 'personal',
  starts_at: `2026-09-07T${start}`, ends_at: `2026-09-07T${end}`, pinned: false, location: null,
  notes: null, source: 'agent', recurring: false, color: null, workout: null,
  created: true, // checkSleep only flags instances the proposal CHANGED
});

const sleepConflicts = () => validate({ events: [at('01:00', '01:15')], constraints: effectiveConstraints() }).filter((c) => c.type === 'constraint' && c.rule === 'sleep');

describe('editable sleep hours', () => {
  test('default blocks 1 AM; after setting sleep to 2-9 it is allowed', async () => {
    expect(effectiveConstraints().sleep.protect).toBe('00:00-07:00'); // hardcoded default
    expect(sleepConflicts().length).toBeGreaterThan(0); // 1 AM blocked by default

    const { diff, conflicts } = await setPreferenceTool.run({ type: 'sleep', sleep: '02:00-09:00' } as never, 'commit');
    expect(conflicts).toEqual([]);
    expect(effectiveConstraints().sleep.protect).toBe('02:00-09:00');
    expect(diff.sleep_before).toBe('00:00-07:00');
    expect(diff.sleep_after).toBe('02:00-09:00');

    expect(sleepConflicts()).toEqual([]); // 1 AM now fine (before the 2 AM window)
  });

  test('2:30 AM is still blocked under the new 2-9 window', async () => {
    await setPreferenceTool.run({ type: 'sleep', sleep: '02:00-09:00' } as never, 'commit');
    const c = validate({ events: [at('02:30', '02:45')], constraints: effectiveConstraints() }).filter((x) => x.type === 'constraint' && x.rule === 'sleep');
    expect(c.length).toBeGreaterThan(0);
  });

  test('setting the same window is a no-op', async () => {
    await setPreferenceTool.run({ type: 'sleep', sleep: '02:00-09:00' } as never, 'commit');
    const again = await setPreferenceTool.run({ type: 'sleep', sleep: '02:00-09:00' } as never, 'commit');
    expect(again.conflicts.some((c) => c.type === 'constraint' && c.rule === 'already')).toBe(true);
  });
});
