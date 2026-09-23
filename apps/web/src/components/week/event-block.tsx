'use client';

/**
 * One event on the grid.
 *
 * DEPTH still encodes the entire interaction model — color is only a second
 * channel (what the block IS), depth is the meaning (whether it can MOVE):
 * pinned = recessed INTO the page (fill, 2px left spine, inset shadow, no
 * drag); movable = raised ON it (fill, soft tinted hairline, lift shadow, grab).
 *
 * Drag (desktop pointer, movable only): 4px slop arms it, then the block lifts
 * (--lift-drag + 2° tilt) and follows the pointer in BOTH axes — snapped to the
 * day column under the cursor and to 15-minute steps. Drop reverts the visual
 * immediately and files a shift_events proposal — the same code path as chat.
 * The block does not move until the proposal is approved.
 *
 * Click (pointer moved less than the slop) opens the color popover instead.
 */
import { flipKey } from '@/lib/use-commit-slide';
import { useCallback, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { fmtRange12 } from '@mise/core/time';
import { colorSpec, type EventInstance } from '@/lib/api';
import { EventPopover } from './event-popover';
import {
  DAY_END_MIN,
  DAY_START_MIN,
  SNAP_MINUTES,
  type BlockRect,
  type Geometry,
} from './geometry';

const DRAG_SLOP_PX = 4;
const MINUTES_PER_DAY = 1440;

/**
 * The line budget.
 *
 * The whole day fits the viewport, so blocks are SHORT: at a laptop scale a
 * 90-min gym block is ~57px, a 75-min class ~47px, a 60-min cook ~38px — and
 * every one of them shrinks again the moment anything opens ABOVE the grid (the
 * drag note, the import panel), because the grid is sized from the room left
 * under the header. The box is therefore measured, not guessed.
 *
 * LEADING is the lever, never the type. DESIGN fixes five type SIZES; it does
 * not fix line-height, so each line gets the tightest box its own face can sit
 * in rather than one flat rhythm for all of them:
 *
 *   t-body 15px  → 16   the title
 *   t-time 12px  → 13   the range. Mono, and its glyphs are digits, ':', '–'
 *                       and AM/PM — not one of which has a descender, so this
 *                       is the cheapest line in the block.
 *   t-label 13px → 14   the subtitle and the location
 *
 * A flat 16px rhythm charged 48px for three lines, which is why a 60-minute
 * block used to drop its range entirely at 35px and show a bare "Cook lunches".
 * At 16/13/14 three lines cost 43px and two cost 29px, and a 35px block keeps
 * its range.
 *
 * Then LINES shed, poorest-first — location, then subtitle, then the range —
 * and PADDING gives before any of them. Nothing ever shrinks off the scale.
 */
const L_TITLE = 16; // t-body
const L_TIME = 13; // t-time
const L_META = 14; // t-label — subtitle and location
const PAD_ROOMY = 4; // py-1, per side
const PAD_TIGHT = 2; // py-0.5, per side

interface Fit {
  /** Line 1. The title — unless the subtitle had to take it. See below. */
  headline: string;
  showTime: boolean;
  showSubtitle: boolean;
  showLocation: boolean;
  /** Vertical padding per side, in px. */
  pad: number;
}

/**
 * What fits in `height`, and how much air is left over for padding.
 *
 * THE HEADLINE IS THE SPECIFIC THING, NOT THE GENERIC ONE.
 *
 * "Gym" four times a week tells you nothing you didn't already know; the fact
 * you opened the calendar to find is WHICH session it is. So when a block knows
 * something specific about itself — the split day, the recipe — that is the
 * first line, and the generic title steps aside:
 *
 *     Chest and back          Chipotle Chicken Rice Bowls
 *     5 – 6:30 PM             6:45 – 7:45 PM
 *     Gregory Gym
 *
 * Nothing is lost by dropping "Gym": the colour already says what kind of block
 * it is, and the popover's first line is still the title. What is gained is a
 * column that reads as Monday-chest, Tuesday-shoulders, Wednesday-tacos rather
 * than Gym, Gym, Cook, Cook. A block with nothing specific to say (a class, a
 * one-off) keeps its own title, because that IS its specific thing.
 *
 * This also settles a size problem rather than fighting it. A 60-minute block is
 * ~38px and three lines cost 43px + padding; the day is 1080 minutes and must
 * not scroll, so no viewport this runs at fits all three. Promoting the subtitle
 * means the useful line is never the one that gets dropped.
 */
function fitLines(inst: EventInstance, height: number): Fit {
  // Movable blocks carry a 1px border top AND bottom; pinned ones only a spine.
  const border = inst.pinned ? 0 : 2;
  // Fit against the tightest padding the block is allowed to keep.
  const room = height - border - PAD_TIGHT * 2;

  // The specific label wins line 1 whenever there is one; the generic title is
  // then redundant on the block and never rendered.
  const headline = inst.subtitle || inst.title;

  let used = L_TITLE; // line 1 is never in question
  const take = (cost: number): boolean => {
    if (used + cost > room) return false;
    used += cost;
    return true;
  };

  const showTime = take(L_TIME);
  // The subtitle IS the headline now, so line 3 is the location's to win.
  const showSubtitle = false;
  const showLocation = Boolean(inst.location) && take(L_META);

  // Hand back whatever air is left, up to py-1.
  const slack = height - border - used;
  const pad = slack >= PAD_ROOMY * 2 ? PAD_ROOMY : slack >= PAD_TIGHT * 2 ? PAD_TIGHT : 0;

  return { headline, showTime, showSubtitle, showLocation, pad };
}

export interface ColumnHit {
  index: number;
  width: number;
}

interface DragState {
  dx: number;
  dy: number;
  dayDelta: number;
  minuteDelta: number;
}

interface EventBlockProps {
  inst: EventInstance;
  geo: Geometry;
  rect: BlockRect;
  /** Index of the column this block lives in (0 = Monday). */
  dayIndex: number;
  /** A pending proposal touches this instance → 1px --signal border. */
  pending: boolean;
  /** Which day column a client-x lands in, and how wide a column is. */
  columnAt(clientX: number): ColumnHit | null;
  /** Applies the move. Awaited so the block can hold its dropped position. */
  onProposeShift(inst: EventInstance, deltaMinutes: number): void | Promise<void>;
  /** Applies a resize: exact new start/end ('HH:mm'). Awaited like the move. */
  onSetTime(inst: EventInstance, startTime: string, endTime: string): void | Promise<void>;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const minToHM = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;

export function EventBlock({
  inst,
  geo,
  rect,
  dayIndex,
  pending,
  columnAt,
  onProposeShift,
  onSetTime,
}: EventBlockProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  /** Dropped, waiting on the server. The block stays put; no bounce. */
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  /** Resize: steps of SNAP_MINUTES added to the END while dragging the bottom
   *  edge. null = not resizing. */
  const [resizeSteps, setResizeSteps] = useState<number | null>(null);
  const resizeArmed = useRef<{ pointerId: number; startY: number; moved: boolean } | null>(null);
  const resizeStepsRef = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  const armed = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    canDrag: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const blockRef = useRef<HTMLDivElement | null>(null);

  // While busy the card keeps its lifted look — it is still "in hand".
  const dragging = drag !== null;
  const lifted = dragging || busy;
  const spec = colorSpec(inst.color, inst.kind);
  const { top, height, startMin, endMin } = rect;

  // Clamps live in MINUTES, not pixels: snapPx is fractional at most scales and
  // a pixel-space clamp would drift a step at a time.
  const maxUpSteps = Math.max(0, Math.floor((startMin - DAY_START_MIN) / SNAP_MINUTES));
  const maxDownSteps = Math.max(0, Math.floor((DAY_END_MIN - endMin) / SNAP_MINUTES));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    suppressClick.current = false;
    // Drag is desktop-only and movable-only; a pinned block still arms so that a
    // dragging gesture on it doesn't land as a recolor click.
    const canDrag = !inst.pinned && e.pointerType !== 'touch';
    armed.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false, canDrag };
    if (canDrag) e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const a = armed.current;
    if (!a || e.pointerId !== a.pointerId) return;
    const dx = e.clientX - a.startX;
    const dy = e.clientY - a.startY;
    if (!a.moved) {
      if (Math.abs(dx) <= DRAG_SLOP_PX && Math.abs(dy) <= DRAG_SLOP_PX) return;
      a.moved = true;
      suppressClick.current = true; // past the slop → it was a drag, not a click
    }
    if (!a.canDrag) return;

    const steps = Math.max(-maxUpSteps, Math.min(maxDownSteps, Math.round(dy / geo.snapPx)));
    const hit = columnAt(e.clientX);
    const dayDelta = hit ? hit.index - dayIndex : (dragRef.current?.dayDelta ?? 0);
    const colWidth = hit?.width ?? 0;
    const next: DragState = {
      dx: Math.round(dayDelta * colWidth),
      dy: Math.round(steps * geo.snapPx),
      dayDelta,
      minuteDelta: steps * SNAP_MINUTES,
    };
    dragRef.current = next;
    setDrag(next);
  };

  const endDrag = (commit: boolean) => {
    const a = armed.current;
    const d = dragRef.current;
    armed.current = null;
    dragRef.current = null;

    const delta = d ? d.dayDelta * MINUTES_PER_DAY + d.minuteDelta : 0;
    if (!a?.moved || !d || !commit || delta === 0) {
      setDrag(null);
      return;
    }

    // HOLD the block at the slot you dropped it in until the server has moved
    // it. Clearing the offset now would snap it back to the old time for the
    // ~100ms round trip and then slide it forward — a visible bounce. When the
    // refetch lands, `top` is already the new time, so dropping the offset here
    // is invisible. If the move was refused, this is what returns it home.
    setBusy(true);
    void Promise.resolve(onProposeShift(inst, delta)).finally(() => {
      setBusy(false);
      setDrag(null);
    });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (armed.current && e.pointerId === armed.current.pointerId) endDrag(true);
  };
  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (armed.current && e.pointerId === armed.current.pointerId) endDrag(false);
  };
  const onClick = () => {
    if (suppressClick.current) return;
    setOpen((v) => !v);
  };
  const closePopover = useCallback(() => setOpen(false), []);

  // Resize: drag the bottom edge to change the END time, snapped to 15 min. The
  // start is fixed; you're stretching or shrinking how long the block runs. It
  // commits through set_event_time — the same make-room path as a move — so a
  // block you grow onto the next one pushes it, and one grown onto a class is
  // refused. Its own gesture on a child handle, so it never arms a move.
  //
  // Bounds in minutes: never shorter than one snap, never past 15 min before
  // midnight (the grid's edge, and set_event_time can't take 24:00).
  const minResizeSteps = Math.ceil((startMin + SNAP_MINUTES - endMin) / SNAP_MINUTES);
  const maxResizeSteps = Math.floor((DAY_END_MIN - SNAP_MINUTES - endMin) / SNAP_MINUTES);

  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || inst.pinned || e.pointerType === 'touch') return;
    e.stopPropagation();
    resizeArmed.current = { pointerId: e.pointerId, startY: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const a = resizeArmed.current;
    if (!a || e.pointerId !== a.pointerId) return;
    e.stopPropagation();
    const dy = e.clientY - a.startY;
    if (!a.moved) {
      if (Math.abs(dy) <= DRAG_SLOP_PX) return;
      a.moved = true;
    }
    const steps = Math.max(minResizeSteps, Math.min(maxResizeSteps, Math.round(dy / geo.snapPx)));
    resizeStepsRef.current = steps;
    setResizeSteps(steps);
  };
  const endResize = (commit: boolean) => {
    const a = resizeArmed.current;
    const steps = resizeStepsRef.current;
    resizeArmed.current = null;
    resizeStepsRef.current = 0;
    if (!a?.moved || !commit || steps === 0) {
      setResizeSteps(null);
      return;
    }
    const newEndMin = endMin + steps * SNAP_MINUTES;
    setBusy(true);
    void Promise.resolve(onSetTime(inst, minToHM(startMin), minToHM(newEndMin))).finally(() => {
      setBusy(false);
      setResizeSteps(null);
    });
  };
  const onResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (resizeArmed.current?.pointerId === e.pointerId) endResize(true);
  };
  const onResizeCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (resizeArmed.current?.pointerId === e.pointerId) endResize(false);
  };
  const resizing = resizeSteps !== null && resizeSteps !== 0;
  const resizeExtraPx = resizeSteps !== null ? resizeSteps * geo.snapPx : 0;
  const raised = lifted || resizing;

  // The WHOLE timeframe, always — never a bare start time. 12-hour and terse:
  // '5 – 6:30 PM', not '17:00 – 18:30'. The meridiem is said once when both ends
  // share it, so the range costs barely more width than one end of it did. While
  // resizing, the END tracks the drag live so the label reads the new length as
  // you stretch it.
  const liveEnd = resizing
    ? `${inst.instance_date}T${minToHM(endMin + (resizeSteps ?? 0) * SNAP_MINUTES)}`
    : inst.ends_at;
  const time = fmtRange12(inst.starts_at, liveEnd);
  const subtitle = inst.subtitle ?? null;

  // Line 1 the headline, line 2 the range UNDER it (never beside it), line 3
  // what this block actually is — "Chest and back", "Chipotle Chicken Rice
  // Bowls". A gym block that only says "Gym" tells you nothing, so the subtitle
  // outranks the location, which takes whatever line is left over.
  const { headline, showTime, showSubtitle, showLocation, pad } = fitLines(inst, height);

  return (
    <>
      <div
        ref={blockRef}
        data-flip-key={flipKey(inst.title, inst.starts_at)}
        className={clsx(
          'absolute left-1 right-1 select-none overflow-hidden rounded-r px-2',
          inst.pinned
            ? 'cursor-default shadow-inset-pin'
            : clsx(
                'border',
                raised
                  ? 'z-20 shadow-lift-drag'
                  : 'cursor-grab shadow-lift hover:shadow-lift-drag',
                raised && !resizing && 'cursor-grabbing',
              ),
        )}
        style={{
          top,
          height: height + resizeExtraPx,
          paddingTop: pad,
          paddingBottom: pad,
          background: spec.fill,
          color: spec.ink,
          // Pinned: the spine is the fixed point your eye catches. Movable: a
          // soft 20%-alpha tint of the same line color — present enough to read
          // as a raised card edge, quiet enough not to compete with the spine.
          borderLeft: inst.pinned ? `2px solid ${spec.line}` : undefined,
          borderColor: inst.pinned ? undefined : pending ? 'var(--signal)' : `${spec.line}33`,
          // `translate` and `rotate` are set as INDIVIDUAL transform properties,
          // not a single `transform`, so they can transition independently:
          // translate must track the pointer with zero delay, while the 2° tilt
          // and the shadow bloom animate over --fast — the card feels picked up
          // rather than teleported (motion rule 2).
          // The offset survives the drop (`lifted`, not `dragging`) so the block
          // stays in the slot you put it in while the server catches up.
          translate: drag ? `${drag.dx}px ${drag.dy}px` : undefined,
          rotate: dragging ? '2deg' : '0deg',
          // Stable key + top computed from data: when the move commits and the
          // week refetches, `top` is already the new time — so releasing the
          // offset is invisible, and a move made from CHAT still slides here
          // (motion rule 3). `top` never transitions mid-drag or the card lags.
          transition: raised
            ? 'box-shadow var(--fast) var(--ease), rotate var(--fast) var(--ease)'
            : 'top var(--slow) var(--ease), height var(--slow) var(--ease), box-shadow var(--fast) var(--ease), rotate var(--fast) var(--ease)',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={onClick}
      >
        <p className="t-body truncate" style={{ lineHeight: `${L_TITLE}px` }}>
          {headline}
        </p>
        {showTime && (
          <p className="t-time truncate" style={{ lineHeight: `${L_TIME}px` }}>
            {time}
          </p>
        )}
        {showSubtitle && (
          <p className="t-label truncate" style={{ lineHeight: `${L_META}px` }}>
            {subtitle}
          </p>
        )}
        {showLocation && (
          <p className="t-label truncate" style={{ lineHeight: `${L_META}px` }}>
            {inst.location}
          </p>
        )}

        {/* Resize handle — the bottom edge. Movable blocks only. A hairline grip
            that firms up on hover; the whole strip is the target so it's easy to
            grab even on a short block. Its own pointer gesture (stopPropagation),
            so grabbing the edge never arms a move. */}
        {!inst.pinned && (
          <div
            className="group/resize absolute inset-x-0 bottom-0 flex h-2 cursor-ns-resize items-end justify-center"
            style={{ touchAction: 'none' }}
            aria-hidden="true"
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeCancel}
            onClick={(e) => e.stopPropagation()}
          >
            <span
              className="mb-0.5 h-[2px] w-5 rounded-r opacity-0 transition-opacity group-hover/resize:opacity-60"
              style={{ background: spec.ink, opacity: resizing ? 0.6 : undefined }}
            />
          </div>
        )}
      </div>

      {open && <EventPopover inst={inst} anchorRef={blockRef} onClose={closePopover} />}
    </>
  );
}
