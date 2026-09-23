'use client';

/**
 * Slide a block to its new slot when a change commits (FLIP).
 *
 * A same-day move keeps its DOM node and already glides (event-block's `top`
 * transition). A cross-day move lands in another day column — a new node — so
 * it would just blink into place. When a commit arrives we note where each
 * moved block IS (the old schedule is still on screen); when the refetched
 * schedule renders, each block that actually jumped plays in from there.
 * Blocks that kept their node measure ~0 offset and are left to the CSS.
 */
import { useLayoutEffect, useRef } from 'react';
import type { ProposalRow } from './api';

export function flipKey(title: string, startsAt: string): string {
  return `${title}|${startsAt}`;
}

function find(key: string): HTMLElement | null {
  return document.querySelector(`[data-flip-key="${CSS.escape(key)}"]`);
}

interface Change {
  title: string;
  before: { starts_at: string } | null;
  after: { starts_at: string } | null;
}

export function useCommitSlide(lastCommit: { seq: number; proposal: ProposalRow } | null, rendered: unknown): void {
  const pending = useRef<{ to: string; from: DOMRect; at: number }[]>([]);
  const seen = useRef(0);

  useLayoutEffect(() => {
    if (!lastCommit || lastCommit.seq === seen.current) return;
    seen.current = lastCommit.seq;
    const changes = ((lastCommit.proposal.diff as { changes?: Change[] }).changes ?? []).filter((c) => c.before && c.after);
    const now = performance.now();
    // Appended, not replaced: two commits can land before one refetch renders.
    pending.current = [
      ...pending.current,
      ...changes.flatMap((c) => {
        const el = find(flipKey(c.title, c.before!.starts_at));
        return el ? [{ to: flipKey(c.title, c.after!.starts_at), from: el.getBoundingClientRect(), at: now }] : [];
      }),
    ];
  }, [lastCommit]);

  useLayoutEffect(() => {
    if (pending.current.length === 0) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fresh = performance.now() - 2000; // a failed refetch must not replay later from a stale spot
    for (const p of pending.current.filter((x) => x.at > fresh)) {
      const el = find(p.to);
      if (!el || reduce) continue;
      const now = el.getBoundingClientRect();
      const dx = p.from.left - now.left;
      const dy = p.from.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue; // same node: the CSS transition has it
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
        duration: 380,
        easing: 'cubic-bezier(0.32, 0.72, 0, 1)', // --ease
      });
    }
    pending.current = [];
  }, [rendered]);
}
