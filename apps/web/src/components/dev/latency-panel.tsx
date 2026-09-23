'use client';

/**
 * Dev-only latency panel: where the last chat turns spent their time.
 *
 * Reads GET /api/dev/turns (per-turn traces from the agent loop + request
 * timings for chat/drag/undo). Hidden by default so it never shows up in a
 * screenshot or recording; Ctrl+Shift+L toggles it, `?dev=1` opens it. Only
 * mounted when NODE_ENV !== 'production' (see layout.tsx).
 */
import { useEffect, useState } from 'react';
import { apiBase } from '@/lib/api';

interface ChatMeta {
  backend: string;
  model: string | null;
  ttft_ms?: number | null;
  api_ms?: number | null;
  input_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  output_tokens?: number | null;
  fallback_from?: string;
}
interface RoundTrace {
  round: number;
  start_ms: number;
  wall_ms: number;
  tool_calls: number;
  error?: string;
  meta: ChatMeta;
}
interface SpanTrace {
  name: string;
  start_ms: number;
  ms: number;
  ok: boolean;
}
interface TurnTrace {
  id: string;
  at: string;
  message: string;
  total_ms: number;
  prompt_build_ms: number;
  prompt: { system_chars: number; context_chars: number; tool_schema_chars: number; tools: number };
  rounds: RoundTrace[];
  spans: SpanTrace[];
  db_ms: number;
  db_queries: number;
  outcome: { proposals: number; applied: number; tools: string[] };
}
interface RequestTiming {
  at: string;
  method: string;
  path: string;
  status: number;
  ms: number;
}

const STORE_KEY = 'mise.devLatencyPanel';

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function tokens(r: RoundTrace): string {
  const m = r.meta;
  const parts: string[] = [];
  if (m.input_tokens != null) parts.push(`in ${m.input_tokens}`);
  if (m.cache_read_tokens) parts.push(`cache ${m.cache_read_tokens}`);
  if (m.cache_write_tokens) parts.push(`write ${m.cache_write_tokens}`);
  if (m.output_tokens != null) parts.push(`out ${m.output_tokens}`);
  if (m.ttft_ms != null) parts.push(`ttft ${fmtMs(m.ttft_ms)}`);
  return parts.join(' · ');
}

function Bar({ start, ms, total, color, label }: { start: number; ms: number; total: number; color: string; label: string }) {
  const left = total > 0 ? (start / total) * 100 : 0;
  const width = total > 0 ? Math.max((ms / total) * 100, 0.6) : 0;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr 56px', gap: 8, alignItems: 'center', height: 18 }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>
        {label}
      </span>
      <div style={{ position: 'relative', height: 8, background: 'var(--recessed)', borderRadius: 2 }}>
        <div style={{ position: 'absolute', left: `${left}%`, width: `${width}%`, top: 0, bottom: 0, background: color, borderRadius: 2 }} />
      </div>
      <span style={{ textAlign: 'right' }}>{fmtMs(ms)}</span>
    </div>
  );
}

function Waterfall({ t }: { t: TurnTrace }) {
  const total = t.total_ms;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Bar start={0} ms={t.prompt_build_ms} total={total} color="var(--ink-soft)" label="prompt build" />
      {t.rounds.map((r) => (
        <div key={`r${r.round}`}>
          <Bar
            start={r.start_ms}
            ms={r.wall_ms}
            total={total}
            color={r.error ? 'var(--signal)' : 'var(--ink)'}
            label={`round ${r.round + 1} · ${r.meta.backend}${r.meta.model ? `/${r.meta.model}` : ''}`}
          />
          <div style={{ paddingLeft: 158, color: 'var(--ink-soft)' }}>
            {tokens(r)}
            {r.tool_calls > 0 ? ` · ${r.tool_calls} call${r.tool_calls > 1 ? 's' : ''}` : ''}
            {r.meta.fallback_from ? ` · fell back from ${r.meta.fallback_from}` : ''}
            {r.error ? ` · ${r.error}` : ''}
          </div>
        </div>
      ))}
      {t.spans.map((s, i) => (
        <Bar key={`s${i}`} start={s.start_ms} ms={s.ms} total={total} color={s.ok ? '#4f7a5a' : 'var(--signal)'} label={s.name} />
      ))}
    </div>
  );
}

