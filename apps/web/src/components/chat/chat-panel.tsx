'use client';

/**
 * The chat panel. Desktop: the 360px right rail — no header, no badge, one
 * continuous paper surface. Mobile: a bottom sheet whose collapsed 56px bar
 * keeps the input inline (typing works without expanding).
 *
 * User messages: recessed bubbles, right-aligned. Assistant: ink on paper, no
 * container. Thinking: one pulsing dot. Proposals render as DiffCards inline,
 * anchored after the chat message that references them; orphans (e.g. drag
 * proposals) land at the end, newest last. A just-approved card is held
 * mounted through its collapse animation, then dropped.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '@/lib/store';
import type { ProposalRow } from '@/lib/api';
import { DiffCard } from './diff-card';

const CHAT_CSS = `@keyframes mise-dot { from { opacity: 0.3; } to { opacity: 1; } }`;

const COLLAPSE_HOLD_MS = 400;

export function ChatPanel() {
  const { chat, thinking, send, proposals, approve, reject, applied, undo } = useApp();
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState(false);
  /** Just-approved rows, kept mounted while their card collapses. */
  const [held, setHeld] = useState<ProposalRow[]>([]);

  const dropHeld = (id: string) => setHeld((h) => h.filter((x) => x.id !== id));

  const handleApprove = async (row: ProposalRow) => {
    // Hold the row BEFORE the store refresh removes it, so the card never
    // unmounts mid-flight and the collapse animation has something to run on.
    setHeld((h) => (h.some((x) => x.id === row.id) ? h : [...h, row]));
    try {
      const res = await approve(row.id);
      if (res.status === 'applied') {
        window.setTimeout(() => dropHeld(row.id), COLLAPSE_HOLD_MS);
      } else {
        // needs_review / blocked / expired: the live row is still pending and
        // was refreshed with fresh conflicts — render that, drop the copy.
        dropHeld(row.id);
      }
    } catch (e) {
      console.warn('[chat] approve failed', e);
      dropHeld(row.id);
    }
  };

  const handleReject = async (row: ProposalRow) => {
    try {
      await reject(row.id);
    } catch (e) {
      console.warn('[chat] reject failed', e);
    }
  };

  // Three kinds of card:
  //   done    — the assistant already did it; shows what changed + Undo
  //   pending — it couldn't (a cancel, or something blocked); still asks
  //   held    — just approved by hand, kept mounted for the collapse animation
  const display = new Map<string, { row: ProposalRow; approved: boolean; done: boolean }>();
  for (const p of applied) {
    display.set(p.id, { row: p, approved: false, done: true });
  }
  for (const p of proposals) {
    if (p.status === 'pending') display.set(p.id, { row: p, approved: false, done: false });
  }
  for (const h of held) {
    if (!display.has(h.id)) display.set(h.id, { row: h, approved: true, done: false });
  }

  // Build the message flow: each chat message, then the card it references.
  const rendered = new Set<string>();
  const cardFor = (id: string): ReactNode => {
    const d = display.get(id);
    if (!d || rendered.has(id)) return null;
    rendered.add(id);
    return (
      <DiffCard
        key={`prop-${id}`}
        proposal={d.row}
        approved={d.approved}
        done={d.done}
        onUndo={d.done ? () => undo(d.row.id) : undefined}
        onApprove={() => handleApprove(d.row)}
        onReject={() => handleReject(d.row)}
      />
    );
  };

  const items: ReactNode[] = [];
  for (const m of chat) {
    if (m.role === 'user') {
      items.push(
        <div
          key={m.id}
          className="t-body ml-auto max-w-[85%] whitespace-pre-wrap rounded-r bg-recessed px-3.5 py-2.5 leading-relaxed"
        >
          {m.content}
        </div>,
      );
    } else if (m.role === 'assistant') {
      items.push(
        <div key={m.id} className="t-body whitespace-pre-wrap leading-relaxed">
          {m.content}
        </div>,
      );
    } else {
      continue;
    }
    if (m.proposal_id) {
      const card = cardFor(m.proposal_id);
      if (card) items.push(card);
    }
  }
  // Orphan proposals (drag, add-event) — at the end, newest last.
  const orphans = [...display.values()]
    .filter((d) => !rendered.has(d.row.id))
    .sort((a, b) => (a.row.created_at < b.row.created_at ? -1 : 1));
  for (const d of orphans) {
    const card = cardFor(d.row.id);
    if (card) items.push(card);
  }

  const inputProps = {
    value: draft,
    placeholder: 'Ask — "move gym to Thursday"',
    disabled: thinking,
    'aria-label': 'Ask Mise',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
      e.preventDefault();
      const text = draft.trim();
      if (!text) return;
      void send(text);
      setDraft('');
    },
  };

  const pendingCount = proposals.length;

  return (
    <>
      <style href="mise-chat-kf" precedence="default">
        {CHAT_CSS}
      </style>

      {/* Desktop: the right rail. No header — it's just the surface. */}
      <aside className="hidden min-w-0 border-l border-rule bg-paper md:flex md:h-dvh md:flex-col">
        <MessageList items={items} thinking={thinking} dep={items.length} />
        <div className="border-t border-rule">
          <input
            {...inputProps}
            className="t-input h-14 w-full bg-paper px-5 placeholder:text-ink-soft disabled:opacity-40"
          />
        </div>
      </aside>

      {/* Mobile: bottom sheet. Collapsed = a 56px bar with the input inline. */}
      <div
        className="fixed inset-x-0 bottom-0 z-30 flex flex-col border-t border-rule bg-paper md:hidden"
        style={{
          height: '75dvh',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          transform: expanded
            ? 'translateY(0)'
            : 'translateY(calc(100% - 56px - env(safe-area-inset-bottom, 0px)))',
          transition: 'transform var(--base) var(--ease)',
        }}
      >
        <div className="flex h-14 shrink-0 items-center gap-1 px-2">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse chat' : 'Expand chat'}
            onClick={() => setExpanded((v) => !v)}
            className="flex h-11 w-11 shrink-0 items-center justify-center"
          >
            <span aria-hidden="true" className="h-1 w-8 rounded-r bg-rule" />
          </button>
          <input
            {...inputProps}
            className="t-input h-11 min-w-0 flex-1 bg-paper px-3 placeholder:text-ink-soft disabled:opacity-40"
          />
          {!expanded && pendingCount > 0 && (
            <span
              className="flex shrink-0 items-center gap-1 px-2"
              aria-label={`${pendingCount} pending proposals`}
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-signal" />
              <span className="t-micro">{pendingCount}</span>
            </span>
          )}
        </div>
        <MessageList items={items} thinking={thinking} dep={items.length} />
      </div>
    </>
  );
}

function MessageList({ items, thinking, dep }: { items: ReactNode[]; thinking: boolean; dep: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [dep, thinking]);
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <div className="flex flex-col gap-4">
        {items}
        {thinking && (
          <span
            aria-label="Thinking"
            className="inline-block h-2 w-2 self-start rounded-full bg-ink-soft"
            style={{ animation: 'mise-dot 1s var(--ease) infinite alternate' }}
          />
        )}
      </div>
    </div>
  );
}

export default ChatPanel;
