/**
 * Claude CLI backend tests. NO real CLI calls (each burns Sai's plan usage)
 * and NO Ollama: the spawn and the fallback are injected via
 * __setClaudeCliTestOverrides. Fixture JSON mirrors the empirical probe
 * output of claude v2.1.226 (scratchpad probe1/3/4).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  __setClaudeCliTestOverrides,
  activeChatBackend,
  claudeChatCompletion,
  claudeWithFallback,
  ClaudeCliError,
  resolveClaudeBin,
  type ClaudeSpawnLike,
  type ClaudeSpawnOpts,
} from '../src/claude-cli';
import { parseToolCallText, type ChatCompletionResult, type ChatMessage } from '../src/ollama';

// ---------------------------------------------------------------------------
// Env + override management
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'MISE_CLAUDE_BIN',
  'MISE_CHAT_BACKEND',
  'MISE_CLAUDE_MODEL',
  'MISE_CLAUDE_TIMEOUT_MS',
  'PATH',
  'HOME',
  'CLAUDE_TEST_LEAK',
  'ANTHROPIC_TEST_LEAK',
] as const;
let savedEnv: Record<string, string | undefined>;
let savedWarn: typeof console.warn;
let warns: string[];

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  savedWarn = console.warn;
  warns = [];
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  console.warn = savedWarn;
  __setClaudeCliTestOverrides(); // restore real spawn + Ollama fallback
});

// ---------------------------------------------------------------------------
// Fixtures — shapes verbatim from the CLI probe
// ---------------------------------------------------------------------------

/** A claude -p --output-format json result object (probe1 shape, trimmed). */
function resultJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'OK',
    session_id: '806facdd-0c32-430a-9b2a-46dd5bd528c9',
    stop_reason: 'end_turn',
    num_turns: 1,
    duration_ms: 2533,
    duration_api_ms: 2504,
    total_cost_usd: 0.201288,
    usage: { input_tokens: 2, output_tokens: 4, cache_creation_input_tokens: 33537, cache_read_input_tokens: 0 },
    terminal_reason: 'completed',
    api_error_status: null,
    permission_denials: [],
    ...over,
  });
}

/** probe4: sonnet answering a reminder request through the text protocol. */
const TOOL_CALL_RESULT =
  '<tool_call>{"name":"set_reminder","arguments":{"date":"2026-08-08","time":"09:00","title":"Call mom"}}</tool_call>';

/** probe3: the not-logged-in error shape. */
const NOT_AUTHED_JSON = resultJson({
  is_error: true,
  result: 'Not logged in · Please run /login',
  terminal_reason: 'api_error',
  duration_api_ms: 0,
  session_id: '3bb4f306-7267-43a3-ae61-67f29b8afa10',
});

// ---------------------------------------------------------------------------
// Spawn fakes
// ---------------------------------------------------------------------------

function streamOf(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      if (s !== '') c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });
}

function okProc(stdout: string, stderr = ''): ClaudeSpawnLike {
  return { stdout: streamOf(stdout), stderr: streamOf(stderr), exited: Promise.resolve(0), kill() {} };
}

/** A child that produces nothing until kill() — for the timeout path. */
function hangingProc(): ClaudeSpawnLike {
  let outCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let errCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  return {
    stdout: new ReadableStream({
      start(c) {
        outCtrl = c;
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        errCtrl = c;
      },
    }),
    exited: new Promise((r) => {
      resolveExit = r;
    }),
    kill() {
      outCtrl.close();
      errCtrl.close();
      resolveExit(143);
    },
  };
}

/** Mock spawn returning the given procs in order, capturing every spawn opts. */
function mockSpawn(procs: ClaudeSpawnLike[]): { calls: ClaudeSpawnOpts[] } {
  const calls: ClaudeSpawnOpts[] = [];
  __setClaudeCliTestOverrides({
    spawn: (opts) => {
      calls.push(opts);
      const proc = procs.shift();
      if (!proc) throw new Error('mock spawn called more times than procs provided');
      return proc;
    },
    // Any accidental fallback in a non-fallback test must blow up, not hit Ollama.
    fallback: () => {
      throw new Error('fallback must not run in this test');
    },
  });
  return { calls };
}

