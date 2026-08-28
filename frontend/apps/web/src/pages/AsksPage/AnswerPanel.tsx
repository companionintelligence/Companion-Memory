import { useQuery } from '@apollo/client';
import { EmptyState, LoadingPage } from '@ci/common';
import { Button, Card } from '@ci/shadcn';

import { AnswerCard } from './AnswerCard';
import { itemLabel } from './askBinding';
import type { AnswerReview } from './askPresentation';
import { ASK_ANSWER } from './asksOperations';

interface Props {
  askId: string;
  /** Who answered, in the container's words. Never invented — see partyLabel. */
  responderName: string;
  /**
   * Whether the VIEWER is the responder.
   *
   * This is not cosmetic. `AskAnswerType.toType` narrows the whole document for
   * an asker — zeroed counts, a count-free summary, a null consent basis — so
   * the same query returns two different truths depending on who asks, and the
   * card has to be told which one it received. Defaults to the asker's (narrow)
   * reading, so a caller that forgets under-claims rather than over-claims.
   */
  isResponder?: boolean;
  /**
   * Auto vs reviewed, when the CALLER can establish it from something other
   * than this answer.
   *
   * The answer document cannot: it carries no such flag, and its consent basis
   * is responder-only. The disclosure history can — `AskAuditType.outcome`
   * separates `answered` from `auto_answered` — so a history row passes what it
   * knows and the outbox passes nothing.
   */
  review?: AnswerReview;
}

/**
 * The answer to one ask, fetched on demand.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 *
 * `askAnswer` has been on the schema, resolved, disclosure-filtered and tested,
 * and NO CLIENT SELECTED IT. The consequence was not a missing feature but a
 * broken promise: an owner could read a request, weigh it, cap it, approve it
 * and watch `runAsk` succeed — and the person who asked had no surface anywhere
 * that showed the answer. Every journey through this feature ended in silence.
 *
 * Fetched per-ask rather than joined onto the outbox on purpose. The outbox is
 * a list of asks and most of them have no answer; a per-row query keeps the
 * disclosure read to the one the person actually opened, which is also the read
 * that shows up in the responder's logs.
 *
 * An answer that is not there yet is NOT an error. `askAnswer` returns null
 * until the ask reaches `answered` — including for an ask the responder
 * declined, which the asker's projection deliberately cannot distinguish from
 * one nobody has got to. Both render as "no answer", because inventing a
 * difference here would rebuild the oracle `askerVisibleStatus` closed.
 */
export function AnswerPanel({ askId, responderName, isResponder = false, review }: Props) {
  const { data, loading, error, refetch } = useQuery(ASK_ANSWER, { variables: { id: askId } });

  if (error) {
    return (
      <Card className="flex flex-col items-start gap-2 p-3" role="alert">
        <p className="font-medium">Couldn’t load this answer.</p>
        <p className="text-muted-foreground text-sm">
          This is a failed request, not an empty one — it says nothing about what was or wasn’t shared.
        </p>
        <Button size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </Card>
    );
  }

  if (loading) {
    return <LoadingPage />;
  }

  const answer = data?.askAnswer;

  if (!answer) {
    return <EmptyState message="No answer yet. You’ll see it here once there is one." />;
  }

  // Only the retrieval form carries item references, and the projection already
  // empties them for every other form — so an empty list here is a fact about
  // the form, not a rendering shortcut.
  const items = answer.items.map((item) => ({
    id: item.id,
    type: item.type,
    label: itemLabel(item),
  }));

  // The magnitudes are real ONLY when the viewer is the responder or the form
  // itemizes. This mirrors `AskAnswerType.toType`'s `showCounts`, and mirrors it
  // deliberately rather than reading a flag: the server does not send one, and
  // the alternative is a card that prints a masked zero as if it meant nothing.
  const countsWithheld = !isResponder && items.length === 0;

  return (
    <AnswerCard
      responderName={responderName}
      summary={answer.summary ?? 'They answered, but their Companion sent no summary.'}
      items={items}
      disclosedCount={answer.disclosedCount}
      withheldCount={answer.withheldCount}
      // No caller-supplied value means the wire could not say — and the fallback
      // is the one that claims nothing.
      //
      // Deriving it from `isResponder`, or from a non-null `consentBasis`, was
      // tried and both are wrong. `AskService.approve` neither sets nor clears
      // the basis, and `withdrawPreAuthorization` sends an ask that ALREADY has
      // one back to the owner for review — so an answered ask can carry a
      // consent basis and still have been read by a human, and "I am the
      // responder" does not tell you which of your own asks you read. The only
      // field that separates the two is `AskAuditType.outcome`, which the
      // history tab has and passes in.
      review={review ?? 'undisclosed'}
      countsWithheld={countsWithheld}
      consentBasis={answer.consentBasis}
    />
  );
}
