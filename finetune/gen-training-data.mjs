/**
 * Exec-verified training-data generator for fine-tuning qwen3:8b on this app's
 * scheduling skill. Every example is auto-labeled by RUNNING THE REAL TOOL as
 * the oracle: reset an in-memory DB to a scenario, compute the correct tool
 * args from the actual events, run tool.run(args,'dry'), and keep the example
 * only if it's actionable with no blocking conflict. The prompt captured in each
 * example is the real inference prompt (SYSTEM_PROMPT + buildContext + /no_think
 * + full tool schemas), so training matches serving exactly.
 *
 * Heavily weights fit_in_event (the casual-phrasing spontaneous case the 30B is
 * flaky on) and includes NEGATIVES (ask-to-clarify, plain answers) so the model
 * learns when NOT to fire a tool.
 */
import { resetDbForTests, schema } from '../packages/core/src/db/client.ts';
import { COMPACT_SYSTEM, buildContext } from '../packages/core/src/agent.ts';
import { getTool, modelToolSpecs } from '../packages/core/src/tools/index.ts';
import { isActionable, severityOf } from '../packages/core/src/types.ts';
import { todayInTz, addDaysWall, weekdayCode } from '../packages/core/src/time.ts';

const OUT = process.env.OUT ?? './train.jsonl';
const TOOLS = modelToolSpecs();
const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// Dates: put the scenario on THIS reference week so buildContext's CALENDAR
// block covers it and day-words resolve to real rows.
const TODAY = todayInTz();
function nextDow(code) {
  for (let i = 1; i <= 14; i++) { const d = addDaysWall(TODAY, i); if (weekdayCode(d) === code) return d; }
  return TODAY;
}
const MON = nextDow('MO'), TUE = nextDow('TU'), WED = nextDow('WE'), THU = nextDow('TH'), FRI = nextDow('FR');
const DOW = { MO: MON, TU: TUE, WE: WED, TH: THU, FR: FRI };
const DAYNAME = { MO: 'monday', TU: 'tuesday', WE: 'wednesday', TH: 'thursday', FR: 'friday' };

// Pools for RANDOMISED scenarios — the model must learn to copy ids/days/times
// from the schedule it's shown, not memorise one fixed layout. Every scenario is
// a different, valid week.
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR'];
const CLASS_POOL = [
  ['CS 314', 'GDC 2.216'], ['CS 429', 'GDC 4.302'], ['M 340L', 'RLM 4.102'], ['PHY 303K', 'PAI 3.02'],
  ['CH 301', 'WEL 2.224'], ['HIS 315K', 'GAR 0.102'], ['E 316L', 'PAR 1'], ['GOV 310L', 'JES A121A'],
  ['ECO 304K', 'UTC 2.102A'], ['DATABASE DESIGN', 'GAR 2.112'], ['APPLD MACHINE LEARNING', 'CBA 4.332'],
  ['ELEMENTS OF SOFTWARE DESIGN', 'CAL 100'], ['STA 371G', 'CBA 4.304'], ['M 408D', 'PMA 5.104'],
  ['CS 439', 'GDC 2.210'], ['LINEAR ALGEBRA', 'RLM 5.104'], ['ORGANIC CHEM', 'WEL 3.502'], ['PSY 301', 'SAC 1.402'],
];
const CLASS_SLOTS = [['08:00', '09:00'], ['09:30', '11:00'], ['11:00', '12:30'], ['12:30', '14:00'], ['14:00', '15:30'], ['15:30', '17:00']];
const GYM_TIMES = [['17:00', '18:30'], ['16:00', '17:30'], ['07:00', '08:30'], ['18:00', '19:30'], ['06:30', '08:00']];
const COOK_TIMES = [['18:45', '19:45'], ['17:30', '18:30'], ['19:00', '20:00'], ['18:00', '19:00']];
const WORKOUT_KEYS = ['chest-back', 'shoulders-arms', 'legs'];
const GYM_TITLES = ['Gym', 'Lift', 'Workout'];
const COOK_TITLES = ['Cook lunches', 'Meal prep', 'Cook'];

