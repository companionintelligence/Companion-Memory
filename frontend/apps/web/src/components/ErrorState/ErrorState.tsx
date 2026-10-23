import type { ReactNode } from 'react';

import { Button, cn } from '@ci/shadcn';
import { TriangleAlert, RotateCw } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { useAnswersFromDevice, useReplicaOpenState } from '@/api/powersync/deviceFallback';

export interface ErrorStateProps {
  title?: string;
  /**
   * What went wrong, in the owner's words.
   *
   * Say that the DATA is fine and the FETCH was not, wherever that is true. The
   * failure mode this component exists to end is a page rendering "you have
   * none" over a request that errored, and copy like "nothing here" reproduces
   * that in a nicer font.
   */
  description?: string;
  onRetry?: () => void;
  /**
   * An extra way out, beside Try again.
   *
   * Needed by surfaces rendered OUTSIDE the app shell — `/providers/:id` has no
   * rail on screen, so an error there with only a retry leaves browser Back as
   * the sole escape from a page that may never load.
   */
  children?: ReactNode;
  className?: string;
}

/**
 * Inline "we could not load this" with a retry — the shared alternative to a
 * confident empty state.
 *
 * Lived under `pages/MemoryPage/Components` and was cross-imported from
 * SharedSearchPage already; it is here because the audit found at least eight
 * surfaces that drop a query's `error` and render their empty state instead,
 * and the fix for every one of them is this component. A shared concern sitting
 * inside one page's folder is a concern the next page quietly reimplements or,
 * as happened here, simply omits.
 *
 * The Memory views keep their own memory-worded default by wrapping this — see
 * `pages/MemoryPage/Components/ErrorState.tsx`.
 *
 * On a phone whose appliance is not answering, the default copy says so and
 * names what the phone's own copy still serves, instead of "check your
 * connection" to someone who may be offline on purpose. A caller's own title
 * and description win, since they describe their request, not the connection.
 *
 * Two more cases, and they have to be told apart from that one (`useReplicaOpenState`):
 * the appliance is not answering and the phone's own copy is still being opened —
 * startup on a large file takes seconds, longer when it is waiting out a stale lock —
 * or could not be opened at all. Saying "needs the Memory server" in either sends the
 * person after the wrong thing; the copy is what to wait for, or what failed, and a
 * full restart of the app is what frees a stuck one.
 */
export function ErrorState({ title, description, onRetry, children, className }: ErrorStateProps) {
  const { t } = useTranslation();
  const offline = useAnswersFromDevice();
  const replica = useReplicaOpenState();
  const heading =
    title ??
    (offline
      ? t('ERROR_STATE_OFFLINE_TITLE')
      : replica.opening
        ? t('MEMORY_REPLICA_OPENING_TITLE')
        : replica.failed
          ? t('MEMORY_REPLICA_UNAVAILABLE_TITLE')
          : 'Something went wrong');
  const body =
    description ??
    (offline
      ? t('ERROR_STATE_OFFLINE_DESCRIPTION')
      : replica.opening
        ? t('MEMORY_REPLICA_OPENING_DESCRIPTION')
        : replica.failed
          ? t(replica.locked ? 'MEMORY_REPLICA_LOCKED_DESCRIPTION' : 'MEMORY_REPLICA_UNAVAILABLE_DESCRIPTION')
          : 'This could not be loaded. Check your connection and try again.');

  return (
    <div
      role="alert"
      className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}
    >
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
        <TriangleAlert className="h-8 w-8 text-destructive" />
      </div>

      <h3 className="mb-1 text-lg font-medium text-foreground">{heading}</h3>
      <p className="mb-4 max-w-sm text-sm text-muted-foreground">{body}</p>

      <div className="flex flex-wrap items-center justify-center gap-2">
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCw className="h-4 w-4" />
            Try again
          </Button>
        )}
        {children}
      </div>
    </div>
  );
}
