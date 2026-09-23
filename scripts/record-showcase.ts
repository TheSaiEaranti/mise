/**
 * Record the showcase video: the storyline in scripts/lib/showcase-story.ts,
 * narrated on screen. Before every Enter the cursor visits each block that
 * matters, with a highlight ring and a label; after it, a badge shows the
 * turn's REAL latency and route, read from the API's own trace
 * (GET /api/dev/turns). Title and end cards bracket it. The overlay is
 * injected by Playwright — nothing in the app changes.
 *
 * Needs: the API with the dev surface on (any non-production run) and the
 * clock frozen to match the story, the web app on :3000:
 *   MISE_NOW=2026-09-23T10:00 MISE_DB_PATH=<db> bun run scripts/seed-demo.ts
 *   MISE_NOW=2026-09-23T10:00 MISE_DB_PATH=<db> bun apps/api/src/index.ts
 *   bun run demo:web
 *   bun run scripts/record-showcase.ts --out showcase.webm
 */
import { mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1]! : d;
};
const OUT = resolve(opt('--out', 'showcase.webm'));
const FRAMES = resolve(opt('--frames', join(dirname(OUT), 'showcase-frames')));
const WEB = opt('--url', 'http://localhost:3000/');
const API = opt('--api', 'http://localhost:3001');
const NOW = new Date('2026-09-23T10:00:00-05:00'); // Wed 10 AM, America/Chicago — must match the API's MISE_NOW
const W = 1920;
const H = 1080;

const TODAY = '2026-09-23';
const TOMORROW = '2026-09-24';
const FRIDAY = '2026-09-25';

