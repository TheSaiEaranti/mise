'use client';

/**
 * The diff card — where you decide whether to trust the assistant.
 *
 * Changed values render in --signal until approved. Pinned rows the proposal
 * left alone ALWAYS render, recessed, labeled "unchanged" — seeing what it
 * refused to touch is how trust gets built. A blocking conflict replaces the
 * Approve button with the reason; never an enabled button that will fail.
 *
 * Entrance: fade + 8px rise over var(--slow) (opacity/transform only — space
 * is reserved, no layout shift). On approve the card collapses over
 * var(--base) while the week view's blocks slide to their new positions.
 */
import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { fmt12, fmtDateLong, fmtRange12 } from '@mise/core/time';
import {
  describeConflict,
  isActionable,
  severityOf,
  type EventChange,
  type ProposalRow,
  type UnchangedPinned,
} from '@/lib/api';
import { Button } from '@/components/ui/button';

const CARD_CSS = `@keyframes mise-diff-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`;

export interface DiffCardProps {
  proposal: ProposalRow;
  /** Just approved: values re-render in --ink and the card collapses. */
  approved: boolean;
  /**
   * ALREADY DONE. The assistant applied this itself, so the card is a receipt,
   * not a request: no Approve, no Reject — just what changed, any warning the
   * validator raised, and a way to put it back. (Only shown when `onUndo` is
   * given; a change we can't reverse exactly never claims it can be.)
   */
  done?: boolean;
  onUndo?(): void | Promise<void>;
  onApprove(): void | Promise<void>;
  onReject(): void | Promise<void>;
}

