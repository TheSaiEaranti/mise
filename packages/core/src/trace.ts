/**
 * Per-turn latency tracing. MEASUREMENT ONLY: nothing in this file changes
 * what a turn does, what it sends the model, or what it writes.
 *
 * One chat turn = one TurnTrace. The agent loop opens it (runAgentTurn), and
 * everything underneath (the model backends, the tools, the apply gate, every
 * SQLite statement) records into it through AsyncLocalStorage, so no function
 * signature grows a "trace" parameter. Code running outside a turn (a drag, an
 * undo, a test that calls a tool directly) sees no trace and records nothing.
 *
 * When the turn ends, the trace is:
 *   - logged as ONE structured line: `[turn] {...json...}`
 *   - kept in a small in-memory ring buffer the dev panel reads (/api/dev/turns)
 *   - returned from runAgentTurn, which is how scripts/latency-eval.ts reads it
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from 'bun:sqlite';

/** What a model backend reports about one call, beyond the message itself. */
export interface ChatMeta {
  /** 'claude-cli' | 'ollama' | 'anthropic' — who actually answered. */
  backend: string;
  model: string | null;
  /** Time to first streamed token. null = the backend does not stream. */
  ttft_ms?: number | null;
  /** Model time as the backend reports it (the CLI's duration_api_ms). */
  api_ms?: number | null;
  /** The backend's own wall clock for the call, when it reports one. */
  backend_ms?: number | null;
  /** Uncached input tokens. */
  input_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  output_tokens?: number | null;
  /** Characters of system prompt actually sent (after backend-side additions). */
  system_chars?: number | null;
  /** Characters of non-system prompt sent this call. */
  prompt_chars?: number | null;
  /** True when this call continued an earlier backend session (CLI --resume). */
  resumed?: boolean;
  /** Set when the primary backend failed and another one answered. */
  fallback_from?: string;
  fallback_reason?: string;
  /** Anthropic backend: which model tier answered ('escalated' = the stronger model). */
  tier?: 'default' | 'escalated';
  /** Anthropic backend: why generation stopped (tool_use, end_turn, max_tokens, refusal). */
  stop_reason?: string | null;
  /** 'route' = the router's one-word intent classification, not a turn round. */
  purpose?: 'route';
  /** Anthropic backend: rounds re-issued because a streamed tool input was unparseable. */
  json_retries?: number;
}

export interface RoundTrace {
  round: number;
  /** Offset from turn start. */
  start_ms: number;
  /** How long the agent loop waited on this model call. */
  wall_ms: number;
  tool_calls: number;
  error?: string;
  meta: ChatMeta;
}

export interface SpanTrace {
  /** e.g. 'dry:shift_events', 'commit:shift_events', 'apply.revalidate'. */
  name: string;
  start_ms: number;
  ms: number;
  ok: boolean;
}

export interface TurnTrace {
  id: string;
  /** Wall-clock ISO timestamp the turn started (real clock, not MISE_NOW). */
  at: string;
  message: string;
  total_ms: number;
  /** History load + context build + system prompt assembly. */
  prompt_build_ms: number;
  prompt: {
    system_chars: number;
    context_chars: number;
    tool_schema_chars: number;
    tools: number;
    history_messages: number;
  };
  rounds: RoundTrace[];
  spans: SpanTrace[];
  /**
   * Time inside SQLite during the turn: statement compilation (prepare) plus
   * execution. Overlaps spans. Excludes the BEGIN/COMMIT that bun:sqlite's
   * native transaction() issues internally — it can't be hooked without
   * changing how transactions run (sub-millisecond on this app's writes).
   */
  db_ms: number;
  db_queries: number;
  /** What the router decided (router.ts), or the fast path. */
  route?: {
    families: string[];
    source: string;
    complex: boolean;
    /** Tools sent to the model; null = all of them. */
    tools: number | null;
    /** Calendar days in the context; null = the full two-week window. */
    days: string[] | null;
  };
  outcome: {
    proposals: number;
    applied: number;
    reply_chars: number;
    /** Tool names that produced a proposal this turn, in order. */
    tools: string[];
  };
}

interface Live {
  trace: TurnTrace;
  t0: number;
}

const als = new AsyncLocalStorage<Live>();

const RING_SIZE = 100;
const ring: TurnTrace[] = [];

let seq = 0;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function beginTurnTrace(message: string): { trace: TurnTrace; t0: number } {
  seq += 1;
  const trace: TurnTrace = {
    id: `turn-${Date.now().toString(36)}-${seq}`,
    at: new Date().toISOString(),
    message: message.length > 200 ? message.slice(0, 199) + '…' : message,
    total_ms: 0,
    prompt_build_ms: 0,
    prompt: { system_chars: 0, context_chars: 0, tool_schema_chars: 0, tools: 0, history_messages: 0 },
    rounds: [],
    spans: [],
    db_ms: 0,
    db_queries: 0,
    outcome: { proposals: 0, applied: 0, reply_chars: 0, tools: [] },
  };
  return { trace, t0: performance.now() };
}

/** Run `fn` with `trace` as the current turn. */
export function withTurnTrace<T>(live: { trace: TurnTrace; t0: number }, fn: () => Promise<T>): Promise<T> {
  return als.run({ trace: live.trace, t0: live.t0 }, fn);
}

/** The trace of the turn this code is running inside, if any. */
export function currentTrace(): TurnTrace | undefined {
  return als.getStore()?.trace;
}

/** ms since the current turn started (0 outside a turn). */
export function turnElapsed(): number {
  const live = als.getStore();
  return live ? performance.now() - live.t0 : 0;
}

/**
 * Time `fn` as a named span of the current turn. Outside a turn it just runs
 * `fn`. Errors propagate unchanged; the span is recorded with ok=false.
 */
