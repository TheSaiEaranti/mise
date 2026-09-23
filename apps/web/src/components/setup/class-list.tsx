'use client';

/**
 * Wizard step 2: build the weekly class list. Added classes render as
 * recessed rows WITH the 2px left spine — the exact treatment pinned events
 * get on the grid, because that is exactly what these become.
 */
import { useState } from 'react';
import { TIME_RE, fmtRange12 } from '@mise/core/time';
import type { SemesterSetupBody } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { DayChips, Field, Group, inputCls, type DayCode } from './fields';

export type ClassInput = SemesterSetupBody['classes'][number];

export function ClassRow({ cls, onRemove }: { cls: ClassInput; onRemove: () => void }) {
  return (
    <div className="flex items-center rounded-r border-l-2 border-ink-lock bg-recessed shadow-inset-pin">
      <div className="min-w-0 flex-1 py-2 pl-3">
        <p className="t-body truncate text-ink-lock">{cls.title}</p>
        <p className="t-label text-ink-lock">
          {cls.days.join('/')}{' '}
          <span className="t-time">{fmtRange12(cls.start_time, cls.end_time)}</span>
          {cls.location ? ` · ${cls.location}` : ''}
        </p>
      </div>
      <button
        type="button"
        aria-label={`Remove ${cls.title}`}
        onClick={onRemove}
        className="t-body h-11 w-11 shrink-0 text-ink-lock"
      >
        ×
      </button>
    </div>
  );
}

export function ClassEditor({ onAdd }: { onAdd: (c: ClassInput) => void }) {
  const [title, setTitle] = useState('');
  const [days, setDays] = useState<DayCode[]>([]);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [location, setLocation] = useState('');

  const valid =
    title.trim().length > 0 && days.length > 0 && TIME_RE.test(start) && TIME_RE.test(end) && start < end;

  function add() {
    if (!valid) return;
    onAdd({
      title: title.trim(),
      days,
      start_time: start,
      end_time: end,
      location: location.trim() || undefined,
    });
    setTitle('');
    setDays([]);
    setStart('');
    setEnd('');
    setLocation('');
  }

  return (
    <div className="mt-6 flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Class">
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="CS 429" />
        </Field>
        <Field label="Location (optional)">
          <input
            className={inputCls}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="GDC 2.216"
          />
        </Field>
      </div>
      <Group label="Days">
        <DayChips value={days} onChange={setDays} />
      </Group>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts">
          <input
            type="time"
            className={`${inputCls} font-num`}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="Ends">
          <input type="time" className={`${inputCls} font-num`} value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
      </div>
      <div>
        <Button variant="ghost" disabled={!valid} onClick={add}>
          + Add class
        </Button>
      </div>
    </div>
  );
}
