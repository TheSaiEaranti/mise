'use client';

/**
 * Form primitives for the onboarding wizard. Every selection control uses the
 * recessed-when-on treatment — the same fill language as pinned events — so
 * the wizard teaches the calendar's depth signal before the grid ever renders.
 * No dropdowns, no menus: chips, radio rows, toggles, and a stepper.
 */
import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export const inputCls =
  't-body h-11 w-full min-w-0 rounded-r border border-rule bg-paper px-3 text-ink placeholder:text-ink-soft';

const pressTransition = {
  transition: 'background-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease)',
};

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="t-label mb-1 block text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

/** Like Field, but a div — for controls that are buttons (labels would steal clicks). */
export function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="t-label mb-1 text-ink-soft">{label}</p>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day-of-week chips (RFC5545 codes, canonical MO→SU order)
// ---------------------------------------------------------------------------

export const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type DayCode = (typeof DAY_CODES)[number];

export function DayChips({ value, onChange }: { value: DayCode[]; onChange: (v: DayCode[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {DAY_CODES.map((d) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            onClick={() =>
              onChange(on ? value.filter((x) => x !== d) : DAY_CODES.filter((x) => x === d || value.includes(x)))
            }
            style={pressTransition}
            className={clsx(
              't-label h-11 w-11 rounded-r border border-rule',
              on ? 'bg-recessed text-ink-lock shadow-inset-pin' : 'bg-paper text-ink-soft',
            )}
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Radio rows — mutually exclusive, recessed when selected
// ---------------------------------------------------------------------------

export interface RadioOption<T extends string | number> {
  value: T;
  label: string;
}

export function RadioRows<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly RadioOption<T>[];
  value: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-2">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            style={pressTransition}
            className={clsx(
              't-body flex h-11 items-center rounded-r border border-rule px-3 text-left',
              on ? 'bg-recessed text-ink-lock shadow-inset-pin' : 'bg-paper text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle row — on = recessed. Right slot shows what the state means.
// ---------------------------------------------------------------------------

export function ToggleRow({
  label,
  right,
  pressed,
  onToggle,
}: {
  label: string;
  right: string;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      style={pressTransition}
      className={clsx(
        'flex h-11 w-full items-center justify-between rounded-r border border-rule px-3 text-left',
        pressed ? 'bg-recessed shadow-inset-pin' : 'bg-paper',
      )}
    >
      <span className={clsx('t-body', pressed ? 'text-ink-lock' : 'text-ink')}>{label}</span>
      <span className={clsx('t-label', pressed ? 'text-ink-lock' : 'text-ink-soft')}>{right}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Stepper — the count is a quantity, so it renders mono.
// ---------------------------------------------------------------------------

export function Stepper({
  label,
  value,
  min = 0,
  max = 7,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  const btn =
    't-body h-11 w-11 rounded-r border border-rule bg-paper text-ink enabled:hover:bg-recessed disabled:cursor-default disabled:opacity-40';
  return (
    <div role="group" aria-label={label} className="flex items-center gap-2">
      <button
        type="button"
        aria-label={`Fewer ${label}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        style={pressTransition}
        className={btn}
      >
        −
      </button>
      <output className="t-time inline-block w-11 text-center text-ink">{value}</output>
      <button
        type="button"
        aria-label={`More ${label}`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        style={pressTransition}
        className={btn}
      >
        +
      </button>
    </div>
  );
}
