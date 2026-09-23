/**
 * API integration tests — app.request() straight into Hono, no live server.
 *
 * Fixture week: Mon 2026-07-13 … Sun 2026-07-19. Seeded: a pinned recurring
 * class (TU/TH 14:00), a recurring gym (MO/WE/FR 07:00), a standalone gym +
 * cook on Tue Jul 14.
 *
 * Under test: the proposal lifecycle is the ONLY write path (I2), approve
 * re-derives from current DB state (needs_review / blocked / stale), pinned
 * events never move (I4).
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createMeal, createSuite, getDb, resetDbForTests, runAgentTurn, schema, severityOf, TS_RE, type Conflict, type DB } from '@mise/core';
import { applyProposal, isAutoApplied } from '../src/lib/apply';
import { app } from '../src/app';

// Settings tests must never touch the repo's data/settings.local.json.
const SETTINGS_PATH = join(tmpdir(), `mise-api-test-settings-${process.pid}-${Date.now()}.json`);
process.env.MISE_SETTINGS_PATH = SETTINGS_PATH;
rmSync(SETTINGS_PATH, { force: true });

let db: DB;

function seedBase(d: DB): void {
  d.insert(schema.semester)
    .values({
      id: 'sem1',
      name: 'Fall 2026',
      start_date: '2026-07-01',
      end_date: '2026-12-18',
      timezone: 'America/Chicago',
    })
    .run();
  d.insert(schema.event)
    .values([
      {
        id: 'cs429',
        semester_id: 'sem1',
        title: 'CS 429',
        kind: 'class',
        starts_at: '2026-07-14T14:00',
        ends_at: '2026-07-14T15:00',
        pinned: true,
        rrule: 'FREQ=WEEKLY;BYDAY=TU,TH',
        source: 'recurring',
        location: 'GDC',
        notes: null,
      },
      {
        id: 'rgym',
        semester_id: 'sem1',
        title: 'Lift',
        kind: 'gym',
        starts_at: '2026-07-13T07:00',
        ends_at: '2026-07-13T08:30',
        pinned: false,
        rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
        source: 'recurring',
        location: null,
        notes: null,
      },
      {
        id: 'gym1',
        semester_id: 'sem1',
        title: 'Gym',
        kind: 'gym',
        starts_at: '2026-07-14T16:00',
        ends_at: '2026-07-14T17:30',
        pinned: false,
        rrule: null,
        source: 'manual',
        location: null,
        notes: null,
      },
      {
        id: 'cook1',
        semester_id: 'sem1',
        title: 'Cook lunches',
        kind: 'cook',
        starts_at: '2026-07-14T18:30',
        ends_at: '2026-07-14T19:30',
        pinned: false,
        rrule: null,
        source: 'manual',
        location: null,
        notes: null,
      },
    ])
    .run();
}


const jsonReq = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function createProposalVia(tool_name: string, tool_args: unknown, user_message?: string) {
  const res = await app.request('/api/proposals', jsonReq('POST', { tool_name, tool_args, user_message }));
  expect(res.status).toBe(201);
  const { proposal } = (await res.json()) as { proposal: { id: string; status: string } };
  return proposal;
}

beforeEach(() => {
  db = resetDbForTests();
  seedBase(db);
});

// ---------------------------------------------------------------------------

describe('health', () => {
  test('reports ok, model, and db path', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; model: string; db: string };
    expect(body.ok).toBe(true);
    expect(body.model.length).toBeGreaterThan(0);
    expect(body.db.length).toBeGreaterThan(0);
  });
});

describe('GET /api/schedule', () => {
  test('returns expanded recurring instances in the window', async () => {
    const res = await app.request('/api/schedule?start=2026-07-13&end=2026-07-19');
    expect(res.status).toBe(200);
    const { instances } = (await res.json()) as { instances: { event_id: string; instance_date: string; pinned: boolean }[] };
    // CS 429 expands to TU + TH; the recurring gym to MO/WE/FR.
    expect(instances.filter((i) => i.event_id === 'cs429').map((i) => i.instance_date)).toEqual([
      '2026-07-14',
      '2026-07-16',
    ]);
    expect(instances.filter((i) => i.event_id === 'rgym')).toHaveLength(3);
    expect(instances.filter((i) => i.event_id === 'gym1')).toHaveLength(1);
    expect(instances.find((i) => i.event_id === 'cs429')?.pinned).toBe(true);
  });

  test('defaults to a two-week window without params', async () => {
    const res = await app.request('/api/schedule');
    expect(res.status).toBe(200);
    const { instances } = (await res.json()) as { instances: unknown[] };
    expect(Array.isArray(instances)).toBe(true);
  });

  test('rejects malformed dates with issues', async () => {
    const res = await app.request('/api/schedule?start=next-tuesday');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBeString();
    expect(body.issues.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('proposal lifecycle (the drag path)', () => {
  test('create via POST /api/proposals → approve applies the shift in the DB', async () => {
    const prop = await createProposalVia('shift_events', {
      scope: 'single',
      date: '2026-07-14',
      event_id: 'gym1',
      expect_title: 'Gym',
      delta_minutes: 60,
    });
    expect(prop.status).toBe('pending');

    // Dry run wrote nothing (I2).
    expect(db.select().from(schema.event).where(eq(schema.event.id, 'gym1')).get()!.starts_at).toBe(
      '2026-07-14T16:00',
    );

    const res = await app.request(`/api/proposals/${prop.id}/approve`, jsonReq('POST'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; proposal: { status: string; applied_at: string | null } };
    expect(body.status).toBe('applied');
    expect(body.proposal.status).toBe('approved');
    expect(body.proposal.applied_at).toMatch(TS_RE);

    // The event actually moved.
    const moved = db.select().from(schema.event).where(eq(schema.event.id, 'gym1')).get()!;
    expect(moved.starts_at).toBe('2026-07-14T17:00');
    expect(moved.ends_at).toBe('2026-07-14T18:30');

    // And the audit row agrees.
    const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, prop.id)).get()!;
    expect(row.status).toBe('approved');
    expect(row.applied_at).toMatch(TS_RE);
  });

  test('approve is refused with 409 when the proposal is not pending', async () => {
    const prop = await createProposalVia('shift_events', {
      scope: 'single',
      date: '2026-07-14',
      event_id: 'gym1',
      expect_title: 'Gym',
      delta_minutes: 30,
    });
    expect((await app.request(`/api/proposals/${prop.id}/approve`, jsonReq('POST'))).status).toBe(200);

    const again = await app.request(`/api/proposals/${prop.id}/approve`, jsonReq('POST'));
    expect(again.status).toBe(409);
    const body = (await again.json()) as { error: string };
    expect(body.error).toContain('approved');

    // No double-apply: still exactly one shift.
    expect(db.select().from(schema.event).where(eq(schema.event.id, 'gym1')).get()!.starts_at).toBe(
      '2026-07-14T16:30',
    );
  });

  test('the day changed since the diff was drawn → 409 needs_review, and you see the new knock-on first', async () => {
    const prop = await createProposalVia('shift_events', {
      scope: 'single',
      date: '2026-07-14',
      event_id: 'gym1',
      expect_title: 'Gym',
      delta_minutes: 60,
    });
    expect((prop as unknown as { conflicts: unknown[] }).conflicts ?? []).toBeArray();

    // DB changes underneath the pending proposal: a new event where the gym
    // is headed (17:00–18:30 after the shift).
    db.insert(schema.event)
      .values({
        id: 'intruder',
        semester_id: 'sem1',
        title: 'Study group',
        kind: 'personal',
        starts_at: '2026-07-14T17:00',
        ends_at: '2026-07-14T18:00',
        pinned: false,
        rrule: null,
        source: 'manual',
        location: null,
        notes: null,
      })
      .run();

    // The gym would now push the study group out of the way — a real change to
    // an event the diff card never mentioned. You approve what you were shown,
    // so this comes back for another look with the knock-on now in it.
    const res = await app.request(`/api/proposals/${prop.id}/approve`, jsonReq('POST'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      status: string;
      proposal: { status: string; diff: { changes: { title: string }[] } };
    };
    expect(body.status).toBe('needs_review');
    expect(body.proposal.status).toBe('pending'); // still approvable after review
    // Gym pushes the study group, which pushes the cook session behind it.
    expect(body.proposal.diff.changes.map((c) => c.title).sort()).toEqual([
      'Cook lunches',
      'Gym',
      'Study group',
    ]);

    // The stored row was updated with the fresh diff…
    const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, prop.id)).get()!;
    expect((row.diff as { changes: { title: string }[] }).changes.some((c) => c.title === 'Study group')).toBe(true);
    // …and nothing was written to the calendar.
    expect(db.select().from(schema.event).where(eq(schema.event.id, 'gym1')).get()!.starts_at).toBe(
      '2026-07-14T16:00',
    );
    expect(db.select().from(schema.event).where(eq(schema.event.id, 'intruder')).get()!.starts_at).toBe(
      '2026-07-14T17:00',
    );
  });

  test('blocked proposal (cancel a pinned class) → 409 blocked, DB untouched', async () => {
    const prop = await createProposalVia('cancel_event', { event_id: 'cs429', expect_title: 'CS 429', date: '2026-07-14' });
    const stored = (await (await app.request(`/api/proposals/${prop.id}`)).json()) as {
      proposal: { conflicts: { type: string }[] };
    };
    expect(stored.proposal.conflicts.some((c) => c.type === 'pinned_moved')).toBe(true);

    const res = await app.request(`/api/proposals/${prop.id}/approve`, jsonReq('POST'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('blocked');

    // Nothing happened: class row intact, no exception rows, proposal pending.
    expect(db.select().from(schema.event).where(eq(schema.event.id, 'cs429')).get()).toBeDefined();
    expect(db.select().from(schema.eventException).all()).toHaveLength(0);
    expect(db.select().from(schema.proposal).where(eq(schema.proposal.id, prop.id)).get()!.status).toBe('pending');
  });

  test('a target deleted after proposing → 409 needs_review with a stale conflict, no writes', async () => {
    const prop = await createProposalVia('shift_events', {
      scope: 'single',
      date: '2026-07-14',
      event_id: 'gym1',
      expect_title: 'Gym',
      delta_minutes: 60,
    });
    db.delete(schema.event).where(eq(schema.event.id, 'gym1')).run();

    const res = await app.request(`/api/proposals/${prop.id}/approve`, jsonReq('POST'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { status: string; proposal: { status: string; conflicts: { rule?: string }[] } };
    expect(body.status).toBe('needs_review');
    expect(body.proposal.status).toBe('pending');
    expect(body.proposal.conflicts.some((c) => c.rule === 'stale')).toBe(true);
    expect(db.select().from(schema.eventException).all()).toHaveLength(0);
  });

  test('reject flips pending → rejected and blocks later approval', async () => {
    const prop = await createProposalVia('shift_events', {
      scope: 'single',
      date: '2026-07-14',
      event_id: 'gym1',
      expect_title: 'Gym',
      delta_minutes: 15,
    });
    const res = await app.request(`/api/proposals/${prop.id}/reject`, jsonReq('POST'));
    expect(res.status).toBe(200);
    const { proposal } = (await res.json()) as { proposal: { status: string } };
    expect(proposal.status).toBe('rejected');

    expect((await app.request(`/api/proposals/${prop.id}/approve`, jsonReq('POST'))).status).toBe(409);
    expect(db.select().from(schema.event).where(eq(schema.event.id, 'gym1')).get()!.starts_at).toBe(
      '2026-07-14T16:00',
    );
  });

  test('list filters by status, newest first; unknown proposal 404s', async () => {
    const a = await createProposalVia('shift_events', { scope: 'day', date: '2026-07-14', delta_minutes: 10 });
    await app.request(`/api/proposals/${a.id}/reject`, jsonReq('POST'));
    const b = await createProposalVia('shift_events', { scope: 'day', date: '2026-07-14', delta_minutes: 20 });

    const pending = (await (await app.request('/api/proposals')).json()) as { proposals: { id: string }[] };
    expect(pending.proposals.map((p) => p.id)).toEqual([b.id]);

    const all = (await (await app.request('/api/proposals?status=all')).json()) as { proposals: { id: string }[] };
    expect(all.proposals).toHaveLength(2);
    expect(all.proposals[0]!.id).toBe(b.id); // newest first

    expect((await app.request('/api/proposals/prop-nope')).status).toBe(404);
    expect((await app.request('/api/proposals/prop-nope/approve', jsonReq('POST'))).status).toBe(404);
  });

  test('Cmd-Z (undo-last) walks back through history, newest first', async () => {
    const approve = (id: string) => app.request(`/api/proposals/${id}/approve`, jsonReq('POST'));

    // Two changes: shift the gym, then add a new event.
    const shift = await createProposalVia('shift_events', {
      scope: 'single', date: '2026-07-14', event_id: 'gym1', expect_title: 'Gym', delta_minutes: 60,
    });
    expect((await approve(shift.id)).status).toBe(200);
    const create = await createProposalVia('create_event', {
      title: 'Run', kind: 'gym', date: '2026-07-15', start_time: '06:30', duration_minutes: 60,
    });
    expect((await approve(create.id)).status).toBe(200);

    expect(db.select().from(schema.event).where(eq(schema.event.id, 'gym1')).get()!.starts_at).toBe('2026-07-14T17:00');
    expect(db.select().from(schema.event).all().some((e) => e.title === 'Run')).toBe(true);

    // First Cmd-Z reverses the newest change (the create).
    const u1 = (await (await app.request('/api/proposals/undo-last', jsonReq('POST'))).json()) as {
      ok: boolean; undone_id: string; summary: string;
    };
    expect(u1.ok).toBe(true);
    expect(u1.undone_id).toBe(create.id);
    expect(db.select().from(schema.event).all().some((e) => e.title === 'Run')).toBe(false);
    expect(db.select().from(schema.event).where(eq(schema.event.id, 'gym1')).get()!.starts_at).toBe('2026-07-14T17:00');

    // Second Cmd-Z steps back to the shift — not the create again.
    const u2 = (await (await app.request('/api/proposals/undo-last', jsonReq('POST'))).json()) as {
      ok: boolean; undone_id: string;
    };
    expect(u2.ok).toBe(true);
    expect(u2.undone_id).toBe(shift.id);
    expect(db.select().from(schema.event).where(eq(schema.event.id, 'gym1')).get()!.starts_at).toBe('2026-07-14T16:00');

    // Nothing left.
    const u3 = (await (await app.request('/api/proposals/undo-last', jsonReq('POST'))).json()) as { ok: boolean };
    expect(u3.ok).toBe(false);
  });

  test('a cancel waits for approval (never auto-applied), and Cmd-Z brings it back', async () => {
    // A cancel always asks first (SPEC §0): chat files it pending; only an
    // explicit approve — the confirm tap — deletes anything.
    expect(isAutoApplied('cancel_event')).toBe(false);

    const cancel = await createProposalVia('cancel_event', { event_id: 'gym1', expect_title: 'Gym' });
    expect((await app.request(`/api/proposals/${cancel.id}/approve`, jsonReq('POST'))).status).toBe(200);
    expect(db.select().from(schema.event).where(eq(schema.event.id, 'gym1')).get()).toBeUndefined();

    const u = (await (await app.request('/api/proposals/undo-last', jsonReq('POST'))).json()) as { ok: boolean };
    expect(u.ok).toBe(true);
    const gym = db.select().from(schema.event).where(eq(schema.event.id, 'gym1')).get()!;
    expect(gym.starts_at).toBe('2026-07-14T16:00');
    expect(gym.title).toBe('Gym');
  });

  test('rejects unknown tools, read tools, and bad args with 400', async () => {
    const unknown = await app.request('/api/proposals', jsonReq('POST', { tool_name: 'do_a_thing', tool_args: {} }));
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain('Unknown tool');

    const readTool = await app.request(
      '/api/proposals',
      jsonReq('POST', { tool_name: 'get_schedule', tool_args: { start_date: '2026-07-13', end_date: '2026-07-14' } }),
    );
    expect(readTool.status).toBe(400);
    expect(((await readTool.json()) as { error: string }).error).toContain('read tool');

    const badArgs = await app.request(
      '/api/proposals',
      jsonReq('POST', { tool_name: 'shift_events', tool_args: { scope: 'single', date: '2026-07-14' } }),
    );
    expect(badArgs.status).toBe(400);
    const body = (await badArgs.json()) as { issues: unknown[] };
    expect(body.issues.length).toBeGreaterThan(0);

    expect(db.select().from(schema.proposal).all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('semester', () => {
  test('GET reports the seeded semester and an onboarded flag', async () => {
    const res = await app.request('/api/semester');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { semester: { name: string } | null; onboarded: boolean };
    expect(body.semester?.name).toBe('Fall 2026');
    expect(typeof body.onboarded).toBe('boolean');
  });

  test('wizard: POST /proposal → approve creates semester + pinned classes', async () => {
    db = resetDbForTests(); // wizard starts from nothing
    const res = await app.request(
      '/api/semester/proposal',
      jsonReq('POST', {
        name: 'Spring 2027',
        start_date: '2026-08-24',
        end_date: '2026-12-11',
        classes: [{ title: 'CS 439', days: ['TU', 'TH'], start_time: '14:00', end_time: '15:15', location: 'GDC' }],
      }),
    );
    expect(res.status).toBe(201);
    const { proposal } = (await res.json()) as { proposal: { id: string; tool_name: string; user_message: string } };
    expect(proposal.tool_name).toBe('setup_semester');
    expect(proposal.user_message).toBe('Semester setup');
    expect(db.select().from(schema.semester).all()).toHaveLength(0); // dry = no writes

    const approve = await app.request(`/api/proposals/${proposal.id}/approve`, jsonReq('POST'));
    expect(approve.status).toBe(200);
    expect(db.select().from(schema.semester).all()).toHaveLength(1);

    const sched = (await (
      await app.request('/api/schedule?start=2026-08-24&end=2026-08-30')
    ).json()) as { instances: { title: string; pinned: boolean; instance_date: string }[] };
    const cls = sched.instances.filter((i) => i.title === 'CS 439');
    expect(cls.map((i) => i.instance_date)).toEqual(['2026-08-25', '2026-08-27']);
    expect(cls.every((i) => i.pinned)).toBe(true);
  });

  test('rejects a bad wizard body with issues', async () => {
    const res = await app.request(
      '/api/semester/proposal',
      jsonReq('POST', { name: 'Oops', start_date: 'someday', end_date: '2026-12-11', classes: [] }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: unknown[] };
    expect(body.issues.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('chat messages', () => {
  test('GET /api/chat/messages returns rows newest-last', async () => {
    db.insert(schema.chatMessage)
      .values([
        { id: 'm1', proposal_id: null, role: 'user', content: 'first', created_at: '2026-07-13T10:00' },
        { id: 'm2', proposal_id: null, role: 'assistant', content: 'second', created_at: '2026-07-13T10:00' },
      ])
      .run();
    const res = await app.request('/api/chat/messages?limit=50');
    expect(res.status).toBe(200);
    const { messages } = (await res.json()) as { messages: { content: string }[] };
    expect(messages.map((m) => m.content)).toEqual(['first', 'second']);
  });

  test('POST /api/chat validates the message body', async () => {
    expect((await app.request('/api/chat', jsonReq('POST', {}))).status).toBe(400);
    expect((await app.request('/api/chat', jsonReq('POST', { message: 'x'.repeat(2001) }))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('settings', () => {
  test('PUT roundtrip changes effectiveConstraints', async () => {
    const before = (await (await app.request('/api/settings')).json()) as {
      effective: { cook: { cadence_days: number }; gym: { duration_minutes: number } };
    };
    expect(before.effective.cook.cadence_days).toBe(2); // constraint defaults

    const put = await app.request(
      '/api/settings',
      jsonReq('PUT', { cook_cadence_days: 3, gym_duration_minutes: 60 }),
    );
    expect(put.status).toBe(200);
    const { settings } = (await put.json()) as { settings: { cook_cadence_days: number } };
    expect(settings.cook_cadence_days).toBe(3);

    const after = (await (await app.request('/api/settings')).json()) as {
      effective: { cook: { cadence_days: number }; gym: { duration_minutes: number } };
    };
    expect(after.effective.cook.cadence_days).toBe(3);
    expect(after.effective.gym.duration_minutes).toBe(60);
  });

  test('rejects out-of-range values', async () => {
    const res = await app.request('/api/settings', jsonReq('PUT', { cook_cadence_days: 0 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues[0]!.path).toBe('cook_cadence_days');
  });
});

// ---------------------------------------------------------------------------
// Regression: an approve that writes nothing must never report success.
// (Found by the adversarial review; see packages/core/test/review-fixes.test.ts
// for the tool-level half.)
// ---------------------------------------------------------------------------

describe('a proposal that applies nothing is never "applied"', () => {
  test('day-scope shift whose every target vanished → 409 needs_review, not 200', async () => {
    const prop = await createProposalVia('shift_events', {
      scope: 'day',
      date: '2026-07-14',
      delta_minutes: 60,
      kinds: ['gym', 'cook'],
    });

    // The user saw a real diff...
    const seen = db.select().from(schema.proposal).where(eq(schema.proposal.id, prop.id)).get()!;
    expect((seen.diff as { changes: unknown[] }).changes.length).toBe(2);

    // ...then both targets disappear before they hit Approve.
    db.delete(schema.event).where(eq(schema.event.id, 'gym1')).run();
    db.delete(schema.event).where(eq(schema.event.id, 'cook1')).run();

    const res = await app.request(`/api/proposals/${prop.id}/approve`, jsonReq('POST'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      status: string;
      proposal: { status: string; applied_at: string | null; conflicts: { rule?: string }[] };
    };
    expect(body.status).toBe('needs_review');
    expect(body.proposal.status).toBe('pending');
    expect(body.proposal.applied_at).toBeNull();
    expect(body.proposal.conflicts.some((c) => c.rule === 'stale')).toBe(true);
  });

  test('a tool that could not act (no semester) cannot be approved', async () => {
    db.delete(schema.event).run();
    db.delete(schema.semester).run();

    const prop = await createProposalVia('create_event', {
      title: 'Gym',
      kind: 'gym',
      date: '2026-07-15',
      start_time: '17:00',
      duration_minutes: 90,
    });
    const stored = db.select().from(schema.proposal).where(eq(schema.proposal.id, prop.id)).get()!;
    expect((stored.diff as { changes: unknown[] }).changes).toHaveLength(0);

    const res = await app.request(`/api/proposals/${prop.id}/approve`, jsonReq('POST'));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { status: string }).status).toBe('blocked');

    const after = db.select().from(schema.proposal).where(eq(schema.proposal.id, prop.id)).get()!;
    expect(after.status).toBe('pending');
    expect(after.applied_at).toBeNull();
    expect(db.select().from(schema.event).all()).toHaveLength(0);
  });

  test('cancelling a cook session applies cleanly and deletes the block', async () => {
    const prop = await createProposalVia('cancel_event', { event_id: 'cook1', expect_title: 'Cook lunches' });
    const res = await app.request(`/api/proposals/${prop.id}/approve`, jsonReq('POST'));
    expect(res.status).toBe(200);
    expect(db.select().from(schema.event).all().some((e) => e.id === 'cook1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Drag applies on drop (the UI approves immediately). The safety properties
// that made the approve-click safe must still hold on the server.
// ---------------------------------------------------------------------------

describe('drag-to-move: create then immediately approve', () => {
  test('a movable event moves across days and lands in the audit log', async () => {
    // Tue 16:00 gym → Thu 18:00 is +2 days +2h = 3000 minutes.
    const prop = await createProposalVia('shift_events', {
      scope: 'single',
      event_id: 'gym1',
      expect_title: 'Gym',
      date: '2026-07-14',
      delta_minutes: 3000,
    });
    expect(prop.status).toBe('pending');

    const res = await app.request(`/api/proposals/${prop.id}/approve`, jsonReq('POST'));
    expect(res.status).toBe(200);

    const moved = db.select().from(schema.event).where(eq(schema.event.id, 'gym1')).get()!;
    expect(moved.starts_at).toBe('2026-07-16T18:00');
    expect(moved.ends_at).toBe('2026-07-16T19:30');

    const row = db.select().from(schema.proposal).where(eq(schema.proposal.id, prop.id)).get()!;
    expect(row.status).toBe('approved');
    expect(row.applied_at).not.toBeNull();
    expect(row.tool_name).toBe('shift_events');
  });

  test('dragging a PINNED event is refused — nothing moves, even auto-approved', async () => {
    const before = db.select().from(schema.event).where(eq(schema.event.id, 'cs429')).get()!;

    const prop = await createProposalVia('shift_events', {
      scope: 'single',
      event_id: 'cs429',
      expect_title: 'CS 429',
      date: '2026-07-14',
      delta_minutes: 60,
    });

    // shift_events will not even SELECT a pinned instance, so the diff comes
    // back empty rather than carrying a pinned_moved conflict. Belt and braces:
    // the tool refuses to target it, and the empty diff is unapprovable.
    const stored = db.select().from(schema.proposal).where(eq(schema.proposal.id, prop.id)).get()!;
    expect((stored.diff as { changes: unknown[] }).changes).toHaveLength(0);

    const res = await app.request(`/api/proposals/${prop.id}/approve`, jsonReq('POST'));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { status: string }).status).toBe('blocked');

    const after = db.select().from(schema.event).where(eq(schema.event.id, 'cs429')).get()!;
    expect(after.starts_at).toBe(before.starts_at);
    expect(db.select().from(schema.proposal).where(eq(schema.proposal.id, prop.id)).get()!.applied_at).toBeNull();
  });

  test('a warned-but-legal move still applies (the app surfaces, you decide)', async () => {
    // Gym Tue 16:00 → 21:00: outside the 16:00–19:00 window, a warning not a block.
    const prop = await createProposalVia('shift_events', {
      scope: 'single',
      event_id: 'gym1',
      expect_title: 'Gym',
      date: '2026-07-14',
      delta_minutes: 300,
    });
    const conflicts = (prop as unknown as { conflicts: { type: string; rule?: string }[] }).conflicts;
    expect(conflicts.some((c) => c.type === 'constraint' && c.rule === 'gym_window')).toBe(true);

    const res = await app.request(`/api/proposals/${prop.id}/approve`, jsonReq('POST'));
    expect(res.status).toBe(200);
    expect(db.select().from(schema.event).where(eq(schema.event.id, 'gym1')).get()!.starts_at).toBe('2026-07-14T21:00');
  });
});

// ---------------------------------------------------------------------------
// The assistant may now make several changes in one turn (a "rearrange"), and
// it applies them itself. So two calls must never compound on the same event:
// the model can express one move two ways (a day-scoped shift AND a single
// shift of an event on that day), and applying both would double it.
// ---------------------------------------------------------------------------

describe('one change per event per turn', () => {
  function fakeChat(calls: { name: string; args: unknown }[]) {
    let n = 0;
    return (async () => {
      n++;
      return n === 1
        ? {
            message: {
              content: '',
              tool_calls: calls.map((c, i) => ({
                id: `c${i}`,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            },
          }
        : { message: { content: 'Done.', tool_calls: undefined } };
    }) as never;
  }

  /** The same settle loop the chat route runs. */
  async function settle(proposals: { id: string; tool_name: string; conflicts: unknown }[]) {
    const out: string[] = [];
    for (const p of proposals) {
      const blocked = (p.conflicts as Conflict[]).some((k) => severityOf(k) === 'blocking');
      if (!isAutoApplied(p.tool_name) || blocked) {
        out.push('pending');
        continue;
      }
      out.push((await applyProposal(p.id)).status);
    }
    return out;
  }

  const at = (id: string) => db.select().from(schema.event).where(eq(schema.event.id, id)).get()!.starts_at;

  test('a day-scoped shift plus a redundant single shift of the same event moves it ONCE', async () => {
    // Gym is at 16:00 on Tue in the fixture; both calls mean "30 minutes earlier".
    // (The message used to say "push … back", which reads as LATER — the
    // direction guard now refuses a −30 answer to that, as it should.)
    const { proposals } = await runAgentTurn(db, 'move everything after 3pm 30 minutes earlier', {
      chat: fakeChat([
        { name: 'shift_events', args: { scope: 'day', date: '2026-07-14', delta_minutes: -30, after_time: '15:00' } },
        {
          name: 'shift_events',
          args: { scope: 'single', event_id: 'gym1', expect_title: 'Gym', date: '2026-07-14', delta_minutes: -30 },
        },
      ]),
    });

    // The second call is dropped: it touches an event the first one already moves.
    expect(proposals).toHaveLength(1);
    await settle(proposals);
    expect(at('gym1')).toBe('2026-07-14T15:30'); // 16:00 - 30, NOT 15:00
  });

  test('four near-identical deltas on one event yield ONE move', async () => {
    const { proposals } = await runAgentTurn(db, 'move gym later', {
      chat: fakeChat(
        [60, 61, 62, 63].map((dm) => ({
          name: 'shift_events',
          args: { scope: 'single', event_id: 'gym1', expect_title: 'Gym', date: '2026-07-14', delta_minutes: dm },
        })),
      ),
    });

    expect(proposals).toHaveLength(1);
    await settle(proposals);
    expect(at('gym1')).toBe('2026-07-14T17:00'); // 16:00 + 60 only
  });

  test('changes to DIFFERENT events in one turn still all apply (a real rearrange)', async () => {
    const { proposals } = await runAgentTurn(db, 'move gym and cook later', {
      chat: fakeChat([
        {
          name: 'shift_events',
          args: { scope: 'single', event_id: 'gym1', expect_title: 'Gym', date: '2026-07-14', delta_minutes: 60 },
        },
        {
          name: 'shift_events',
          args: { scope: 'single', event_id: 'cook1', expect_title: 'Cook lunches', date: '2026-07-14', delta_minutes: 30 },
        },
      ]),
    });

    expect(proposals).toHaveLength(2);
    expect(await settle(proposals)).toEqual(['applied', 'applied']);
    expect(at('gym1')).toBe('2026-07-14T17:00');
    expect(at('cook1')).toBe('2026-07-14T19:00');
  });
});