let idc = 0;
const nid = (p) => `evt-${p}-${idc++}`;
const sortDays = (ds) => [...ds].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
function sample(arr, k) { const a = [...arr], out = []; for (let i = 0; i < k && a.length; i++) out.push(a.splice(Math.floor(Math.random() * a.length), 1)[0]); return out; }

function scenario() {
  const db = resetDbForTests();
  db.insert(schema.semester).values({ id: 's1', name: 'Term', start_date: addDaysWall(TODAY, -30), end_date: addDaysWall(TODAY, 90), timezone: 'America/Chicago' }).run();
  const rr = (days) => `FREQ=WEEKLY;BYDAY=${days};UNTIL=${addDaysWall(TODAY, 90).replaceAll('-', '')}`;
  const rows = [];
  const push = (id, title, kind, day0, s, e, pinned, days, loc, wk) =>
    rows.push({ id, semester_id: 's1', title, kind, starts_at: `${DOW[day0]}T${s}`, ends_at: `${DOW[day0]}T${e}`, pinned, rrule: days ? rr(days) : null, source: 'recurring', location: loc ?? null, notes: null, color: null, workout: wk ?? null });

  // classes: 2-3, distinct names + slots, random day-sets
  const classes = [];
  const names = sample(CLASS_POOL, rint(2, 3));
  const slots = sample(CLASS_SLOTS, names.length);
  names.forEach(([name, room], i) => {
    const days = sortDays(rnd([['MO', 'WE'], ['TU', 'TH'], ['MO', 'WE', 'FR'], ['MO', 'TU', 'WE', 'TH'], ['MO', 'WE']]));
    const [s, e] = slots[i]; const id = nid('cls');
    push(id, name, 'class', days[0], s, e, true, days.join(','), room, null);
    classes.push({ id, name, days, start: s, end: e });
  });

  // gym: 2-4 days, one time window, workouts cycle
  const gymDays = sortDays(sample(WEEKDAYS, rint(2, 4)));
  const [gs, ge] = rnd(GYM_TIMES); const gymTitle = rnd(GYM_TITLES); const gloc = rnd(['Gregory', 'RecSports', null]);
  const gyms = gymDays.map((d, i) => { const id = nid('gym'); const workout = WORKOUT_KEYS[i % 3]; push(id, gymTitle, 'gym', d, gs, ge, false, d, gloc, workout); return { id, day: d, start: gs, end: ge, workout, title: gymTitle }; });

  // cook: 2-3 days, one time
  const cookDays = sortDays(sample(WEEKDAYS, rint(2, 3)));
  const [cs, ce] = rnd(COOK_TIMES); const cookTitle = rnd(COOK_TITLES); const cookId = nid('cook');
  push(cookId, cookTitle, 'cook', cookDays[0], cs, ce, false, cookDays.join(','), null, null);
  const cook = { id: cookId, days: cookDays, start: cs, end: ce, title: cookTitle };

  // advising: present 60% of the time, on a random day
  let advising = null;
  if (Math.random() < 0.6) {
    const d = rnd(WEEKDAYS); const id = nid('adv'); const title = rnd(['Advising appointment', 'Advising', 'Career center meeting']);
    push(id, title, 'personal', d, '11:45', '12:30', false, null, rnd(['GDC 1.302', 'SZB 300', null]), null);
    advising = { id, day: d, title, start: '11:45', end: '12:30' };
  }

  db.insert(schema.event).values(rows).run();
  return { db, gyms, cook, classes, advising };
}

const bothDays = (scn) => scn.gyms.map((g) => g.day).filter((d) => scn.cook.days.includes(d));


const examples = [];
let rejected = 0;

/** Verify by running the real tool, then emit an assistant-tool_call example. */
function emitToolCall(db, request, tool, args) {
  const t = getTool(tool);
  if (!t) { rejected++; return; }
  const parsed = t.argsSchema.safeParse(args);
  if (!parsed.success) { rejected++; return; }
  let res;
  try { res = t.run(parsed.data, 'dry'); } catch { rejected++; return; }
  res = res && typeof res.then === 'function' ? undefined : res; // run is async for some
  // fall through to async caller
  return { request, tool, args: parsed.data };
}

