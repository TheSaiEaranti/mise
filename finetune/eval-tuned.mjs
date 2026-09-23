// Gate eval for the fine-tuned 8B: talk to mlx_lm.server (:8081) with the SAME
// compact prompt it was trained on, parse the tool_call, verify it against the
// real tools (exec-oracle), and time it. Compares to the 30B baseline (Phase 3:
// 88% tool-acc, 47s mean).
import { resetDbForTests, schema } from '../packages/core/src/db/client.ts';
import { buildContext, COMPACT_SYSTEM } from '../packages/core/src/agent.ts';
import { getTool } from '../packages/core/src/tools/index.ts';
import { isActionable, severityOf } from '../packages/core/src/types.ts';
import { todayInTz, addDaysWall, weekdayCode } from '../packages/core/src/time.ts';

const SERVER = 'http://localhost:8081/v1/chat/completions';


const TODAY = todayInTz();
const nd = (c) => { for (let i = 1; i <= 14; i++) { const d = addDaysWall(TODAY, i); if (weekdayCode(d) === c) return d; } return TODAY; };
const MON = nd('MO'), TUE = nd('TU'), WED = nd('WE'), THU = nd('TH'), FRI = nd('FR');

function scenario() {
  const db = resetDbForTests();
  db.insert(schema.semester).values({ id: 's1', name: 'Term', start_date: addDaysWall(TODAY, -30), end_date: addDaysWall(TODAY, 90), timezone: 'America/Chicago' }).run();
  const rr = (d) => `FREQ=WEEKLY;BYDAY=${d};UNTIL=${addDaysWall(TODAY, 90).replaceAll('-', '')}`;
  const ev = (id, title, kind, date, s, e, pinned, days, loc, wk) => ({ id, semester_id: 's1', title, kind, starts_at: `${date}T${s}`, ends_at: `${date}T${e}`, pinned, rrule: days ? rr(days) : null, source: 'recurring', location: loc ?? null, notes: null, color: null, workout: wk ?? null });
  db.insert(schema.event).values([
    ev('c-ml', 'APPLD MACHINE LEARNING', 'class', MON, '15:30', '17:00', true, 'MO,WE', 'CBA'),
    ev('g-mo', 'Gym', 'gym', MON, '17:00', '18:30', false, 'MO', 'Gregory', 'shoulders-arms'),
    ev('g-tu', 'Gym', 'gym', TUE, '17:00', '18:30', false, 'TU', 'Gregory', 'chest-back'),
    ev('g-we', 'Gym', 'gym', WED, '17:00', '18:30', false, 'WE', 'Gregory', 'legs'),
    ev('ck', 'Cook lunches', 'cook', FRI, '18:45', '19:45', false, 'MO,WE,FR', null),
    ev('adv', 'Advising appointment', 'personal', TUE, '11:45', '12:30', false, null, 'GDC 1.302'),
  ]).run();
  return db;
}

async function ask(db, message) {
  const sys = COMPACT_SYSTEM + '\n\n' + buildContext(db) + '\n\n/no_think';
  const t0 = Date.now();
  const r = await fetch(SERVER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'system', content: sys }, { role: 'user', content: message }], temperature: 0.1, max_tokens: 300 }) });
  const j = await r.json();
  const secs = (Date.now() - t0) / 1000;
  const m = j.choices?.[0]?.message ?? {};
  let call = null;
  if (m.tool_calls?.[0]) { const f = m.tool_calls[0].function; try { call = { name: f.name, args: typeof f.arguments === 'string' ? JSON.parse(f.arguments) : f.arguments }; } catch {} }
  else if (m.content) { const mm = m.content.match(/<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/); if (mm) { try { const o = JSON.parse(mm[1]); call = { name: o.name, args: o.arguments }; } catch {} } }
  return { secs, call, content: m.content ?? '' };
}

const CASES = [
  { n: 'fit: friends at 8', m: 'hey i have friends coming over at 8 tonight', want: 'fit_in_event' },
  { n: 'fit: dinner 7', m: 'got dinner at 7 on wednesday', want: 'fit_in_event' },
  { n: 'fit: date 9', m: "i've got a date at 9 tonight for a couple hours", want: 'fit_in_event' },
  { n: 'fit: call 3', m: 'there is a call at 3 thursday, block it', want: 'fit_in_event' },
  { n: 'cancel advising', m: 'delete my advising appointment', want: 'cancel_event' },
  { n: 'cancel mon gym', m: "cancel monday's gym", want: 'cancel_event' },
  { n: 'place cook before gym', m: 'on monday make it so i cook before i gym', want: 'place_adjacent' },
  { n: 'recurring days', m: 'change my gym to only monday and wednesday', want: 'set_recurring_days' },
  { n: 'create study', m: 'block 2 hours to study wednesday evening', want: 'create_event' },
  { n: 'set_workout', m: "make tuesday's gym a legs day", want: 'set_workout' },
  { n: 'shift', m: 'push everything monday 30 minutes later', want: 'shift_events' },
  { n: 'preference', m: 'from now on i always want to cook before the gym', want: 'set_preference' },
  { n: 'add class', m: 'add my class CHEM 301, mon wed fri 9 to 10am in WEL 2.224', want: 'add_classes' },
  { n: 'neg: bare delete gym', m: 'delete my gym', want: '' },
];

const results = [];
for (const c of CASES) {
  const db = scenario();
  const { secs, call, content } = await ask(db, c.m);
  const name = call?.name ?? '';
  const tool_ok = name === c.want;
  let exec_ok = null;
  if (call) {
    const t = getTool(name);
    if (t) { const p = t.argsSchema.safeParse(call.args); if (p.success) { try { const r = await t.run(p.data, 'dry'); exec_ok = isActionable(r.diff) && !r.conflicts.some((x) => severityOf(x) === 'blocking'); } catch { exec_ok = false; } } else exec_ok = false; }
    else exec_ok = false;
  }
  results.push({ n: c.n, want: c.want, got: name || '(none)', tool_ok, exec_ok, secs: +secs.toFixed(1) });
  console.log(`  ${tool_ok ? 'OK ' : '✗  '} ${c.n}: got=${name || '(reply)'} exec=${exec_ok} ${secs.toFixed(1)}s`);
}
const acc = results.filter((r) => r.tool_ok).length / results.length;
const execd = results.filter((r) => r.exec_ok !== null);
const execAcc = execd.length ? execd.filter((r) => r.exec_ok).length / execd.length : 0;
const secs = results.map((r) => r.secs).sort((a, b) => a - b);
console.log(`\nFINE-TUNED 8B: tool-acc ${(acc * 100).toFixed(0)}% | exec-valid ${(execAcc * 100).toFixed(0)}% | mean ${(secs.reduce((a, b) => a + b, 0) / secs.length).toFixed(1)}s | p90 ${secs[Math.floor(secs.length * 0.9)]}s`);
console.log(`(baseline 30B, full app: tool-acc 88%, mean 47s)`);
