/**
 * Regression tests for the invariant holes the adversarial review found.
 * Each of these was a live bug; each maps to an invariant in SPEC §0.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { resetDbForTests, schema, type DB } from '../src/db/client';
import { describeOutcome, runAgentTurn } from '../src/agent';
import { getModelTool, modelToolNames, getTool } from '../src/tools/index';
import { cancelEventTool } from '../src/tools/cancel-event';
import { shiftEventsTool } from '../src/tools/shift-events';
import { setupSemesterTool } from '../src/tools/setup-semester';
import { isActionable, isRealChange, severityOf, titlesMatch } from '../src/types';
import { humanizeTimes } from '../src/time';
import type { ToolCall } from '../src/ollama';
import type { ProposalRow } from '../src/proposals';

process.env.MISE_SETTINGS_PATH = '/nonexistent/settings.json';

let db: DB;

function seed() {
  db.insert(schema.semester)
    .values({
      id: 'sem-1',
      name: 'Fall 2026',
      start_date: '2026-09-01',
      end_date: '2026-12-15',
      timezone: 'America/Chicago',
    })
    .run();
  db.insert(schema.event)
    .values([
      {
        id: 'evt-class',
        semester_id: 'sem-1',
        title: 'CS 429',
        kind: 'class',
        starts_at: '2026-09-01T14:00',
        ends_at: '2026-09-01T15:30',
        pinned: true,
        rrule: 'FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261215',
        source: 'recurring',
        location: 'GDC 2.216',
        notes: null,
      },
      {
        id: 'evt-cook',
        semester_id: 'sem-1',
        title: 'Cook lunches',
        kind: 'cook',
        starts_at: '2026-09-08T18:00',
        ends_at: '2026-09-08T19:00',
        pinned: false,
        rrule: null,
        source: 'manual',
        location: null,
        notes: null,
      },
    ])
    .run();
}

function fakeChatWith(calls: ToolCall[]) {
  let n = 0;
  const fn = async () => {
    n++;
    return n === 1
      ? { message: { content: '', tool_calls: calls } }
      : { message: { content: 'Done.', tool_calls: undefined } };
  };
  return fn as never;
}

function call(name: string, args: unknown): ToolCall {
  return { id: `c${Math.floor(performance.now() * 1000) % 100000}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

beforeEach(() => {
  db = resetDbForTests();
  seed();
});

// ---------------------------------------------------------------------------
// I1 / I4 — the model cannot reach setup_semester, the one tool that creates
// pinned events and can wipe the semester.
// ---------------------------------------------------------------------------

describe('hidden tools are unreachable from the model (I1/I4)', () => {
  test('getModelTool refuses setup_semester while getTool still serves the wizard', () => {
    expect(getTool('setup_semester')).toBeDefined();
    expect(getModelTool('setup_semester')).toBeUndefined();
    expect(modelToolNames()).not.toContain('setup_semester');
    expect(getModelTool('shift_events')).toBeDefined();
  });

  // add_classes was un-hidden so the assistant can rebuild the class schedule
  // itself, not only through the photo import — but setup_semester/drop_class
  // stay walled off.
  test('add_classes IS now reachable from the model; the destructive pinned tools are not', () => {
    expect(getModelTool('add_classes')).toBeDefined();
    expect(modelToolNames()).toContain('add_classes');
    expect(getModelTool('setup_semester')).toBeUndefined();
    expect(getModelTool('drop_class')).toBeUndefined();
  });

  test('a model tool_call for setup_semester creates no proposal and destroys nothing', async () => {
    const before = db.select().from(schema.event).all().length;
    const { proposals } = await runAgentTurn(db, 'set up spring semester, replace the old one', {
      chat: fakeChatWith([
        call('setup_semester', {
          name: 'Spring 2027',
          start_date: '2027-01-19',
          end_date: '2027-05-08',
          classes: [{ title: 'CS 439', days: ['MO'], start_time: '09:00', end_time: '10:00' }],
          replace: true,
        }),
      ]),
    });

    expect(proposals).toHaveLength(0);
    // The pinned class and the semester survive untouched.
    expect(db.select().from(schema.event).all().length).toBe(before);
    expect(db.select().from(schema.semester).all()).toHaveLength(1);
    expect(db.select().from(schema.event).where(undefined).all().some((e) => e.id === 'evt-class')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I2 — one mutation per turn, one approval per proposal.
// ---------------------------------------------------------------------------

describe('duplicate tool_calls in one response (I2)', () => {
  test('two identical shift_events calls yield exactly ONE proposal', async () => {
    const args = { scope: 'day', date: '2026-09-08', delta_minutes: 60 };
    const { proposals } = await runAgentTurn(db, 'push tuesday back an hour', {
      chat: fakeChatWith([call('shift_events', args), call('shift_events', args)]),
    });

    expect(proposals).toHaveLength(1);
    expect(db.select().from(schema.proposal).all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// I4 — a cancel aimed at a pinned class is refused, and refusal means no write.
// ---------------------------------------------------------------------------

describe('a cancel blocked by a pinned target writes nothing', () => {
  test('pinned class cancel → blocking pinned_moved, class still there', async () => {
    const { conflicts } = await cancelEventTool.run({ event_id: 'evt-class', expect_title: 'CS 429', date: '2026-09-08' }, 'commit');
    expect(conflicts.some((c) => c.type === 'pinned_moved')).toBe(true);
    expect(db.select().from(schema.event).all().some((e) => e.id === 'evt-class')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I2 — a destructive replace must be visible on the diff the user approves.
// ---------------------------------------------------------------------------

describe('setup_semester replace discloses the wipe (I2)', () => {
  test('dry run warns how much it will delete', async () => {
    const { conflicts } = await setupSemesterTool.run(
      {
        name: 'Spring 2027',
        start_date: '2027-01-19',
        end_date: '2027-05-08',
        timezone: 'America/Chicago',
        classes: [{ title: 'CS 439', days: ['MO'], start_time: '09:00', end_time: '10:00' }],
        replace: true,
      },
      'dry',
    );

    const warn = conflicts.find((c) => c.type === 'constraint' && c.rule === 'replace_semester');
    expect(warn).toBeDefined();
    expect(warn!.type === 'constraint' && warn!.message).toContain('Fall 2026');
    expect(warn!.type === 'constraint' && warn!.message).toMatch(/2 events/);
  });
});

// ---------------------------------------------------------------------------
// An empty diff applies nothing and must never read as success.
// ---------------------------------------------------------------------------

describe('isActionable', () => {
  test('an empty diff is not actionable', () => {
    expect(isActionable({ summary: 'Nothing to shift', changes: [], unchanged_pinned: [] })).toBe(false);
  });

  test('a meal-import-only diff is actionable', () => {
    expect(
      isActionable({
        summary: 'Import',
        changes: [],
        unchanged_pinned: [],
        meal_changes: ['Imported Overnight oats (breakfast) · 3 ingredients'],
      }),
    ).toBe(true);
  });

  test('a tool that cannot act returns a non-actionable diff', async () => {
    const { createSuiteTool } = await import('../src/tools/create-suite');
    const res = await createSuiteTool.run({ breakfast: 'nope', lunch: 'nada' }, 'dry');
    expect(res.conflicts.some((c) => c.type === 'constraint' && c.rule === 'unknown_meal')).toBe(true);
    expect(isActionable(res.diff)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The model copies an event_id out of the schedule table and can copy the WRONG
// ROW. Asked to move "tomorrow's gym" on a day with no gym, it grabbed the cook
// session — and auto-apply committed it. The tool now refuses an id that isn't
// the event the model says it is.
// ---------------------------------------------------------------------------

describe('wrong_event guard', () => {
  test('titlesMatch is forgiving about wording, strict about identity', () => {
    expect(titlesMatch('gym', 'Gym')).toBe(true);
    expect(titlesMatch('Gym', 'Gym')).toBe(true);
    expect(titlesMatch('cook', 'Cook lunches')).toBe(true);
    expect(titlesMatch('CS 429', 'CS 429 Computer Organization')).toBe(true);
    // The failure that started this:
    expect(titlesMatch('Gym', 'Cook lunches')).toBe(false);
    expect(titlesMatch('gym', 'Cook lunches')).toBe(false);
  });

  test('shifting an id whose title is a different event is REFUSED and blocking', async () => {
    const res = await shiftEventsTool.run(
      {
        scope: 'single',
        date: '2026-09-08',
        event_id: 'evt-cook', // the cook session…
        expect_title: 'Gym', // …but the model thinks it grabbed the gym
        delta_minutes: 60,
      },
      'commit',
    );

    const wrong = res.conflicts.find((c) => c.type === 'wrong_event');
    expect(wrong).toBeDefined();
    expect(severityOf(wrong!)).toBe('blocking');
    expect(res.diff.changes).toHaveLength(0);
    // And nothing moved.
    expect(
      db.select().from(schema.event).all().find((e) => e.id === 'evt-cook')!.starts_at,
    ).toBe('2026-09-08T18:00');
  });

  test('cancelling an id whose title is a different event is REFUSED — nothing deleted', async () => {
    const before = db.select().from(schema.event).all().length;
    const res = await cancelEventTool.run({ event_id: 'evt-cook', expect_title: 'Gym' }, 'commit');

    expect(res.conflicts.some((c) => c.type === 'wrong_event')).toBe(true);
    expect(db.select().from(schema.event).all().length).toBe(before);
    expect(db.select().from(schema.event).all().some((e) => e.id === 'evt-cook')).toBe(true);
  });

  test('a matching title goes through as normal', async () => {
    const res = await shiftEventsTool.run(
      {
        scope: 'single',
        date: '2026-09-08',
        event_id: 'evt-cook',
        expect_title: 'Cook lunches',
        delta_minutes: 60,
      },
      'commit',
    );
    expect(res.conflicts.some((c) => c.type === 'wrong_event')).toBe(false);
    expect(
      db.select().from(schema.event).all().find((e) => e.id === 'evt-cook')!.starts_at,
    ).toBe('2026-09-08T19:00');
  });

  test('a tool that can do nothing files NO proposal — the model is told instead', async () => {
    // "move Wednesday's gym" when there is no gym that day.
    const { proposals, reply } = await runAgentTurn(db, 'move my gym on wednesday later', {
      chat: (() => {
        let n = 0;
        return async () => {
          n++;
          return n === 1
            ? {
                message: {
                  content: '',
                  tool_calls: [
                    call('shift_events', {
                      scope: 'single',
                      date: '2026-09-09',
                      event_id: 'evt-cook',
                      expect_title: 'Gym',
                      delta_minutes: 60,
                    }),
                  ],
                },
              }
            : { message: { content: "You don't have a gym session on Wednesday.", tool_calls: undefined } };
        };
      })() as never,
    });

    // No dead card, no write — and the model got the chance to say the true thing.
    expect(proposals).toHaveLength(0);
    expect(db.select().from(schema.proposal).all()).toHaveLength(0);
    expect(reply).toContain("don't have a gym");
  });
});

// ---------------------------------------------------------------------------
// "I have friends coming over 6-7, can you adjust my gym?" — a STATEMENT plus a
// REQUEST. Two failures came out of it: the friends event was never created, and
// the gym was "rescheduled" to the slot it was already in and reported applied.
// ---------------------------------------------------------------------------

describe('compound requests and no-op moves', () => {
  test('a move whose times are unchanged is not a real change', () => {
    const same = {
      event_id: 'e1',
      instance_date: '2026-09-08',
      title: 'Gym',
      kind: 'gym' as const,
      pinned: false,
      before: { starts_at: '2026-09-08T17:00', ends_at: '2026-09-08T18:30' },
      after: { starts_at: '2026-09-08T17:00', ends_at: '2026-09-08T18:30' },
    };
    expect(isRealChange(same)).toBe(false);
    // …and a diff made only of no-ops applies nothing.
    expect(isActionable({ summary: 'Gym 5 PM → 5 PM', changes: [same], unchanged_pinned: [] })).toBe(false);

    const moved = { ...same, after: { starts_at: '2026-09-08T18:00', ends_at: '2026-09-08T19:30' } };
    expect(isRealChange(moved)).toBe(true);
    expect(isActionable({ summary: 'Shift', changes: [moved], unchanged_pinned: [] })).toBe(true);
  });

  /** The API's applyProposal, in miniature: commit each proposal as it is made. */
  function settleFor(applied: string[]) {
    return async (p: ProposalRow) => {
      applied.push(p.tool_name);
      const tool = getTool(p.tool_name)!;
      if (tool.kind !== 'mutation') return p;
      await tool.run(tool.argsSchema.parse(p.tool_args), 'commit');
      return { ...p, status: 'approved' as const };
    };
  }

  test('each change lands before the next one is planned (settle runs in-turn)', async () => {
    // Friends over at 8pm (a free slot), and cook pushed +90 into 19:30–20:30 —
    // which now runs into the block that was just booked. The shift is planned
    // AGAINST THE COMMITTED FRIENDS BLOCK, so it makes room for it: if settle
    // weren't running in-turn, the shift would dry-run against a calendar where
    // the friends block did not exist yet, and nothing would move.
    const applied: string[] = [];

    const { proposals } = await runAgentTurn(db, 'friends over at 8, and push the cook session back', {
      chat: (() => {
        let n = 0;
        return async () => {
          n++;
          return n === 1
            ? {
                message: {
                  content: '',
                  tool_calls: [
                    call('create_event', {
                      title: 'Friends over',
                      kind: 'personal',
                      date: '2026-09-08',
                      start_time: '20:00',
                      duration_minutes: 60,
                    }),
                    call('shift_events', {
                      scope: 'single',
                      date: '2026-09-08',
                      event_id: 'evt-cook',
                      expect_title: 'Cook lunches',
                      delta_minutes: 90,
                    }),
                  ],
                },
              }
            : { message: { content: 'Done.', tool_calls: undefined } };
        };
      })() as never,
      settle: settleFor(applied),
    });

    // BOTH happened, in order — the plan was not swallowed by the request.
    expect(proposals).toHaveLength(2);
    expect(applied).toEqual(['create_event', 'shift_events']);

    const events = db.select().from(schema.event).all();
    const cook = events.find((e) => e.id === 'evt-cook')!;
    expect(cook.starts_at).toBe('2026-09-08T19:30');

    // The friends block was pushed clear of the cook session it collided with —
    // proof the second call saw the first one's write.
    const friends = events.find((e) => e.title === 'Friends over')!;
    expect(friends.starts_at).toBe('2026-09-08T20:30');
    expect(friends.ends_at).toBe('2026-09-08T21:30');
  });

  test('"friends over 6-7, adjust my gym" moves the gym ONCE — the room is made, not made twice', async () => {
    // The real failure this guards: booking the friends block over the cook
    // session already slides the cook session clear of it. The model, still
    // reading the pre-turn table, then asks to move that same session itself —
    // and that would move it a SECOND time, to a slot nobody asked for.
    const applied: string[] = [];

    const { proposals, reply } = await runAgentTurn(db, 'friends over 6-7, adjust my cook session', {
      chat: (() => {
        let n = 0;
        return async () => {
          n++;
          return n === 1
            ? {
                message: {
                  content: '',
                  tool_calls: [
                    call('create_event', {
                      title: 'Friends over',
                      kind: 'personal',
                      date: '2026-09-08',
                      start_time: '18:00',
                      duration_minutes: 60,
                    }),
                    call('shift_events', {
                      scope: 'single',
                      date: '2026-09-08',
                      event_id: 'evt-cook',
                      expect_title: 'Cook lunches',
                      delta_minutes: 90,
                    }),
                  ],
                },
              }
            : { message: { content: 'Done.', tool_calls: undefined } };
        };
      })() as never,
      settle: settleFor(applied),
    });

    // One change, covering both halves of the request: the block is booked and
    // the cook session got out of its way. The redundant shift was dropped.
    expect(applied).toEqual(['create_event']);
    expect(proposals).toHaveLength(1);

    const events = db.select().from(schema.event).all();
    expect(events.find((e) => e.title === 'Friends over')!.starts_at).toBe('2026-09-08T18:00');
    // 19:00 — clear of the friends block. NOT 20:30, which is where a second
    // +90 on top of the knock-on would have put it.
    expect(events.find((e) => e.id === 'evt-cook')!.starts_at).toBe('2026-09-08T19:00');

    // And Sai is told the cook session moved, and why.
    expect(reply).toContain('Added Friends over');
    expect(reply).toContain('Moved Cook lunches');
    expect(reply).toContain('to make room');
  });
});