async function verifyAndPush(db, request, tool, args) {
  const t = getTool(tool);
  if (!t) { rejected++; return; }
  const parsed = t.argsSchema.safeParse(args);
  if (!parsed.success) { rejected++; return; }
  let diff, conflicts;
  try { const r = await t.run(parsed.data, 'dry'); diff = r.diff; conflicts = r.conflicts; }
  catch { rejected++; return; }
  if (!isActionable(diff) || conflicts.some((c) => severityOf(c) === 'blocking')) { rejected++; return; }
  const sys = COMPACT_SYSTEM + '\n\n' + buildContext(db) + '\n\n/no_think';
  // Assistant turn is the LITERAL qwen3 tool-call string, not a tool_calls field.
  // Training on the exact text the model must emit sidesteps every chat-template
  // rendering quirk (which /no_think + no-tools broke); the app parses it back
  // with a regex. Empty <think></think> because /no_think.
  const content = `<think>\n\n</think>\n\n<tool_call>\n${JSON.stringify({ name: tool, arguments: parsed.data })}\n</tool_call>`;
  examples.push({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: request },
      { role: 'assistant', content },
    ],
  });
}

function pushNegative(db, request, reply) {
  const sys = COMPACT_SYSTEM + '\n\n' + buildContext(db) + '\n\n/no_think';
  const content = `<think>\n\n</think>\n\n${reply}`;
  examples.push({ messages: [{ role: 'system', content: sys }, { role: 'user', content: request }, { role: 'assistant', content }] });
}

// ---- fit_in_event: the priority. Many casual phrasings, no conflict + conflict.
const FIT_TITLES = ['friends', 'my friends', 'some friends', 'a friend', 'my roommate', 'people'];
const FIT_THINGS = [['dinner', 'Dinner'], ['a date', 'Date'], ['a call', 'Call'], ['a study group', 'Study group'], ['drinks', 'Drinks'], ['a meeting', 'Meeting']];
const eve = (h) => `${String(h).padStart(2, '0')}:00`;
async function genFit() {
  const N = 300;
  for (let i = 0; i < N; i++) {
    const scn = scenario();
    const day = rnd(WEEKDAYS);
    const date = DOW[day];
    const h = rint(17, 21); // 5-9pm
    const dur = rnd([60, 90, 120]);
    let request, title;
    if (rnd(['friends', 'thing']) === 'friends') {
      const who = rnd(FIT_TITLES);
      title = 'Friends over';
      request = rnd([
        `hey i have ${who} coming over at ${h - 12}`,
        `${who} are coming over at ${h - 12} tonight`,
        `${who} coming over ${DAYNAME[day]} at ${h - 12}`,
        `i've got ${who} over at ${h - 12} for a bit`,
        `${who} over ${DAYNAME[day]} ${h - 12}pm`,
      ]);
    } else {
      const [w, t] = rnd(FIT_THINGS);
      title = t;
      request = rnd([`i have ${w} at ${h - 12} ${DAYNAME[day]}`, `${w} at ${h - 12} tonight`, `got ${w} ${DAYNAME[day]} at ${h - 12}`, `there's ${w} at ${h - 12}, block it off`]);
    }
    await verifyAndPush(scn.db, request, 'fit_in_event', { title, kind: 'personal', date, start_time: eve(h), duration_minutes: dur });
  }
}

// ---- cancel_event — target a gym day or the advising, using THIS scenario's ids
async function genCancel() {
  for (let i = 0; i < 90; i++) {
    const scn = scenario();
    if (scn.advising && Math.random() < 0.4) {
      const a = scn.advising;
      await verifyAndPush(scn.db, rnd([`delete my ${a.title.toLowerCase()}`, `cancel my ${a.title.toLowerCase()}`, `get rid of the ${a.title.toLowerCase()}`, `remove my ${a.title.toLowerCase()}`]), 'cancel_event', { event_id: a.id, expect_title: a.title, date: DOW[a.day] });
    } else {
      const g = rnd(scn.gyms);
      await verifyAndPush(scn.db, rnd([`cancel ${DAYNAME[g.day]}'s ${g.title.toLowerCase()}`, `delete my ${g.title.toLowerCase()} on ${DAYNAME[g.day]}`, `skip the ${g.title.toLowerCase()} ${DAYNAME[g.day]}`, `no ${g.title.toLowerCase()} ${DAYNAME[g.day]} this week`]), 'cancel_event', { event_id: g.id, expect_title: g.title, date: DOW[g.day] });
    }
  }
}