// ---------------------------------------------------------------------------
// Meals v2: the Meals tab lists AI-imported meals + suites; the cook popover
// assigns/clears what a cook block cooks. All direct CRUD, like reminders.
// ---------------------------------------------------------------------------

describe('meals + suites + cook assignments', () => {
  function seedMeals() {
    const b = createMeal(getDb(), { name: 'Overnight oats', meal_type: 'breakfast', ingredients: ['2 cups oats'] });
    const l = createMeal(getDb(), { name: 'Chipotle bowls', meal_type: 'lunch', ingredients: ['1 lb chicken'] });
    const s = createSuite(getDb(), { name: 'Oats + Bowls', breakfast_meal_id: b.id, lunch_meal_id: l.id });
    return { b, l, s };
  }

  test('GET /api/meals joins suite meal names; DELETE removes a meal and its suite', async () => {
    const { b, s } = seedMeals();
    const res = await app.request('/api/meals');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meals: unknown[]; suites: { id: string; breakfast_name: string; lunch_name: string }[] };
    expect(body.meals).toHaveLength(2);
    expect(body.suites).toEqual([
      expect.objectContaining({ id: s.id, breakfast_name: 'Overnight oats', lunch_name: 'Chipotle bowls' }),
    ]);

    expect((await app.request(`/api/meals/${b.id}`, jsonReq('DELETE'))).status).toBe(204);
    const after = (await (await app.request('/api/meals')).json()) as { meals: unknown[]; suites: unknown[] };
    expect(after.meals).toHaveLength(1);
    expect(after.suites).toHaveLength(0); // suite died with its breakfast
  });

  test('assignments: PUT upserts, subtitle appears on the schedule, DELETE clears', async () => {
    const { s } = seedMeals();
    const put = await app.request(
      '/api/meals/assignments',
      jsonReq('PUT', { event_id: 'cook1', date: '2026-07-14', suite_id: s.id }),
    );
    expect(put.status).toBe(200);

    // The cook block now carries the suite as its derived subtitle.
    const sched = (await (await app.request('/api/schedule?start=2026-07-14&end=2026-07-14')).json()) as {
      instances: { event_id: string; subtitle: string | null }[];
    };
    expect(sched.instances.find((i) => i.event_id === 'cook1')?.subtitle).toBe('Oats + Bowls');

    const list = (await (await app.request('/api/meals/assignments?start=2026-07-13&end=2026-07-19')).json()) as {
      assignments: { suite_id: string }[];
    };
    expect(list.assignments).toEqual([expect.objectContaining({ suite_id: s.id })]);

    expect((await app.request('/api/meals/assignments?event_id=cook1&date=2026-07-14', jsonReq('DELETE'))).status).toBe(204);
    expect((await app.request('/api/meals/assignments?event_id=cook1&date=2026-07-14', jsonReq('DELETE'))).status).toBe(404);
  });

  test('POST /api/meals/suites creates a manual suite; meals stay; dup and wrong-type refused', async () => {
    const b = createMeal(getDb(), { name: 'Overnight oats', meal_type: 'breakfast', ingredients: ['2 cups oats'] });
    const l = createMeal(getDb(), { name: 'Chipotle bowls', meal_type: 'lunch', ingredients: ['1 lb chicken'] });

    const res = await app.request('/api/meals/suites', jsonReq('POST', { breakfast_meal_id: b.id, lunch_meal_id: l.id }));
    expect(res.status).toBe(201);
    const { suite } = (await res.json()) as { suite: { name: string; breakfast_name: string } };
    expect(suite.name).toBe('Overnight oats + Chipotle bowls'); // default name
    expect(suite.breakfast_name).toBe('Overnight oats');

    // The individual meals are untouched — a suite is a pairing, not a merge.
    const after = (await (await app.request('/api/meals')).json()) as { meals: unknown[]; suites: unknown[] };
    expect(after.meals).toHaveLength(2);
    expect(after.suites).toHaveLength(1);

    // Same pair again → 409; a lunch passed as the breakfast → 400.
    expect((await app.request('/api/meals/suites', jsonReq('POST', { breakfast_meal_id: b.id, lunch_meal_id: l.id }))).status).toBe(409);
    expect((await app.request('/api/meals/suites', jsonReq('POST', { breakfast_meal_id: l.id, lunch_meal_id: b.id }))).status).toBe(400);
  });

  test('PUT /api/meals/assignments refuses both or neither of suite_id/meal_id', async () => {
    const { s, l } = seedMeals();
    const both = await app.request(
      '/api/meals/assignments',
      jsonReq('PUT', { event_id: 'cook1', date: '2026-07-14', suite_id: s.id, meal_id: l.id }),
    );
    expect(both.status).toBe(400);
    const neither = await app.request('/api/meals/assignments', jsonReq('PUT', { event_id: 'cook1', date: '2026-07-14' }));
    expect(neither.status).toBe(400);
  });
});
