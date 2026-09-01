import { useEffect } from 'react';

import { useToast } from '@ci/shadcn';

import { useImportApi } from '@/pages/ImportPage/useImportApi';

// Once per PAGE LOAD, not per layout mount: the module-level flag survives
// StrictMode's double-invoked effects and any layout remount, so the user is
// told once and not nagged on every navigation.
let notifiedThisLoad = false;

/** Test seam — a fresh jsdom module registry per suite makes this redundant, but explicit beats implicit. */
export function resetUnsyncedImportsNoticeForTests(): void {
  notifiedThisLoad = false;
}

/**
 * Tell the user, anywhere in the app, that imports finished parsing but were
 * never pushed into their memory.
 *
 * The gap this closes: an import started during onboarding finishes its read
 * stage after the user has moved on, and nothing anywhere says the records
 * are still sitting in staging. One check on page load (mounted from the
 * main layout, which wraps every authenticated page), one persistent toast,
 * and Sync now performs exactly what the wizard's Sync card performs —
 * `POST /import/push` over every eligible run.
 */
export function useUnsyncedImportsNotice(): void {
  const api = useImportApi();
  const { toast } = useToast();

  useEffect(() => {
    if (!api.ready || notifiedThisLoad) {
      return;
    }

    // Claimed before the async check resolves: one check per load, even when
    // StrictMode re-runs the effect while the first check is in flight.
    notifiedThisLoad = true;

    void (async () => {
      try {
        const unpushed = await api.listUnpushed();

        if (unpushed.length === 0) {
          return;
        }

        toast('You have unsynced imports.', {
          // Persistent: an actionable prompt that fades in four seconds is a
          // prompt most people never see.
          duration: Infinity,
          closeButton: true,
          // Off the default bottom-right corner deliberately: every other
          // toast in the app is ephemeral and bottom-right is fine for those,
          // but a duration:Infinity notice can sit there for as long as the
          // user has an unsynced import — long enough to permanently cover a
          // fixed bottom-right action, which is exactly where the import
          // wizard's own "Continue" button lives (confirmed: it silently ate
          // every click, since a covering toast intercepts pointer events).
          position: 'top-right',
          action: {
            label: 'Sync now',
            onClick: () => {
              void api
                .startPush()
                .then(({ runs }) =>
                  toast.success(`Syncing ${runs.length} import${runs.length === 1 ? '' : 's'}.`),
                )
                .catch((err: unknown) =>
                  toast.error(err instanceof Error ? err.message : 'The sync could not be started.'),
                );
            },
          },
        });
      } catch {
        // A failed eligibility check must never break the app shell; the
        // wizard's Sync card remains the fallback surface.
      }
    })();
  }, [api, toast]);
}
