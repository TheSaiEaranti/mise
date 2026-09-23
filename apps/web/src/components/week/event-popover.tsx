'use client';

/**
 * The event popover. Click a block and this is what opens: what the block IS
 * (a gym day is "Shoulder and arms", a cook block is "Chipotle Chicken Rice
 * Bowls"), what it can become (the swatches), and — behind one ghost button —
 * exactly what is in it: the lifts and their loads, the ingredients and the
 * method.
 *
 * It is a raised card anchored to the block. Not a modal, no overlay, no
 * backdrop, no drawer, no navigation. "View details" expands IN PLACE. Closes
 * on outside pointerdown or Escape.
 *
 * Details are fetched on demand — the grid must never pay for a detail the user
 * did not ask to see — and cached per (event_id, date) for the session, so the
 * second open is instant.
 *
 * Color is cosmetic, so recoloring saves directly instead of filing a proposal
 * (only TIME goes through approval). Pinned blocks are recolorable for the same
 * reason: the lock is on when the event happens, not what it looks like.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { fmtRange12 } from '@mise/core/time';
import {
  EVENT_COLORS,
  assignCook,
  cancelEventBlock,
  clearCookAssignment,
  colorSpec,
  dropClass,
  getCookAssignments,
  getEventDetails,
  getMeals,
  setEventColor,
  setEventTime,
  setEventTitle,
  setKindColor,
  type CookAssignment,
  type EventDetails,
  type EventInstance,
  type Meal,
  type SuiteWithNames,
} from '@/lib/api';
import { useApp } from '@/lib/store';
import { Button } from '@/components/ui/button';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const GAP = 8;
const EDGE = 8;

/**
 * Session cache. A gym day's lifts do not change while you look at the week, so
 * re-opening a block is instant and silent — no dot, no second request.
 */
const detailsCache = new Map<string, EventDetails>();
const cacheKey = (eventId: string, date: string) => `${eventId}|${date}`;

function Check({ ink }: { ink: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      fill="none"
      stroke={ink}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 6.5 5 9l4.5-5.5" />
    </svg>
  );
}

interface EventPopoverProps {
  inst: EventInstance;
  /** The block this is anchored to. Also the "inside" test for outside-click. */
  anchorRef: RefObject<HTMLDivElement | null>;
  onClose(): void;
}

