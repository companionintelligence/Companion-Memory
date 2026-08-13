import { useOutboxQueue } from '@ci/common';
import { Badge } from '@ci/shadcn';
import { useTranslation } from 'react-i18next';

/**
 * Queue-depth chips sitting beside {@link ConnectionModeIndicator}, in the same minimal
 * style: a dot plus a number.
 *
 * Two separate chips, deliberately. `pending` is ambient — captures are safely on disk and
 * will drain on their own, so it reads as a neutral outline chip like the mode indicator.
 * `needs_attention` is not ambient: flushing has given up on those items and only the user
 * can resolve them, so it gets the destructive variant to be unmistakably distinct.
 *
 * Renders nothing when the queue is empty (and on web, where there is no sidecar and so no
 * queue at all) — the chip is a signal, not permanent chrome.
 */
export function OutboxQueueIndicator() {
  const { pending, needsAttention } = useOutboxQueue();
  const { t } = useTranslation();

  if (pending === 0 && needsAttention === 0) {
    return null;
  }

  return (
    <>
      {pending > 0 && (
        <Badge
          variant="outline"
          className="select-none gap-1.5"
          aria-label={t('OUTBOX_PENDING_COUNT', { n: pending })}
        >
          <span className="inline-block size-1.5 shrink-0 rounded-full bg-sky-500" aria-hidden="true" />
          <span aria-hidden="true">{pending}</span>
        </Badge>
      )}

      {needsAttention > 0 && (
        <Badge
          variant="destructive"
          className="select-none gap-1.5"
          aria-label={t('OUTBOX_NEEDS_ATTENTION_COUNT', { n: needsAttention })}
        >
          <span aria-hidden="true">{needsAttention}</span>
        </Badge>
      )}
    </>
  );
}