// ---- place_adjacent — only on a day that actually has BOTH gym and cook
async function genAdjacent() {
  let made = 0;
  for (let i = 0; i < 200 && made < 70; i++) {
    const scn = scenario();
    const days = bothDays(scn);
    if (!days.length) continue;
    const day = rnd(days);
    const g = scn.gyms.find((x) => x.day === day);
    if (Math.random() < 0.5)
      await verifyAndPush(scn.db, rnd([`${DAYNAME[day]} i want to cook before the gym`, `on ${DAYNAME[day]} make it so i cook before i gym`, `cook before gym ${DAYNAME[day]}`]), 'place_adjacent', { event_id: scn.cook.id, expect_title: scn.cook.title, date: DOW[day], anchor_title: g.title, position: 'before', gap_minutes: 0 });
    else
      await verifyAndPush(scn.db, rnd([`put my ${DAYNAME[day]} ${g.title.toLowerCase()} right after i cook`, `${g.title.toLowerCase()} straight after cooking ${DAYNAME[day]}, no break`]), 'place_adjacent', { event_id: g.id, expect_title: g.title, date: DOW[day], anchor_title: scn.cook.title, position: 'after', gap_minutes: 0 });
    made++;
  }
}

// ---- set_recurring_days — reshape the gym cluster to a new weekday set
async function genRecurringDays() {
  for (let i = 0; i < 50; i++) {
    const scn = scenario();
    const g = scn.gyms[0];
    const set = sortDays(sample(WEEKDAYS, rint(2, 3)));
    const words = set.map((d) => DAYNAME[d]).join(' and ');
    await verifyAndPush(scn.db, rnd([`change my ${g.title.toLowerCase()} to only ${words}`, `${g.title.toLowerCase()} only on ${words} from now`, `i only want ${g.title.toLowerCase()} ${words}`]), 'set_recurring_days', { event_id: g.id, expect_title: g.title, days: set });
  }
}

// ---- create_event (recurring gym + flexible study block)
async function genCreate() {
  for (let i = 0; i < 80; i++) {
    const scn = scenario();
    if (Math.random() < 0.5) {
      const dur = rnd([60, 90, 120]);
      const day = rnd(WEEKDAYS);
      await verifyAndPush(scn.db, rnd([`block ${dur === 60 ? 'an hour' : dur / 60 + ' hours'} to study ${DAYNAME[day]} evening`, `save ${dur} minutes ${DAYNAME[day]} night to read`, `reserve ${dur / 60} hours ${DAYNAME[day]} to study`]), 'create_event', { title: 'Study', kind: 'personal', date: DOW[day], start_time: '20:00', duration_minutes: dur });
    } else {
      const day = rnd(WEEKDAYS);
      const wk = rnd(['Legs', 'Chest and back', 'Shoulder and arms']);
      await verifyAndPush(scn.db, rnd([`add a gym session ${DAYNAME[day]} 5 to 6:30, it's a ${wk.toLowerCase()} day`, `put gym on ${DAYNAME[day]} 5pm, ${wk.toLowerCase()}`]), 'create_event', { title: 'Gym', kind: 'gym', date: DOW[day], start_time: '17:00', duration_minutes: 90, workout: wk, repeat: { frequency: 'weekly', days: [day] } });
    }
  }
}