// ---------------------------------------------------------------------------
// The on-screen layer: cursor, highlight ring + label, caption, badge, cards.
// ---------------------------------------------------------------------------
const OVERLAY = String.raw`
addEventListener('DOMContentLoaded', () => {
  const css = document.createElement('style');
  css.textContent = ` + '`' + String.raw`
    #__cur { position: fixed; left: 0; top: 0; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%;
      background: rgba(22,24,29,.8); box-shadow: 0 0 0 3px rgba(255,255,255,.95), 0 2px 10px rgba(0,0,0,.3);
      z-index: 2147483647; pointer-events: none; transform: translate(-200px,-200px); transition: scale 120ms ease; }
    #__ring { position: fixed; z-index: 2147483646; pointer-events: none; border: 3px solid #c2410c; border-radius: 10px;
      box-shadow: 0 0 0 6px rgba(194,65,12,.18), 0 8px 30px rgba(194,65,12,.25); opacity: 0;
      transition: left 280ms cubic-bezier(.32,.72,0,1), top 280ms cubic-bezier(.32,.72,0,1), width 280ms cubic-bezier(.32,.72,0,1),
                  height 280ms cubic-bezier(.32,.72,0,1), opacity 200ms ease; }
    #__label { position: fixed; z-index: 2147483646; pointer-events: none; opacity: 0; transition: opacity 200ms ease, left 280ms, top 280ms;
      background: #16181d; color: #fff; font: 600 17px/1.3 'Inter Tight', system-ui, sans-serif; padding: 9px 14px; border-radius: 9px;
      box-shadow: 0 8px 28px rgba(0,0,0,.25); max-width: 420px; }
    #__label .sub { display: block; font-weight: 450; font-size: 14px; color: #c9ccd3; margin-top: 2px; }
    #__cap { position: fixed; z-index: 2147483645; pointer-events: none; left: 760px; top: 20px; transform: translate(-50%, -8px); opacity: 0;
      transition: opacity 300ms ease, transform 300ms cubic-bezier(.32,.72,0,1);
      background: rgba(22,24,29,.94); color: #fff; font: 600 21px/1.25 'Inter Tight', system-ui, sans-serif; padding: 12px 20px 12px 14px;
      border-radius: 12px; display: flex; align-items: center; gap: 12px; white-space: nowrap; box-shadow: 0 10px 34px rgba(0,0,0,.22); }
    #__cap.on { opacity: 1; transform: translate(-50%, 0); }
    #__cap .n { background: #c2410c; color: #fff; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-size: 16px; }
    #__badge { position: fixed; z-index: 2147483645; pointer-events: none; left: 760px; top: 84px; transform: translate(-50%, -6px); opacity: 0;
      transition: opacity 260ms ease, transform 260ms cubic-bezier(.32,.72,0,1);
      background: #ecfdf3; color: #065f46; border: 1.5px solid #6ee7b7; font: 600 17px/1.2 'IBM Plex Mono', ui-monospace, monospace;
      padding: 8px 14px; border-radius: 999px; white-space: nowrap; }
    #__badge.on { opacity: 1; transform: translate(-50%, 0); }
    #__card { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; background: #0f1115; color: #fff;
      opacity: 0; pointer-events: none; transition: opacity 500ms ease; font-family: 'Inter Tight', system-ui, sans-serif; }
    #__card.on { opacity: 1; }
    #__card .t { font-size: 84px; font-weight: 700; letter-spacing: -2px; }
    #__card .s { font-size: 28px; color: #c9ccd3; margin-top: 10px; text-align: center; }
    #__card .row { display: flex; gap: 22px; margin-top: 44px; justify-content: center; flex-wrap: wrap; }
    #__card .k { background: #1b1e25; border: 1px solid #2a2e37; border-radius: 16px; padding: 20px 26px; min-width: 250px; text-align: center; }
    #__card .k b { display: block; font-size: 40px; font-weight: 700; color: #fff; }
    #__card .k span { display: block; font-size: 17px; color: #9aa0ab; margin-top: 6px; }
    #__card .f { margin-top: 42px; font-size: 22px; color: #e4e6ea; text-align: center; }
    #__card .m { margin-top: 12px; font-size: 16px; color: #7c828d; text-align: center; }
  ` + '`' + String.raw`;
  document.head.appendChild(css);
  const mk = (id) => { const d = document.createElement('div'); d.id = id; document.body.appendChild(d); return d; };
  const cur = mk('__cur'), ring = mk('__ring'), label = mk('__label'), cap = mk('__cap'), badge = mk('__badge'), card = mk('__card');
  addEventListener('mousemove', (e) => { cur.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; }, true);
  addEventListener('mousedown', () => { cur.style.scale = '0.75'; }, true);
  addEventListener('mouseup', () => { cur.style.scale = '1'; }, true);
  window.__demo = {
    ring(b, text, sub, side) {
      const pad = 6;
      Object.assign(ring.style, { left: (b.x - pad) + 'px', top: (b.y - pad) + 'px', width: (b.width + pad * 2) + 'px', height: (b.height + pad * 2) + 'px', opacity: 1 });
      label.innerHTML = text + (sub ? '<span class="sub">' + sub + '</span>' : '');
      label.style.opacity = 1;
      const lw = label.offsetWidth, lh = label.offsetHeight;
      let lx = side === 'left' ? b.x - lw - 18 : b.x + b.width + 18;
      if (lx + lw > 1500) lx = b.x - lw - 18;
      if (lx < 60) lx = b.x;
      let ly = b.y + b.height / 2 - lh / 2;
      if (lx === b.x) ly = b.y + b.height + 14;
      label.style.left = lx + 'px'; label.style.top = Math.max(8, ly) + 'px';
    },
    clear() { ring.style.opacity = 0; label.style.opacity = 0; },
    caption(n, text) { cap.innerHTML = '<span class="n">' + n + '</span>' + text; cap.classList.add('on'); badge.classList.remove('on'); },
    badge(text) { badge.textContent = text; badge.classList.add('on'); },
    hideBadge() { badge.classList.remove('on'); },
    card(html) { card.innerHTML = html; card.classList.add('on'); },
    hideCard() { card.classList.remove('on'); },
  };
});
`;

// ---------------------------------------------------------------------------
// Directing helpers
// ---------------------------------------------------------------------------
const pause = (page: Page, ms: number) => page.waitForTimeout(ms);
const block = (title: string, date: string, time?: string) =>
  time ? `[data-flip-key^="${title}"][data-flip-key$="|${date}T${time}"]` : `[data-flip-key^="${title}"][data-flip-key*="|${date}T"]`;
const INPUT = 'input[aria-label="Ask Mise"]:visible';