// ---------------------------------------------------------------------------
// The prompt asks the model for 12-hour time; this makes it true regardless.
// ---------------------------------------------------------------------------

describe('humanizeTimes', () => {
  test('rewrites 24-hour clock times the model slipped into its prose', () => {
    expect(humanizeTimes('Gym moved to (16:00–17:30).')).toBe('Gym moved to (4 PM–5:30 PM).');
    expect(humanizeTimes('Your gym is at 17:00 and cook at 18:45.')).toBe(
      'Your gym is at 5 PM and cook at 6:45 PM.',
    );
    expect(humanizeTimes('Moved to 09:05.')).toBe('Moved to 9:05 AM.');
    expect(humanizeTimes('Starts at 00:30.')).toBe('Starts at 12:30 AM.');
  });

  test('leaves alone what is not a clock time', () => {
    expect(humanizeTimes('It takes 90 minutes.')).toBe('It takes 90 minutes.');
    expect(humanizeTimes('Friends at 6-8 PM.')).toBe('Friends at 6-8 PM.');
    // Machine timestamps are not prose and must survive untouched.
    expect(humanizeTimes('Event 2026-07-14T17:00 stays.')).toBe('Event 2026-07-14T17:00 stays.');
  });
});

// ---------------------------------------------------------------------------
// THE MODEL DOES NOT NARRATE ITS OWN WORK.
//
// Asked to clear Tuesday evening, it replied "I moved your gym and cook sessions
// on Tuesday" — there was no cook session on Tuesday. The tool call was correct;
// the sentence was invented. A confident false statement about your own calendar
// is worse than an error, because you believe it. So the reply is now written
// from the committed diffs, and the model only speaks when it changed nothing.
// ---------------------------------------------------------------------------

