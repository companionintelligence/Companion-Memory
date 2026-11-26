import { useState } from 'react';

import { fetchJson } from '@ci/common';
import { Button } from '@ci/shadcn';

import { useAuth } from '@/hooks';

import { OnboardingButton } from './OnboardingButton';
import { StepHeader } from './StepHeader';
import { useOnboardService } from './useOnboardService';

/**
 * How long finishing waits for the server to accept the first sync. The wizard now waits on the answer,
 * so a server that never replies must end as a failure the person can retry or skip, not as a button
 * stuck on "Finishing…". Starting a sync only queues work, so a healthy server answers well inside this.
 */
const FIRST_SYNC_TIMEOUT_MS = 15_000;

export function RunFirstSyncStep() {
  const [{ authToken }] = useAuth();
  const [{ loading: submitting, error }, { onboard }] = useOnboardService();

  // Why the first sync did not start, if it did not. Finishing used to fire the request and carry
  // on whatever it answered, so a sync that never started looked exactly like one that had.
  const [syncError, setSyncError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  async function finish() {
    setSyncError(null);
    setStarting(true);

    try {
      const result = await fetchJson<{ disabledReason?: string }>('/api/connections/sync-now', {
        method: 'POST',
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        timeout: FIRST_SYNC_TIMEOUT_MS,
      });

      // The request itself succeeded, but the server will not run the sync until an administrator
      // switches scheduled connection sync back on, and retrying changes nothing.
      if (result?.disabledReason) {
        setSyncError(
          'Automatic syncing is paused on this Memory, so the first sync cannot start. You can finish without syncing and see System status for what to do next.',
        );

        return;
      }

      await onboard();
    } catch {
      setSyncError(
        'Your first sync could not start. Check your connection and retry, or finish without syncing.',
      );
    } finally {
      setStarting(false);
    }
  }

  // The wizard promises "every step is skippable", and this is the one step the shared footer
  // does not draw, so it carries its own way out. Finishing without the sync only skips the
  // sync request: the owner still lands in the app, and connectors sync on their own schedule.
  async function finishWithoutSync() {
    setSyncError(null);
    await onboard();
  }

  return (
    <div className="space-y-8 w-full max-w-2xl mx-auto">
      <StepHeader
        title="Your life, unclouded."
        description={
          <>
            <span className="block">Who you know, where you go,</span>
            <span className="block">everything physical you own and interact with,</span>
            <span className="block">everything digital that you create and consume:</span>
            <span className="block mt-3 text-foreground/90">
              a private, searchable memory — one that belongs to you.
            </span>
          </>
        }
      />

      {(error != null || syncError) && (
        <p role="alert" className="text-base text-destructive">
          {syncError ?? 'Could not finish setup — please try again.'}
        </p>
      )}

      <OnboardingButton
        type="button"
        size="lg"
        className="w-full h-14 text-lg sm:text-xl"
        disabled={submitting || starting}
        onClick={() => void finish()}
      >
        {submitting || starting
          ? 'Finishing…'
          : syncError
            ? 'Retry first sync'
            : 'Run my first sync and finish'}
      </OnboardingButton>

      <Button
        type="button"
        variant="ghost"
        size="lg"
        className="h-11 text-base"
        disabled={submitting || starting}
        onClick={() => void finishWithoutSync()}
      >
        Finish without syncing
      </Button>
    </div>
  );
}
