/**
 * Agent loop tests (SPEC §4). NO network: chatCompletion is replaced by fake
 * functions injected via AgentDeps. Tools are the real ones, registered by
 * importing the agent (which imports tools/index).
 */
import { beforeEach, describe, expect, test } from 'bun:test';

// Deterministic constraints: point the settings overlay at a missing file so
// defaults from config/constraints.ts always apply.
process.env.MISE_SETTINGS_PATH = '/nonexistent/mise-agent-test-settings.json';

import { resetDbForTests, schema, type DB } from '../src/db/client';
import { SYSTEM_PROMPT, buildContext, formatDiffSummary, runAgentTurn } from '../src/agent';
import type { ChatCompletionResult, ChatMessage, chatCompletion } from '../src/ollama';
import { addDaysWall, composeTs, fmtDateLong, todayInTz } from '../src/time';
import type { Conflict, Diff } from '../src/types';

const today = todayInTz();
const tomorrow = addDaysWall(today, 1);
// Derived, not hardcoded — otherwise the reply's weekday breaks every day.
const tomorrowShort = fmtDateLong(tomorrow, 'EEE');

let db: DB;

beforeEach(() => {
  db = resetDbForTests();
  db.insert(schema.semester)
    .values({
      id: 'sem-1',
      name: 'Test Semester',
      start_date: addDaysWall(today, -30),
      end_date: addDaysWall(today, 60),
      timezone: 'America/Chicago',
    })
    .run();
  db.insert(schema.event)
    .values([
      {
        // Pinned class every day of the week so any test date has an instance.
        id: 'evt-class',
        semester_id: 'sem-1',
        title: 'CS 429',
        kind: 'class',
        starts_at: composeTs(addDaysWall(today, -30), '14:00'),
        ends_at: composeTs(addDaysWall(today, -30), '15:15'),
        pinned: true,
        rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
        source: 'recurring',
        location: 'GDC 2.216',
        notes: null,
      },
      {
        id: 'evt-gym',
        semester_id: 'sem-1',
        title: 'Gym',
        kind: 'gym',
        starts_at: composeTs(tomorrow, '16:00'),
        ends_at: composeTs(tomorrow, '17:30'),
        pinned: false,
        rrule: null,
        source: 'manual',
        location: 'Gregory',
        notes: null,
      },
    ])
    .run();
});

// ---------------------------------------------------------------------------
// Fake chat plumbing
// ---------------------------------------------------------------------------

let callSeq = 0;

function textResponse(content: string): ChatCompletionResult {
  return { message: { content } };
}