// ---- set_workout / edit_workout / shift / set_preference
const WK_NAME_TO_KEY = { 'chest and back': 'chest-back', 'shoulder and arms': 'shoulders-arms', legs: 'legs' };
async function genMisc() {
  // set_workout — relabel a gym session's split day, using this scenario's gym +
  // a workout name DIFFERENT from its current one (else it's a no-op).
  for (let i = 0; i < 70; i++) {
    const scn = scenario();
    const g = rnd(scn.gyms);
    const wk = rnd(['Legs', 'Chest and back', 'Shoulder and arms'].filter((n) => WK_NAME_TO_KEY[n.toLowerCase()] !== g.workout));
    const wl = wk.toLowerCase();
    await verifyAndPush(scn.db, rnd([
      `make ${DAYNAME[g.day]}'s ${g.title.toLowerCase()} a ${wl} day`,
      `make ${DAYNAME[g.day]}'s ${g.title.toLowerCase()} ${wl} instead`,
      `${DAYNAME[g.day]}'s ${g.title.toLowerCase()} should be ${wl}`,
      `switch ${DAYNAME[g.day]} to ${wl}`,
      `relabel ${DAYNAME[g.day]} ${g.title.toLowerCase()} as ${wl}`,
    ]), 'set_workout', { event_id: g.id, expect_title: g.title, workout: wk });
  }
  // edit_workout — edits the SPLIT definition (fixed day names, scenario-agnostic).
  const LIFTS = [['Romanian deadlift', '225*8*6'], ['Leg press', '400*10*8'], ['Bench press', '135*8*5'], ['Lat pulldown', '120*10'], ['Hack squat', '180*10*8'], ['Db shoulder press', '90*9*7'], ['Bulgarian split squat', '50*10']];
  const SPLITDAY = ['Legs', 'Chest and back', 'Shoulder and arms'];
  for (let i = 0; i < 55; i++) {
    const scn = scenario();
    const [lift, load] = rnd(LIFTS);
    const day = rnd(SPLITDAY);
    const spoken = load.replaceAll('*', 'x');
    await verifyAndPush(scn.db, rnd([
      `add ${lift.toLowerCase()} ${spoken} to my ${day.toLowerCase()} day`,
      `put ${lift.toLowerCase()} ${spoken} on ${day.toLowerCase()}`,
      `add ${lift.toLowerCase()} to ${day.toLowerCase()}, ${spoken}`,
      `${day.toLowerCase()} day: add ${lift.toLowerCase()} at ${spoken}`,
    ]), 'edit_workout', { action: 'set_exercise', day, exercise: lift, load });
  }
  // shift_events — a day that actually has movable blocks in this scenario.
  for (let i = 0; i < 55; i++) {
    const scn = scenario();
    const dayPool = [...new Set([...scn.gyms.map((g) => g.day), ...scn.cook.days])];
    const day = rnd(dayPool);
    const delta = rnd([30, 60, -30, 45, -60, 15]);
    const mag = Math.abs(delta), dir = delta < 0 ? 'earlier' : 'later';
    await verifyAndPush(scn.db, rnd([
      `push everything ${DAYNAME[day]} ${mag} minutes ${dir}`,
      `move ${DAYNAME[day]} ${dir === 'later' ? 'back' : 'up'} ${mag} min`,
      `shift my whole ${DAYNAME[day]} ${mag} min ${dir}`,
      `everything ${DAYNAME[day]} ${mag} minutes ${dir} please`,
    ]), 'shift_events', { scope: 'day', date: DOW[day], delta_minutes: delta });
  }
  // set_preference — standing rules (scenario-agnostic).
  for (let i = 0; i < 70; i++) {
    const scn = scenario(); const db = scn.db;
    const r = Math.random();
    if (r < 0.34) await verifyAndPush(db, rnd([
      'from now on i always cook before i gym', 'i like to cook before the gym, always', 'rule: cook before gym', 'i prefer cooking then gym', 'always put cooking before my workout',
    ]), 'set_preference', { type: 'order', before: 'cook', after: 'gym' });
    else if (r < 0.67) await verifyAndPush(db, rnd([
      'gym is a 5 to 8pm thing for me', 'i prefer to work out between 5 and 8', 'always gym in the evening, 5-8', 'from now on gym should be 5-8pm',
    ]), 'set_preference', { type: 'window', kind: 'gym', windows: ['17:00-20:00'] });
    else await verifyAndPush(db, rnd([
      'i like to cook in the evening, 6 to 9', 'always cook between 6 and 9pm', 'cooking is a 6-9pm thing',
    ]), 'set_preference', { type: 'window', kind: 'cook', windows: ['18:00-21:00'] });
  }
}

