/**
 * The Mise API (SPEC §1–2): Bun + Hono. Tailscale is the auth boundary — CORS
 * is deliberately wide open and there is NO auth code anywhere in this app.
 * Tests hit `app.request()` directly; src/index.ts serves it.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { healthRoute } from './routes/health';
import { scheduleRoute } from './routes/schedule';
import { semesterRoute } from './routes/semester';
import { chatRoute } from './routes/chat';
import { proposalsRoute } from './routes/proposals';
import { mealsRoute } from './routes/meals';
import { remindersRoute } from './routes/reminders';
import { internshipsRoute } from './routes/internships';
import { settingsRoute } from './routes/settings';
import { eventsRoute } from './routes/events';
import { scheduleImportRoute } from './routes/schedule-import';
import { devRoute } from './routes/dev';
import { requestTiming } from './lib/dev-timing';

export const app = new Hono();

app.use('*', cors()); // any origin — tailnet only (SPEC §1)
app.use('/api/*', requestTiming); // dev latency panel; records, never alters

app.onError((err, c) => {
  console.error('[api]', err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.route('/health', healthRoute);
app.route('/api/schedule', scheduleRoute);
app.route('/api/semester', semesterRoute);
app.route('/api/chat', chatRoute);
app.route('/api/proposals', proposalsRoute);
app.route('/api/meals', mealsRoute);
app.route('/api/reminders', remindersRoute);
app.route('/api/internships', internshipsRoute);
app.route('/api/settings', settingsRoute);
app.route('/api/events', eventsRoute);
app.route('/api/schedule-import', scheduleImportRoute);
app.route('/api/dev', devRoute);
