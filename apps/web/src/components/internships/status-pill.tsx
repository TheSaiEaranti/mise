'use client';

/**
 * The status pill — the one control the board has, shared by Feed and
 * Tracker. Untracked shows a quiet "Track" affordance; tracked shows the
 * status as a compact pill. Clicking either opens a small raised card (the
 * event-popover language: no modal, no backdrop, closes on outside
 * pointerdown or Escape) with the seven pipeline statuses plus Untrack.
 *
 * Each status is a token treatment, not a new color: interested sits on the
 * paper, applied/OA are recessed (filed, like a pinned block), interview is
 * ink, an offer is the one place --signal appears on this screen besides the
 * NEW badge, and rejected/ghosted are muted. The parent owns the optimistic
 * update; this component only reports the choice.
 */
import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import type { AppStatus } from '@/lib/api';

/** Pipeline order — interested → … → ghosted. Tracker groups render in this order. */
export const STATUS_ORDER: AppStatus[] = [
  'interested',
  'applied',
  'oa',
  'interview',
  'offer',
  'rejected',
  'ghosted',
];

export const STATUS_LABEL: Record<AppStatus, string> = {
  interested: 'Interested',
  applied: 'Applied',
  oa: 'OA',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  ghosted: 'Ghosted',
};

/** Token-only treatments. Depth and ink do the work; --signal marks the offer. */
const PILL: Record<AppStatus, string> = {
  interested: 'border border-rule bg-paper text-ink',
  applied: 'bg-recessed text-ink-lock',
  oa: 'border-l-2 border-ink-lock bg-recessed text-ink-lock',
  interview: 'bg-ink text-paper',
  offer: 'border border-signal bg-paper text-signal',
  rejected: 'border border-rule bg-paper text-ink-soft',
  ghosted: 'bg-paper text-ink-soft',
};

export interface StatusPillProps {
  status: AppStatus | null;
  onChange(next: AppStatus | null): void;
  disabled?: boolean;
}

export function StatusPill({ status, onChange, disabled }: StatusPillProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && !ref.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{ transition: 'background-color var(--fast) var(--ease), color var(--fast) var(--ease)' }}
        className={clsx(
          't-micro inline-flex h-8 select-none items-center rounded-r px-2.5',
          'disabled:cursor-default disabled:opacity-40',
          status ? PILL[status] : 'text-ink-soft hover:text-ink',
        )}
      >
        {status ? STATUS_LABEL[status] : 'Track'}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Application status"
          className="absolute right-0 top-full z-20 mt-1 w-36 rounded-r border border-rule bg-paper p-1 shadow-lift"
        >
          {STATUS_ORDER.map((s) => (
            <button
              key={s}
              type="button"
              role="menuitemradio"
              aria-checked={s === status}
              onClick={() => {
                setOpen(false);
                if (s !== status) onChange(s);
              }}
              className={clsx(
                't-label flex w-full items-baseline justify-between gap-2 rounded-r px-2 py-1.5 text-left hover:bg-recessed',
                s === status ? 'text-ink' : 'text-ink-soft',
              )}
            >
              {STATUS_LABEL[s]}
              {s === status && <span aria-hidden="true">✓</span>}
            </button>
          ))}
          {status && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onChange(null);
              }}
              className="t-label mt-1 flex w-full items-baseline border-t border-rule px-2 py-1.5 text-left text-ink-soft hover:bg-recessed"
            >
              Untrack
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default StatusPill;
