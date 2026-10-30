import { useCallback, useState } from 'react';

import { ApprovalCard } from './ApprovalCard';
import { useApprovals, type ApprovalOutcome } from './useApprovals';

/** How many approved runs stay on the page, newest first. */
const MAX_SHOWN_RUNS = 5;

interface ApprovedRun {
  id: string;
  intent: string;
  outcome: ApprovalOutcome;
}

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
  // A set, not one id: answering a second card while the first is still running must not
  // re-enable the second card's buttons when the first one finishes.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [answerError, setAnswerError] = useState<string | null>(null);
  // Approved runs, newest first. A card is gone once the queue reloads. For a read chat queued
  // this is the only place its answer appears, so declining or approving another card keeps it.
  const [runs, setRuns] = useState<ApprovedRun[]>([]);

  const onAnswer = useCallback(
    async (id: string, verdict: 'approve' | 'decline') => {
      const intent = actions?.find((action) => action.id === id)?.intent ?? id;

      setBusyIds((current) => new Set(current).add(id));
      setAnswerError(null);

      try {
        const outcome = await answer(id, verdict);

        if (outcome != null) {
          setRuns((current) =>
            [{ id, intent, outcome }, ...current.filter((run) => run.id !== id)].slice(0, MAX_SHOWN_RUNS),
          );
        }
      } catch (err: unknown) {
        // Surfaced, not swallowed. Approving RE-RUNS the intent, so a failure here
        // can mean the run itself failed — and an owner who tapped Approve and saw
        // the card vanish would reasonably believe it worked.
        setAnswerError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyIds((current) => {
          const next = new Set(current);

          next.delete(id);

          return next;
        });
      }
    },
    [actions, answer],
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

      {runs.map((run) =>
        run.outcome.success ? (
          <section
            key={run.id}
            data-testid={`approved-run-${run.id}`}
            className="flex flex-col gap-2 rounded border p-3"
          >
            {/* Only the sentence is a live region. A screen reader re-reads all of one, while the
                result can be a hundred messages long. */}
            <p className="text-sm" role="status">
              Ran <code>{run.intent}</code>.{run.outcome.data !== undefined && ' It returned:'}
            </p>
            {run.outcome.data !== undefined && (
              <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
                {JSON.stringify(run.outcome.data, null, 2)}
              </pre>
            )}
          </section>
        ) : (
          <p key={run.id} className="text-sm text-destructive" role="alert">
            Approved <code>{run.intent}</code>, but it failed:{' '}
            {run.outcome.error?.message ?? 'no reason given'}
          </p>
        ),
      )}

      {loading && actions == null && <p className="text-sm text-muted-foreground">Loading…</p>}

      {/*
        An empty queue is the NORMAL state and should read as reassurance, not as
        an error or a missing feature. Most days nothing asks.
      */}
      {actions != null && actions.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing is waiting. Anything chat or an installed app stops to ask you about will appear here.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {actions?.map((action) => (
          <ApprovalCard
            key={action.id}
            action={action}
            busy={busyIds.has(action.id)}
            onAnswer={(id, verdict) => void onAnswer(id, verdict)}
          />
        ))}
      </div>
    </div>
  );
}
