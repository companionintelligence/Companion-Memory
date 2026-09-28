import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

import { OnboardingButton } from './OnboardingButton';
import { StepHeader } from './StepHeader';
import { useOnboardService } from './useOnboardService';

export function RunFirstSyncStep() {
  const [{ authToken }] = useAuth();
  const [{ loading: submitting, error }, { onboard }] = useOnboardService();

  async function finish() {
    void fetchJson('/api/connections/sync-now', {
      method: 'POST',
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    }).catch(() => undefined);

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

      {error != null && (
        <p className="text-base text-destructive">Could not finish setup — please try again.</p>
      )}

      <OnboardingButton
        type="button"
        size="lg"
        className="w-full h-14 text-lg sm:text-xl"
        disabled={submitting}
        onClick={() => void finish()}
      >
        {submitting ? 'Finishing…' : 'Run my first sync and finish'}
      </OnboardingButton>
    </div>
  );
}
