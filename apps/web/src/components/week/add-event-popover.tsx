'use client';

/**
 * The add-event popover: a small raised card under the '+' button — not a
 * modal, no overlay. Submitting files a create_event proposal (the same
 * approval path as everything else); the diff card appears in chat.
 */
import { useState } from 'react';
import { clsx } from 'clsx';
import { DATE_RE, TIME_RE } from '@mise/core/time';
import { Button } from '@/components/ui/button';

export interface NewEventArgs {
  title: string;
  kind: 'gym' | 'cook' | 'personal' | 'commute';
  date: string;
  start_time: string;
  duration_minutes: number;
}

const KINDS: NewEventArgs['kind'][] = ['gym', 'cook', 'personal', 'commute'];

const FIELD = 'h-9 w-full rounded-r border border-rule bg-paper px-3';

interface AddEventPopoverProps {
  defaultDate: string;
  onSubmit(args: NewEventArgs): void;
  onClose(): void;
}

export function AddEventPopover({ defaultDate, onSubmit, onClose }: AddEventPopoverProps) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<NewEventArgs['kind']>('personal');
  const [date, setDate] = useState(defaultDate);
  const [start, setStart] = useState('17:00');
  const [duration, setDuration] = useState('60');

  const mins = Number(duration);
  const valid =
    title.trim().length > 0 &&
    DATE_RE.test(date) &&
    TIME_RE.test(start) &&
    Number.isInteger(mins) &&
    mins >= 5 &&
    mins <= 720;

  return (
    <form
      className="absolute right-0 top-full z-30 mt-2 w-72 max-w-[calc(100vw-32px)] rounded-r border border-rule bg-paper p-4 text-left shadow-lift"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSubmit({
          title: title.trim(),
          kind,
          date,
          start_time: start,
          duration_minutes: mins,
        });
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <label className="block pb-3">
        <span className="t-label block pb-1 text-ink-soft">Title</span>
        <input
          autoFocus
          className={clsx(FIELD, 't-body')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Gym"
        />
      </label>

      <fieldset className="pb-3">
        <legend className="t-label pb-1 text-ink-soft">Kind</legend>
        <div className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <label
              key={k}
              className={clsx(
                't-label flex h-9 cursor-pointer select-none items-center rounded-r border border-rule px-3',
                kind === k ? 'bg-recessed' : 'bg-paper',
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink',
              )}
            >
              <input
                type="radio"
                name="kind"
                value={k}
                checked={kind === k}
                onChange={() => setKind(k)}
                className="sr-only"
              />
              {k}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block pb-3">
        <span className="t-label block pb-1 text-ink-soft">Date</span>
        <input
          type="date"
          className={clsx(FIELD, 't-time')}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>

      <div className="flex gap-2 pb-4">
        <label className="block flex-1">
          <span className="t-label block pb-1 text-ink-soft">Start</span>
          <input
            type="time"
            step={900}
            className={clsx(FIELD, 't-time')}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label className="block flex-1">
          <span className="t-label block pb-1 text-ink-soft">Minutes</span>
          <input
            type="number"
            min={5}
            max={720}
            step={5}
            inputMode="numeric"
            className={clsx(FIELD, 't-time')}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!valid}>
          Add event
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
