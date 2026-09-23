/**
 * Dry-run the showcase storyline (scripts/record-showcase.ts) through the real
 * API routes on a fresh in-memory demo semester, frozen at Wed 10:00 — so the
 * video never records a surprise. Prints what each step did and how long it took.
 *
 *   bun run scripts/showcase-dryrun.ts
 */
process.env.MISE_DB_PATH = ':memory:';
process.env.MISE_SETTINGS_PATH ??= '/nonexistent/settings.json';
process.env.MISE_TURN_LOG = '0';
process.env.MISE_NOW ??= '2026-09-23T10:00';

const { resetDbForTests } = await import('../packages/core/src/db/client');
const { getInstances } = await import('../packages/core/src/schedule');
const { todayInTz, addDaysWall } = await import('../packages/core/src/time');
const { warmAnthropicCache } = await import('../packages/core/src/anthropic');
const { warmupPrefixes } = await import('../packages/core/src/agent');
const { recentTurnTraces } = await import('../packages/core/src/trace');
const { app } = await import('../apps/api/src/app');
const { seedDemoSemester } = await import('./lib/demo-fixture');
const { STORY } = await import('./lib/showcase-story');

const db = resetDbForTests();
const T = todayInTz();
seedDemoSemester(db, T);
await warmAnthropicCache(warmupPrefixes());

const day = (d: string) =>
  getInstances(db, d, d)
    .map((i) => `${i.title} ${i.starts_at.slice(11)}–${i.ends_at.slice(11)}`)
    .join(' · ');

let ok = true;
for (const step of STORY) {
  const t0 = performance.now();
  const res = await app.request('/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: step.say }) });
  const text = await res.text();
  const done = JSON.parse(text.split('\n\n').filter((b) => b.includes('event: done'))[0]!.split('data:')[1]!);
  const ms = performance.now() - t0;
  const trace = recentTurnTraces(1)[0]!;
  const proposals = done.proposals as { id: string; tool_name: string; status: string }[];
  if (step.approve) {
    for (const p of proposals.filter((x) => x.status === 'pending')) await app.request(`/api/proposals/${p.id}/approve`, { method: 'POST' });
  }
  const verdict = step.check(db, T);
  if (verdict !== true) ok = false;
  console.log(`${verdict === true ? 'OK  ' : 'FAIL'} ${Math.round(ms).toString().padStart(5)} ms  ${trace.route?.source ?? '-'}  ${proposals.map((p) => `${p.tool_name}:${p.status}`).join(',') || '-'}  "${step.say}"`);
  console.log(`       reply: ${done.reply}`);
  if (verdict !== true) console.log(`       ✗ ${verdict}`);
  for (const d of step.showDays ?? []) console.log(`       ${d === T ? 'today' : d}: ${day(d === 'TODAY' ? T : d === 'TOMORROW' ? addDaysWall(T, 1) : d)}`);
}
const undo = await app.request('/api/proposals/undo-last', { method: 'POST' });
console.log(`undo-last: ${undo.status} · advising back: ${getInstances(db, addDaysWall(T, 2), addDaysWall(T, 2)).some((i) => /Advising/.test(i.title))}`);
process.exit(ok ? 0 : 1);