export async function traceSpan<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const live = als.getStore();
  if (!live) return fn();
  const start = performance.now();
  let ok = false;
  try {
    const out = await fn();
    ok = true;
    return out;
  } finally {
    live.trace.spans.push({
      name,
      start_ms: round1(start - live.t0),
      ms: round1(performance.now() - start),
      ok,
    });
  }
}

export function recordRound(r: Omit<RoundTrace, 'start_ms' | 'wall_ms'> & { startedAt: number }): void {
  const live = als.getStore();
  if (!live) return;
  const { startedAt, ...rest } = r;
  live.trace.rounds.push({
    ...rest,
    start_ms: round1(startedAt - live.t0),
    wall_ms: round1(performance.now() - startedAt),
  });
}

/** Close the trace: stamp totals, log one line, keep it for the dev panel. */
export function finishTurnTrace(live: { trace: TurnTrace; t0: number }): TurnTrace {
  const t = live.trace;
  t.total_ms = round1(performance.now() - live.t0);
  t.db_ms = round1(t.db_ms);
  ring.push(t);
  if (ring.length > RING_SIZE) ring.shift();
  if (shouldLog()) console.log(`[turn] ${JSON.stringify(summarizeTrace(t))}`);
  return t;
}

function shouldLog(): boolean {
  if (process.env.MISE_TURN_LOG === '0') return false;
  if (process.env.MISE_TURN_LOG === '1') return true;
  return process.env.NODE_ENV !== 'test';
}

/** The one-line form: every number that matters, no prompt text. */
export function summarizeTrace(t: TurnTrace) {
  const sum = (f: (r: RoundTrace) => number | null | undefined) =>
    t.rounds.reduce((a, r) => a + (f(r) ?? 0), 0);
  return {
    id: t.id,
    msg: t.message.length > 80 ? t.message.slice(0, 79) + '…' : t.message,
    total_ms: t.total_ms,
    prompt_build_ms: t.prompt_build_ms,
    rounds: t.rounds.length,
    model_ms: round1(sum((r) => r.wall_ms)),
    in_tok: sum((r) => r.meta.input_tokens),
    cache_read_tok: sum((r) => r.meta.cache_read_tokens),
    cache_write_tok: sum((r) => r.meta.cache_write_tokens),
    out_tok: sum((r) => r.meta.output_tokens),
    per_round: t.rounds.map((r) => ({
      backend: r.meta.backend,
      model: r.meta.model,
      wall_ms: r.wall_ms,
      ttft_ms: r.meta.ttft_ms ?? null,
      api_ms: r.meta.api_ms ?? null,
      in: r.meta.input_tokens ?? null,
      cr: r.meta.cache_read_tokens ?? null,
      cw: r.meta.cache_write_tokens ?? null,
      out: r.meta.output_tokens ?? null,
      calls: r.tool_calls,
      ...(r.error ? { error: r.error } : {}),
      ...(r.meta.fallback_from ? { fallback_from: r.meta.fallback_from } : {}),
    })),
    spans: t.spans.map((s) => `${s.name}:${s.ms}${s.ok ? '' : '!'}`),
    db_ms: t.db_ms,
    db_q: t.db_queries,
    prompt_chars: t.prompt,
    outcome: t.outcome,
  };
}

export function recentTurnTraces(limit = 20): TurnTrace[] {
  return ring.slice(-limit).reverse();
}

/** Test seam. */
export function __clearTurnTraces(): void {
  ring.length = 0;
}

// ---------------------------------------------------------------------------
// SQLite timing
// ---------------------------------------------------------------------------

const WRAPPED = Symbol.for('mise.trace.wrapped');

/** Wrap `orig` so its duration adds to db_ms (and, if `counts`, to db_queries). */
function timed<F extends (...a: any[]) => any>(orig: F, self: unknown, counts = true): F {
  return function (this: unknown, ...args: any[]) {
    const live = als.getStore();
    if (!live) return orig.apply(self, args);
    const start = performance.now();
    try {
      return orig.apply(self, args);
    } finally {
      live.trace.db_ms += performance.now() - start;
      if (counts) live.trace.db_queries += 1;
    }
  } as F;
}

function wrapStatement<S extends object>(stmt: S): S {
  if ((stmt as any)[WRAPPED]) return stmt;
  for (const m of ['run', 'all', 'get', 'values'] as const) {
    const orig = (stmt as any)[m];
    if (typeof orig === 'function') (stmt as any)[m] = timed(orig, stmt);
  }
  (stmt as any)[WRAPPED] = true;
  return stmt;
}

/**
 * Time SQLite work on this connection while a turn is active. drizzle's
 * bun-sqlite driver compiles every query with prepare() and executes it with
 * run/all/get/values, and uses exec() for raw SQL; query() is the cached form
 * of prepare(). Compilation and execution both count toward db_ms; only
 * executions count as queries. Statements are returned unchanged apart from
 * the timing wrapper, and everything stays synchronous, so bun:sqlite
 * transactions behave exactly as before.
 */
export function instrumentSqlite(sqlite: Database): void {
  const s = sqlite as any;
  if (s[WRAPPED]) return;
  const prepare = s.prepare.bind(sqlite);
  const query = s.query.bind(sqlite);
  const timedPrepare = timed(prepare, sqlite, false);
  const timedQuery = timed(query, sqlite, false);
  s.prepare = (...a: any[]) => wrapStatement(timedPrepare(...a));
  s.query = (...a: any[]) => wrapStatement(timedQuery(...a));
  for (const m of ['exec', 'run'] as const) {
    if (typeof s[m] === 'function') s[m] = timed(s[m].bind(sqlite), sqlite);
  }
  s[WRAPPED] = true;
}
