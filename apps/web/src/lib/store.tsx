'use client';

/**
 * App-wide client state: pending proposals, chat history, and a schedule
 * version counter the week view watches to know when to refetch.
 *
 * Plain React context — no external state lib. Polls proposals + chat every
 * 30s. Fetch failures keep old state and console.warn; the app never blanks
 * because the API blinked.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  approveProposal,
  createProposal,
  describeConflict,
  getChatMessages,
  isActionable,
  isUndoableProposal,
  getProposals,
  rejectProposal,
  sendChatStream,
  severityOf,
  undoLast as undoLastApi,
  undoProposal as undoApplied,
  type ChatRole,
  type ProposalRow,
  type UndoLastResult,
} from './api';

/** The proposal row as screens consume it — API JSON shape, re-exported here
 *  so screens can import everything they need from the store. */
export type { ProposalRow } from './api';

export interface ChatMsg {
  id: string;
  role: ChatRole;
  content: string;
  proposal_id?: string | null;
}

/** What a dropped block did. `blocked` = nothing moved; the card is in chat. */
export type MoveOutcome =
  | {
      status: 'applied';
      summary: string;
      warnings: string[];
      /** Titles of events the drop pushed out of its way, if any. */
      madeRoom: string[];
      proposal_id: string;
    }
  | { status: 'blocked'; reason: string };