export function EventPopover({ inst, anchorRef, onClose }: EventPopoverProps) {
  const { bumpSchedule } = useApp();
  const ref = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [busy, setBusy] = useState(false);

  // Dropping a class is a two-tap action: the first tap arms it, the second one
  // commits — a course is not something a stray click should be able to delete.
  const isClass = inst.kind === 'class';
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  // Deleting a movable block (an advising appointment, one gym day) — the same
  // two-tap arm/confirm, but this one IS undoable (cancel_event is on Cmd-Z), so
  // the copy says so rather than warning it's permanent. A recurring block only
  // loses THIS occurrence; a one-off is gone entirely.
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);

  // Editing the time by hand. Only movable blocks — a class is an anchor and its
  // hours don't get nudged (the block doesn't drag either). The <input type=time>
  // gives back 24h 'HH:mm', which is exactly what the tool wants.
  const editable = !inst.pinned;
  const startHM = inst.starts_at.slice(11, 16);
  const endHM = inst.ends_at.slice(11, 16);
  const [start, setStart] = useState(startHM);
  const [end, setEnd] = useState(endHM);
  const [savingTime, setSavingTime] = useState(false);
  const [timeError, setTimeError] = useState<string | null>(null);
  const timeChanged = start !== startHM || end !== endHM;
  const timeValid = end > start;

  // Click the name to rename. A recurring block renames every instance at once.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(inst.title);

  const key = cacheKey(inst.event_id, inst.instance_date);
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState<EventDetails | null>(() => detailsCache.get(key) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What this cook block is cooking. The picker lists the AI-imported suites
  // (a suite = breakfast + lunch, cooked together) and the unpaired meals;
  // assigning is direct CRUD (like recoloring), not a proposal — it moves no
  // time. Fetched fresh per open: the list only changes when Sai imports.
  const isCook = inst.kind === 'cook';
  const [cookOptions, setCookOptions] = useState<{ meals: Meal[]; suites: SuiteWithNames[] } | null>(null);
  const [assigned, setAssigned] = useState<CookAssignment | null>(null);
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  useEffect(() => {
    if (!isCook) return;
    let live = true;
    // All assignments, not just this date's: a standalone block dragged to
    // another day keeps its assignment keyed to the old date, and it still
    // belongs to this block (assignCook keeps standalone events to one row).
    void Promise.all([getMeals(), getCookAssignments()])
      .then(([m, a]) => {
        if (!live) return;
        setCookOptions(m);
        const mine = a.assignments.filter((x) => x.event_id === inst.event_id);
        setAssigned(
          mine.find((x) => x.date === inst.instance_date) ??
            (!inst.recurring && mine.length === 1 ? mine[0]! : null),
        );
      })
      .catch(() => {
        if (live) setAssignError('Could not load your meals.');
      });
    return () => {
      live = false;
    };
  }, [isCook, inst.event_id, inst.instance_date, inst.recurring]);

  const doAssign = useCallback(
    async (sel: { suite_id: string } | { meal_id: string } | null) => {
      if (assignBusy) return;
      setAssignBusy(true);
      setAssignError(null);
      try {
        if (sel === null) {
          // Clear the row we actually found — a moved standalone block's
          // assignment may be keyed to the date it was assigned on.
          await clearCookAssignment(inst.event_id, assigned?.date ?? inst.instance_date);
        } else {
          await assignCook({ event_id: inst.event_id, date: inst.instance_date, ...sel });
        }
        detailsCache.delete(key); // the ingredients behind "View details" changed
        bumpSchedule();
        onClose();
      } catch (e) {
        if (alive.current) {
          setAssignError(e instanceof Error ? e.message : 'Could not assign that.');
          setAssignBusy(false);
        }
      }
    },
    [assignBusy, assigned, inst.event_id, inst.instance_date, key, bumpSchedule, onClose],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** The effective key: the override if set, else the kind's default. */
  const current = colorSpec(inst.color, inst.kind).key;

  // Before the details land, the block already knows its own time and what it
  // is — so the header is never empty and never shifts when the payload arrives.
  const title = details?.title ?? inst.title;
  const when = details?.when ?? fmtRange12(inst.starts_at, inst.ends_at);
  const subtitle = details?.subtitle ?? inst.subtitle ?? null;
  const hasDetails = inst.has_details === true;

  // Fixed to the viewport: the block sets `rotate`, which would make it the
  // containing block for a fixed child, so this renders as its SIBLING.
  // Re-run whenever the card changes size (details expand) so an opened panel
  // still flips above the block rather than running off the bottom.
  useIsoLayoutEffect(() => {
    const anchor = anchorRef.current;
    const el = ref.current;
    if (!anchor || !el) return;
    const a = anchor.getBoundingClientRect();
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    const roomBelow = window.innerHeight - EDGE - (a.bottom + GAP);
    const roomAbove = a.top - GAP - EDGE;
    // Below by default; flip above only when it does not fit below AND above is
    // the roomier side. max-h keeps `h` bounded, so one of the two nearly always
    // fits; the clamp is the belt-and-braces for a block at the very edge.
    const top = h <= roomBelow || roomBelow >= roomAbove ? a.bottom + GAP : a.top - h - GAP;
    setPos({
      top: Math.round(Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - h))),
      left: Math.round(Math.max(EDGE, Math.min(a.left, window.innerWidth - w - EDGE))),
    });
  }, [anchorRef, expanded, details, loading, error]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      // The block itself toggles the popover; let its own click handle that.
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, anchorRef]);

  const toggleDetails = useCallback(() => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    setError(null);

    const hit = detailsCache.get(key);
    if (hit) {
      setDetails(hit);
      return;
    }
    setLoading(true);
    void getEventDetails(inst.event_id, inst.instance_date)
      .then((d) => {
        detailsCache.set(key, d);
        if (alive.current) setDetails(d);
      })
      .catch((e: unknown) => {
        if (alive.current) setError(e instanceof Error ? e.message : 'Could not load details.');
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
  }, [expanded, key, inst.event_id, inst.instance_date]);

  const save = useCallback(
    async (run: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      try {
        await run();
        bumpSchedule();
      } catch (e) {
        console.warn('[week] recolor failed', e);
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [busy, bumpSchedule],
  );

  const doDrop = useCallback(async () => {
    if (dropping) return;
    setDropping(true);
    setDropError(null);
    try {
      const { status } = await dropClass(inst.event_id, inst.title);
      if (status === 'applied') {
        bumpSchedule();
        onClose();
        return;
      }
      // The class changed underneath (e.g. already dropped in another view).
      // Refresh so the grid reflects reality, and say so rather than silently
      // pretending it worked.
      bumpSchedule();
      setDropError('That class already changed — check the schedule.');
      setConfirmDrop(false);
    } catch (e) {
      setDropError(e instanceof Error ? e.message : 'Could not drop the class.');
    } finally {
      if (alive.current) setDropping(false);
    }
  }, [dropping, inst.event_id, inst.title, bumpSchedule, onClose]);

  const doDelete = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    setDelError(null);
    try {
      const { status } = await cancelEventBlock(inst.event_id, inst.title, inst.instance_date);
      if (status === 'applied') {
        bumpSchedule();
        onClose();
        return;
      }
      // Refused or changed underneath — refresh and say so rather than pretend.
      bumpSchedule();
      setDelError('That block already changed — check the schedule.');
      setConfirmDel(false);
    } catch (e) {
      setDelError(e instanceof Error ? e.message : 'Could not delete the block.');
    } finally {
      if (alive.current) setDeleting(false);
    }
  }, [deleting, inst.event_id, inst.title, inst.instance_date, bumpSchedule, onClose]);

  const saveName = useCallback(async () => {
    const next = nameDraft.trim();
    setRenaming(false);
    if (!next || next === inst.title) return;
    try {
      await setEventTitle(inst.event_id, next);
      bumpSchedule();
    } catch (e) {
      console.warn('[popover] rename failed', e);
    }
  }, [nameDraft, inst.event_id, inst.title, bumpSchedule]);

  const saveTime = useCallback(async () => {
    if (savingTime || !timeChanged || !timeValid) return;
    setSavingTime(true);
    setTimeError(null);
    try {
      const { status, reason } = await setEventTime(inst.event_id, inst.title, inst.instance_date, start, end);
      if (status === 'applied') {
        bumpSchedule();
        onClose();
        return;
      }
      // Refused (usually a collision with a class) — say why, leave the fields
      // as they were so Sai can pick another time.
      bumpSchedule();
      setTimeError(reason ?? 'That time didn’t work — try another.');
    } catch (e) {
      setTimeError(e instanceof Error ? e.message : 'Could not set the time.');
    } finally {
      if (alive.current) setSavingTime(false);
    }
  }, [savingTime, timeChanged, timeValid, inst.event_id, inst.title, inst.instance_date, start, end, bumpSchedule, onClose]);

  // The method, as paragraphs. A recipe's steps are newline-separated text, not
  // a document format — splitting is the whole parser we need.
  const paragraphs = (details?.body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <div
      ref={ref}
      role="group"
      aria-label={inst.title}
      className="fixed z-30 flex max-h-[60vh] w-[300px] max-w-[calc(100vw-16px)] flex-col rounded-r border border-rule bg-paper shadow-lift"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      {/* Header + details: the part that can grow, so this is the part that scrolls. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {renaming ? (
          <input
            autoFocus
            value={nameDraft}
            maxLength={80}
            aria-label="Rename block"
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveName();
              else if (e.key === 'Escape') {
                setNameDraft(inst.title);
                setRenaming(false);
              }
            }}
            className="t-body w-full rounded-r border border-rule bg-paper px-1.5 py-0.5 font-semibold text-ink"
          />
        ) : (
          <button
            type="button"
            title="Click to rename"
            onClick={() => {
              setNameDraft(inst.title);
              setRenaming(true);
            }}
            className="t-body block max-w-full truncate text-left font-semibold hover:text-ink-soft"
          >
            {title}
          </button>
        )}
        <p className="t-time truncate text-ink-soft">{when}</p>
        {subtitle && <p className="t-label truncate text-ink-soft">{subtitle}</p>}

        {hasDetails && (
          <div className="pt-2">
            <Button
              variant="ghost"
              aria-expanded={expanded}
              className="-ml-2 justify-start px-2"
              onClick={toggleDetails}
            >
              {expanded ? 'Hide details' : 'View details'}
            </Button>
          </div>
        )}

        {expanded && loading && (
          <p className="t-label mise-dot pt-2 text-ink-soft" aria-hidden="true">
            ●
          </p>
        )}

        {expanded && error && <p className="t-label pt-2 text-ink-soft">{error}</p>}

        {expanded && !loading && !error && details && (
          <div className="pt-2">
            {details.sections.map((section) => (
              <section key={section.heading} className="pt-3 first:pt-0">
                <p className="t-micro text-ink-soft">{section.heading}</p>
                <ul className="pt-1">
                  {section.lines.map((line, i) => (
                    <li
                      key={`${line.label}-${i}`}
                      className="flex items-baseline justify-between gap-3 py-1"
                    >
                      <span className="t-body min-w-0 flex-1 truncate">{line.label}</span>
                      {line.value && (
                        <span className="t-time shrink-0 whitespace-nowrap text-ink-soft">
                          {line.value}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            {paragraphs.map((text, i) => (
              <p key={i} className="t-label pt-2 text-ink-soft">
                {text}
              </p>
            ))}

            {details.sections.length === 0 && paragraphs.length === 0 && (
              <p className="t-label text-ink-soft">Nothing written down yet.</p>
            )}
          </div>
        )}
      </div>

      {/* What this cook block cooks. Pick a suite (breakfast + lunch together)
          or a single meal; the block's subtitle and details derive from it. */}
      {isCook && (
        <div className="shrink-0 border-t border-rule p-3">
          <p className="t-micro text-ink-soft">Cooking</p>
          {cookOptions === null && !assignError && (
            <p className="t-label mise-dot pt-1 text-ink-soft" aria-hidden="true">
              ●
            </p>
          )}
          {cookOptions !== null && cookOptions.suites.length === 0 && cookOptions.meals.length === 0 && (
            <p className="t-label pt-1 text-ink-soft">
              No meals imported yet — paste a recipe to the assistant.
            </p>
          )}
          {cookOptions !== null && (cookOptions.suites.length > 0 || cookOptions.meals.length > 0) && (
            <div className="max-h-40 overflow-y-auto pt-1">
              {cookOptions.suites.map((s) => {
                const on = assigned?.suite_id === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={on}
                    disabled={assignBusy}
                    onClick={() => void doAssign({ suite_id: s.id })}
                    className="flex w-full items-baseline justify-between gap-3 px-2 py-1.5 text-left hover:bg-recessed"
                  >
                    <span className="t-label min-w-0 flex-1 truncate text-ink">
                      {on ? '✓ ' : ''}
                      {s.name}
                    </span>
                    <span className="t-micro max-w-[55%] truncate text-ink-soft">
                      {s.breakfast_name} + {s.lunch_name}
                    </span>
                  </button>
                );
              })}
              {cookOptions.meals.map((m) => {
                const on = assigned?.meal_id === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={on}
                    disabled={assignBusy}
                    onClick={() => void doAssign({ meal_id: m.id })}
                    className="flex w-full items-baseline justify-between gap-3 px-2 py-1.5 text-left hover:bg-recessed"
                  >
                    <span className="t-label min-w-0 flex-1 truncate text-ink">
                      {on ? '✓ ' : ''}
                      {m.name}
                    </span>
                    <span className="t-micro max-w-[55%] truncate text-ink-soft">
                      {m.meal_type === 'breakfast' ? 'Breakfast' : 'Lunch'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {assigned && (
            <Button
              variant="ghost"
              disabled={assignBusy}
              className="mt-1 w-full justify-start px-2"
              onClick={() => void doAssign(null)}
            >
              Unassign
            </Button>
          )}
          {assignError && <p className="t-label pt-2 text-ink-soft">{assignError}</p>}
        </div>
      )}

      {/* Time. Movable blocks only — a class is an anchor. Type an exact start
          and end; this is where you change how long a block is, not just when it
          starts, and it goes through the same make-room path as a drag. */}
      {editable && (
        <div className="shrink-0 border-t border-rule p-3">
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="t-micro text-ink-soft">Start</span>
              <input
                type="time"
                value={start}
                disabled={savingTime}
                onChange={(e) => {
                  setStart(e.target.value);
                  setTimeError(null);
                }}
                className="t-time rounded-r border border-rule bg-paper px-2 py-1 text-ink"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="t-micro text-ink-soft">End</span>
              <input
                type="time"
                value={end}
                disabled={savingTime}
                onChange={(e) => {
                  setEnd(e.target.value);
                  setTimeError(null);
                }}
                className="t-time rounded-r border border-rule bg-paper px-2 py-1 text-ink"
              />
            </label>
            <Button
              variant="secondary"
              disabled={savingTime || !timeChanged || !timeValid}
              onClick={() => void saveTime()}
            >
              {savingTime ? 'Saving…' : 'Save'}
            </Button>
          </div>
          {timeChanged && !timeValid && (
            <p className="t-label pt-2 text-ink-soft">The end has to come after the start.</p>
          )}
          {timeError && <p className="t-label pt-2 text-ink-soft">{timeError}</p>}
        </div>
      )}

      {/* Color. Below the hairline, and never scrolls away. */}
      <div className="shrink-0 border-t border-rule p-3">
        <div className="grid w-fit grid-cols-4">
          {EVENT_COLORS.map((spec) => (
            <button
              key={spec.key}
              type="button"
              aria-label={spec.label}
              aria-pressed={current === spec.key}
              disabled={busy}
              className="flex h-11 w-11 items-center justify-center"
              onClick={() => void save(() => setEventColor(inst.event_id, spec.key))}
            >
              <span
                className="flex h-5 w-5 items-center justify-center rounded-r"
                style={{ background: spec.fill, border: `2px solid ${spec.line}` }}
              >
                {current === spec.key && <Check ink={spec.ink} />}
              </span>
            </button>
          ))}
        </div>

        <div className="flex flex-col items-start pt-2">
          <Button
            variant="ghost"
            disabled={busy}
            className="w-full justify-start px-2"
            onClick={() => void save(() => setEventColor(inst.event_id, null))}
          >
            Reset to default
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            className="w-full justify-start px-2"
            onClick={() => void save(() => setKindColor(inst.kind, current))}
          >
            Apply to all {inst.kind}
          </Button>
        </div>
      </div>

      {/* Drop a class. Its own section under a hairline, because it is the one
          action here that removes something and can't be taken back. Only for
          classes — a gym or cook block is cancelled from chat, where it's
          undoable. */}
      {isClass && (
        <div className="shrink-0 border-t border-rule p-3">
          {!confirmDrop ? (
            <Button
              variant="ghost"
              className="w-full justify-start px-2 text-signal"
              onClick={() => {
                setDropError(null);
                setConfirmDrop(true);
              }}
            >
              Drop this class
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="t-label px-2 text-ink-soft">
                Remove {inst.title} for the rest of the semester? This can’t be undone.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={dropping}
                  className="!bg-signal"
                  onClick={() => void doDrop()}
                >
                  {dropping ? 'Dropping…' : 'Drop it'}
                </Button>
                <Button
                  variant="ghost"
                  disabled={dropping}
                  onClick={() => setConfirmDrop(false)}
                >
                  Keep it
                </Button>
              </div>
            </div>
          )}
          {dropError && <p className="t-label px-2 pt-2 text-ink-soft">{dropError}</p>}
        </div>
      )}

      {/* Delete a movable block. The click-to-delete counterpart to dropping a
          class: an advising appointment, or just one gym day. A recurring block
          loses only THIS occurrence; a one-off goes entirely. Undoable (Cmd-Z),
          so it doesn't threaten permanence the way dropping a class does. */}
      {!isClass && (
        <div className="shrink-0 border-t border-rule p-3">
          {!confirmDel ? (
            <Button
              variant="ghost"
              className="w-full justify-start px-2 text-signal"
              onClick={() => {
                setDelError(null);
                setConfirmDel(true);
              }}
            >
              {inst.recurring ? 'Delete just this one' : 'Delete this block'}
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="t-label px-2 text-ink-soft">
                {inst.recurring
                  ? `Delete just this ${inst.title}? The rest of the series stays. ⌘Z undoes it.`
                  : `Delete ${inst.title}? ⌘Z undoes it.`}
              </p>
              <div className="flex gap-2">
                <Button variant="primary" disabled={deleting} onClick={() => void doDelete()}>
                  {deleting ? 'Deleting…' : 'Delete'}
                </Button>
                <Button variant="ghost" disabled={deleting} onClick={() => setConfirmDel(false)}>
                  Keep it
                </Button>
              </div>
            </div>
          )}
          {delError && <p className="t-label px-2 pt-2 text-ink-soft">{delError}</p>}
        </div>
      )}
    </div>
  );
}

export default EventPopover;
