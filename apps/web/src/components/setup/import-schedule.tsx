'use client';

/**
 * Import a class schedule from a photo — the recipe-import flow (SPEC §8),
 * applied to classes: choose/drop/paste → read → EDITABLE PREVIEW → commit.
 *
 * The vision model is untrusted structured data. It gets ~85% right, so the
 * preview is the feature: every field is editable, unreadable rows are flagged
 * rather than guessed, and nothing is written until a diff is approved.
 *
 * Two modes, because the commit path differs by where you are:
 *   - `onParsed` (the wizard): hand the classes up. No semester exists yet
 *     during onboarding, so add_classes would only come back `no_semester`;
 *     the classes flow through the wizard's own setup_semester review instead.
 *   - default (the week): file an add_classes proposal and render its DiffCard.
 *     Never a direct write — same server path as chat (I2).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { TIME_RE } from '@mise/core/time';
import { createProposal, getProposal, importScheduleImage, type ProposalRow } from '@/lib/api';
import { useApp } from '@/lib/store';
import { Button } from '@/components/ui/button';
import { DiffCard } from '@/components/chat/diff-card';
import { DAY_CODES, DayChips, inputCls, type DayCode } from './fields';
import type { ClassInput } from './class-list';

/** Row state mirrors the form, not the wire: times stay strings so a
 *  half-typed "09:" is a state you can be in without the row exploding. */
interface Row {
  title: string;
  days: DayCode[];
  start: string;
  end: string;
  location: string;
}

const BLANK: Row = { title: '', days: [], start: '', end: '', location: '' };

/** Held while the approved card collapses — same beat as the chat panel. */
const COLLAPSE_HOLD_MS = 400;

const APPROVE_NOTICE: Record<string, string> = {
  needs_review: 'The schedule changed underneath this proposal — review and approve again.',
  blocked: 'A blocking conflict appeared — this proposal cannot be applied.',
  expired: 'This proposal expired. Read the photo again.',
};

function toRow(c: { title: string; days: string[]; start_time: string; end_time: string; location?: string }): Row {
  return {
    title: c.title ?? '',
    // Filter through DAY_CODES: canonical MO→SU order, and anything the model
    // invented ("MON", "M") is dropped rather than trusted into the args.
    days: DAY_CODES.filter((d) => c.days?.includes(d)),
    start: c.start_time ?? '',
    end: c.end_time ?? '',
    location: c.location ?? '',
  };
}

function toClass(r: Row): ClassInput {
  return {
    title: r.title.trim(),
    days: r.days,
    start_time: r.start,
    end_time: r.end,
    location: r.location.trim() || undefined,
  };
}

/** One line, under the offending row. Never fail silently at submit. */
function rowError(r: Row): string | null {
  if (!r.title.trim()) return 'Needs a title.';
  if (r.days.length === 0) return 'Pick at least one day.';
  if (!TIME_RE.test(r.start) || !TIME_RE.test(r.end)) return 'Needs a start and end time.';
  if (r.start >= r.end) return 'Ends before it starts.';
  return null;
}

export interface ImportScheduleProps {
  /** Wizard mode: take the parsed classes, skip the proposal entirely. */
  onParsed?: (classes: ClassInput[]) => void;
}

