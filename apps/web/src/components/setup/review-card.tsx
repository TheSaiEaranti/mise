'use client';

/**
 * The wizard's diff card — same rules as the chat diff card (DESIGN.md):
 * created values render in --signal with mono times, untouched pinned rows
 * render recessed and labeled `unchanged`, warnings get a --signal glyph with
 * --ink-soft text, and a blocking conflict replaces the Approve button with
 * its reason (never an enabled button that will fail).
 * Entrance: fade + 8px rise at --slow — one of the four sanctioned animations
 * (prefers-reduced-motion zeroes it globally).
 */
import { useEffect, useState } from 'react';
import { fmt12, fmtDateLong, fmtRange12 } from '@mise/core/time';
import { describeConflict, severityOf, type ProposalRow, type SemesterSetupBody } from '@/lib/api';
import { Button } from '@/components/ui/button';

export function SetupReviewCard({
  proposal,
  busy,
  notice,
  onApprove,
  onBack,
}: {
  proposal: ProposalRow;
  busy: boolean;
  notice: string | null;
  onApprove: () => void;
  onBack: () => void;
}) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  /** Validated setup_semester args, straight off the proposal row — the class
   *  list here is server truth, index-aligned with diff.changes. */
  const args = proposal.tool_args as unknown as Partial<SemesterSetupBody>;
  const blocking = proposal.conflicts.filter((c) => severityOf(c) === 'blocking');
  const warnings = proposal.conflicts.filter((c) => severityOf(c) === 'warning');
  const canApprove = proposal.status === 'pending' && blocking.length === 0 && !busy;

  return (
    <div
      className="rounded-r border border-rule bg-paper p-4 shadow-lift"
      style={{
        opacity: entered ? 1 : 0,
        transform: entered ? 'none' : 'translateY(8px)',
        transition: 'opacity var(--slow) var(--ease), transform var(--slow) var(--ease)',
      }}
    >
      <p className="t-body text-ink">{proposal.diff.summary}</p>

      <div className="mt-4 flex flex-col gap-3">
        {proposal.diff.changes.map((ch, i) => {
          const cls = args.classes?.[i];
          return (
            <div key={`${ch.event_id}-${ch.instance_date}`}>
              <div className="flex items-baseline justify-between gap-3">
                <p className="t-body min-w-0 truncate text-ink">{ch.title}</p>
                {ch.after && (
                  <p className="shrink-0 text-signal">
                    <span className="t-label">{fmtDateLong(ch.instance_date, 'EEE MMM d')}</span>{' '}
                    <span className="t-time">{fmtRange12(ch.after.starts_at, ch.after.ends_at)}</span>
                  </p>
                )}
              </div>
              {cls && (
                <p className="t-label text-ink-soft">
                  {cls.days.join('/')}{' '}
                  <span className="t-time">{fmtRange12(cls.start_time, cls.end_time)}</span> · weekly
                </p>
              )}
            </div>
          );
        })}
      </div>

      {proposal.diff.unchanged_pinned.length > 0 && (
        <div className="mt-4 flex flex-col gap-2 border-t border-rule pt-4">
          {proposal.diff.unchanged_pinned.map((u) => (
            <div
              key={`${u.event_id}-${u.instance_date}`}
              className="flex items-center rounded-r border-l-2 border-ink-lock bg-recessed px-3 py-2 shadow-inset-pin"
            >
              <span className="t-body min-w-0 flex-1 truncate text-ink-lock">{u.title}</span>
              <span className="t-time shrink-0 pl-3 text-ink-lock">{fmt12(u.starts_at)}</span>
              <span className="t-label shrink-0 pl-3 text-ink-lock">unchanged</span>
            </div>
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          {warnings.map((c, i) => (
            <p key={i} className="t-label text-ink-soft">
              <span aria-hidden="true" className="text-signal">
                {'⚠︎'}
              </span>{' '}
              {describeConflict(c)}
            </p>
          ))}
        </div>
      )}

      {notice && <p className="t-label mt-4 text-ink-soft">{notice}</p>}

      <div className="mt-6 flex items-center gap-3">
        {blocking.length > 0 ? (
          <p className="t-label text-signal">{describeConflict(blocking[0])}</p>
        ) : (
          <Button onClick={onApprove} disabled={!canApprove}>
            Approve
          </Button>
        )}
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
      </div>
    </div>
  );
}