export function LatencyPanel() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<TurnTrace[]>([]);
  const [requests, setRequests] = useState<RequestTiming[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let initial = false;
    try {
      initial = new URLSearchParams(window.location.search).get('dev') === '1' || localStorage.getItem(STORE_KEY) === '1';
    } catch {
      // storage blocked — panel just starts closed
    }
    setOpen(initial);
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
        e.preventDefault();
        setOpen((o) => {
          try {
            localStorage.setItem(STORE_KEY, o ? '0' : '1');
          } catch {
            // ignore
          }
          return !o;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${apiBase()}/api/dev/turns?limit=15`);
        if (!res.ok) throw new Error(`${res.status}`);
        const body = (await res.json()) as { turns: TurnTrace[]; requests: RequestTiming[] };
        if (!alive) return;
        setTurns(body.turns);
        setRequests(body.requests);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const id = window.setInterval(load, 1500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [open]);

  if (!open) return null;
  const last = turns[0];

  return (
    <aside
      aria-label="Latency (dev)"
      style={{
        position: 'fixed',
        left: 12,
        bottom: 72,
        zIndex: 60,
        width: 460,
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: '62vh',
        overflowY: 'auto',
        background: 'var(--paper)',
        border: '1px solid var(--rule)',
        borderRadius: 'var(--r)',
        boxShadow: 'var(--lift-drag)',
        padding: 12,
        font: '11px/1.4 var(--font-num)',
        color: 'var(--ink)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>latency · dev</strong>
        <span style={{ color: 'var(--ink-soft)' }}>ctrl+shift+L</span>
      </div>
      {error && <div style={{ color: 'var(--signal)' }}>/api/dev/turns: {error}</div>}
      {!last && !error && <div style={{ color: 'var(--ink-soft)' }}>No chat turns yet.</div>}
      {last && (
        <>
          <div style={{ marginBottom: 6 }}>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>“{last.message}”</div>
            <div style={{ color: 'var(--ink-soft)' }}>
              total {fmtMs(last.total_ms)} · {last.rounds.length} round{last.rounds.length === 1 ? '' : 's'} · db{' '}
              {fmtMs(last.db_ms)} ({last.db_queries}q) · prompt {Math.round(
                (last.prompt.system_chars + last.prompt.tool_schema_chars) / 1000,
              )}k chars · {last.outcome.tools.join(', ') || 'no change'}
            </div>
          </div>
          <Waterfall t={last} />
        </>
      )}
      {turns.length > 1 && (
        <table style={{ width: '100%', marginTop: 10, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--ink-soft)', textAlign: 'left' }}>
              <th>turn</th>
              <th style={{ textAlign: 'right' }}>total</th>
              <th style={{ textAlign: 'right' }}>rounds</th>
              <th style={{ textAlign: 'right' }}>in tok</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((t) => (
              <tr key={t.id} style={{ borderTop: '1px solid var(--rule)' }}>
                <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.message}</td>
                <td style={{ textAlign: 'right' }}>{fmtMs(t.total_ms)}</td>
                <td style={{ textAlign: 'right' }}>{t.rounds.length}</td>
                <td style={{ textAlign: 'right' }}>
                  {t.rounds.reduce((a, r) => a + (r.meta.input_tokens ?? 0) + (r.meta.cache_read_tokens ?? 0) + (r.meta.cache_write_tokens ?? 0), 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {requests.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ color: 'var(--ink-soft)' }}>requests (chat, drag, undo)</div>
          {requests.slice(0, 8).map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>
                {r.method} {r.path} {r.status}
              </span>
              <span>{fmtMs(r.ms)}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
