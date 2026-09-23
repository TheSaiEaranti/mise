/**
 * `bun run seed:demo` — a realistic, entirely fake Fall semester for demos and
 * recordings (scripts/lib/demo-fixture.ts), built around today so the demo
 * script in DEMO.md works whatever day it's run.
 *
 * Writes to data/demo.db by default — NOT your real data/mise.db. Run the app
 * against it with `bun run dev:demo`. Set MISE_DB_PATH to seed elsewhere.
 * Idempotent: wipes the calendar, chat, proposal log (so Cmd-Z starts clean),
 * reminders and saved preferences, then re-seeds. Internship data is untouched.
 */
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
process.env.MISE_DB_PATH ??= join(root, 'data', 'demo.db');

const { getDb, schema } = await import('../packages/core/src/db/client');
const { todayInTz } = await import('../packages/core/src/time');
const { seedDemoSemester } = await import('./lib/demo-fixture');

if (process.env.MISE_DB_PATH.endsWith('mise.db') && !process.argv.includes('--yes-wipe-mise-db')) {
  console.error(`Refusing to wipe ${process.env.MISE_DB_PATH} — that looks like your real calendar. Pass --yes-wipe-mise-db if you mean it.`);
  process.exit(1);
}

const db = getDb();
for (const t of [
  schema.eventException,
  schema.cookAssignment,
  schema.mealSuite,
  schema.meal,
  schema.proposal,
  schema.chatMessage,
  schema.reminder,
  schema.preferences,
  schema.event,
  schema.semester,
]) {
  db.delete(t).run();
}

const fx = seedDemoSemester(db, todayInTz());
const n = db.select().from(schema.event).all().length;
console.log(`Seeded the demo semester into ${process.env.MISE_DB_PATH}`);
console.log(`  ${fx.semester.start} → ${fx.semester.end}, ${n} events, today = ${fx.today}`);
console.log('  Run the app on it:  bun run dev:demo');
