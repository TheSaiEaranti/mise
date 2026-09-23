/**
 * Time the DEMO.md script: the five commands, N times each, through the real
 * API routes (POST /api/chat/stream, approve, undo) on a fresh in-memory copy
 * of the demo semester each round — after warming the prompt cache the way
 * the server does at startup.
 *
 *   bun run scripts/demo-timing.ts [--rounds 3] [--now 2026-09-25T14:00]
 *
 * For each streamed turn: time to the first status line, to the diff card
 * (the first `proposal` event), and to the final answer. Also checks the
 * story holds: the pinned class didn't move, Fridays lost their gym, the
 * cancel waited for approval, and Undo brought the appointment back.
 */
const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
process.env.MISE_DB_PATH = ':memory:';
process.env.MISE_SETTINGS_PATH ??= '/nonexistent/settings.json';
process.env.MISE_TURN_LOG ??= '0';
if (opt('--now')) process.env.MISE_NOW = opt('--now');

const { resetDbForTests, schema } = await import('../packages/core/src/db/client');
const { getInstances } = await import('../packages/core/src/schedule');
const { addDaysWall, todayInTz, weekdayCode } = await import('../packages/core/src/time');
const { warmAnthropicCache } = await import('../packages/core/src/anthropic');
const { warmupPrefixes } = await import('../packages/core/src/agent');
const { activeChatBackend } = await import('../packages/core/src/claude-cli');
const { app } = await import('../apps/api/src/app');
const { seedDemoSemester } = await import('./lib/demo-fixture');

const ROUNDS = Number(opt('--rounds') ?? 3);
const today = todayInTz();
const tomorrow = addDaysWall(today, 1);

interface Timing {
  first_status: number | null;
  card: number | null;
  total: number;
  reply: string;
  proposals: { id: string; status: string; tool_name: string }[];
}

/** POST a message to the SSE route and timestamp the events as they arrive. */
async function streamed(message: string): Promise<Timing> {
  const t0 = performance.now();
  const res = await app.request('/api/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  const out: Timing = { first_status: null, card: null, total: 0, reply: '', proposals: [] };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += value;
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const event = /event: (.+)/.exec(block)?.[1];
      const data = JSON.parse(block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('') || '{}');
      const at = performance.now() - t0;
      if (event === 'status' && out.first_status === null) out.first_status = at;
      if (event === 'proposal' && out.card === null) out.card = at;
      if (event === 'done') {
        out.total = at;
        out.reply = data.reply;
        out.proposals = data.proposals;
      }
    }
    if (done) break;
  }
  return out;
}

const start = (date: string, re: RegExp) => getInstances(resetless(), date, date).find((i) => re.test(i.title))?.starts_at.slice(11) ?? null;
let dbRef: ReturnType<typeof resetDbForTests>;
const resetless = () => dbRef;

console.log(`demo timing · today ${today} (${weekdayCode(today)}), tomorrow ${tomorrow} (${weekdayCode(tomorrow)}) · backend ${activeChatBackend()} · ${ROUNDS} rounds`);
if (activeChatBackend() === 'anthropic') {
  const w = await warmAnthropicCache(warmupPrefixes());
  console.log(`cache warmed (${w.written} written, ${w.read} already cached)`);
}

const rows: Record<string, number[]> = {};
const add = (k: string, ms: number | null) => {
  if (ms !== null) (rows[k] ??= []).push(ms);
};
const problems: string[] = [];

for (let r = 0; r < ROUNDS; r++) {
  dbRef = resetDbForTests();
  seedDemoSemester(dbRef, today);
  const pinnedTitle = /ECO 304K/;
  const pinnedBefore = start(tomorrow, pinnedTitle);

  const s1 = await streamed('move my gym block to 6pm');
  add('1 move gym to 6pm · total', s1.total);
  if (start(today, /^Gym/) !== '18:00') problems.push(`r${r} step 1: gym at ${start(today, /^Gym/)}`);

  const s2 = await streamed('shift everything after 3pm tomorrow back an hour');
  add('2 shift after 3pm tmrw · total', s2.total);
  if (start(tomorrow, pinnedTitle) !== pinnedBefore) problems.push(`r${r} step 2: the pinned class moved`);

  const s3 = await streamed('no gym on Fridays');
  add('3 no gym on Fridays · first status', s3.first_status);
  add('3 no gym on Fridays · diff card', s3.card);
  add('3 no gym on Fridays · total', s3.total);
  let friday = today;
  while (weekdayCode(friday) !== 'FR' || friday === today) friday = addDaysWall(friday, 1);
  if (getInstances(dbRef, friday, friday).some((i) => i.kind === 'gym')) problems.push(`r${r} step 3: ${friday} still has gym`);

  const s4 = await streamed('cancel my advising appointment');
  add('4 cancel · first status', s4.first_status);
  add('4 cancel · confirm card', s4.card);
  add('4 cancel · total', s4.total);
  const cancel = s4.proposals.find((p) => p.tool_name === 'cancel_event');
  if (!cancel || cancel.status !== 'pending') problems.push(`r${r} step 4: cancel ${cancel ? cancel.status : 'missing'} — "${s4.reply.slice(0, 60)}"`);
  if (cancel) {
    const t = performance.now();
    const a = await app.request(`/api/proposals/${cancel.id}/approve`, { method: 'POST' });
    add('4 cancel · approve click', performance.now() - t);
    if (a.status !== 200) problems.push(`r${r} step 4: approve ${a.status}`);

    const t5 = performance.now();
    const u = await app.request(`/api/proposals/${cancel.id}/undo`, { method: 'POST' });
    add('5 undo · click', performance.now() - t5);
    const back = getInstances(dbRef, addDaysWall(today, 2), addDaysWall(today, 2)).some((i) => /Advising/.test(i.title));
    if (u.status !== 200 || !back) problems.push(`r${r} step 5: undo ${u.status}, advising back: ${back}`);
  }
}

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`);
console.log('\n| step | runs | min | max |');
console.log('|---|---|---|---|');
for (const [k, v] of Object.entries(rows)) console.log(`| ${k} | ${v.map(fmt).join(', ')} | ${fmt(Math.min(...v))} | ${fmt(Math.max(...v))} |`);
const slow = Object.entries(rows).filter(([k, v]) => k.endsWith('total') && Math.max(...v) > 3000);
console.log(problems.length ? `\nPROBLEMS:\n  ${problems.join('\n  ')}` : '\nstory holds on every round: pinned class unmoved, Fridays cleared, cancel asked first, Undo restored it.');
console.log(slow.length ? `\nOVER 3s: ${slow.map(([k]) => k).join('; ')}` : 'every step under 3s.');
if (problems.length || slow.length) process.exit(1);
