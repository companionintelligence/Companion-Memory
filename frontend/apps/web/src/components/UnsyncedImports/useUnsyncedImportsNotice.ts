import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { useToast } from '@ci/shadcn';

import { useImportApi } from '@/pages/ImportPage/useImportApi';

// All of this is module state ON PURPOSE. The notice is told once per PAGE
// LOAD, not per layout mount: the module-level flag survives StrictMode's
// double-invoked effects, the desktop-to-phone layout switch on first render and
// any layout remount, so the user is told once and not nagged on every
// navigation. `visible` lives beside it for the same reason — a dismissal must
// outlast the component that was showing it.
let checkedThisLoad = false;
let visible = false;
const listeners = new Set<() => void>();

function setVisible(next: boolean): void {
  if (visible === next) {
    return;
  }

  visible = next;

  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return visible;
}

/** Test seam — a fresh jsdom module registry per suite makes this redundant, but explicit beats implicit. */
export function resetUnsyncedImportsNoticeForTests(): void {
  checkedThisLoad = false;
  setVisible(false);
}

export interface UnsyncedImportsNotice {
  /** Parsed imports are waiting to be pushed into memory, and the user has not dismissed the notice. */
  visible: boolean;
  /** Push every eligible run, exactly as the wizard's Sync card does. Hides the notice. */
  syncNow: () => void;
  /** Hide the notice for the rest of this page load. Pushes nothing. */
  dismiss: () => void;
}

/**
 * Tell the user, anywhere in the app, that imports finished parsing but were
 * never pushed into their memory.
 *
 * The gap this closes: an import started during onboarding finishes its read
 * stage after the user has moved on, and nothing anywhere says the records
 * are still sitting in staging. One check on page load (mounted from the
 * main layout, which wraps every authenticated page), one persistent notice,
 * and Sync now performs exactly what the wizard's Sync card performs —
 * `POST /import/push` over every eligible run.
 *
 * It returns STATE for `UnsyncedImportsBanner` to draw in the layout flow. It
 * used to raise a sonner toast, and a toast cannot be layered or given room: it
 * is `position: fixed` at z-index 999999999, so a notice that stays up for as
 * long as there is an unsynced import sat over open dialogs, over the first row
 * of every page, and — inert but still painted — over the phone drawer.
 */
export function useUnsyncedImportsNotice({ suppressed = false }: { suppressed?: boolean } = {}): UnsyncedImportsNotice {
  const api = useImportApi();
  const { toast } = useToast();
  const isVisible = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    // Suppressed does NOT claim the once-per-load flag: if the getting-started
    // banner that suppresses this is dismissed and the shell remounts, the check
    // is still owed.
    if (!api.ready || checkedThisLoad || suppressed) {
      return;
    }

    // Claimed before the async check resolves: one check per load, even when
    // StrictMode re-runs the effect while the first check is in flight.
    checkedThisLoad = true;

    void (async () => {
      try {
        const unpushed = await api.listUnpushed();

        if (unpushed.length > 0) {
          setVisible(true);
        }
      } catch {
        // A failed eligibility check must never break the app shell; the
        // wizard's Sync card remains the fallback surface.
      }
    })();
  }, [api, suppressed]);

  const dismiss = useCallback(() => setVisible(false), []);

  const syncNow = useCallback(() => {
    // Hidden before the request settles, as the toast's action always was: one
    // click, one push, however slow the appliance is to answer.
    setVisible(false);

    void api
      .startPush()
      .then(({ runs }) => toast.success(`Syncing ${runs.length} import${runs.length === 1 ? '' : 's'}.`))
      .catch((err: unknown) =>
        toast.error(err instanceof Error ? err.message : 'The sync could not be started.'),
      );
  }, [api, toast]);

  return { visible: isVisible, syncNow, dismiss };
}
