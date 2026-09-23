'use client';

/**
 * The app barely has buttons — Approve/Reject, Import recipe, +, week arrows.
 * Three variants, per DESIGN.md, 36px tall, one radius, transition on
 * background and shadow only.
 */
import { clsx } from 'clsx';
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(
        't-label inline-flex h-9 select-none items-center justify-center rounded-r px-4',
        variant === 'primary' && 'bg-ink text-paper',
        variant === 'secondary' && 'border border-rule bg-paper text-ink enabled:hover:bg-recessed',
        variant === 'ghost' && 'bg-transparent text-ink enabled:hover:bg-recessed',
        'disabled:cursor-default disabled:opacity-40',
        className,
      )}
      style={{
        transition: 'background-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease)',
      }}
      {...rest}
    />
  );
}

export default Button;
