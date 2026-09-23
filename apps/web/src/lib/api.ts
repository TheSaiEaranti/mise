/**
 * Typed client for the Mise API (apps/api, Hono on :3001).
 *
 * Every function maps 1:1 to a route. All JSON. Non-2xx responses throw
 * `Error(body.error)` — except approveProposal, whose 409 is a typed result
 * (`needs_review` / `blocked` / `expired`), because a 409 there is a normal
 * outcome of the proposal lifecycle, not a failure.
 *
 * Only pure modules from core may be imported here (types/time) — never the
 * root, db, tools, or agent (they pull in bun:sqlite and break the build).
 */
import type {
  ChatRole,
  ColorSpec,
  Conflict,
  CookAssignment,
  Diff,
  EventDetails,
  EventInstance,
  EventKind,
  Meal,
  MealSuite,
  Reminder,
  ProposalStatus,
} from '@mise/core/types';

// ---------------------------------------------------------------------------
// Re-exports — the types screens need, from the two sanctioned pure modules.
// ---------------------------------------------------------------------------

export type {
  ChatRole,
  ColorSpec,
  Conflict,
  ConflictSeverity,
  DetailLine,
  DetailSection,
  Diff,
  EventChange,
  EventColor,
  EventDetails,
  EventInstance,
  EventKind,
  EventSource,
  CookAssignment,
  Meal,
  MealSuite,
  MealType,
  MealPattern,
  ProposalStatus,
  SlotCandidate,
  UnchangedPinned,
  UserSettings,
} from '@mise/core/types';

export {
  describeConflict,
  severityOf,
  isActionable,
  colorSpec,
  isEventColor,
  EVENT_COLORS,
  EVENT_KINDS,
  KIND_COLOR,
} from '@mise/core/types';

// Re-exported above for callers; also needed as values in this module.
import { describeConflict, severityOf, isActionable } from '@mise/core/types';

// ---------------------------------------------------------------------------
// API JSON shapes (rows as they arrive over the wire)
// ---------------------------------------------------------------------------

/** A proposal row as the API returns it. The spine of the app. */
export interface ProposalRow {
  id: string;
  created_at: string;
  user_message: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  diff: Diff;
  conflicts: Conflict[];
  status: ProposalStatus;
  applied_at: string | null;
}

export interface Semester {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  timezone: string;
}

export interface ChatMessageRow {
  id: string;
  proposal_id: string | null;
  role: ChatRole;
  content: string;
  created_at: string;
}

/** Matches the API's settings schema — every field optional (overlay file). */
export interface SettingsPatch {
  cook_cadence_days?: number;
  covers_next_lunches?: number;
  gym_target_per_week?: number;
  gym_duration_minutes?: number;
  meals?: {
    breakfast?: 'batch' | 'cook' | 'out';
    lunch?: 'batch' | 'cook' | 'out';
    dinner?: 'batch' | 'cook' | 'out';
  };
  onboarded?: boolean;
}

/** Body for POST /api/semester/proposal (setup_semester tool args). */
export interface SemesterSetupBody {
  name: string;
  start_date: string;
  end_date: string;
  timezone?: string;
  classes: {
    title: string;
    days: ('MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU')[];
    start_time: string;
    end_time: string;
    location?: string;
  }[];
  replace?: boolean;
}

export type ApproveStatus = 'applied' | 'needs_review' | 'blocked' | 'expired';

export interface ApproveResult {
  status: ApproveStatus;
  proposal: ProposalRow;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** API origin: same host the page was loaded from, port 3001. Works on
 *  localhost, tailnet MagicDNS, and the phone. SSR falls back to localhost. */
export function apiBase(): string {
  if (typeof window === 'undefined') return 'http://localhost:3001';
  return `http://${window.location.hostname}:3001`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: init?.body
      ? { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
      : init?.headers,
  });
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return body as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}

// ---------------------------------------------------------------------------
// Schedule + semester
// ---------------------------------------------------------------------------

export function getSchedule(start?: string, end?: string): Promise<{ instances: EventInstance[] }> {
  const q = new URLSearchParams();
  if (start) q.set('start', start);
  if (end) q.set('end', end);
  const qs = q.toString();
  return request(`/api/schedule${qs ? `?${qs}` : ''}`);
}

