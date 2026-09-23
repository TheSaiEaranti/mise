/**
 * POST /api/chat/stream: progress as Server-Sent Events. A fast-path command
 * needs no model at all, so this runs the real route end to end.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

process.env.MISE_SETTINGS_PATH = '/nonexistent/mise-chat-stream-test-settings.json';

import { addDaysWall, resetDbForTests, schema, todayInTz, type DB } from '@mise/core';
import { app } from '../src/app';

let db: DB;
const tomorrow = addDaysWall(todayInTz(), 1);

beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: addDaysWall(todayInTz(), -30), end_date: addDaysWall(todayInTz(), 60), timezone: 'America/Chicago' })
    .run();
  db.insert(schema.event)
    .values({ id: 'gym1', semester_id: 's1', title: 'Gym', kind: 'gym', starts_at: `${tomorrow}T16:00`, ends_at: `${tomorrow}T17:30`, pinned: false, rrule: null, source: 'manual', location: null, notes: null })
    .run();
});

function parse(text: string): { event: string; data: any }[] {
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => {
      const event = /event: (.+)/.exec(b)?.[1] ?? 'message';
      const data = JSON.parse(b.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''));
      return { event, data };
    });
}

describe('/api/chat/stream', () => {
  test('streams status, the dry-run diff, the commit, then the same answer /api/chat gives', async () => {
    const res = await app.request('/api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: "push tomorrow's gym back 30 minutes" }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parse(await res.text());
    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe('status');
    expect(kinds.indexOf('proposal')).toBeLessThan(kinds.indexOf('settled'));
    expect(kinds[kinds.length - 1]).toBe('done');
    expect(events.find((e) => e.event === 'proposal')!.data.proposal.status).toBe('pending'); // dry-run, before the gate
    expect(events.find((e) => e.event === 'settled')!.data.proposal.status).toBe('approved');
    expect(events.filter((e) => e.event === 'status').map((e) => e.data.text)).toContain('Moved');
    const done = events[events.length - 1]!.data;
    expect(done.reply).toContain('Moved Gym');
    expect(db.select().from(schema.event).all().find((e) => e.id === 'gym1')!.starts_at).toBe(`${tomorrow}T16:30`);
  });

  test('bad bodies are rejected before streaming', async () => {
    const res = await app.request('/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
  });
});