function toolCallResponse(name: string, args: unknown, content = ''): ChatCompletionResult {
  return {
    message: {
      content,
      tool_calls: [
        {
          id: `call-${++callSeq}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
  };
}

/** Scripted fake: returns responses in order, records every messages array. */
function fakeChat(responses: ChatCompletionResult[]) {
  const seen: ChatMessage[][] = [];
  let n = 0;
  const chat = (async (opts: { messages: ChatMessage[] }) => {
    seen.push(opts.messages.map((m) => ({ ...m })));
    const res = responses[n];
    if (!res) throw new Error(`fake chat exhausted after ${n} calls`);
    n++;
    return res;
  }) as typeof chatCompletion;
  return { chat, seen, count: () => n };
}

function allChatRows() {
  return db.select().from(schema.chatMessage).all();
}

function allProposalRows() {
  return db.select().from(schema.proposal).all();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAgentTurn', () => {
  test('plain content passes through; user+assistant chat rows; no proposals', async () => {
    const { chat, seen, count } = fakeChat([textResponse('Hi Sai, nothing to change.')]);
    const { reply, proposals } = await runAgentTurn(db, 'hello', { chat });

    expect(reply).toBe('Hi Sai, nothing to change.');
    expect(proposals).toEqual([]);
    expect(count()).toBe(1);

    const rows = allChatRows();
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.role).sort()).toEqual(['assistant', 'user']);
    const user = rows.find((r) => r.role === 'user')!;
    const assistant = rows.find((r) => r.role === 'assistant')!;
    expect(user.content).toBe('hello');
    expect(assistant.content).toBe('Hi Sai, nothing to change.');
    expect(assistant.proposal_id).toBeNull();
    expect(allProposalRows()).toEqual([]);

    // System message is SYSTEM_PROMPT + context.
    const sys = seen[0]![0]!;
    expect(sys.role).toBe('system');
    expect(sys.content.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(sys.content).toContain('PINNED (cannot move):');
  });

  test('shift_events tool call → one pending proposal, pinned class untouched, linked chat row', async () => {
    const { chat, count } = fakeChat([
      toolCallResponse(
        'shift_events',
        { scope: 'day', date: tomorrow, delta_minutes: 60 },
        'Shifting tomorrow by an hour.',
      ),
      textResponse('Shifting tomorrow by an hour.'),
    ]);
    const { reply, proposals } = await runAgentTurn(db, 'push everything tomorrow an hour later', { chat });

    // One proposal. The loop runs a second round so the model can answer after
    // its change lands (that is what lets it finish a compound request).
    expect(proposals.length).toBe(1);
    expect(count()).toBe(2);
    const prop = proposals[0]!;
    expect(prop.tool_name).toBe('shift_events');
    expect(prop.status).toBe('pending');

    const stored = allProposalRows();
    expect(stored.length).toBe(1);
    expect(stored[0]!.id).toBe(prop.id);

    const diff = prop.diff as Diff;
    expect(diff.changes.length).toBeGreaterThanOrEqual(1);
    // The gym moved; the pinned class did NOT — it shows up as unchanged_pinned.
    expect(diff.changes.every((c) => c.event_id !== 'evt-class')).toBe(true);
    expect(diff.changes.some((c) => c.event_id === 'evt-gym')).toBe(true);
    expect(diff.unchanged_pinned.some((p) => p.event_id === 'evt-class')).toBe(true);

    const conflicts = prop.conflicts as Conflict[];
    expect(conflicts.every((c) => c.type !== 'pinned_moved')).toBe(true);

    // The reply is written from the DIFF, not from the model's prose. Asked to
    // clear an evening it once reported moving a cook session that did not exist;
    // it no longer gets to narrate its own work.
    expect(reply).toBe(`Move Gym to ${tomorrowShort} 5 – 6:30 PM — approve it below.`);
    expect(reply).not.toContain('Shifting tomorrow');
    const assistant = allChatRows().find((r) => r.role === 'assistant')!;
    expect(assistant.proposal_id).toBe(prop.id);

    // The event table was NOT written (dry-run only — I1/I2).
    const gym = db.select().from(schema.event).all().find((e) => e.id === 'evt-gym')!;
    expect(gym.starts_at).toBe(composeTs(tomorrow, '16:00'));
  });

  test('invalid args then valid → one schema retry, proposal created', async () => {
    const { chat, seen, count } = fakeChat([
      toolCallResponse('shift_events', { scope: 'day', date: tomorrow, delta_minutes: 'sixty' }),
      toolCallResponse('shift_events', { scope: 'day', date: tomorrow, delta_minutes: 60 }),
      textResponse(''),
    ]);
    const { reply, proposals } = await runAgentTurn(db, 'shift tomorrow +60', { chat });

    expect(count()).toBe(3);
    expect(proposals.length).toBe(1);
    expect(proposals[0]!.tool_name).toBe('shift_events');
    expect((proposals[0]!.tool_args as Record<string, unknown>).delta_minutes).toBe(60);

    // The retry round-trip fed the validation error back as a tool message.
    const second = seen[1]!;
    const toolErr = second.find((m) => m.role === 'tool');
    expect(toolErr).toBeDefined();
    expect(toolErr!.content).toContain('Invalid arguments for shift_events');

    // The reply describes what the diff actually did.
    expect(reply.startsWith('Proposed: ')).toBe(false);
    expect(reply).toContain('Gym');
  });

  test('unknown tool then plain text → no proposal, no throw', async () => {
    const { chat, seen, count } = fakeChat([
      toolCallResponse('do_magic', { anything: true }),
      textResponse('Sorry, I cannot do that.'),
    ]);
    const { reply, proposals } = await runAgentTurn(db, 'do magic', { chat });

    expect(reply).toBe('Sorry, I cannot do that.');
    expect(proposals).toEqual([]);
    expect(allProposalRows()).toEqual([]);
    expect(count()).toBe(2);

    const second = seen[1]!;
    const toolErr = second.find((m) => m.role === 'tool');
    expect(toolErr).toBeDefined();
    expect(toolErr!.content).toContain('Unknown tool "do_magic"');
    expect(toolErr!.content).toContain('shift_events');
  });

  test('get_schedule read tool → data fed back, text reply, NO proposal', async () => {
    const { chat, seen, count } = fakeChat([
      toolCallResponse('get_schedule', { start_date: today, end_date: addDaysWall(today, 7) }),
      textResponse('You have CS 429 every day at 14:00.'),
    ]);
    const { reply, proposals } = await runAgentTurn(db, "what's my week look like?", { chat });

    // The model said "14:00"; Sai never sees a 24-hour clock. humanizeTimes
    // rewrites it on the way out, so the prompt rule is enforced, not merely asked.
    expect(reply).toBe('You have CS 429 every day at 2 PM.');
    expect(proposals).toEqual([]);
    expect(allProposalRows()).toEqual([]);
    expect(count()).toBe(2);

    // The second call received a tool-role message carrying the event data.
    const second = seen[1]!;
    const toolData = second.find((m) => m.role === 'tool');
    expect(toolData).toBeDefined();
    expect(toolData!.content).toContain('CS 429');
    expect(toolData!.content.length).toBeLessThanOrEqual(1501);
  });

  test('chat throws (Ollama down) → graceful reply mentioning setup, user message recorded', async () => {
    const chat = (async () => {
      const err = new Error('Cannot reach Ollama at http://127.0.0.1:11434: fetch failed (ECONNREFUSED)');
      throw err;
    }) as typeof chatCompletion;

    const { reply, proposals } = await runAgentTurn(db, 'shift tomorrow', { chat });

    expect(reply).toContain('bun run setup');
    expect(proposals).toEqual([]);
    expect(allProposalRows()).toEqual([]);
    const rows = allChatRows();
    expect(rows.find((r) => r.role === 'user')?.content).toBe('shift tomorrow');
    expect(rows.find((r) => r.role === 'assistant')?.content).toBe(reply);
  });
});

describe('buildContext', () => {
  test('contains PINNED list + constraint lines + gym split, stays under 10000 chars with 60+ events', () => {
    // Flood the window: 5 personal events/day for 14 days = 70, plus the
    // recurring class = well over the 60-row cap.
    const extra = [];
    for (let d = 0; d < 14; d++) {
      for (let k = 0; k < 5; k++) {
        const date = addDaysWall(today, d);
        extra.push({
          id: `evt-p-${d}-${k}`,
          semester_id: 'sem-1',
          title: `Errand ${d}-${k} with a fairly long title`,
          kind: 'personal' as const,
          starts_at: composeTs(date, `0${8 + k}:00`.slice(-5)),
          ends_at: composeTs(date, `0${8 + k}:30`.slice(-5)),
          pinned: false,
          rrule: null,
          source: 'manual' as const,
          location: 'Somewhere on campus',
          notes: null,
        });
      }
    }
    db.insert(schema.event).values(extra).run();

    const ctx = buildContext(db);

    expect(ctx).toContain('Now: ');
    expect(ctx).toContain('America/Chicago');
    expect(ctx).toContain('PINNED (cannot move):');
    expect(ctx).toContain('CS 429');
    expect(ctx).toContain('CONSTRAINTS:');
    expect(ctx).toContain('Commute: 15 min');
    expect(ctx).toContain('Gym: 4×/week');
    expect(ctx).toContain('dinner OUT — NEVER schedule dinner');
    expect(ctx).toContain('Sleep: 00:00-07:00');
    expect(ctx).toContain('…and '); // table truncation note
    expect(ctx).toContain('GYM SPLIT'); // the split, so the model can resolve "bench press" → its day
    // Budget covers the split block and the per-gym workout label in the table.
    // Still small and bounded — a real week is a handful of gym sessions.
    expect(ctx.length).toBeLessThan(10500);

    // Cap honored: at most 60 table rows (lines with the column separator).
    const tableRows = ctx.split('\n').filter((l) => /^\d{4}-\d{2}-\d{2} \| /.test(l));
    expect(tableRows.length).toBeLessThanOrEqual(60);
  });
});

describe('formatDiffSummary', () => {
  test('summary + one line per change', () => {
    const diff: Diff = {
      summary: 'Shift Tuesday · +60 min',
      changes: [
        {
          event_id: 'e1',
          instance_date: tomorrow,
          title: 'Gym',
          kind: 'gym',
          pinned: false,
          before: { starts_at: composeTs(tomorrow, '16:00'), ends_at: composeTs(tomorrow, '17:30') },
          after: { starts_at: composeTs(tomorrow, '17:00'), ends_at: composeTs(tomorrow, '18:30') },
        },
        {
          event_id: 'e2',
          instance_date: tomorrow,
          title: 'Cook',
          kind: 'cook',
          pinned: false,
          before: { starts_at: composeTs(tomorrow, '18:30'), ends_at: composeTs(tomorrow, '19:30') },
          after: null,
        },
      ],
      unchanged_pinned: [],
    };
    expect(formatDiffSummary(diff)).toBe(
      'Shift Tuesday · +60 min\nGym 4 PM → 5 PM\nCook 6:30 PM cancelled',
    );
  });
});