// ---- add_classes
async function genClasses() {
  const NAMES = [['CHEM 301', 'WEL 2.224'], ['HIST 315', 'GAR 0.102'], ['LINEAR ALGEBRA', 'RLM 5.104'], ['PHYSICS 105', 'PAI 3.02'], ['ECO 304K', 'UTC 2.102A'], ['GOV 310L', 'JES A121']];
  for (let i = 0; i < 50; i++) {
    const scn = scenario();
    const [name, room] = rnd(NAMES);
    const days = rnd([['MO', 'WE', 'FR'], ['TU', 'TH'], ['MO', 'WE']]);
    const words = days.map((d) => DAYNAME[d].slice(0, 3)).join('/');
    await verifyAndPush(scn.db, rnd([`add my class ${name}, ${words} 9 to 10am in ${room}`, `i have ${name} ${words} 9-10 in ${room}`]), 'add_classes', { classes: [{ title: name, days, start_time: '09:00', end_time: '10:00', location: room }] });
  }
}

// ---- NEGATIVES: ambiguous / conversational → NO tool. Replies reference THIS
// scenario's real gym days, and only fire when they're genuinely ambiguous/absent.
function genNegatives() {
  for (let i = 0; i < 130; i++) {
    const scn = scenario();
    const r = Math.random();
    const gymDayNames = scn.gyms.map((g) => DAYNAME[g.day]);
    const t = scn.gyms[0].title.toLowerCase();
    const noGymDay = WEEKDAYS.find((d) => !scn.gyms.some((g) => g.day === d));
    if (r < 0.45 && scn.gyms.length >= 2) {
      const list = gymDayNames.slice(0, -1).map((d) => d[0].toUpperCase() + d.slice(1)).join(', ') + ' and ' + (gymDayNames.at(-1)[0].toUpperCase() + gymDayNames.at(-1).slice(1));
      pushNegative(scn.db, rnd([`delete my ${t}`, `cancel ${t}`, `get rid of my ${t} sessions`, `remove my ${t}`, `scrap the ${t}`, `no more ${t}`]), `You've got ${t} on ${list} — which one do you want to cancel? (Or say 'all of them' to drop it entirely.)`);
    } else if (r < 0.7 && noGymDay) {
      pushNegative(scn.db, rnd([`on ${DAYNAME[noGymDay]} make me cook before the gym`, `${DAYNAME[noGymDay]} cook then gym`, `put gym after cooking on ${DAYNAME[noGymDay]}`]), `You don't have a gym session on ${DAYNAME[noGymDay][0].toUpperCase() + DAYNAME[noGymDay].slice(1)}. Want me to add one, or did you mean a different day?`);
    } else {
      pushNegative(scn.db, rnd(['thanks!', 'cool', 'how does this work?', 'what can you do?', 'nice', 'ok']), "I manage your calendar — tell me things like 'friends over at 8', 'cancel Monday's gym', or 'I like to cook before I gym', and I'll handle it.");
    }
  }
}

await genFit();
await genCancel();
await genAdjacent();
await genRecurringDays();
await genCreate();
await genMisc();
await genClasses();
genNegatives();

// shuffle
for (let i = examples.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[examples[i], examples[j]] = [examples[j], examples[i]]; }
const SPLIT = Math.floor(examples.length * 0.9);
const toJsonl = (arr) => arr.map((e) => JSON.stringify(e)).join('\n') + '\n';
await Bun.write('./data/train.jsonl', toJsonl(examples.slice(0, SPLIT)));
await Bun.write('./data/valid.jsonl', toJsonl(examples.slice(SPLIT)));

const byTool = {};
for (const e of examples) { const c = e.messages[2].content; const m = c.match(/<tool_call>\s*{"name":"([^"]+)"/); const k = m ? m[1] : '(no-tool/negative)'; byTool[k] = (byTool[k] ?? 0) + 1; }
console.log(`generated ${examples.length} verified examples (${rejected} rejected by the oracle)`);
console.log('by tool:', JSON.stringify(byTool, null, 2));
