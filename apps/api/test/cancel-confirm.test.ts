/**
 * A cancel always asks first (SPEC §0, README "Cancelling still asks").
 *
 * Driven through the real POST /api/chat route — the real agent loop and the
 * real commit policy — with only the claude CLI process mocked. The model asks
 * for a cancel and a move in the same turn: the move auto-applies like any
 * reversible change, the cancel is filed pending and deletes nothing until the
 * confirm (approve) comes in.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

process.env.MISE_SETTINGS_PATH = '/nonexistent/mise-cancel-confirm-test-settings.json';

import { resetDbForTests, schema, type DB } from '@mise/core';
import { __setClaudeCliTestOverrides, type ClaudeSpawnLike } from '../../../packages/core/src/claude-cli';
import { app } from '../src/app';

let db: DB;
const savedBin = process.env.MISE_CLAUDE_BIN;
const savedBackend = process.env.MISE_CHAT_BACKEND;

function stream(s: string): ReadableStream<Uint8Array> {
  return new Response(s).body!;
}

/** A claude CLI child that prints one json result. */
function cliResult(result: string): ClaudeSpawnLike {
  const json = JSON.stringify({ type: 'result', is_error: false, result, session_id: 'sess-1' });
  return { stdout: stream(json), stderr: stream(''), exited: Promise.resolve(0), kill() {} };
}

/** The CLI answers each model round from `results`, in order. */
function mockModel(results: string[]): void {
  __setClaudeCliTestOverrides({
    spawn: () => {
      const r = results.shift();
      if (r === undefined) throw new Error('model called more times than scripted');
      return cliResult(r);
    },
    fallback: () => {
      throw new Error('fallback must not run in this test');
    },
  });
}

const call = (name: string, args: unknown) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

beforeEach(() => {
  process.env.MISE_CLAUDE_BIN = '/fake/claude';
  delete process.env.MISE_CHAT_BACKEND;
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({ id: 's1', name: 'Fall', start_date: '2026-08-26', end_date: '2026-12-09', timezone: 'America/Chicago' })
    .run();
  const ev = (id: string, title: string, kind: 'gym' | 'personal', date: string, s: string, e: string) => ({
    id,
    semester_id: 's1',
    title,
    kind,
    starts_at: `${date}T${s}`,
    ends_at: `${date}T${e}`,
    pinned: false,
    rrule: null,
    source: 'manual' as const,
    location: null,
    notes: null,
  });
  db.insert(schema.event)
    .values([
      ev('gym1', 'Gym', 'gym', '2026-09-02', '16:00', '17:30'),
      ev('adv1', 'Advising appointment', 'personal', '2026-09-03', '11:45', '12:30'),
    ])
    .run();
});

afterEach(() => {
  __setClaudeCliTestOverrides();
  if (savedBin === undefined) delete process.env.MISE_CLAUDE_BIN;
  else process.env.MISE_CLAUDE_BIN = savedBin;
  if (savedBackend === undefined) delete process.env.MISE_CHAT_BACKEND;
  else process.env.MISE_CHAT_BACKEND = savedBackend;
});

const eventRow = (id: string) => db.select().from(schema.event).where(eq(schema.event.id, id)).get();

describe('cancel from chat', () => {
  test('is filed for confirmation and deletes nothing; a move in the same turn still auto-applies', async () => {
    mockModel([
      [
        call('cancel_event', { event_id: 'adv1', expect_title: 'Advising appointment' }),
        call('shift_events', { scope: 'single', date: '2026-09-02', event_id: 'gym1', expect_title: 'Gym', delta_minutes: 60 }),
      ].join('\n'),
      '',
    ]);

    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'cancel my advising appointment and push my gym an hour' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: string; proposals: { id: string; tool_name: string; status: string }[] };

    const cancel = body.proposals.find((p) => p.tool_name === 'cancel_event')!;
    const shift = body.proposals.find((p) => p.tool_name === 'shift_events')!;
    expect(cancel.status).toBe('pending');
    expect(shift.status).toBe('approved');

    // Nothing was deleted; the move landed.
    expect(eventRow('adv1')).toBeDefined();
    expect(eventRow('gym1')!.starts_at).toBe('2026-09-02T17:00');

    // The reply asks rather than claiming it's done.
    expect(body.reply).toContain('Cancel Advising appointment');
    expect(body.reply).toContain('approve it below');
    expect(body.reply).not.toContain('Cancelled');

    // The confirm tap is what deletes it.
    const approve = await app.request(`/api/proposals/${cancel.id}/approve`, { method: 'POST' });
    expect(approve.status).toBe(200);
    expect(eventRow('adv1')).toBeUndefined();
  });

  test('rejecting the card leaves the event where it was', async () => {
    mockModel([call('cancel_event', { event_id: 'adv1', expect_title: 'Advising appointment' }), '']);
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'cancel my advising appointment' }),
    });
    const body = (await res.json()) as { proposals: { id: string; status: string }[] };
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]!.status).toBe('pending');

    const reject = await app.request(`/api/proposals/${body.proposals[0]!.id}/reject`, { method: 'POST' });
    expect(reject.status).toBe(200);
    expect(eventRow('adv1')).toBeDefined();
  });
});