/**
 * What "View details" opens: the lifts behind a gym block, the recipe behind a
 * cook block. Fetched ON DEMAND — the grid never asks for this, only a block
 * you actually opened does. `instance_date` is part of the identity: the same
 * recurring event says something different on a different day.
 */
export function getEventDetails(eventId: string, date: string): Promise<EventDetails> {
  return request<{ details: EventDetails }>(
    `/api/schedule/${encodeURIComponent(eventId)}/details?date=${encodeURIComponent(date)}`,
  ).then((r) => r.details);
}

export function getSemester(): Promise<{ semester: Semester | null; onboarded: boolean }> {
  return request('/api/semester');
}

export function postSemesterProposal(body: SemesterSetupBody): Promise<{ proposal: ProposalRow }> {
  return post('/api/semester/proposal', body);
}

// ---------------------------------------------------------------------------
// Reminders — set by the AI in chat, deleted from the calendar marker, so
// these save directly, not through the proposal flow.
// ---------------------------------------------------------------------------
export function getReminders(start?: string, end?: string): Promise<{ reminders: Reminder[] }> {
  const q = start && end ? `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` : '';
  return request(`/api/reminders${q}`);
}

export function createReminder(body: { date: string; time: string; title: string }): Promise<{ reminder: Reminder }> {
  return post('/api/reminders', body);
}

