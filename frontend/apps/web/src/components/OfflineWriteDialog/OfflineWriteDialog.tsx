import { useCallback, useEffect, useRef, useState } from 'react';

import { subscribeOfflineWriteBlocked, useConnectionMode } from '@ci/common';
import { AlertDialog, Button, muteErrorToasts } from '@ci/shadcn';
import { Loader2 } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

/**
 * The one explanation for every write refused while the appliance is unreachable (the
 * write guard in `@ci/common`'s `offlineWrites.ts` and the Apollo link beside it): a
 * connection the person tried to add, a record they edited or deleted, an archive they
 * dropped on the import page. Nothing was changed, and the thing to do is wait.
 *
 * Mounted once, inside `ConnectionModeProvider`, because the refusal is raised from the
 * HTTP layer and the control that started it may be anywhere — or gone. While it is open
 * it watches the probe: when the appliance answers again, on "Check again" or on its own
 * re-probe, the copy flips to say so instead of leaving a stale warning on screen.
 *
 * A refusal also mutes `toast.error` for a moment: the feature that tried the write still
 * runs its catch block and still toasts its own "Could not … Try again shortly", which
 * beside this dialog is a second, vaguer account of the same thing.
 *
 * "Check again" re-runs the probe, which on a dead server fails within its timeout and
 * on a live one answers in milliseconds — either way too fast to see, so the first version
 * of this button appeared to do nothing (Kyle, 2026-10-23). It now swaps the copy for a
 * spinner and "Checking…" for {@link CHECK_AGAIN_DISPLAY_MS}, then shows the verdict:
 * the same warning if nothing answered, "Connected again" if the server did.
 */
/** How long after a refusal the feature's own error toast may still arrive. */
export const REFUSED_WRITE_TOAST_MUTE_MS = 2_000;

/** How long the checking state stays on screen, whatever the probe's own timing. */
export const CHECK_AGAIN_DISPLAY_MS = 2_000;

export function OfflineWriteDialog() {
  const { mode, isResolved, refresh } = useConnectionMode();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () =>
      subscribeOfflineWriteBlocked(() => {
        muteErrorToasts(REFUSED_WRITE_TOAST_MUTE_MS);
        setOpen(true);
      }),
    [],
  );

  // The timer must not outlive the dialog: a close mid-check would otherwise set state
  // on an unmounted tree, and a reopen would inherit a stale "checking".
  useEffect(
    () => () => {
      if (checkTimer.current) {
        clearTimeout(checkTimer.current);
      }
    },
    [],
  );

  const checkAgain = useCallback(() => {
    refresh();
    setChecking(true);

    if (checkTimer.current) {
      clearTimeout(checkTimer.current);
    }

    checkTimer.current = setTimeout(() => {
      checkTimer.current = null;
      setChecking(false);
    }, CHECK_AGAIN_DISPLAY_MS);
  }, [refresh]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);

    if (!next) {
      setChecking(false);

      if (checkTimer.current) {
        clearTimeout(checkTimer.current);
        checkTimer.current = null;
      }
    }
  };

  const reconnected = !checking && isResolved && mode === 'connected';

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialog.Content
        data-testid="offline-write-dialog"
        data-reconnected={reconnected}
        data-checking={checking}
      >
        <AlertDialog.Header>
          <AlertDialog.Title className="flex items-center gap-2">
            {checking && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            {checking
              ? t('OFFLINE_WRITE_CHECKING_TITLE')
              : reconnected
                ? t('OFFLINE_WRITE_RECONNECTED_TITLE')
                : t('OFFLINE_WRITE_TITLE')}
          </AlertDialog.Title>
          <AlertDialog.Description>
            {checking
              ? t('OFFLINE_WRITE_CHECKING_DESCRIPTION')
              : reconnected
                ? t('OFFLINE_WRITE_RECONNECTED_DESCRIPTION')
                : t('OFFLINE_WRITE_DESCRIPTION')}
          </AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
          {!reconnected && (
            <Button variant="outline" onClick={checkAgain} disabled={checking}>
              {t('CONNECTION_MODE_CHECK_AGAIN')}
            </Button>
          )}
          <AlertDialog.Action>{t('OFFLINE_WRITE_DISMISS')}</AlertDialog.Action>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog>
  );
}
