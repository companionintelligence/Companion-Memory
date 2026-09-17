import { useCallback, useState } from 'react';

import { ApprovalCard } from './ApprovalCard';
import { useApprovals } from './useApprovals';

/**
 * The owner's answer queue.
 *
 * This is the surface the capability gate has been writing to since before it
 * existed: `ci.pending_actions` has had a service, a state machine, an expiry
 * cron and approve/decline routes for some time, with ZERO frontend consumers —
 * partly because the controller was mounted behind a path the gateway could not
 * route to (see CI-Server#1684), so the endpoints did not resolve at all.
 *
 * Without a page, "the appliance asks before doing anything irreversible" was
 * only true in the sense that it refused. A refusal the owner cannot answer is
 * not a gate, it is an outage.
 */
export function ApprovalsPage() {
  const { actions, loading, error, answer } = useApprovals();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);

  const onAnswer = useCallback(
    async (id: string, verdict: 'approve' | 'decline') => {
      setBusyId(id);
      setAnswerError(null);

      try {
        await answer(id, verdict);
      } catch (err: unknown) {
        // Surfaced, not swallowed. Approving RE-RUNS the intent, so a failure here
        // can mean the run itself failed — and an owner who tapped Approve and saw
        // the card vanish would reasonably believe it worked.
        setAnswerError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [answer],
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Things your appliance stopped and would like you to confirm.
        </p>
      </header>

      {error != null && (
        <p className="text-sm text-destructive" role="alert">
          Could not load the queue: {error}
        </p>
      )}

      {answerError != null && (
        <p className="text-sm text-destructive" role="alert">
          {answerError}
        </p>
      )}

      {loading && actions == null && <p className="text-sm text-muted-foreground">Loading…</p>}

      {/*
        An empty queue is the NORMAL state and should read as reassurance, not as
        an error or a missing feature. Most days nothing asks.
      */}
      {actions != null && actions.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing is waiting. Anything irreversible an installed app tries will appear here.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {actions?.map((action) => (
          <ApprovalCard
            key={action.id}
            action={action}
            busy={busyId === action.id}
            onAnswer={(id, verdict) => void onAnswer(id, verdict)}
          />
        ))}
      </div>
    </div>
  );
}