async function glideTo(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<void> {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
}

/** Move to an element, ring it, label it, hold. Returns its box (for "it was here"). */
async function point(page: Page, selector: string, text: string, sub = '', hold = 2600, side?: 'left') {
  const el = page.locator(selector).first();
  await el.waitFor({ state: 'visible', timeout: 10_000 });
  const box = (await el.boundingBox())!;
  await glideTo(page, box);
  await page.evaluate(([b, t, s, sd]) => (window as any).__demo.ring(b, t, s, sd), [box, text, sub, side] as const);
  await pause(page, hold);
  return box;
}

/** Ring a remembered spot (a block that is gone now). */
async function pointAt(page: Page, box: { x: number; y: number; width: number; height: number }, text: string, sub = '', hold = 2600) {
  await glideTo(page, box);
  await page.evaluate(([b, t, s]) => (window as any).__demo.ring(b, t, s), [box, text, sub] as const);
  await pause(page, hold);
}

const clear = (page: Page) => page.evaluate(() => (window as any).__demo.clear());
const caption = (page: Page, n: string, text: string) => page.evaluate(([a, b]) => (window as any).__demo.caption(a, b), [n, text] as const);

async function typeCommand(page: Page, text: string): Promise<void> {
  const input = page.locator(INPUT).first();
  await glideTo(page, (await input.boundingBox())!);
  await input.click();
  await input.pressSequentially(text, { delay: 62 });
  await pause(page, 500);
}

function prettyModel(m: string | null | undefined): string {
  if (!m) return 'the model';
  if (/haiku-4-5/.test(m)) return 'Claude Haiku 4.5';
  if (/sonnet-5/.test(m)) return 'Claude Sonnet 5';
  return m;
}

/** Press Enter, wait for the answer, and show what the turn actually cost. */
async function send(page: Page): Promise<void> {
  await clear(page);
  const input = page.locator(INPUT).first();
  await glideTo(page, (await input.boundingBox())!);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (sel) => {
      const el = [...document.querySelectorAll<HTMLInputElement>(sel.replace(':visible', ''))].find((e) => e.offsetParent !== null);
      return el !== undefined && !el.disabled;
    },
    INPUT,
    { timeout: 30_000 },
  );
  const { turns } = (await (await fetch(`${API}/api/dev/turns?limit=1`)).json()) as { turns: any[] };
  const t = turns[0];
  const ms: number = t.total_ms;
  const time = ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
  const rounds = (t.rounds as any[]).filter((r) => r.meta.purpose !== 'route');
  const how = t.route?.source === 'fast_path' ? 'no model call · deterministic parser' : `${prettyModel(rounds[0]?.meta.model)} · ${rounds.length} model round${rounds.length === 1 ? '' : 's'}`;
  const tail = t.outcome.applied > 0 ? ' · validated ✓ committed' : t.outcome.proposals > 0 ? ' · waiting for your approval' : '';
  await page.evaluate((b) => (window as any).__demo.badge(b), `⚡ ${time} · ${how}${tail}`);
  await pause(page, 1600);
}

async function still(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(FRAMES, `${name}.png`) });
}

// ---------------------------------------------------------------------------
// The film
// ---------------------------------------------------------------------------
mkdirSync(FRAMES, { recursive: true });
const videoDir = join(dirname(OUT), '.showcase-video-tmp');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  timezoneId: 'America/Chicago',
  recordVideo: { dir: videoDir, size: { width: W, height: H } },
});
await context.addInitScript(OVERLAY);
const page = await context.newPage();
await page.clock.setFixedTime(NOW);
const t0 = Date.now();

await page.goto(WEB, { waitUntil: 'networkidle' });
await page.evaluate(() =>
  (window as any).__demo.card(
    `<div><div class="t">Mise</div><div class="s">A calendar you talk to. Claude proposes — a deterministic validator decides.</div>
     <div class="row"><div class="k"><b>1.3 s</b><span>median command (was 10.4 s)</span></div>
     <div class="k"><b>100%</b><span>eval accuracy (was 90.9%)</span></div>
     <div class="k"><b>0</b><span>writes the model makes itself</span></div></div></div>`,
  ),
);
await pause(page, 4200);
await page.evaluate(() => (window as any).__demo.hideCard());
await page.mouse.move(W * 0.4, H * 0.5, { steps: 20 });
await pause(page, 1400);

// ① A plan — the calendar makes room -----------------------------------------
await caption(page, '1', 'Tell it a plan in plain English — the calendar makes room');
await pause(page, 1200);
await typeCommand(page, 'friends are coming over at 5 tonight for two hours');
await point(page, block('Gym', TODAY, '17:00'), 'Tonight: Gym 5 – 6:30 PM', 'right where the friends are coming', 2800);
await point(page, block('SDS 322E', TODAY), 'Pinned class', 'classes are anchors — nothing may move them', 2200);
await send(page);
await point(page, block('Friends', TODAY), 'New: Friends over 5 – 7 PM', 'one sentence → a tool call → a dry-run → committed', 2800);
await point(page, block('Gym', TODAY, '19:00'), 'Gym moved to 7 PM — "to make room"', 'the reflow engine did that, not the model', 3000);
await still(page, '1-plan');
await clear(page);