export function deleteReminder(id: string): Promise<void> {
  return request(`/api/reminders/${id}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Event color — cosmetic, so it saves DIRECTLY. It moves no time, touches no
// pin, and nothing derives from it, so it does not file a proposal. Everything
// that changes *when* an event happens still goes through the approval path.
// ---------------------------------------------------------------------------

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

/** The palette, straight from core — the swatches paint from this. */
export function getColors(): Promise<{ colors: ColorSpec[] }> {
  return request('/api/events/colors');
}

/** `null` clears the override and falls back to the kind's default. */
export function setEventColor(id: string, color: string | null): Promise<{ ok: true }> {
  return patch(`/api/events/${id}/color`, { color });
}

/** Rename a block. A recurring block renames every instance at once. */
export function setEventTitle(id: string, title: string): Promise<{ ok: true }> {
  return patch(`/api/events/${id}/title`, { title });
}

export function setKindColor(
  kind: EventKind,
  color: string | null,
): Promise<{ ok: true; updated: number }> {
  return patch('/api/events/color-by-kind', { kind, color });
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export function sendChat(message: string): Promise<{ reply: string; proposals: ProposalRow[] }> {
  return post('/api/chat', { message });
}

export function getChatMessages(limit?: number): Promise<{ messages: ChatMessageRow[] }> {
  return request(`/api/chat/messages${limit ? `?limit=${limit}` : ''}`);
}

// ---------------------------------------------------------------------------
// Proposals (the lifecycle — I2)
// ---------------------------------------------------------------------------

export function getProposals(
  status?: 'pending' | 'approved' | 'rejected' | 'all',
): Promise<{ proposals: ProposalRow[] }> {
  return request(`/api/proposals${status ? `?status=${status}` : ''}`);
}

export function getProposal(id: string): Promise<{ proposal: ProposalRow }> {
  return request(`/api/proposals/${id}`);
}

/** THE DRAG PATH — identical server code path as chat (SPEC §4/§9). */
export function createProposal(
  tool_name: string,
  tool_args: object,
  user_message?: string,
): Promise<{ proposal: ProposalRow }> {
  return post('/api/proposals', { tool_name, tool_args, user_message });
}

/**
 * Approve. A 409 here is a lifecycle outcome, not an error:
 * - `needs_review`: the DB changed underneath; conflicts were re-derived.
 * - `blocked`: a blocking conflict — can never be applied (I4).
 * - `expired`: the stored args no longer parse.
 * Anything else non-2xx still throws.
 */
export async function approveProposal(id: string): Promise<ApproveResult> {
  const res = await fetch(`${apiBase()}/api/proposals/${id}/approve`, { method: 'POST' });
  const body = (await res.json().catch(() => null)) as
    | { status?: string; proposal?: ProposalRow; error?: string }
    | null;
  if ((res.ok || res.status === 409) && body?.proposal && typeof body.status === 'string') {
    return { status: body.status as ApproveStatus, proposal: body.proposal };
  }
  // 409 without a status field: the proposal was already resolved elsewhere.
  if (res.status === 409 && body?.proposal) {
    const p = body.proposal;
    return { status: p.status === 'approved' ? 'applied' : p.status === 'expired' ? 'expired' : 'blocked', proposal: p };
  }
  throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
}

export function rejectProposal(id: string): Promise<{ proposal: ProposalRow }> {
  return post(`/api/proposals/${id}/reject`);
}

/**
 * Drop a class for good — the whole series. Files the proposal and approves it
 * in one step, because the click that got here already IS the confirmation (the
 * popover asks first). Returns whether it actually applied; a non-'applied'
 * status means the class changed underneath and the caller should refresh.
 */
export async function dropClass(
  eventId: string,
  expectTitle: string,
): Promise<{ status: ApproveStatus }> {
  const { proposal } = await createProposal(
    'drop_class',
    { event_id: eventId, expect_title: expectTitle },
    `Drop ${expectTitle}`,
  );
  const res = await approveProposal(proposal.id);
  return { status: res.status };
}

/**
 * Delete ONE block by clicking it — the movable-block counterpart to dropClass.
 * A one-off (advising appointment, a single study block) is removed outright; a
 * single occurrence of a recurring block (one gym day) is cancelled just for
 * that date, the rest of the series left alone. Unlike dropClass this is
 * UNDOABLE — cancel_event is on the Cmd-Z path — so the popover offers it
 * without the "can't be taken back" warning. Passing `date` is safe either way:
 * cancel_event requires it for a recurring instance and ignores it for a one-off.
 * Files + approves in one step; the popover's confirm tap already IS the yes.
 */
export async function cancelEventBlock(
  eventId: string,
  expectTitle: string,
  date: string,
): Promise<{ status: ApproveStatus }> {
  const { proposal } = await createProposal(
    'cancel_event',
    { event_id: eventId, expect_title: expectTitle, date },
    `Delete ${expectTitle}`,
  );
  const res = await approveProposal(proposal.id);
  return { status: res.status };
}

/**
 * Set one event instance to exact start/end times (24h 'HH:mm'). The commit path
 * for the popover time fields and the resize-drag — same server code as chat's
 * set_event_time. Files the proposal and, because it's a reversible time change
 * (auto-applied like a drag), approves it in one step. A non-'applied' status
 * means it was refused (a collision with a class, or the block changed under it)
 * and the message says why.
 */
export async function setEventTime(
  eventId: string,
  expectTitle: string,
  date: string,
  startTime: string,
  endTime: string,
): Promise<{ status: ApproveStatus; reason: string | null }> {
  const { proposal } = await createProposal(
    'set_event_time',
    { event_id: eventId, expect_title: expectTitle, date, start_time: startTime, end_time: endTime },
    `Retime ${expectTitle} → ${startTime}–${endTime}`,
  );
  const blocking = proposal.conflicts.find((c) => severityOf(c) === 'blocking');
  if (blocking) return { status: 'blocked', reason: describeConflict(blocking) };
  if (!isActionable(proposal.diff)) {
    const why = proposal.conflicts[0];
    return { status: 'blocked', reason: why ? describeConflict(why) : 'Nothing changed.' };
  }
  const res = await approveProposal(proposal.id);
  const c = res.proposal.conflicts.find((k) => severityOf(k) === 'blocking');
  return { status: res.status, reason: c ? describeConflict(c) : null };
}

// ---------------------------------------------------------------------------
// Schedule photo import (SPEC §8's shape, applied to classes)
//
// Extraction only — the vision model is one more untrusted source of structured
// data. Nothing is written here: the user edits the candidates in a preview and
// the commit goes through createProposal('add_classes', …) like everything else.
// ---------------------------------------------------------------------------

/** A candidate class read off a photo. Mirrors core's ClassZ (tools/add-classes),
 *  redeclared because this module may only import the pure core modules. */
export interface ParsedClass {
  title: string;
  /** RFC5545 weekday codes — MO TU WE TH FR SA SU. */
  days: string[];
  /** HH:mm, 24-hour. */
  start_time: string;
  end_time: string;
  location?: string;
  color?: string;
}

export interface ScheduleImportResult {
  classes: ParsedClass[];
  /** Rows the model saw but could not parse. Flagged, never guessed. */
  skipped: string[];
}

/** Ollama down, vision model missing, or an unreadable image → 502, and the
 *  API's human message arrives as Error.message for the panel to render. */
export function importScheduleImage(imageB64: string): Promise<ScheduleImportResult> {
  return post('/api/schedule-import', { image: imageB64 });
}

// ---------------------------------------------------------------------------
// Meals v2 — meals and suites are CREATED by the AI (import_meals /
// create_suite in chat); the UI lists them, deletes them, and assigns what a
// cook block cooks. Direct CRUD, like reminders.
// ---------------------------------------------------------------------------

/** A suite as the API returns it: joined with its meal names for rendering. */
export interface SuiteWithNames extends MealSuite {
  breakfast_name: string;
  lunch_name: string;
}

export function getMeals(): Promise<{ meals: Meal[]; suites: SuiteWithNames[] }> {
  return request('/api/meals');
}

export function deleteMeal(id: string): Promise<void> {
  return request(`/api/meals/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Manual suite creation from the Meals tab. The chat path (create_suite via
 *  the AI) goes through the proposal flow instead; both point at the same
 *  meals — the individual meals always stay. */
export function createSuite(body: {
  breakfast_meal_id: string;
  lunch_meal_id: string;
  name?: string;
}): Promise<{ suite: SuiteWithNames }> {
  return post('/api/meals/suites', body);
}

export function deleteSuite(id: string): Promise<void> {
  return request(`/api/meals/suites/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function getCookAssignments(start?: string, end?: string): Promise<{ assignments: CookAssignment[] }> {
  const q = start && end ? `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` : '';
  return request(`/api/meals/assignments${q}`);
}

/** Assign what a cook block cooks — a suite (both meals) or a single meal. */
export function assignCook(
  body: { event_id: string; date: string } & ({ suite_id: string } | { meal_id: string }),
): Promise<{ assignment: CookAssignment }> {
  return request('/api/meals/assignments', { method: 'PUT', body: JSON.stringify(body) });
}

export function clearCookAssignment(event_id: string, date: string): Promise<void> {
  return request(
    `/api/meals/assignments?event_id=${encodeURIComponent(event_id)}&date=${encodeURIComponent(date)}`,
    { method: 'DELETE' },
  );
}

// ---------------------------------------------------------------------------
// Internships — the board is synced from community aggregator feeds; tracking
// a listing is a direct-UI action, like reminders. Types are redeclared here
// (mirroring core/internships.ts) because this module may only import the
// pure core modules. NOTE: internship timestamps are full ISO 8601 UTC
// strings, unlike the app's wall-time convention.
// ---------------------------------------------------------------------------

/** Application pipeline, in order. */
export type AppStatus = 'interested' | 'applied' | 'oa' | 'interview' | 'offer' | 'rejected' | 'ghosted';

export interface InternshipApplicationRow {
  internship_id: string;
  status: AppStatus;
  notes: string | null;
  /** Stamped the first time status becomes 'applied'; kept thereafter. */
  applied_at: string | null;
  updated_at: string;
}

/** A listing plus its application row (null = not tracked). */
export interface InternshipItem {
  id: string;
  /** Which feed this came from ('simplify' | 'vanshb03' | future sources). */
  source: string;
  company: string;
  title: string;
  url: string;
  locations: string[];
  terms: string[];
  /** Normalized: Software | AI/ML/Data | Hardware | Product | Quant | … */
  category: string;
  sponsorship: string | null;
  active: boolean;
  date_posted: string;
  date_updated: string;
  first_seen: string;
  application: InternshipApplicationRow | null;
}

export interface SyncSourceReport {
  source: string;
  skipped: boolean;
  fetched: number;
  inserted: number;
  updated: number;
  error?: string;
}

export interface SyncReport {
  sources: SyncSourceReport[];
  lastSynced: string | null;
}

export interface InternshipListParams {
  /** Matches company OR title, case-insensitive substring. */
  q?: string;
  category?: string;
  /** Exact term from facets, e.g. "Summer 2026". */
  term?: string;
  status?: AppStatus;
  /** Default true — closed listings stay out unless asked for. */
  activeOnly?: boolean;
  trackedOnly?: boolean;
  limit?: number;
  offset?: number;
  sort?: 'posted' | 'updated' | 'company';
}

export interface InternshipListResult {
  items: InternshipItem[];
  total: number;
  lastSynced: string | null;
  /** Distinct values among active rows — the filter dropdowns. */
  facets: { categories: string[]; terms: string[] };
}

export interface InternshipTrackerGroup {
  status: AppStatus;
  items: InternshipItem[];
}

export function listInternships(params: InternshipListParams = {}): Promise<InternshipListResult> {
  const q = new URLSearchParams();
  if (params.q) q.set('q', params.q);
  if (params.category) q.set('category', params.category);
  if (params.term) q.set('term', params.term);
  if (params.status) q.set('status', params.status);
  if (params.activeOnly !== undefined) q.set('activeOnly', String(params.activeOnly));
  if (params.trackedOnly !== undefined) q.set('trackedOnly', String(params.trackedOnly));
  if (params.limit !== undefined) q.set('limit', String(params.limit));
  if (params.offset !== undefined) q.set('offset', String(params.offset));
  if (params.sort) q.set('sort', params.sort);
  const qs = q.toString();
  return request(`/api/internships${qs ? `?${qs}` : ''}`);
}

/** Refresh the board from the feeds. Can take ~10–30s on a real download. */
export function syncInternships(force?: boolean): Promise<SyncReport> {
  return post('/api/internships/sync', { force: force ?? false });
}

/** Track / move / untrack. `null` status untracks; `notes` omitted keeps the
 *  existing notes, a string/null sets/clears them. */
export function setInternshipApplication(
  id: string,
  status: AppStatus | null,
  notes?: string | null,
): Promise<InternshipItem> {
  return request<{ item: InternshipItem }>(
    `/api/internships/${encodeURIComponent(id)}/application`,
    { method: 'PUT', body: JSON.stringify(notes === undefined ? { status } : { status, notes }) },
  ).then((r) => r.item);
}

/** Pipeline groups in order (interested → … → ghosted); empty groups omitted. */
export function getInternshipTracker(): Promise<InternshipTrackerGroup[]> {
  return request<{ groups: InternshipTrackerGroup[] }>('/api/internships/tracker').then((r) => r.groups);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function getSettings(): Promise<{ settings: SettingsPatch; effective: Record<string, unknown> }> {
  return request('/api/settings');
}

export function putSettings(s: SettingsPatch): Promise<{ settings: SettingsPatch }> {
  return request('/api/settings', { method: 'PUT', body: JSON.stringify(s) });
}

// ---------------------------------------------------------------------------
// Undo — the counterweight to auto-apply. See packages/core/src/undo.ts.
// ---------------------------------------------------------------------------

/** Tools whose changes can be put back. Everything the assistant does in chat
 *  is here, so Cmd-Z can reverse any of it (see packages/core/src/undo.ts). */
const UNDOABLE = new Set(['shift_events', 'set_event_time', 'set_recurring_days', 'place_adjacent', 'set_workout', 'create_event', 'fit_in_event', 'set_preference', 'add_classes', 'block_free_time', 'reschedule_to_free_slot', 'cancel_event', 'edit_workout', 'import_meals', 'create_suite', 'track_application']);

export function isUndoableProposal(p: Pick<ProposalRow, 'tool_name' | 'status'>): boolean {
  return p.status === 'approved' && UNDOABLE.has(p.tool_name);
}

export function undoProposal(id: string): Promise<{ ok: true }> {
  return post(`/api/proposals/${id}/undo`);
}

export type UndoLastResult =
  | { ok: true; undone_id: string; summary: string }
  | { ok: false; reason: string };

/** Cmd-Z: reverse the most recent not-yet-undone change, whatever made it. */
export function undoLast(): Promise<UndoLastResult> {
  return post('/api/proposals/undo-last');
}