describe('replies are written from the diff, not by the model', () => {
  test('a change the model did NOT make cannot appear in the reply', async () => {
    // The model shifts the day (only the gym exists) and then LIES about it.
    const { reply } = await runAgentTurn(db, 'clear tuesday evening', {
      chat: (() => {
        let n = 0;
        return async () => {
          n++;
          return n === 1
            ? {
                message: {
                  content: '',
                  tool_calls: [
                    call('shift_events', {
                      scope: 'day',
                      date: '2026-09-08',
                      delta_minutes: 60,
                      kinds: ['gym', 'cook'],
                    }),
                  ],
                },
              }
            : {
                message: {
                  content: 'I moved your gym and cook sessions on Tuesday back by an hour.',
                  tool_calls: undefined,
                },
              };
        };
      })() as never,
      settle: async (p) => {
        const tool = getTool(p.tool_name)!;
        if (tool.kind === 'mutation') await tool.run(tool.argsSchema.parse(p.tool_args), 'commit');
        return { ...p, status: 'approved' as const };
      },
    });

    // The fixture has a cook on 2026-09-08 but NO gym. The model claimed both.
    // The reply must describe only what the diff actually did.
    expect(reply).toContain('Cook lunches');
    expect(reply.toLowerCase()).not.toContain('gym');
    expect(reply).not.toContain('I moved your gym and cook');
  });

  test('pending changes are described in the present tense — nothing is claimed done', () => {
    const pending = {
      id: 'p1',
      status: 'pending',
      diff: {
        summary: 'Cancel Cook lunches',
        changes: [
          {
            event_id: 'evt-cook',
            instance_date: '2026-09-08',
            title: 'Cook lunches',
            kind: 'cook' as const,
            pinned: false,
            before: { starts_at: '2026-09-08T18:00', ends_at: '2026-09-08T19:00' },
            after: null,
          },
        ],
        unchanged_pinned: [],
      },
    } as never;

    const out = describeOutcome([pending]);
    expect(out).toContain('Cancel Cook lunches');
    expect(out).toContain('approve it below');
    expect(out).not.toContain('Cancelled'); // it has NOT happened yet
  });

  test('applied changes are past tense and carry the real new time', () => {
    const applied = {
      id: 'p2',
      status: 'approved',
      diff: {
        summary: 'Shift Gym',
        changes: [
          {
            event_id: 'evt-gym',
            instance_date: '2026-09-08',
            title: 'Gym',
            kind: 'gym' as const,
            pinned: false,
            before: { starts_at: '2026-09-08T17:00', ends_at: '2026-09-08T18:30' },
            after: { starts_at: '2026-09-08T16:00', ends_at: '2026-09-08T17:30' },
          },
        ],
        unchanged_pinned: [],
      },
    } as never;

    expect(describeOutcome([applied])).toBe('Moved Gym to Tue 4 – 5:30 PM.');
  });

  test('a no-op move is not reported as a change at all', () => {
    const noop = {
      id: 'p3',
      status: 'approved',
      diff: {
        summary: 'Reschedule Gym',
        changes: [
          {
            event_id: 'evt-gym',
            instance_date: '2026-09-08',
            title: 'Gym',
            kind: 'gym' as const,
            pinned: false,
            before: { starts_at: '2026-09-08T17:00', ends_at: '2026-09-08T18:30' },
            after: { starts_at: '2026-09-08T17:00', ends_at: '2026-09-08T18:30' },
          },
        ],
        unchanged_pinned: [],
      },
    } as never;

    expect(describeOutcome([noop])).toBe('');
  });
});