// ② Pinned classes never move ------------------------------------------------
await caption(page, '2', 'A bulk edit — pinned classes must not move');
await pause(page, 1000);
await typeCommand(page, 'shift everything after 3pm tomorrow back an hour');
await point(page, block('ECO 304K', TOMORROW), 'ECO 304K · 3:30 PM · PINNED', 'after 3 PM — but a class can never move', 3000);
await point(page, block('Gym', TOMORROW, '18:00'), 'Gym 6 PM', '"back" = an hour earlier', 1900);
await point(page, block('Study group', TOMORROW, '20:00'), 'Study group 8 PM', 'should move an hour earlier', 1900);
await send(page);
await point(page, block('ECO 304K', TOMORROW), 'Still 3:30 PM ✓', 'the validator refuses any change that moves a pinned event', 3000);
await point(page, block('Gym', TOMORROW, '17:00'), 'Gym now 5 PM', 'an hour earlier — right as the class ends', 1900);
await point(page, block('Study group', TOMORROW, '19:00'), 'Study group now 7 PM', '', 1500);
await still(page, '2-pinned');
await clear(page);

// ③ Every week of the semester -------------------------------------------------
await caption(page, '3', 'Change every week of the semester in one sentence');
await pause(page, 1000);
await typeCommand(page, 'no gym on Fridays');
const fridayGym = await point(page, block('Gym', FRIDAY, '16:30'), 'Friday gym', 'a weekly series — every Friday until December', 2600);
await send(page);
await pointAt(page, fridayGym, 'Gone this Friday…', '', 2000);
await clear(page);
await glideTo(page, (await page.locator('[aria-label="Next week"]').boundingBox())!);
await page.locator('[aria-label="Next week"]').click();
await pause(page, 900);
await pointAt(page, fridayGym, '…and next Friday, and every one after', 'one set_recurring_days call reshaped the whole series', 3000);
await still(page, '3-every-friday');
await clear(page);
await glideTo(page, (await page.locator('[aria-label="Previous week"]').boundingBox())!);
await page.locator('[aria-label="Previous week"]').click();
await pause(page, 900);

// ④ Every block at once ----------------------------------------------------------
await caption(page, '4', 'Edit every block of a kind at once');
await pause(page, 1000);
await typeCommand(page, 'make my gym sessions 2 hours long');
await point(page, block('Gym', TODAY, '19:00'), 'Gym · 90 min', '', 1800);
await send(page);
await point(page, block('Gym', TODAY, '19:00'), '2 hours', 'and every other gym block, every week', 2400);
await point(page, block('Gym', TOMORROW, '17:00'), '2 hours', '', 1600);
await clear(page);

// ⑤ A cancel asks first -------------------------------------------------------
await caption(page, '5', 'Deleting something always asks first');
await pause(page, 1000);
await typeCommand(page, 'cancel my advising appointment');
const advising = await point(page, block('Advising', FRIDAY), 'Advising appointment · Fri 1 PM', '', 2200);
await send(page);
await point(page, 'button:has-text("Approve")', 'Nothing is deleted until you approve', 'reversible edits just happen; a cancel asks', 3000, 'left');
await still(page, '5-cancel-asks');
await page.locator('button:has-text("Approve")').first().click();
await pause(page, 1200);
await pointAt(page, advising, 'Cancelled', '', 1800);
await clear(page);

// ⑥ Undo ----------------------------------------------------------------------------
await caption(page, '6', 'Every change is one keystroke from undone');
await page.evaluate(() => (window as any).__demo.hideBadge());
await page.mouse.move(W * 0.42, 160, { steps: 22 });
await page.mouse.click(W * 0.42, 160);
await pause(page, 700);
await page.keyboard.press('Meta+z');
await pause(page, 900);
await point(page, block('Advising', FRIDAY), 'Back ✓', 'Cmd-Z', 2600);
await still(page, '6-undo');
await clear(page);
await pause(page, 800);

// End card -----------------------------------------------------------------------
await page.evaluate(() =>
  (window as any).__demo.card(
    `<div><div class="t" style="font-size:56px">Measured, not guessed</div>
     <div class="row"><div class="k"><b>10.4 s → 1.3 s</b><span>median latency</span></div>
     <div class="k"><b>18.8 s → 1.9 s</b><span>p90 latency</span></div>
     <div class="k"><b>90.9% → 100%</b><span>tool + outcome accuracy</span></div>
     <div class="k"><b>45× fewer</b><span>input tokens per command</span></div></div>
     <div class="f">Direct API · intent routing · prompt caching · early exit · deterministic fast path</div>
     <div class="m">22 realistic commands × 2, before vs after · the model proposes, the validator decides, every change is undoable</div></div>`,
  ),
);
await pause(page, 6500);

const seconds = (Date.now() - t0) / 1000;
const video = page.video();
await context.close();
await browser.close();
renameSync(await video!.path(), OUT);
console.log(`recorded ${seconds.toFixed(1)}s → ${OUT}`);
console.log(`stills → ${FRAMES}`);