function baseMessages(): ChatMessage[] {
  return [
    { role: 'system', content: 'You are Mise, the scheduler.\n\nSCHEDULE: (table here)\n\n/no_think' },
    { role: 'user', content: 'remind me to call mom tomorrow at 9' },
  ];
}

const REMINDER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: 'set a point-in-time reminder',
      parameters: { type: 'object', properties: { date: {}, time: {}, title: {} } },
    },
  },
];

// ---------------------------------------------------------------------------
// Backend selection (env switching + binary resolution)
// ---------------------------------------------------------------------------

describe('backend selection', () => {
  test('MISE_CLAUDE_BIN is honored verbatim, even when the path is dead', () => {
    process.env.MISE_CLAUDE_BIN = '/nonexistent/claude';
    expect(resolveClaudeBin()).toBe('/nonexistent/claude');
    delete process.env.MISE_CHAT_BACKEND;
    // Selection still says claude — the spawn failure at call time triggers
    // the per-call Ollama fallback (tested below), matching the spec's
    // MISE_CLAUDE_BIN=/nonexistent e2e fallback drill.
    expect(activeChatBackend()).toBe('claude');
  });

  test('no override, empty PATH, no ~/.local/bin/claude → null → ollama', () => {
    delete process.env.MISE_CLAUDE_BIN;
    process.env.PATH = '/nonexistent-path-entry';
    process.env.HOME = '/nonexistent-home';
    expect(resolveClaudeBin()).toBeNull();
    delete process.env.MISE_CHAT_BACKEND;
    expect(activeChatBackend()).toBe('ollama');
  });

  test('MISE_CHAT_BACKEND=ollama forces ollama even with a binary present', () => {
    process.env.MISE_CLAUDE_BIN = '/some/claude';
    process.env.MISE_CHAT_BACKEND = 'ollama';
    expect(activeChatBackend()).toBe('ollama');
  });

  test('default (env unset) is claude when a binary resolves', () => {
    process.env.MISE_CLAUDE_BIN = '/some/claude';
    delete process.env.MISE_CHAT_BACKEND;
    expect(activeChatBackend()).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// Happy path + session resume (the tool-call round trip)
// ---------------------------------------------------------------------------

describe('claudeChatCompletion', () => {
  test('tool-call round trip: first call spawns fresh, second call resumes with only the tool results', async () => {
    process.env.MISE_CLAUDE_BIN = '/fake/claude';
    delete process.env.MISE_CLAUDE_MODEL;
    process.env.CLAUDE_TEST_LEAK = 'nested-session-var';
    process.env.ANTHROPIC_TEST_LEAK = 'nested-session-var';
    const { calls } = mockSpawn([
      okProc(resultJson({ result: TOOL_CALL_RESULT })),
      okProc(resultJson({ result: 'Reminder set for tomorrow at 9am.' })),
    ]);

    const messages = baseMessages();
    const res = await claudeChatCompletion({ messages, tools: REMINDER_TOOLS, tool_choice: 'auto', temperature: 0.1 });

    // Parsed through the shared text protocol: one call, residual content empty.
    expect(res.message.tool_calls).toHaveLength(1);
    const tc = res.message.tool_calls![0]!;
    expect(tc.function.name).toBe('set_reminder');
    expect(JSON.parse(tc.function.arguments)).toEqual({ date: '2026-08-08', time: '09:00', title: 'Call mom' });
    expect(res.message.content).toBe('');

    // Invocation shape (probe-verified flags).
    const first = calls[0]!;
    expect(first.cmd[0]).toBe('/fake/claude');
    expect(first.cmd).toContain('-p');
    expect(first.cmd.slice(1)).toContain('--output-format');
    expect(first.cmd[first.cmd.indexOf('--output-format') + 1]).toBe('json');
    expect(first.cmd[first.cmd.indexOf('--model') + 1]).toBe('sonnet');
    expect(first.cmd[first.cmd.indexOf('--tools') + 1]).toBe('');
    expect(first.cmd).not.toContain('--resume');
    const sys = first.cmd[first.cmd.indexOf('--system-prompt') + 1]!;
    expect(sys).toContain('You are Mise');
    expect(sys).toContain('<tool_call>'); // format instruction
    expect(sys).toContain('"set_reminder"'); // schema block
    expect(sys).not.toContain('/no_think'); // qwen-only switch stripped
    // Prompt rides stdin (write-then-close) — not argv.
    expect(new TextDecoder().decode(first.stdin)).toBe('User: remind me to call mom tomorrow at 9');
    // Nested-session vars are stripped from the child env.
    expect(Object.keys(first.env).some((k) => /^(CLAUDE|ANTHROPIC)/i.test(k))).toBe(false);
    expect(first.env.HOME).toBeDefined();

    // The agent loop appends its assistant echo + the tool result, then calls
    // again with the SAME array — that identity is the session key.
    messages.push({ role: 'assistant', content: '', tool_calls: res.message.tool_calls });
    messages.push({ role: 'tool', tool_call_id: tc.id, content: 'Done: reminder set. It is on the calendar now.' });
    const res2 = await claudeChatCompletion({ messages, tools: REMINDER_TOOLS, tool_choice: 'auto', temperature: 0.1 });

    const second = calls[1]!;
    expect(second.cmd[second.cmd.indexOf('--resume') + 1]).toBe('806facdd-0c32-430a-9b2a-46dd5bd528c9');
    // System prompt re-passed on resume (persistence across resume unverified).
    expect(second.cmd).toContain('--system-prompt');
    // Only the delta since the last call — the tool result, not the history,
    // and not Claude's own assistant echo.
    expect(new TextDecoder().decode(second.stdin)).toBe('Tool result: Done: reminder set. It is on the calendar now.');
    expect(res2.message.content).toBe('Reminder set for tomorrow at 9am.');
    expect(res2.message.tool_calls).toBeUndefined();
  });

  test('a different messages array starts a fresh session', async () => {
    process.env.MISE_CLAUDE_BIN = '/fake/claude';
    const { calls } = mockSpawn([okProc(resultJson()), okProc(resultJson())]);
    await claudeChatCompletion({ messages: baseMessages() });
    await claudeChatCompletion({ messages: baseMessages() });
    expect(calls[0]!.cmd).not.toContain('--resume');
    expect(calls[1]!.cmd).not.toContain('--resume');
  });

  test('MISE_CLAUDE_MODEL overrides the model flag', async () => {
    process.env.MISE_CLAUDE_BIN = '/fake/claude';
    process.env.MISE_CLAUDE_MODEL = 'opus';
    const { calls } = mockSpawn([okProc(resultJson())]);
    await claudeChatCompletion({ messages: baseMessages() });
    expect(calls[0]!.cmd[calls[0]!.cmd.indexOf('--model') + 1]).toBe('opus');
  });
});

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

describe('error taxonomy', () => {
  test('non-JSON stdout → malformed-output', async () => {
    process.env.MISE_CLAUDE_BIN = '/fake/claude';
    mockSpawn([okProc('Segmentation fault (core dumped)', 'boom')]);
    const err = await claudeChatCompletion({ messages: baseMessages() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeCliError);
    expect((err as ClaudeCliError).kind).toBe('malformed-output');
  });

  test('is_error with the /login message → not-authed (classified from JSON, not exit code)', async () => {
    process.env.MISE_CLAUDE_BIN = '/fake/claude';
    mockSpawn([okProc(NOT_AUTHED_JSON)]); // exit 0 on purpose — probe never confirmed non-zero
    const err = await claudeChatCompletion({ messages: baseMessages() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeCliError);
    expect((err as ClaudeCliError).kind).toBe('not-authed');
  });

  test('is_error with any other message → api-error', async () => {
    process.env.MISE_CLAUDE_BIN = '/fake/claude';
    mockSpawn([okProc(resultJson({ is_error: true, result: 'API overloaded', terminal_reason: 'api_error' }))]);
    const err = await claudeChatCompletion({ messages: baseMessages() }).catch((e: unknown) => e);
    expect((err as ClaudeCliError).kind).toBe('api-error');
  });

  test('a wedged child is killed at the deadline → timeout', async () => {
    process.env.MISE_CLAUDE_BIN = '/fake/claude';
    process.env.MISE_CLAUDE_TIMEOUT_MS = '25';
    mockSpawn([hangingProc()]);
    const started = Date.now();
    const err = await claudeChatCompletion({ messages: baseMessages() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeCliError);
    expect((err as ClaudeCliError).kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('spawn ENOENT → not-installed', async () => {
    process.env.MISE_CLAUDE_BIN = '/nonexistent/claude';
    __setClaudeCliTestOverrides({
      spawn: () => {
        const e = new Error("Executable not found in $PATH: '/nonexistent/claude'") as Error & { code: string };
        e.code = 'ENOENT';
        throw e;
      },
      fallback: () => {
        throw new Error('fallback must not run in this test');
      },
    });
    const err = await claudeChatCompletion({ messages: baseMessages() }).catch((e: unknown) => e);
    expect((err as ClaudeCliError).kind).toBe('not-installed');
  });

  test('no resolvable binary at all → not-installed without spawning', async () => {
    delete process.env.MISE_CLAUDE_BIN;
    process.env.PATH = '/nonexistent-path-entry';
    process.env.HOME = '/nonexistent-home';
    mockSpawn([]); // would throw if the spawn were reached
    const err = await claudeChatCompletion({ messages: baseMessages() }).catch((e: unknown) => e);
    expect((err as ClaudeCliError).kind).toBe('not-installed');
  });
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

describe('claudeWithFallback', () => {
  test('delegates to Ollama on failure, warning with the taxonomy kind', async () => {
    process.env.MISE_CLAUDE_BIN = '/nonexistent/claude';
    const fallbackCalls: ChatMessage[][] = [];
    __setClaudeCliTestOverrides({
      spawn: () => {
        const e = new Error('spawn ENOENT') as Error & { code: string };
        e.code = 'ENOENT';
        throw e;
      },
      fallback: async (opts): Promise<ChatCompletionResult> => {
        fallbackCalls.push(opts.messages);
        return { message: { content: 'answered by ollama' } };
      },
    });
    const messages = baseMessages();
    const res = await claudeWithFallback({ messages, tools: REMINDER_TOOLS });
    expect(res.message.content).toBe('answered by ollama');
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0]).toBe(messages); // same opts passed through
    expect(warns.some((w) => w.includes('not-installed'))).toBe(true);
  });

  test('does not touch the fallback when claude succeeds', async () => {
    process.env.MISE_CLAUDE_BIN = '/fake/claude';
    mockSpawn([okProc(resultJson({ result: 'hello from claude' }))]);
    const res = await claudeWithFallback({ messages: baseMessages() });
    expect(res.message.content).toBe('hello from claude');
    expect(warns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Shared <tool_call> parser (extracted from ollama.ts)
// ---------------------------------------------------------------------------

describe('parseToolCallText', () => {
  test('extracts multiple calls with positional ids and strips them from the text', () => {
    const raw =
      'Booking both.\n' +
      '<tool_call>{"name":"fit_in_event","arguments":{"title":"Friends","date":"2026-08-08"}}</tool_call>\n' +
      '<tool_call>{"name":"shift_events","arguments":{"scope":"day","date":"2026-08-08","delta_minutes":30}}</tool_call>';
    const { text, tool_calls } = parseToolCallText(raw);
    expect(tool_calls).toHaveLength(2);
    expect(tool_calls![0]!.id).toBe('tc0');
    expect(tool_calls![1]!.id).toBe('tc1');
    expect(tool_calls![1]!.function.name).toBe('shift_events');
    expect(JSON.parse(tool_calls![0]!.function.arguments)).toEqual({ title: 'Friends', date: '2026-08-08' });
    expect(text).toBe('Booking both.');
  });

  test('leaves a malformed block in the text and reports no calls', () => {
    const raw = '<tool_call>{"name": broken json}</tool_call>';
    const { text, tool_calls } = parseToolCallText(raw);
    expect(tool_calls).toBeUndefined();
    expect(text).toBe(raw);
  });

  test('plain prose passes through untouched', () => {
    const { text, tool_calls } = parseToolCallText('Nothing on Thursday after 3pm.');
    expect(tool_calls).toBeUndefined();
    expect(text).toBe('Nothing on Thursday after 3pm.');
  });
});
