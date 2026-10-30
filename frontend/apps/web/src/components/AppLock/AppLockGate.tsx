import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from 'react';

import { isNativePlatform, lockScreenQueueNote, useOutboxQueue } from '@ci/common';

import { usePendingUploadsByTable } from '@/api/powersync/pendingUploads';
import { useAppLock } from '@/hooks/useAppLock';

import { LockScreen } from './LockScreen';

/**
 * The web half of the app lock: while the native side reports `locked`, the page
 * renders {@link LockScreen} instead of its children, so nothing sensitive is mounted
 * behind the native overlay. The native state is the only source of truth — this never
 * decides to lock, it only mirrors — and it never blocks sync: this sits INSIDE the
 * PowerSync and outbox providers, which stay mounted whatever it renders.
 *
 * It also feeds the native overlay its one line of context: what is waiting to sync, by
 * kind -- position fixes from the capture outbox, notes and saved searches from PowerSync's
 * upload queue. That something is waiting is not sensitive; what is waiting is, and stays
 * hidden.
 *
 * Off native there is no lock and the children render as they are.
 */
export function AppLockGate({ children }: { children: ReactNode }) {
  return (
    <GateBoundary fallback={children}>
      <LockMirror>{children}</LockMirror>
    </GateBoundary>
  );
}

/**
 * Keeps a fault in the mirror from taking the app with it. The first build threw during
 * its first render on every phone launch (a Capacitor thenable with no `catch`) and,
 * with nothing above the Memory views catching render errors, the app came up blank.
 * On a fault this renders the page: the native overlay above the WebView is the control
 * that actually hides it, so failing open here loses the mirror, not the lock.
 */
class GateBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      '[app-lock] the lock mirror failed; showing the page (the native overlay still locks)',
      error,
      info,
    );
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function LockMirror({ children }: { children: ReactNode }) {
  const native = isNativePlatform();
  const [status, { unlock, setLockScreenNote }] = useAppLock();
  const { pending, pendingByKind } = useOutboxQueue();
  const uploads = usePendingUploadsByTable();
  const [busy, setBusy] = useState(false);

  const locations = pendingByKind.positions ?? 0;
  const outboxNotes = pendingByKind.note ?? 0;
  const note = lockScreenQueueNote({
    locations,
    notes: outboxNotes + (uploads.notes ?? 0),
    savedSearches: uploads.saved_searches ?? 0,
    // Whatever else the outbox holds under a kind this note does not name.
    other: Math.max(0, pending - locations - outboxNotes),
  });
  const locked = native && status?.locked === true;

  useEffect(() => {
    if (!native || !status?.enabled) {
      return;
    }

    void setLockScreenNote(note);
  }, [native, note, setLockScreenNote, status?.enabled]);

  if (!locked) {
    return children;
  }

  const handleUnlock = async () => {
    setBusy(true);

    try {
      await unlock();
    } finally {
      setBusy(false);
    }
  };

  return <LockScreen note={note} busy={busy} onUnlock={() => void handleUnlock()} />;
}
