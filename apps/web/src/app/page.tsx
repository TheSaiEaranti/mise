'use client';

/**
 * The Week screen — the default surface. Desktop: 7-column grid with drag-to-
 * propose. Mobile: a day list. Both read the same schedule window and refetch
 * when the store's scheduleVersion bumps (i.e. after an approved proposal),
 * which is what makes approved shifts slide into place.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addDaysWall,
  addMinutesWall,
  dateOf,
  fmt12,
  fmtDateLong,
  fmtRange12,
  timeOf,
  todayInTz,
  weekMonday,
} from '@mise/core/time';
import { getSchedule, getSemester, getReminders, deleteReminder, type EventInstance } from '@/lib/api';
import type { Reminder } from '@mise/core/types';
import { useApp } from '@/lib/store';
import { Button } from '@/components/ui/button';
import { WeekGrid } from '@/components/week/week-grid';
import { DayList } from '@/components/week/day-list';
import { AddEventPopover, type NewEventArgs } from '@/components/week/add-event-popover';
import { instanceKey } from '@/components/week/geometry';
import { ImportSchedule } from '@/components/setup/import-schedule';

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {dir === 'left' ? <path d="M10 3 5 8l5 5" /> : <path d="M6 3l5 5-5 5" />}
    </svg>
  );
}

/** "Gym" · "Gym and Cook lunches" · "Gym, Cook lunches and Call home" */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function Plus() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

interface MovedNote {
  text: string;
  /** A ready-to-fire tool call that reverses this change, or null when the
   *  change can't be cleanly reversed in one click (a recurring instance). */
  undo: { tool_name: string; tool_args: Record<string, unknown>; user_message: string } | null;
}

