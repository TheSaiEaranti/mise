/**
 * Compare two latency-eval runs.
 *
 *   bun run scripts/compare-latency.ts [before] [after]   (default: before after)
 *
 * Prints the before/after table (markdown) and a per-command accuracy check.
 * Exits non-zero if any command is right fewer times after than before —
 * "accuracy must not drop" is checked per command, not just in aggregate.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Run {
  id: string;
  message: string;
  correct: boolean;
  total_ms: number;
  rounds: number;
}
interface Summary {
  label: string;
  backends: string[];
  runs: number;
  p50_ms: number | null;
  p90_ms: number | null;
  simple_move_p50_ms: number | null;
  simple_move_p90_ms: number | null;
  rounds_mean: number | null;
  input_tokens_mean: number | null;
  cache_hit_rate: number | null;
  tool_accuracy: number;
  outcome_accuracy: number;
  fast_path_runs?: number;
}

const dir = join(import.meta.dir, '..', 'eval', 'latency');
const load = (label: string) => JSON.parse(readFileSync(join(dir, `${label}.json`), 'utf8')) as { summary: Summary; runs: Run[] };

const [bLabel = 'before', aLabel = 'after'] = process.argv.slice(2);
const b = load(bLabel);
const a = load(aLabel);

const s = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(2)}s`);
const pc = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const x = (bv: number | null, av: number | null) => (bv && av ? `${(bv / av).toFixed(1)}×` : '');

console.log(`| | ${bLabel} | ${aLabel} | |`);
console.log('|---|---|---|---|');
console.log(`| backend / model | ${b.summary.backends.join(', ')} | ${a.summary.backends.join(', ')} | |`);
console.log(`| p50 latency (all commands) | ${s(b.summary.p50_ms)} | ${s(a.summary.p50_ms)} | ${x(b.summary.p50_ms, a.summary.p50_ms)} faster |`);
console.log(`| p90 latency (all commands) | ${s(b.summary.p90_ms)} | ${s(a.summary.p90_ms)} | ${x(b.summary.p90_ms, a.summary.p90_ms)} faster |`);
console.log(`| p50 / p90 simple edits | ${s(b.summary.simple_move_p50_ms)} / ${s(b.summary.simple_move_p90_ms)} | ${s(a.summary.simple_move_p50_ms)} / ${s(a.summary.simple_move_p90_ms)} | |`);
console.log(`| model rounds per turn | ${b.summary.rounds_mean} | ${a.summary.rounds_mean} | |`);
console.log(`| input tokens per turn | ${b.summary.input_tokens_mean?.toLocaleString()} | ${a.summary.input_tokens_mean?.toLocaleString()} | ${x(b.summary.input_tokens_mean, a.summary.input_tokens_mean)} fewer |`);
console.log(`| prompt-cache hit rate (input tokens) | ${pc(b.summary.cache_hit_rate)} | ${pc(a.summary.cache_hit_rate)} | |`);
console.log(`| tool accuracy | ${pc(b.summary.tool_accuracy)} | ${pc(a.summary.tool_accuracy)} | |`);
console.log(`| tool + outcome accuracy | ${pc(b.summary.outcome_accuracy)} | ${pc(a.summary.outcome_accuracy)} | |`);
if (a.summary.fast_path_runs !== undefined) console.log(`| answered without a model (fast path) | 0/${b.summary.runs} | ${a.summary.fast_path_runs}/${a.summary.runs} | |`);

const per = (runs: Run[]) => {
  const m = new Map<string, { message: string; ok: number; n: number }>();
  for (const r of runs) {
    const e = m.get(r.id) ?? { message: r.message, ok: 0, n: 0 };
    e.n++;
    if (r.correct) e.ok++;
    m.set(r.id, e);
  }
  return m;
};
const pb = per(b.runs);
const pa = per(a.runs);
const worse: string[] = [];
console.log('\nper command (correct / runs):');
for (const [id, e] of pb) {
  const af = pa.get(id);
  const rate = (v: { ok: number; n: number } | undefined) => (v ? v.ok / v.n : 0);
  const flag = af && rate(af) < rate(e) ? '  ← WORSE' : af && rate(af) > rate(e) ? '  (fixed)' : '';
  if (flag.includes('WORSE')) worse.push(id);
  console.log(`  ${id}  ${e.ok}/${e.n} → ${af ? `${af.ok}/${af.n}` : 'missing'}${flag}  "${e.message}"`);
}
if (worse.length > 0) {
  console.error(`\naccuracy dropped on: ${worse.join(', ')}`);
  process.exit(1);
}
console.log('\nno command is less accurate after than before.');
