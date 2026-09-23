'use client';

/**
 * One feed row. Collapsed: company, title, the first two locations, when it
 * was posted, a NEW badge inside 72h, the status pill, and the posting link.
 * Clicking the text expands IN PLACE (no navigation, no drawer): every
 * location, the terms, sponsorship, source, the applied date, and — once the
 * role is tracked — a notes textarea that saves on blur. A note has to live
 * on an application row, so an untracked role shows a one-line hint instead
 * of a textarea that couldn't persist.
 */
import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import type { AppStatus, InternshipItem } from '@/lib/api';
import { StatusPill } from './status-pill';
import { fmtDay, isNew, timeAgo } from './format';

export function InternshipRow({
  item,
  onStatus,
  onNotes,
}: {
  item: InternshipItem;
  onStatus(id: string, status: AppStatus | null): void;
  onNotes(id: string, notes: string | null): void;
}) {
  const [open, setOpen] = useState(false);
  const app = item.application;

  // React fires no blur on unmount, and a refetch that shrinks the list (page
  // 0 replaces "Load more" pages) unmounts rows mid-edit — so the latest
  // unsaved draft is flushed from the cleanup instead of silently dropped.
  const draftRef = useRef<string | null>(null);
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    const draft = draftRef.current;
    if (draft === null || !app) return;
    draftRef.current = null;
    const next = draft.trim();
    if (next !== (app.notes ?? '').trim()) onNotes(item.id, next || null);
  };
  useEffect(() => () => flushRef.current(), []);

  const shownLocs = item.locations.slice(0, 2).join(' · ');
  const moreLocs = item.locations.length - 2;

  return (
    <li className="border-b border-rule">
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 flex-1 py-3 text-left"
        >
          <span className="flex items-baseline gap-2">
            <span className={clsx('t-body truncate font-semibold', item.active ? 'text-ink' : 'text-ink-soft')}>
              {item.company}
            </span>
            {/* applied_at survives status moves (oa/offer/…), so the check
                stays once a real application went out */}
            {app?.applied_at && (
              <span className="t-micro shrink-0 text-ink" title="Applied" aria-label="Applied">
                ✓
              </span>
            )}
            {/* Not --signal: DESIGN.md reserves the accent for look-here-now
                (the now line, conflicts), and a fresh sync can badge half the
                first screen. The micro face alone carries it. */}
            {isNew(item.date_posted) && (
              <span className="t-micro shrink-0 text-ink">New</span>
            )}
            {!item.active && <span className="t-micro shrink-0 text-ink-soft">Closed</span>}
          </span>
          <span className="t-label block truncate text-ink-soft">{item.title}</span>
          <span className="flex items-baseline gap-2">
            {item.locations.length > 0 && (
              <span className="t-label min-w-0 truncate text-ink-soft">
                {shownLocs}
                {moreLocs > 0 ? ` +${moreLocs} more` : ''}
              </span>
            )}
            <span className="t-time shrink-0 text-ink-soft">{timeAgo(item.date_posted)}</span>
          </span>
        </button>
        <StatusPill status={app?.status ?? null} onChange={(s) => onStatus(item.id, s)} />
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open the ${item.company} posting`}
          className="t-label shrink-0 px-1 text-ink-soft hover:text-ink"
          style={{ transition: 'color var(--fast) var(--ease)' }}
        >
          ↗
        </a>
      </div>

      {open && (
        <div className="pb-4">
          {item.locations.length > 0 && (
            <p className="t-label text-ink-soft">{item.locations.join(' · ')}</p>
          )}
          <p className="t-label text-ink-soft">
            {[
              item.terms.join(' · ') || null,
              item.category,
              item.sponsorship,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <p className="t-time pt-1 text-ink-soft">
            via {item.source} · posted {fmtDay(item.date_posted)} · updated {fmtDay(item.date_updated)}
          </p>
          {app?.applied_at && (
            <p className="t-label pt-1 text-ink-soft">Applied {fmtDay(app.applied_at)}</p>
          )}

          {app ? (
            <div className="pt-2">
              <label className="t-micro text-ink-soft" htmlFor={`notes-${item.id}`}>
                Notes
              </label>
              <textarea
                id={`notes-${item.id}`}
                rows={3}
                maxLength={2000}
                defaultValue={app.notes ?? ''}
                placeholder="Saved when you click away"
                onChange={(e) => {
                  draftRef.current = e.target.value;
                }}
                onBlur={(e) => {
                  draftRef.current = null;
                  const next = e.target.value.trim();
                  if (next !== (app.notes ?? '').trim()) onNotes(item.id, next || null);
                }}
                className="t-label mt-1 w-full rounded-r border border-rule bg-paper px-3 py-2 text-ink placeholder:text-ink-soft"
              />
            </div>
          ) : (
            <p className="t-label pt-2 text-ink-soft">Track this role to keep notes on it.</p>
          )}
        </div>
      )}
    </li>
  );
}

export default InternshipRow;