export function ImportSchedule({ onParsed }: ImportScheduleProps) {
  const { approve, reject, bumpSchedule } = useApp();

  const [image, setImage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [proposal, setProposal] = useState<ProposalRow | null>(null);
  const [approved, setApproved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const reset = useCallback(() => {
    setImage(null);
    setRows(null);
    setSkipped([]);
    setProposal(null);
    setApproved(false);
    setNotice(null);
    setError(null);
  }, []);

  /** All three routes — button, drop, paste — land here. */
  const takeFile = useCallback((file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('That file is not an image.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        setError('Could not read that file.');
        return;
      }
      setImage(reader.result);
      setRows(null);
      setSkipped([]);
      setProposal(null);
      setApproved(false);
      setNotice(null);
      setError(null);
      setAdded(false);
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsDataURL(file);
  }, []);

  // Paste is the fastest path: students screenshot the registrar page, then
  // ⌘V straight into the panel. Only image blobs are intercepted — pasting
  // text into the fields below still behaves like paste.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data) return;
      let file: File | null = data.files[0] ?? null;
      if (!file) {
        for (const item of Array.from(data.items)) {
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            file = item.getAsFile();
            break;
          }
        }
      }
      if (!file || !file.type.startsWith('image/')) return;
      e.preventDefault();
      takeFile(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [takeFile]);

  async function read() {
    if (!image || reading) return;
    setReading(true);
    setError(null);
    try {
      const res = await importScheduleImage(image);
      // Never a dead end: an unreadable photo still opens the preview with a
      // row to fill in by hand.
      setRows(res.classes.length > 0 ? res.classes.map(toRow) : [{ ...BLANK }]);
      setSkipped(res.skipped ?? []);
    } catch (e) {
      // 502 from the API — Ollama down, model missing, image unreadable. Its
      // message already tells you what to run.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  }

  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) => (rs ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    if (!rows || rows.length === 0 || submitting) return;
    const classes = rows.map(toClass);

    // Wizard mode: no semester exists yet, so these go into the wizard's list
    // and get created by setup_semester, not add_classes.
    if (onParsed) {
      onParsed(classes);
      reset();
      setAdded(false);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await createProposal(
        'add_classes',
        { classes },
        'Import class schedule from photo',
      );
      setProposal(res.proposal);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApprove() {
    if (!proposal) return;
    setNotice(null);
    try {
      const { status } = await approve(proposal.id);
      if (status === 'applied') {
        bumpSchedule();
        setApproved(true);
        // Let the card collapse before the panel clears out from under it.
        timerRef.current = window.setTimeout(() => {
          reset();
          setAdded(true);
        }, COLLAPSE_HOLD_MS);
        return;
      }
      // needs_review / blocked / expired: conflicts were re-derived server-side.
      const fresh = await getProposal(proposal.id).catch(() => null);
      if (fresh) setProposal(fresh.proposal);
      setNotice(APPROVE_NOTICE[status] ?? 'Could not apply the proposal.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleReject() {
    if (!proposal) return;
    const id = proposal.id;
    setProposal(null);
    setNotice(null);
    // Back to the preview with the edits intact — reject means "not like that".
    try {
      await reject(id);
    } catch (e) {
      console.warn('[import-schedule] reject failed', e);
    }
  }

  const errors = (rows ?? []).map(rowError);
  const valid = rows !== null && rows.length > 0 && errors.every((e) => e === null);

  if (proposal) {
    return (
      <div className="mt-4">
        <DiffCard
          proposal={proposal}
          approved={approved}
          onApprove={handleApprove}
          onReject={handleReject}
        />
        {notice && <p className="t-label mt-2 text-ink-soft">{notice}</p>}
        {error && <p className="t-label mt-2 text-ink-soft">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-r border border-rule p-4">
      {rows === null ? (
        <>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              takeFile(e.dataTransfer.files[0]);
            }}
            className={clsx(
              'flex flex-col items-center gap-3 rounded-r border border-dashed p-6 text-center',
              dragging ? 'border-ink-soft bg-recessed' : 'border-rule',
            )}
            style={{ transition: 'background-color var(--fast) var(--ease)' }}
          >
            <p className="t-label text-ink-soft">Drop a screenshot of your class schedule</p>
            <Button variant="secondary" className="h-11" onClick={() => fileRef.current?.click()}>
              Choose photo
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              aria-label="Class schedule photo"
              className="sr-only"
              onChange={(e) => {
                takeFile(e.target.files?.[0]);
                e.target.value = ''; // same file twice still fires change
              }}
            />
          </div>

          {image && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image}
                alt="Chosen class schedule"
                className="mt-3 max-h-[140px] rounded-r border border-rule"
              />
              <div className="mt-3 flex items-center gap-3">
                <Button disabled={reading} onClick={() => void read()}>
                  Read schedule
                </Button>
                {reading && (
                  <span className="t-body mise-dot text-ink-soft" aria-hidden="true">
                    ●
                  </span>
                )}
                <span role="status" className="sr-only">
                  {reading ? 'Reading the schedule…' : ''}
                </span>
              </div>
            </>
          )}

          {error && <p className="t-label mt-2 text-ink-soft">{error}</p>}
          {added && <p className="t-label mt-2 text-ink-soft">Added to your calendar.</p>}
        </>
      ) : (
        <>
          {image && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={image}
              alt="Chosen class schedule"
              className="max-h-[140px] rounded-r border border-rule"
            />
          )}

          {skipped.length > 0 && (
            <p className="t-label mt-3 text-ink-soft">
              Couldn&rsquo;t read {skipped.length} row{skipped.length === 1 ? '' : 's'}:{' '}
              {skipped.join(', ')}. Add them by hand.
            </p>
          )}

          <ul className="mt-3 flex flex-col">
            {rows.map((row, i) => (
              <li key={i} className="border-t border-rule py-3 first:border-t-0 first:pt-0">
                <div className="flex items-center gap-2">
                  <input
                    aria-label="Class"
                    placeholder="CS 429"
                    className={inputCls}
                    value={row.title}
                    onChange={(e) => setRow(i, { title: e.target.value })}
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${row.title.trim() || 'class'}`}
                    onClick={() => setRows((rs) => (rs ?? []).filter((_, j) => j !== i))}
                    className="flex h-11 w-11 shrink-0 items-center justify-center text-ink-soft hover:text-ink"
                    style={{ transition: 'color var(--fast) var(--ease)' }}
                  >
                    ×
                  </button>
                </div>
                <div className="mt-2">
                  <DayChips value={row.days} onChange={(days) => setRow(i, { days })} />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <input
                    type="time"
                    aria-label="Starts"
                    className={`${inputCls} font-num`}
                    value={row.start}
                    onChange={(e) => setRow(i, { start: e.target.value })}
                  />
                  <input
                    type="time"
                    aria-label="Ends"
                    className={`${inputCls} font-num`}
                    value={row.end}
                    onChange={(e) => setRow(i, { end: e.target.value })}
                  />
                </div>
                <input
                  aria-label="Location"
                  placeholder="GDC 2.216"
                  className={`${inputCls} mt-2`}
                  value={row.location}
                  onChange={(e) => setRow(i, { location: e.target.value })}
                />
                {errors[i] && <p className="t-label mt-1 text-ink-soft">{errors[i]}</p>}
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => setRows((rs) => [...(rs ?? []), { ...BLANK }])}
            className="t-label flex h-11 items-center px-1 text-ink-soft hover:text-ink"
            style={{ transition: 'color var(--fast) var(--ease)' }}
          >
            + Add class
          </button>

          <div className="mt-3 flex items-center gap-3">
            <Button disabled={!valid || submitting} onClick={() => void submit()}>
              Add {rows.length} class{rows.length === 1 ? '' : 'es'}
            </Button>
            <Button variant="ghost" className="text-ink-soft" disabled={submitting} onClick={reset}>
              Start over
            </Button>
            {submitting && (
              <span className="t-body mise-dot text-ink-soft" aria-hidden="true">
                ●
              </span>
            )}
          </div>

          {error && <p className="t-label mt-2 text-ink-soft">{error}</p>}
        </>
      )}
    </div>
  );
}

export default ImportSchedule;