export interface AppContextValue {
  /** Bumped after every applied mutation — the week view refetches on change. */
  scheduleVersion: number;
  bumpSchedule(): void;
  /** Pending proposals, newest first. */
  proposals: ProposalRow[];
  refreshProposals(): Promise<void>;
  /** Chat history, oldest first. Hydrated from the API on mount. */
  chat: ChatMsg[];
  /** True while an agent turn is in flight. Render one pulsing dot, per DESIGN. */
  thinking: boolean;
  /** What the turn in flight is doing ("Finding Gym on Thu…"), streamed. */
  status: string | null;
  /** The turn in flight's proposals: dry-run previews, then as the commit gate settled them. */
  live: { proposal: ProposalRow; settled: boolean }[];
  /** The last committed change's diff, for the week view's slide animation. */
  lastCommit: { seq: number; proposal: ProposalRow } | null;
  send(message: string): Promise<void>;
  approve(id: string): Promise<{ status: string }>;
  reject(id: string): Promise<void>;
  /** Files a proposal for approval in chat — used by the non-drag affordances
   *  (add event, plan a cook, remove a cook session). Same server path as chat. */
  dragProposal(tool_name: string, tool_args: object, user_message: string): Promise<void>;
  /** Drag-to-move: files AND applies, unless the validator blocks it. */
  dragMove(args: {
    tool_name: string;
    tool_args: Record<string, unknown>;
    user_message: string;
  }): Promise<MoveOutcome>;
  /** Changes the assistant applied on its own this session, newest last. They
   *  render in chat as "done, and here's Undo" instead of "please approve". */
  applied: ProposalRow[];
  /** Put an applied change back. */
  undo(id: string): Promise<void>;
  /** Cmd-Z: reverse the most recent change, whatever made it. */
  undoLast(): Promise<UndoLastResult>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [scheduleVersion, setScheduleVersion] = useState(0);
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [applied, setApplied] = useState<ProposalRow[]>([]);
  const [thinking, setThinking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [live, setLive] = useState<{ proposal: ProposalRow; settled: boolean }[]>([]);
  const liveRef = useRef<{ proposal: ProposalRow; settled: boolean }[]>([]);
  const putLive = (next: { proposal: ProposalRow; settled: boolean }[]) => {
    liveRef.current = next;
    setLive(next);
  };
  const [lastCommit, setLastCommit] = useState<{ seq: number; proposal: ProposalRow } | null>(null);
  const commitSeq = useRef(0);
  // Guards the poll from clobbering the optimistic message mid-turn.
  const thinkingRef = useRef(false);
  // Monotonic sequence for proposal fetches. On a slow link the 30s poll can
  // resolve AFTER a later approve/reject refresh and restore the list it was
  // served — resurrecting a resolved proposal as a pending, re-approvable diff
  // card. Only the newest request in flight is allowed to write state.
  const proposalSeq = useRef(0);

  const bumpSchedule = useCallback(() => setScheduleVersion((v) => v + 1), []);

  const refreshProposals = useCallback(async () => {
    const seq = ++proposalSeq.current;
    try {
      const res = await getProposals('pending');
      if (seq !== proposalSeq.current) return; // a newer fetch already landed
      setProposals(res.proposals); // API orders newest first
    } catch (e) {
      console.warn('[store] proposals refresh failed', e);
    }
  }, []);

  const refreshChat = useCallback(async () => {
    if (thinkingRef.current) return;
    try {
      const res = await getChatMessages();
      setChat(
        res.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          proposal_id: m.proposal_id,
        })),
      );
    } catch (e) {
      console.warn('[store] chat refresh failed', e);
    }
  }, []);

  const send = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed || thinkingRef.current) return;
      // Optimistic user message; the 30s poll reconciles with server rows.
      setChat((c) => [
        ...c,
        { id: `local-${Date.now()}`, role: 'user', content: trimmed, proposal_id: null },
      ]);
      thinkingRef.current = true;
      setThinking(true);
      setStatus(null);
      putLive([]);
      try {
        const { reply, proposals: created } = await sendChatStream(trimmed, (e) => {
          if (e.type === 'status') setStatus(e.text);
          else if (e.type === 'proposal')
            putLive([...liveRef.current.filter((x) => x.proposal.id !== e.proposal.id), { proposal: e.proposal, settled: false }]);
          else if (e.type === 'settled') {
            putLive(liveRef.current.map((x) => (x.proposal.id === e.proposal.id ? { proposal: e.proposal, settled: true } : x)));
            if (e.proposal.status === 'approved') {
              // The change is in the database now: move the block now, not
              // when the reply arrives.
              commitSeq.current += 1;
              setLastCommit({ seq: commitSeq.current, proposal: e.proposal });
              bumpSchedule();
            }
          }
        });
        // The assistant applies what it decides (see apps/api/src/routes/chat.ts),
        // so most of these come back already 'approved'. Those render as
        // "here's what I did · Undo"; anything it could NOT apply — a cancel, or
        // something the validator blocked — comes back pending and still asks.
        // Every applied change keeps its receipt; the card offers Undo only
        // where undo exists (chat-panel checks isUndoableProposal).
        const done = created.filter((p) => p.status === 'approved');
        if (done.length > 0) setApplied((a) => [...a, ...done].slice(-6));

        setChat((c) => [
          ...c,
          {
            id: `local-${Date.now()}-reply`,
            role: 'assistant',
            content: reply,
            proposal_id: created[0]?.id ?? null,
          },
        ]);
        await refreshProposals();
        bumpSchedule();
      } catch (e) {
        console.warn('[store] send failed', e);
        // The stream broke, but anything it already committed is real: keep
        // those receipts (with their Undo) and resync with the server.
        const committed = liveRef.current.filter((x) => x.settled && x.proposal.status === 'approved').map((x) => x.proposal);
        if (committed.length > 0) setApplied((a) => [...a, ...committed].slice(-6));
        void refreshProposals();
        bumpSchedule();
      } finally {
        thinkingRef.current = false;
        setThinking(false);
        setStatus(null);
        putLive([]);
      }
    },
    [refreshProposals, bumpSchedule],
  );

  const approve = useCallback(
    async (id: string) => {
      const result = await approveProposal(id);
      // needs_review leaves the row pending with re-derived conflicts;
      // refreshing pulls the updated diff either way.
      await refreshProposals();
      if (result.status === 'applied') bumpSchedule();
      return { status: result.status };
    },
    [refreshProposals, bumpSchedule],
  );

  const reject = useCallback(
    async (id: string) => {
      await rejectProposal(id);
      await refreshProposals();
    },
    [refreshProposals],
  );

  const dragProposal = useCallback(
    async (tool_name: string, tool_args: object, user_message: string) => {
      await createProposal(tool_name, tool_args, user_message);
      await refreshProposals();
    },
    [refreshProposals],
  );

  /**
   * Drag = direct manipulation. Dropping a block APPLIES the move: it files the
   * proposal and immediately approves it, so the block lands where you put it.
   *
   * The invariant survives where it matters. The move still goes through the
   * tool (dry → validate → commit in a transaction), still writes a proposal row
   * to the audit log, and is still REFUSED if it would touch a pinned event or
   * raise a blocking conflict — in that case the row stays pending, its diff
   * card appears in chat, and the block snaps back. What changed is only who
   * clicks Approve for the safe case: dragging IS the approval. Warnings the
   * validator raised come back with the result so the UI can surface them, and
   * the move is undoable.
   */
  const dragMove = useCallback(
    async (args: {
      tool_name: string;
      tool_args: Record<string, unknown>;
      user_message: string;
    }): Promise<MoveOutcome> => {
      const { proposal } = await createProposal(args.tool_name, args.tool_args, args.user_message);

      const blocking = proposal.conflicts.find((c) => severityOf(c) === 'blocking');
      if (blocking) {
        // Never auto-apply something the validator blocks (I4). Leave it pending
        // so the diff card explains the refusal.
        await refreshProposals();
        return { status: 'blocked', reason: describeConflict(blocking) };
      }

      // Nothing to apply. A pinned target lands here rather than on a
      // pinned_moved conflict, because shift_events refuses to even select
      // pinned instances — so the diff comes back empty. Either way: no write.
      if (!isActionable(proposal.diff)) {
        await refreshProposals();
        const why = proposal.conflicts[0];
        return { status: 'blocked', reason: why ? describeConflict(why) : "That event can't be moved." };
      }

      const result = await approveProposal(proposal.id);
      await refreshProposals();

      if (result.status !== 'applied') {
        bumpSchedule();
        const c = result.proposal.conflicts.find((k) => severityOf(k) === 'blocking');
        return { status: 'blocked', reason: c ? describeConflict(c) : 'The schedule changed — check the card in chat.' };
      }

      bumpSchedule();
      const warnings = result.proposal.conflicts
        .filter((c) => severityOf(c) === 'warning')
        .map(describeConflict);
      // Dropping a block on top of something movable pushes it later rather than
      // burying it. That is a change to an event Sai did not touch, so the toast
      // has to name it — a block quietly sliding somewhere else is the exact
      // thing that makes a calendar untrustworthy.
      const madeRoom = result.proposal.diff.changes
        .filter((c) => c.knock_on === true)
        .map((c) => c.title);
      return {
        status: 'applied',
        summary: result.proposal.diff.summary,
        warnings,
        madeRoom,
        proposal_id: proposal.id,
      };
    },
    [refreshProposals, bumpSchedule],
  );

  const undo = useCallback(
    async (id: string) => {
      await undoApplied(id);
      setApplied((a) => a.filter((p) => p.id !== id));
      bumpSchedule();
      await refreshProposals();
    },
    [bumpSchedule, refreshProposals],
  );

  const undoLast = useCallback(async (): Promise<UndoLastResult> => {
    const res = await undoLastApi();
    if (res.ok) {
      // Drop it from the chat "done" strip too, so its card stops offering an
      // Undo for something already reversed.
      setApplied((a) => a.filter((p) => p.id !== res.undone_id));
      bumpSchedule();
      await refreshProposals();
    }
    return res;
  }, [bumpSchedule, refreshProposals]);

  useEffect(() => {
    void refreshProposals();
    void refreshChat();
    const timer = setInterval(() => {
      void refreshProposals();
      void refreshChat();
    }, 30_000);
    return () => clearInterval(timer);
  }, [refreshProposals, refreshChat]);

  return (
    <AppContext.Provider
      value={{
        scheduleVersion,
        bumpSchedule,
        proposals,
        refreshProposals,
        chat,
        thinking,
        status,
        live,
        lastCommit,
        send,
        approve,
        reject,
        dragProposal,
        dragMove,
        applied,
        undo,
        undoLast,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