export default function WeekPage() {
  const { scheduleVersion, proposals, dragProposal, dragMove, undoLast, bumpSchedule } = useApp();
  const [monday, setMonday] = useState(() => weekMonday(todayInTz()));
  const [instances, setInstances] = useState<EventInstance[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  /** What the last drop did. One line under the header; no toast system. */
  const [moved, setMoved] = useState<MovedNote | null>(null);
  /** The week the semester starts — the calendar never shows days before it, so
   *  an empty run-up to the term (or old cleared weeks) isn't scrollable. */
  const [minMonday, setMinMonday] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getSemester()
      .then((res) => {
        if (alive && res.semester) setMinMonday(weekMonday(res.semester.start_date));
      })
      .catch((e) => console.warn('[week] semester fetch failed', e));
    return () => {
      alive = false;
    };
  }, [scheduleVersion]);

  // Once we know the semester start, snap forward if we opened on an earlier week
  // (e.g. today is before the term begins) — the calendar starts at the term.
  useEffect(() => {
    if (minMonday) setMonday((m) => (m < minMonday ? minMonday : m));
  }, [minMonday]);

  useEffect(() => {
    let alive = true;
    getSchedule(monday, addDaysWall(monday, 6))
      .then((res) => {
        if (alive) setInstances(res.instances);
      })
      .catch((e) => console.warn('[week] schedule fetch failed', e));
    return () => {
      alive = false;
    };
  }, [monday, scheduleVersion]);

  // Reminders for the visible week — same version signal, so an add on the
  // Reminders tab (which bumps it) shows up here too.
  useEffect(() => {
    let alive = true;
    getReminders(monday, addDaysWall(monday, 6))
      .then((res) => {
        if (alive) setReminders(res.reminders);
      })
      .catch((e) => console.warn('[week] reminders fetch failed', e));
    return () => {
      alive = false;
    };
  }, [monday, scheduleVersion]);

  const removeReminder = useCallback(
    (id: string) => {
      void deleteReminder(id)
        .then(() => bumpSchedule())
        .catch((e) => console.warn('[week] reminder delete failed', e));
    },
    [bumpSchedule],
  );

  // Cmd-Z / Ctrl-Z reverses the last change — a drag, a resize, or anything the
  // assistant did. Each press steps back one. We never intercept it while a text
  // field is focused, so undo in the chat box stays native text undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'z' || !(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
      e.preventDefault();
      void undoLast().then((res) =>
        setMoved({ text: res.ok ? `Undone — ${res.summary}` : res.reason, undo: null }),
      );
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undoLast]);

  // Paging weeks drops the note — its Undo targets a date you're no longer looking at.
  useEffect(() => setMoved(null), [monday]);

  const today = todayInTz();
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysWall(monday, i)), [monday]);

  const byDate = useMemo(() => {
    const m = new Map<string, EventInstance[]>();
    for (const d of days) m.set(d, []);
    for (const inst of instances) m.get(inst.instance_date)?.push(inst);
    for (const list of m.values()) list.sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
    return m;
  }, [instances, days]);

  const remindersByDate = useMemo(() => {
    const m = new Map<string, Reminder[]>();
    for (const d of days) m.set(d, []);
    for (const r of reminders) m.get(r.date)?.push(r);
    return m;
  }, [reminders, days]);

  /** Instances touched by any pending proposal → --signal border on the grid. */
  const pendingKeys = useMemo(() => {
    const s = new Set<string>();
    for (const p of proposals) {
      if (p.status !== 'pending') continue;
      for (const ch of p.diff?.changes ?? []) {
        if (ch.before) s.add(instanceKey(ch.event_id, ch.instance_date));
      }
    }
    return s;
  }, [proposals]);

  /**
   * THE DRAG PATH — same server code path as chat, but dropping APPLIES the
   * move: the block lands where you put it instead of bouncing back for an
   * approval click. Still a real proposal (validated, transactional, written to
   * the audit log), and still refused outright if it would touch something
   * pinned — in that case the block snaps back and the card explains why.
   *
   * delta_minutes carries the day change too (dayDelta * 1440 + minutes), so a
   * cross-day drag is still pure intent and the tool owns every timestamp (I3).
   * Returns a promise the block awaits before dropping its visual offset, so it
   * never flickers back to the old slot on the way to the new one.
   */
  const proposeShift = useCallback(
    async (inst: EventInstance, deltaMinutes: number) => {
      const target = addMinutesWall(inst.starts_at, deltaMinutes);
      const day = fmtDateLong(dateOf(target), 'EEE');
      // Two audiences, one instant. `label` is what the model and the audit log
      // read, so it stays 24-hour like every other machine-facing string;
      // `shown` is the line Sai reads under the header, so it's 12-hour.
      const label = `${day} ${timeOf(target)}`;
      const shown = `${day} ${fmt12(target)}`;
      // Dragging a REPEATING block moves the whole series — the change sticks
      // across weeks instead of leaving a one-week override that reverts (the
      // "my manual move didn't record" bug). A one-off block moves just itself.
      const scope = inst.recurring ? 'series' : 'single';
      try {
        const res = await dragMove({
          tool_name: 'shift_events',
          tool_args: {
            scope,
            event_id: inst.event_id,
            // The tool cross-checks this against the real event. A drag can't
            // pick the wrong one — you grabbed the block — but the guard is on
            // the tool, so the drag states its target like anything else.
            expect_title: inst.title,
            date: inst.instance_date,
            delta_minutes: deltaMinutes,
          },
          user_message: `Drag: ${inst.title} → ${label}${inst.recurring ? ' (every week)' : ''}`,
        });

        if (res.status === 'blocked') {
          setMoved({ text: res.reason, undo: null });
          return;
        }
        const aside =
          res.madeRoom.length > 0
            ? ` — ${listOf(res.madeRoom)} moved to make room`
            : res.warnings.length
              ? ` — ${res.warnings[0]}`
              : '';
        setMoved({
          text: `${inst.title} → ${shown}${inst.recurring ? ' · every week' : ''}${aside}`,
          // A series move (and a moved recurring override) doesn't leave the id
          // we'd shift back, but dragging it back does the inverse series move —
          // so the undo is "drag it back", and the button-undo is for one-offs.
          undo: inst.recurring
            ? null
            : {
                tool_name: 'shift_events',
                tool_args: {
                  scope: 'single',
                  event_id: inst.event_id,
                  expect_title: inst.title,
                  date: dateOf(target),
                  delta_minutes: -deltaMinutes,
                },
                user_message: `Undo: ${inst.title}`,
              },
        });
      } catch (e) {
        console.warn('[week] drag failed', e);
        setMoved({ text: 'That move failed — the schedule is unchanged.', undo: null });
      }
    },
    [dragMove],
  );

  /**
   * Resize dropped: the block's bottom edge was dragged to a new end (start and
   * end come in as 'HH:mm'). Same path and same one-line feedback as a move —
   * set_event_time, which makes room and refuses landing on a class.
   */
  const proposeResize = useCallback(
    async (inst: EventInstance, startTime: string, endTime: string) => {
      const shown = fmtRange12(`${inst.instance_date}T${startTime}`, `${inst.instance_date}T${endTime}`);
      try {
        const res = await dragMove({
          tool_name: 'set_event_time',
          tool_args: {
            event_id: inst.event_id,
            expect_title: inst.title,
            date: inst.instance_date,
            start_time: startTime,
            end_time: endTime,
          },
          user_message: `Resize: ${inst.title} → ${startTime}–${endTime}`,
        });

        if (res.status === 'blocked') {
          setMoved({ text: res.reason, undo: null });
          return;
        }
        const aside =
          res.madeRoom.length > 0
            ? ` — ${listOf(res.madeRoom)} moved to make room`
            : res.warnings.length
              ? ` — ${res.warnings[0]}`
              : '';
        setMoved({
          text: `${inst.title} → ${shown}${aside}`,
          undo: inst.recurring
            ? null
            : {
                tool_name: 'set_event_time',
                tool_args: {
                  event_id: inst.event_id,
                  expect_title: inst.title,
                  date: inst.instance_date,
                  start_time: timeOf(inst.starts_at),
                  end_time: timeOf(inst.ends_at),
                },
                user_message: `Undo: ${inst.title}`,
              },
        });
      } catch (e) {
        console.warn('[week] resize failed', e);
        setMoved({ text: 'That resize failed — the schedule is unchanged.', undo: null });
      }
    },
    [dragMove],
  );

  const undoMove = useCallback(async () => {
    const u = moved?.undo;
    if (!u) return;
    setMoved(null);
    try {
      await dragMove(u);
    } catch (e) {
      console.warn('[week] undo failed', e);
    }
  }, [moved, dragMove]);

  const createEvent = useCallback(
    (args: NewEventArgs) => {
      dragProposal(
        'create_event',
        args,
        `Add: ${args.title} · ${fmtDateLong(args.date, 'EEE MMM d')} ${args.start_time}`,
      ).catch((e) => console.warn('[week] create proposal failed', e));
      setAddOpen(false);
    },
    [dragProposal],
  );

  return (
    // md:pb-6 — the desktop grid measures the room left under the header and
    // sizes itself to it; the padding below it is part of that budget.
    <main className="px-6 pb-10 md:px-10 md:pb-6">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-6 pt-4">
        <h1 className="t-display">Week of {fmtDateLong(monday, 'MMM d')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={importOpen ? 'ghost' : 'secondary'}
            aria-expanded={importOpen}
            className="h-11"
            onClick={() => setImportOpen((v) => !v)}
          >
            {importOpen ? 'Close' : 'Import schedule'}
          </Button>
          <div className="relative flex items-center">
            <Button
              variant="ghost"
              aria-label="Previous week"
              className="h-11 w-11 px-0"
              disabled={!!minMonday && monday <= minMonday}
              onClick={() =>
                setMonday((m) => {
                  const prev = addDaysWall(m, -7);
                  return minMonday && prev < minMonday ? m : prev;
                })
              }
            >
              <Chevron dir="left" />
            </Button>
            <Button
              variant="ghost"
              aria-label="Next week"
              className="h-11 w-11 px-0"
              onClick={() => setMonday((m) => addDaysWall(m, 7))}
            >
              <Chevron dir="right" />
            </Button>
            <Button
              variant="ghost"
              aria-label="Add event"
              aria-expanded={addOpen}
              className="h-11 w-11 px-0"
              onClick={() => setAddOpen((v) => !v)}
            >
              <Plus />
            </Button>
            {addOpen && (
              <AddEventPopover
                defaultDate={days.includes(today) ? today : monday}
                onSubmit={createEvent}
                onClose={() => setAddOpen(false)}
              />
            )}
          </div>
        </div>
      </div>

      {/* What the last drop did. One line of ink-soft text with a ghost Undo —
          not a toast, not a banner. It clears on the next drag or week change. */}
      {moved && (
        <div className="flex items-center gap-3 pb-4">
          <p className="t-label min-w-0 truncate text-ink-soft">{moved.text}</p>
          {moved.undo && (
            <Button variant="ghost" className="h-8 shrink-0" onClick={undoMove}>
              Undo
            </Button>
          )}
        </div>
      )}

      {/* Post-onboarding path: a semester exists, so this files an add_classes
          proposal. Opens in place under the header — never a modal. */}
      {importOpen && (
        <div className="max-w-xl pb-6">
          <ImportSchedule />
        </div>
      )}

      <WeekGrid
        days={days}
        today={today}
        byDate={byDate}
        remindersByDate={remindersByDate}
        pendingKeys={pendingKeys}
        onProposeShift={proposeShift}
        onSetTime={proposeResize}
        onDeleteReminder={removeReminder}
      />
      <DayList days={days} today={today} byDate={byDate} pendingKeys={pendingKeys} />
    </main>
  );
}