export function DiffCard({ proposal, approved, done, onUndo, onApprove, onReject }: DiffCardProps) {
  const { diff, conflicts } = proposal;
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  // Approve success → collapse: max-height/opacity over var(--base).
  useEffect(() => {
    const el = shellRef.current;
    if (!el || !approved) return;
    el.style.maxHeight = `${el.scrollHeight}px`;
    el.style.overflow = 'hidden';
    void el.offsetHeight; // flush so the transition has a starting value
    el.style.transition = 'max-height var(--base) var(--ease), opacity var(--base) var(--ease)';
    el.style.maxHeight = '0px';
    el.style.opacity = '0';
  }, [approved]);

  const warnings = conflicts.filter((c) => severityOf(c) === 'warning');
  const blocking = conflicts.find((c) => severityOf(c) === 'blocking');
  // A diff with nothing in it applies nothing — the API refuses to approve it.
  // Show the reason where the button would be rather than an enabled button
  // that will fail (DESIGN.md, the diff card's last rule).
  const inert = !isActionable(diff);
  const refusal = blocking
    ? describeConflict(blocking)
    : inert
      ? (conflicts.map(describeConflict)[0] ?? 'Nothing to apply.')
      : null;
  // --signal marks a value that is proposed and not yet real. A change the
  // assistant already made IS real, so it renders in plain ink — the orange is
  // reserved for things still waiting on you.
  const newTime = approved || done ? 'text-ink' : 'text-signal';

  const run = (fn: () => void | Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const alternates = (diff.candidates ?? []).slice(1);
  const hasRows =
    diff.changes.length > 0 ||
    (diff.workout_changes?.length ?? 0) > 0 ||
    (diff.meal_changes?.length ?? 0) > 0;

  return (
    <div ref={shellRef} className="w-full">
      <style href="mise-diff-kf" precedence="default">
        {CARD_CSS}
      </style>
      <div
        className="rounded-r border border-rule bg-paper p-4 shadow-lift"
        style={{ animation: 'mise-diff-in var(--slow) var(--ease) both' }}
      >
        <p className="t-body" style={{ fontWeight: 600 }}>
          {diff.summary}
        </p>
        {diff.detail && <p className="t-label pt-1 text-ink-soft">{diff.detail}</p>}

        {hasRows && (
          <div className="flex flex-col gap-2 pt-3">
            {diff.changes.map((ch) => (
              <ChangeRow key={`${ch.event_id}:${ch.instance_date}`} ch={ch} newTime={newTime} />
            ))}
            {(diff.meal_changes ?? []).map((mc, i) => (
              <p key={`meal-${i}`} className={clsx('t-body', newTime)}>
                {mc}
              </p>
            ))}
            {(diff.workout_changes ?? []).map((wc, i) => (
              <p key={`workout-${i}`} className={clsx('t-body', newTime)}>
                {wc}
              </p>
            ))}
          </div>
        )}

        {alternates.length > 0 && (
          <p className="t-label pt-2 text-ink-soft">
            Also free:{' '}
            {alternates.map((c) => `${fmtDateLong(c.date, 'EEE')} ${fmt12(c.start_time)}`).join(' · ')}
          </p>
        )}

        {diff.unchanged_pinned.length > 0 && (
          <div className="mt-3 flex flex-col gap-1 border-t border-rule pt-3">
            {diff.unchanged_pinned.map((u) => (
              <PinnedRow key={`${u.event_id}:${u.instance_date}`} u={u} />
            ))}
          </div>
        )}

        {warnings.length > 0 && (
          <div className="flex flex-col gap-2 pt-3">
            {warnings.map((c, i) => (
              <div key={`warn-${i}`} className="flex items-start gap-2">
                <WarnGlyph />
                <span className="t-label text-ink-soft">{describeConflict(c)}</span>
              </div>
            ))}
          </div>
        )}

        {done ? (
          // A receipt, not a request. It already happened; the only question is
          // whether you want it kept.
          <div className="flex items-center gap-3 pt-4">
            {undone ? (
              <span className="t-label text-ink-soft">Put back.</span>
            ) : (
              onUndo && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={run(async () => {
                    await onUndo();
                    setUndone(true);
                  })}
                >
                  Undo
                </Button>
              )
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 pt-4">
            {refusal !== null ? (
              <span className="t-label min-w-0 flex-1 text-ink-lock">{refusal}</span>
            ) : (
              <Button onClick={run(onApprove)} disabled={busy || approved}>
                Approve
              </Button>
            )}
            <Button variant="ghost" onClick={run(onReject)} disabled={busy || approved}>
              Reject
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ChangeRow({ ch, newTime }: { ch: EventChange; newTime: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={clsx('t-body min-w-0 truncate', !ch.after && 'text-ink-soft')}>
        {ch.title}
        {/* Nobody asked for this row. Without the label it reads as the app
            moving something at random; with it, it reads as the schedule doing
            its job. */}
        {ch.knock_on === true && <span className="t-label pl-2 text-ink-soft">made room</span>}
      </span>
      {ch.before && ch.after && (
        <span className="t-time shrink-0 whitespace-nowrap text-ink-soft">
          {fmt12(ch.before.starts_at)} → <span className={newTime}>{fmt12(ch.after.starts_at)}</span>
        </span>
      )}
      {!ch.before && ch.after && (
        <span className={clsx('t-time shrink-0 whitespace-nowrap', newTime)}>
          + {fmtRange12(ch.after.starts_at, ch.after.ends_at)}
        </span>
      )}
      {ch.before && !ch.after && (
        <span className="t-time shrink-0 whitespace-nowrap text-ink-soft line-through">
          {fmtRange12(ch.before.starts_at, ch.before.ends_at)}
        </span>
      )}
    </div>
  );
}

/** A pinned row the proposal did not touch — recessed, spine, "unchanged". */
function PinnedRow({ u }: { u: UnchangedPinned }) {
  return (
    <div
      className="flex items-baseline gap-3 rounded-r bg-recessed px-2 py-1 text-ink-lock shadow-inset-pin"
      style={{ borderLeft: '2px solid var(--ink-lock)' }}
    >
      <span className="t-body min-w-0 flex-1 truncate">{u.title}</span>
      {/* The day, not just the hour. A change can span a few days, and three
          rows reading "CS 429 · 10 AM · unchanged" look like a rendering bug
          rather than three different lectures. */}
      <span className="t-time shrink-0 text-ink-lock">
        {fmtDateLong(u.instance_date, 'EEE')} {fmt12(u.starts_at)}
      </span>
      <span className="t-label shrink-0 text-ink-lock">unchanged</span>
    </div>
  );
}

function WarnGlyph() {
  return (
    <svg
      className="mt-[3px] shrink-0"
      width="11"
      height="11"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path
        d="M6 1.4 L11.2 10.6 H0.8 Z"
        fill="none"
        stroke="var(--signal)"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
